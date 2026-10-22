import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, realpathSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hash } from '../src/contracts.mjs';
import { loadManifestGraph, digest } from '../src/material-graph.mjs';
import { loadWorkflow } from '../src/workflow-policy.mjs';
import { createRun, driveRun, RunStore } from '../src/run.mjs';
import { validateWorkspacePolicy, runWorkspaceRead, runSpecification, runWorkspaceApply } from '../src/registry-workspace-steps.mjs';

const SPEC = { summary: 'Update the bounded artifact', criteria: ['value.txt contains changed'], plan: ['Change only value.txt'] };
const PROPOSAL = { files: [{ path: 'value.txt', content: 'changed' }] };
const yaml = doc => Object.entries(doc).map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join('\n') + '\n';
const document = (id, extra = {}) => ({ manifest: 'q-core.workflow/v1', id, version: '1.0.0', settings: { budgetUsd: null }, ...extra });
const apply = (id = 'apply', extra = {}) => ({ id, kind: 'workspace-apply', config: { source: '{{inputs.proposal}}', ...extra } });
const gate = { id: 'approval', kind: 'approval-gate', config: { reviewer: 'human', bind: 'sha256' } };
const planning = [
  { id: 'workspace', kind: 'workspace-read' },
  { id: 'specification', kind: 'specification', config: { source: '{{inputs.specification}}', workspace: '{{steps.workspace.output}}' } },
];
const APPROVED = { approval: '{{steps.approval.output}}' };
const securityError = /approval|approved|gate|specification|subject|hash|binding/i;

function fixture(t, steps = [apply()]) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'q-core-round2-security-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'value.txt'), 'original');
  writeFileSync(join(root, 'outside.txt'), 'outside-original');
  writeFileSync(join(root, 'verify.mjs'), 'process.exit(0);');
  const policy = validateWorkspacePolicy({ workspace: root, allowedPaths: ['value.txt'], intent: 'Update the bounded artifact', maxRepairAttempts: 0, verifier: { command: process.execPath, args: ['verify.mjs'], timeoutMs: 3000 } });
  const file = join(root, 'workflow.yaml');
  const put = (path, doc) => { const bytes = yaml(doc); writeFileSync(join(root, path), bytes); return { kind: 'workflow', id: doc.id, version: doc.version, path, sha256: digest(bytes) }; };
  const parent = extra => document('round2-parent', { inputs: { proposal: { type: 'object', default: PROPOSAL }, noop: { type: 'object', default: { files: [{ path: 'value.txt', content: 'original' }] } }, specification: { type: 'object', default: SPEC } }, steps, ...extra });
  put('workflow.yaml', parent());
  const store = new RunStore(file);
  const ctx = inputs => ({ workspacePolicy: policy, inputs, priorOutputs: {}, priorStepNames: {}, templateId: 'round2-parent', runStore: store });
  const specification = (source = SPEC) => {
    const workspace = runWorkspaceRead({}, ctx({})).output;
    return runSpecification({ config: { source: '{{inputs.specification}}', workspace: '{{inputs.workspace}}' } }, ctx({ specification: source, workspace })).output;
  };
  const start = async ({ unchecked = false, withPolicy = true } = {}) => {
    const manifest = unchecked ? loadManifestGraph(file) : loadWorkflow(file);
    const run = createRun(manifest);
    if (withPolicy) run.workspacePolicy = policy;
    await driveRun(run, { store });
    return run;
  };
  return { root, file, policy, put, parent, store, ctx, specification, start, text: path => readFileSync(join(root, path), 'utf8') };
}

// These fixtures exercise the write-time binding after a persisted approval; they
// do not test the terminal confirmation interface or write outside temp fixtures.
function approvedFixture(f, waiting) {
  assert.equal(waiting.status, 'waiting_human', waiting.summary);
  const run = f.store.load(waiting.runId);
  const row = run.steps.find(step => step.status === 'waiting_human');
  row.status = 'success'; row.decision = 'approve'; row.confirmation = { channel: 'local-security-fixture' }; row.finishedAt = new Date().toISOString();
  run.status = 'running'; run.finishedAt = null;
  return { run, gate: row };
}

