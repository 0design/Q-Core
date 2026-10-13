import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, copyFileSync, writeFileSync, readFileSync, rmSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadWorkflow } from '../src/workflow-policy.mjs';
import { createRun, driveRun, resumeRun, RunStore } from '../src/run.mjs';
import { specification, SPEC_SECTIONS } from '../src/specification.mjs';
import { hash } from '../src/contracts.mjs';
import { digest } from '../src/material-graph.mjs';
import { AGENT_SESSION_ENV } from '../src/human-confirmation.mjs';
for (const name of AGENT_SESSION_ENV) delete process.env[name];

const callerProvider = { kind: 'caller', agent: 'codex', model: 'test-double', payerScope: 'local-cli' };
const draft = {
  summary: 'sum adds two numbers so totals are right',
  stories: ['As a caller, I want sum(a, b) to add, so that totals are right'],
  requirements: ['sum returns a + b for two numbers'],
  constraints: ['Keep the exported name sum'],
  outOfScope: ['Do not change verify.mjs'],
  edgeCases: ['Negative numbers', 'Zero'],
  criteria: ['Given 2 and 3, when sum runs, then it returns 5'],
};
const planned = { plan: ['Change the operator in sum.mjs'], tasks: ['Edit sum.mjs: replace - with +; serves criterion 1'] };