function assertRefused(f, run) {
  assert.equal(run.status, 'failed', run.summary);
  assert.match(run.summary, securityError);
  assert.equal(f.text('value.txt'), 'original');
  assert.equal(f.text('outside.txt'), 'outside-original');
}

test('a supplied specification cannot change content while retaining its original canonical hash', t => {
  const f = fixture(t), specification = f.specification(), originalHash = specification.hash;
  specification.spec.criteria = ['An unapproved replacement criterion'];
  assert.equal(specification.hash, originalHash);
  assert.throws(() => runWorkspaceApply(apply('apply', { specification: '{{inputs.specification}}' }), f.ctx({ proposal: PROPOSAL, specification })), securityError);
  assert.equal(f.text('value.txt'), 'original');
});

test('a supplied specification must have the bounded specification structure, even with a claimed hash', t => {
  const f = fixture(t), specification = f.specification();
  specification.spec = { summary: 'Invalid without criteria or plan' };
  assert.throws(() => runWorkspaceApply(apply('apply', { specification: '{{inputs.specification}}' }), f.ctx({ proposal: PROPOSAL, specification })), /specification|criteria|plan|hash/i);
  assert.equal(f.text('value.txt'), 'original');
});

test('validator rejects a second source-only workspace apply governed by an earlier gate', t => {
  const f = fixture(t, [...planning, gate, apply('first', APPROVED), apply('second')]);
  assert.throws(() => loadWorkflow(f.file), securityError);
});

test('runtime rejects a second source-only workspace apply after a gate even without validator policy', async t => {
  const first = apply('first', { ...APPROVED, source: '{{inputs.noop}}' });
  const f = fixture(t, [...planning, gate, first, apply('second')]);
  const { run } = approvedFixture(f, await f.start({ unchecked: true }));
  await driveRun(run, { store: f.store });
  assert.equal(run.steps.find(row => row.stepId === 'first').status, 'success');
  assertRefused(f, run);
});

function nested(f, { approved = false, gated = true } = {}) {
  const child = document('round2-child', { inputs: { proposal: { type: 'object' }, ...(approved ? { approval: { type: 'object' } } : {}) }, steps: [apply('child-apply', approved ? { approval: '{{inputs.approval}}' } : {})] });
  const ref = f.put('child.yaml', child);
  const inputs = { proposal: '{{inputs.proposal}}', ...(approved ? { approval: '{{steps.approval.output}}' } : {}) };
  f.put('workflow.yaml', f.parent({ dependencies: { writer: ref }, steps: [...(gated ? [...planning, gate] : []), { id: 'call', kind: 'workflow-call', config: { ref: 'writer', inputs: JSON.stringify(inputs) } }] }));
}

test('validator follows a parent approval gate into a child workflow and rejects an unbound child apply', t => {
  const f = fixture(t); nested(f);
  assert.throws(() => loadWorkflow(f.file), securityError);
});

test('runtime follows a parent approval gate into a child workflow and refuses an unbound child apply', async t => {
  const f = fixture(t); nested(f);
  const { run } = approvedFixture(f, await f.start({ unchecked: true }));
  await driveRun(run, { store: f.store });
  assert.equal(run.steps.find(row => row.stepId === 'child-apply').status, 'failed');
  assertRefused(f, run);
});

test('a nested child apply bound to its parent gate preserves the exact approved specification hash', async t => {
  const f = fixture(t); nested(f, { approved: true });
  const { run, gate: approval } = approvedFixture(f, await f.start());
  await driveRun(run, { store: f.store });
  assert.equal(run.status, 'success', run.summary);
  const artifact = run.steps.find(row => row.stepId === 'child-apply').output;
  assert.equal(artifact.specHash, approval.output.subject.hash);
  assert.equal(f.text('value.txt'), 'changed');
  assert.equal(f.text('outside.txt'), 'outside-original');
});

test('a gated apply refuses a changed subject after approval even if its supplied approval hash is recomputed', async t => {
  const f = fixture(t, [...planning, gate, apply('apply', APPROVED)]);
  const { run, gate: approval } = approvedFixture(f, await f.start());
  const replacement = f.specification({ ...SPEC, summary: 'A different specification never approved by this gate' });
  approval.output.subject = replacement;
  approval.output.approvalHash = hash(replacement);
  await driveRun(run, { store: f.store });
  assertRefused(f, run);
});

test('a parent gate subject cannot be replaced before a nested child apply by recomputing a supplied approval hash', async t => {
  const f = fixture(t); nested(f, { approved: true });
  const { run, gate: approval } = approvedFixture(f, await f.start());
  const replacement = f.specification({ ...SPEC, plan: ['A changed plan that the parent gate never approved'] });
  approval.output.subject = replacement;
  approval.output.approvalHash = hash(replacement);
  await driveRun(run, { store: f.store });
  assertRefused(f, run);
});

test('a truly ungated workflow still writes only its policy-scoped artifact', async t => {
  const f = fixture(t), run = await f.start();
  assert.equal(run.status, 'success', run.summary);
  assert.equal(f.text('value.txt'), 'changed');
  assert.equal(f.text('outside.txt'), 'outside-original');
});

test('a workspace symlink into an outside directory refuses the write and preserves the outside file', t => {
  const f = fixture(t), outside = realpathSync(mkdtempSync(join(tmpdir(), 'q-core-round2-outside-')));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  writeFileSync(join(outside, 'value.txt'), 'outside-original');
  mkdirSync(join(f.root, 'linked'));
  writeFileSync(join(f.root, 'linked', 'value.txt'), 'original');
  const policy = validateWorkspacePolicy({ ...f.policy, allowedPaths: ['linked/value.txt'] });
  rmSync(join(f.root, 'linked'), { recursive: true });
  symlinkSync(outside, join(f.root, 'linked'), 'dir');
  assert.throws(() => runWorkspaceApply(apply(), { ...f.ctx({ proposal: { files: [{ path: 'linked/value.txt', content: 'escaped' }] } }), workspacePolicy: policy }), /symlink|scope/i);
  assert.equal(readFileSync(join(outside, 'value.txt'), 'utf8'), 'outside-original');
  assert.equal(f.text('value.txt'), 'original');
});

test('a nested workflow cannot execute workspace writes without a runtime workspace policy', async t => {
  const f = fixture(t); nested(f, { gated: false });
  const run = await f.start({ withPolicy: false });
  assert.equal(run.status, 'failed');
  assert.match(run.summary, /workspace policy required|invalid workspace policy/i);
  assert.equal(run.steps.find(row => row.stepId === 'child-apply').status, 'failed');
  assert.equal(f.text('value.txt'), 'original');
  assert.equal(f.text('outside.txt'), 'outside-original');
});

test('validator retains a gate taken inside a control branch when checking an apply after the branch', t => {
  const f = fixture(t, [{ id: 'choose', kind: 'if', config: { condition: 'true' }, then: [...planning, gate] }, apply()]);
  assert.throws(() => loadWorkflow(f.file), securityError);
});

test('runtime retains a gate taken inside a control branch when executing an apply after the branch', async t => {
  const f = fixture(t, [{ id: 'choose', kind: 'if', config: { condition: 'true' }, then: [...planning, gate] }, apply()]);
  const { run } = approvedFixture(f, await f.start({ unchecked: true }));
  await driveRun(run, { store: f.store });
  assertRefused(f, run);
});

function repeated(f, kind) {
  const doc = f.parent();
  doc.inputs.items = { type: 'array', default: [1, 2] };
  doc.steps = [{ id: 'repeat', kind, config: kind === 'loop' ? { maxIterations: 2 } : { over: '{{inputs.items}}', maxItems: 2 }, then: [apply('iteration-apply', { source: '{{inputs.noop}}' }), ...planning, gate] }];
  f.put('workflow.yaml', doc);
}

for (const kind of ['loop', 'each']) {
  test(`validator checks a ${kind} body apply before its gate against the prior iteration's approval`, t => {
    const f = fixture(t); repeated(f, kind);
    assert.throws(() => loadWorkflow(f.file), securityError);
  });

  test(`runtime refuses a ${kind} body source-only apply after a gate approved in the prior iteration`, async t => {
    const f = fixture(t); repeated(f, kind);
    const { run } = approvedFixture(f, await f.start({ unchecked: true }));
    await driveRun(run, { store: f.store });
    assertRefused(f, run);
    assert.deepEqual(run.steps.filter(row => row.stepId === 'iteration-apply').map(row => row.status), ['success', 'failed']);
  });
}