function workspace(t) {
  const root = mkdtempSync(join(tmpdir(), 'qf-sdd-brief-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  copyFileSync(new URL('../registry/workflows/sdd-brief.yaml', import.meta.url), join(root, 'sdd-brief.yaml'));
  writeFileSync(join(root, 'sum.mjs'), 'export const sum=(a,b)=>a-b;');
  writeFileSync(join(root, 'verify.mjs'), 'import assert from "node:assert/strict"; import {sum} from "./sum.mjs"; assert.equal(sum(2,3),5);');
  return root;
}
const policyFor = root => ({ workspace: root, allowedPaths: ['sum.mjs'], intent: 'Make sum add two numbers', maxRepairAttempts: 0, verifier: { command: process.execPath, args: ['verify.mjs'], timeoutMs: 5000 } });

test('sdd-brief alone: clarification, reviewed draft, plan and tasks end in one approved specification and write no file', async t => {
  const root = workspace(t), file = join(root, 'sdd-brief.yaml');
  const manifest = loadWorkflow(file), store = new RunStore(file), run = createRun(manifest);
  run.workspacePolicy = policyFor(root);
  const opts = { store, callerProvider, settings: manifest.settings };
  const answer = output => { const job = run.pendingInference; return driveRun(run, { ...opts, inferenceReply: { jobId: job.jobId, hash: job.hash, output: { text: JSON.stringify(output) } } }); };
  const approve = async stepId => {
    const gate = run.steps.find(s => s.status === 'waiting_human');
    assert.equal(gate.stepId, stepId);
    await resumeRun(run, { ...opts, decision: 'approve', confirmation: { channel: 'test-human' }, approvalHash: gate.output.approvalHash });
    return gate;
  };
  const before = readFileSync(join(root, 'sum.mjs'), 'utf8');

  await driveRun(run, opts);
  assert.equal(run.status, 'waiting_inference');
  await answer({ questions: [{ id: 'negatives', question: 'Must sum handle negative numbers?' }] });
  assert.equal(run.status, 'waiting_human');
  assert.equal(run.steps.find(s => s.stepId === 'specify').gateReason, 'clarification');
  await driveRun(run, { ...opts, clarification: { hash: run.pendingClarification.hash, answers: [{ id: 'negatives', answer: 'Yes' }] } });
  assert.equal(JSON.parse(run.pendingInference.messages[1].content).clarification.answers[0].answer, 'Yes');

  await answer(draft);
  const review = await approve('review');
  assert.deepEqual(review.output.subject, draft, 'the person reviews the whole draft');
  assert.equal(run.status, 'waiting_inference');
  await answer(planned);
  const approval = await approve('approval');
  assert.equal(run.status, 'success', run.summary);

  const spec = approval.output.subject.spec;
  assert.deepEqual(spec, { ...draft, plan: planned.plan, tasks: planned.tasks }, 'draft sections, plan and tasks are kept exactly');
  assert.deepEqual(run.output.specification.spec, spec);
  assert.equal(run.output.approval.approvalHash, approval.output.approvalHash);
  assert.equal(readFileSync(join(root, 'sum.mjs'), 'utf8'), before, 'the brief writes no file');
  assert.equal(run.steps.some(s => s.kind === 'workspace-apply'), false);
});

test('a plan that also rewrites the draft is refused; the draft is not copied by a model', async t => {
  const root = workspace(t), file = join(root, 'sdd-brief.yaml');
  const manifest = loadWorkflow(file), store = new RunStore(file), run = createRun(manifest);
  run.workspacePolicy = policyFor(root);
  const opts = { store, callerProvider, settings: manifest.settings };
  const answer = output => { const job = run.pendingInference; return driveRun(run, { ...opts, inferenceReply: { jobId: job.jobId, hash: job.hash, output: { text: JSON.stringify(output) } } }); };
  await driveRun(run, opts);
  await answer(draft);
  const review = run.steps.find(s => s.status === 'waiting_human');
  await resumeRun(run, { ...opts, decision: 'approve', confirmation: { channel: 'test-human' }, approvalHash: review.output.approvalHash });
  await answer({ ...planned, criteria: ['Anything passes'] });
  assert.equal(run.status, 'failed');
  assert.match(run.steps.find(s => s.stepId === 'specification').errorText, /plan and optional tasks/);
});

test('specification: a {summary, criteria, plan} record hashes exactly as before; optional sections are bounded', () => {
  const old = { summary: 'Return sum', criteria: ['sum(2,3) equals 5'], plan: ['Update sum.mjs', 'Run independent verifier'] };
  const normalised = specification({ ...old });
  assert.deepEqual(Object.keys(normalised), ['summary', 'criteria', 'plan']);
  assert.equal(hash(normalised), hash(old));
  assert.deepEqual(SPEC_SECTIONS, ['stories', 'requirements', 'nonFunctional', 'constraints', 'outOfScope', 'edgeCases', 'tasks']);
  assert.deepEqual(specification({ ...old, tasks: ['one'] }).tasks, ['one']);
  for (const bad of [[], [''], [1], Array(51).fill('x'), 'text']) assert.throws(() => specification({ ...old, edgeCases: bad }), /edgeCases must be a bounded list/);
});

const yaml = doc => Object.entries(doc).map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join('\n') + '\n';
test('a child that always stops at a human gate covers the parent side effect; a gate inside a branch does not', t => {
  const dir = mkdtempSync(join(tmpdir(), 'qf-child-gate-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const gate = { id: 'approve', kind: 'approval-gate', config: { reviewer: 'human', bind: 'sha256', anchor: 'x' } };
  const child = steps => ({ manifest: 'q-core.workflow/v1', id: 'child', version: '1.0.0', steps });
  const parent = sha => ({ manifest: 'q-core.workflow/v1', id: 'parent', version: '1.0.0', dependencies: { c: { kind: 'workflow', id: 'child', version: '1.0.0', path: './child.yaml', sha256: sha } },
    steps: [{ id: 'call', kind: 'workflow-call', config: { ref: 'c', inputs: '{}' } }, { id: 'send', kind: 'api-request', config: { method: 'POST', url: 'https://example.test/hook', body: '{}' } }] });
  const write = (steps) => { const bytes = yaml(child(steps)); writeFileSync(join(dir, 'child.yaml'), bytes); writeFileSync(join(dir, 'parent.yaml'), yaml(parent(digest(bytes)))); };
  write([{ id: 'note', kind: 'deduplicate', config: { source: '[]' } }, gate]);
  assert.doesNotThrow(() => loadWorkflow(join(dir, 'parent.yaml')));
  write([{ id: 'branch', kind: 'if', config: { condition: 'true' }, then: [gate] }]);
  assert.throws(() => loadWorkflow(join(dir, 'parent.yaml')), /GATE_REQUIRED: step "send"/);
  write([{ id: 'note', kind: 'deduplicate', config: { source: '[]' } }]);
  assert.throws(() => loadWorkflow(join(dir, 'parent.yaml')), /GATE_REQUIRED: step "send"/);
});

test('both Registry SDD workflows load as created (unreviewed) manifests', () => {
  const dir = new URL('../registry/workflows/', import.meta.url).pathname;
  for (const file of ['sdd-brief.yaml', 'sdd-pipeline.yaml']) assert.doesNotThrow(() => loadWorkflow(join(dir, file)), file);
  assert.ok(readdirSync(dir).includes('sdd-brief.yaml'));
});