test('a later gate in the same workflow may approve a new specification and supersede its earlier subject', async t => {
  const f = fixture(t), doc = f.parent();
  doc.inputs.nextSpecification = { type: 'object', default: { ...SPEC, summary: 'The updated specification approved by the later gate' } };
  doc.steps = [...planning, gate,
    { id: 'next-workspace', kind: 'workspace-read' },
    { id: 'next-specification', kind: 'specification', config: { source: '{{inputs.nextSpecification}}', workspace: '{{steps.next-workspace.output}}' } },
    { id: 'next-approval', kind: 'approval-gate', config: { reviewer: 'human', bind: 'sha256' } },
    apply('apply', { approval: '{{steps.next-approval.output}}' }),
  ];
  f.put('workflow.yaml', doc);
  const first = approvedFixture(f, await f.start());
  await driveRun(first.run, { store: f.store });
  const second = approvedFixture(f, first.run);
  assert.notEqual(first.gate.output.subject.hash, second.gate.output.subject.hash);
  await driveRun(second.run, { store: f.store });
  assert.equal(second.run.status, 'success', second.run.summary);
  assert.equal(second.run.steps.find(row => row.stepId === 'apply').output.specHash, second.gate.output.subject.hash);
  assert.equal(f.text('value.txt'), 'changed');
  assert.equal(f.text('outside.txt'), 'outside-original');
});

test('a child gate approving a different specification cannot replace an inherited parent approval binding', async t => {
  const f = fixture(t);
  const child = document('round2-child', { inputs: { proposal: { type: 'object' }, specification: { type: 'object' } }, steps: [...planning, gate, apply('child-apply', APPROVED)] });
  const ref = f.put('child.yaml', child);
  const doc = f.parent({ dependencies: { writer: ref }, steps: [...planning, gate, { id: 'call', kind: 'workflow-call', config: { ref: 'writer', inputs: JSON.stringify({ proposal: '{{inputs.proposal}}', specification: { ...SPEC, summary: 'A different child specification never approved by the parent gate' } }) } }] });
  f.put('workflow.yaml', doc);
  const parent = approvedFixture(f, await f.start());
  await driveRun(parent.run, { store: f.store });
  const childApproval = approvedFixture(f, parent.run);
  assert.notEqual(parent.gate.output.approvalHash, childApproval.gate.output.approvalHash);
  await driveRun(childApproval.run, { store: f.store });
  assertRefused(f, childApproval.run);
  assert.equal(childApproval.run.steps.find(row => row.stepId === 'child-apply').status, 'failed');
});

test('a gated apply fails closed when no independent approved subject hash remains', async t => {
  const f = fixture(t, [...planning, gate, apply('apply', APPROVED)]);
  const { run, gate: approval } = approvedFixture(f, await f.start());
  const replacement = f.specification({ ...SPEC, summary: 'A replacement that has no recorded approved hash' });
  run.steps.find(row => row.stepId === 'specification').output = replacement;
  approval.output.subject = replacement;
  approval.output.approvalHash = hash(replacement);
  delete approval.boundSubjectHash;
  delete approval.approvedSubjectHash;
  await driveRun(run, { store: f.store });
  assertRefused(f, run);
});

test('a newly recorded approval hash restores the binding for a legacy waiting gate', async t => {
  const f = fixture(t, [...planning, gate, apply('apply', APPROVED)]);
  const { run, gate: approval } = approvedFixture(f, await f.start());
  delete approval.boundSubjectHash;
  // Model the hash recorded by resumeRun when a person approves the current subject.
  approval.approvedSubjectHash = approval.output.approvalHash;
  await driveRun(run, { store: f.store });
  assert.equal(run.status, 'success', run.summary);
  assert.equal(f.text('value.txt'), 'changed');
  assert.equal(f.text('outside.txt'), 'outside-original');
});
