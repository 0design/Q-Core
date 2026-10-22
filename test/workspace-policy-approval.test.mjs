/* D-0269: workspace policy bounds writes; human approval is an optional workflow component. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, realpathSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { loadWorkflow } from '../src/workflow-policy.mjs';
import { createRun, driveRun, resumeRun, RunStore } from '../src/run.mjs';
import { validateWorkspacePolicy, runWorkspaceApply, runWorkspaceRead } from '../src/registry-workspace-steps.mjs';
import { AGENT_SESSION_ENV, confirmHumanDecision } from '../src/human-confirmation.mjs';
import { hash } from '../src/contracts.mjs';

const cli = resolve('bin/q-core.mjs');
const cleanEnv = () => {
  const env = { ...process.env, QF_NO_UPDATE_CHECK: '1' };
  for (const key of AGENT_SESSION_ENV) delete env[key];
  return env;
};
const yaml = doc => Object.entries(doc).map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join('\n') + '\n';
const spec = { summary: 'Write a bounded artifact', criteria: ['value.txt contains changed'], plan: ['Edit value.txt only'] };
const proposal = { files: [{ path: 'value.txt', content: 'changed' }] };
const callerProvider = { kind: 'caller', agent: 'codex', model: 'test-double', payerScope: 'local-cli' };
const apply = extra => ({ id: 'apply', kind: 'workspace-apply', config: { source: '{{inputs.proposal}}', ...extra } });
const planning = [
  { id: 'workspace', kind: 'workspace-read' },
  { id: 'specification', kind: 'specification', config: { source: '{{inputs.specification}}', workspace: '{{steps.workspace.output}}' } },
];

function fixture(t, steps = [apply()]) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'q-core-optional-approval-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'value.txt'), 'original');
  writeFileSync(join(root, 'outside.txt'), 'outside-original');
  writeFileSync(join(root, 'verify.mjs'), 'process.exit(0);');
  const policy = { workspace: root, allowedPaths: ['value.txt'], intent: 'Write a bounded artifact', maxRepairAttempts: 0, verifier: { command: process.execPath, args: ['verify.mjs'], timeoutMs: 3000 } };
  const file = join(root, 'workflow.yaml'), policyFile = join(root, 'workspace-policy.json'), inputsFile = join(root, 'inputs.json');
  writeFileSync(file, yaml({ manifest: 'q-core.workflow/v1', id: 'optional-approval', version: '1.0.0', settings: { budgetUsd: null }, inputs: { proposal: { type: 'object', default: proposal }, specification: { type: 'object', default: spec } }, steps }));
  writeFileSync(policyFile, JSON.stringify(policy));
  writeFileSync(inputsFile, JSON.stringify({ proposal }));
  const command = (args, opts = {}) => spawnSync(process.execPath, [cli, ...args], { cwd: root, encoding: 'utf8', env: cleanEnv(), ...opts });
  const start = (withPolicy = true) => command(['run', file, '--inputs', inputsFile, ...(withPolicy ? ['--workspace-policy', policyFile] : []), '--json']);
  const text = path => readFileSync(join(root, path), 'utf8');
  return { root, file, policy, policyFile, inputsFile, command, start, text };
}
function result(processResult, expectedCode) {
  assert.equal(processResult.status, expectedCode, processResult.stderr + processResult.stdout);
  assert.doesNotMatch(processResult.stderr + processResult.stdout, /GATE_REQUIRED/);
  return JSON.parse(processResult.stdout);
}

test('workspace-apply without a gate validates and autonomously writes only files allowed by workspace policy', t => {
  const f = fixture(t);
  const validation = f.command(['validate', f.file]);
  assert.equal(validation.status, 0, validation.stderr + validation.stdout);
  const run = result(f.start(), 0);
  assert.equal(run.status, 'success');
  assert.equal(run.steps[0].kind, 'workspace-apply');
  assert.equal(run.steps[0].status, 'success');
  assert.equal(f.text('value.txt'), 'changed');
  assert.equal(f.text('outside.txt'), 'outside-original');
  assert.equal(f.text('verify.mjs'), 'process.exit(0);');
  assert.equal(run.steps.some(row => row.kind === 'approval-gate'), false);
});

test('ungated writes outside allowed paths or outside the workspace are refused by workspace policy', t => {
  const f = fixture(t);
  const escaped = join(tmpdir(), `q-core-escape-${process.pid}-${Date.now()}.txt`);
  t.after(() => rmSync(escaped, { force: true }));
  for (const path of ['outside.txt', escaped, '../escape.txt', '.qf/agent-state.json']) {
    writeFileSync(f.inputsFile, JSON.stringify({ proposal: { files: [{ path, content: 'escaped' }] } }));
    const run = result(f.start(), 1);
    assert.equal(run.status, 'failed', path);
    assert.match(run.summary, /scope|allowed/i, path);
    assert.match(run.steps.at(-1).errorText, /scope|allowed/i, path);
    assert.equal(f.text('value.txt'), 'original');
    assert.equal(f.text('outside.txt'), 'outside-original');
    assert.equal(existsSync(escaped), false);
  }
});

test('ungated workspace-apply without a workspace policy refuses writes', t => {
  const f = fixture(t);
  const run = result(f.start(false), 1);
  assert.equal(run.status, 'failed');
  assert.match(run.summary, /workspace policy required|invalid workspace policy/i);
  assert.equal(f.text('value.txt'), 'original');
});

test('an ungated specification-bound apply retains the specification hash through independent verification', t => {
  const f = fixture(t, [...planning, apply({ specification: '{{steps.specification.output}}' }),
    { id: 'verify', kind: 'determined', config: { source: '{{steps.apply.output}}', specification: '{{steps.specification.output}}' } },
  ]);
  writeFileSync(join(f.root, 'verify.mjs'), 'import { readFileSync } from "node:fs"; if(readFileSync("value.txt", "utf8")!=="changed")process.exit(1);');
  const done = result(f.start(), 0);
  assert.equal(done.status, 'success', done.summary);
  const specification = done.steps.find(row => row.kind === 'specification').output;
  const artifact = done.steps.find(row => row.kind === 'workspace-apply').output;
  assert.equal(artifact.specHash, specification.hash);
  assert.equal(done.steps.at(-1).output.outcome, 'pass');
  assert.equal(done.steps.at(-1).output.specHash, specification.hash);
  assert.equal(f.text('value.txt'), 'changed');
  assert.equal(f.text('outside.txt'), 'outside-original');
});

test('an explicit sha256 gate still blocks the write and neither an agent nor a pipe can approve it', t => {
  const f = fixture(t, [...planning, { id: 'approval', kind: 'approval-gate', config: { reviewer: 'human', bind: 'sha256' } }, apply({ approval: '{{steps.approval.output}}' })]);
  const parked = result(f.start(), 2);
  assert.equal(parked.status, 'waiting_human');
  assert.equal(f.text('value.txt'), 'original');
  const hash = parked.nextAction.approvalHash;
  assert.match(hash, /^[a-f0-9]{64}$/);
  const args = ['approve', f.file, parked.runId, '--approval-hash', hash];
  for (const opts of [{ env: { ...cleanEnv(), CLAUDECODE: '1' } }, { input: 'yes\n' }]) {
    const refused = f.command(args, opts);
    assert.equal(refused.status, 2, refused.stderr);
    assert.match(refused.stderr, /HUMAN_CONFIRMATION_REQUIRED/);
    assert.doesNotMatch(refused.stderr + refused.stdout, /type the code/);
    assert.equal(new RunStore(f.file).load(parked.runId).status, 'waiting_human');
    assert.equal(f.text('value.txt'), 'original');
  }
  const stale = f.command(['approve', f.file, parked.runId, '--approval-hash', '0'.repeat(64)]);
  assert.equal(stale.status, 1);
  assert.match(stale.stderr, /Approval does not match/);
  assert.equal(f.text('value.txt'), 'original');
});

test('a configured gate accepts only the terminal one-time code before applying the exact approved specification', async t => {
  const f = fixture(t, [...planning, { id: 'approval', kind: 'approval-gate', config: { reviewer: 'human', bind: 'sha256' } }, apply({ approval: '{{steps.approval.output}}' })]);
  const parked = result(f.start(), 2);
  const written = [];
  const terminal = answer => ({ env: {}, stdinIsTTY: true, stdoutIsTTY: true, code: 'K7PQ3X', openTerminal: () => ({ write: text => written.push(text), readLine: () => answer, close() {} }) });
  assert.throws(() => confirmHumanDecision({ decision: 'approve' }, terminal('yes')), error => error.code === 'HUMAN_CONFIRMATION_REQUIRED' && error.reason === 'code-mismatch');
  assert.equal(f.text('value.txt'), 'original');
  assert.equal(new RunStore(f.file).load(parked.runId).status, 'waiting_human');
  const confirmation = confirmHumanDecision({ decision: 'approve' }, terminal('K7PQ3X'));
  assert.match(written.join(''), /type the code K7PQ3X/);
  const store = new RunStore(f.file), waiting = store.load(parked.runId);
  const markers = Object.fromEntries(AGENT_SESSION_ENV.map(key => [key, process.env[key]]));
  let done;
  try {
    for (const key of AGENT_SESSION_ENV) delete process.env[key];
    done = await resumeRun(waiting, { decision: 'approve', approvalHash: parked.nextAction.approvalHash, confirmation, store });
  } finally {
    for (const [key, value] of Object.entries(markers)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  assert.equal(done.status, 'success', done.summary);
  assert.equal(done.steps.find(row => row.kind === 'approval-gate').confirmation.channel, 'tty-code');
  assert.equal(f.text('value.txt'), 'changed');
  assert.equal(f.text('outside.txt'), 'outside-original');
});

test('an ungated specification preserves its pinned workspace, policy and verifier before apply', async t => {
  for (const changed of ['workspace', 'policy', 'verifier']) await t.test(changed, async t => {
    const f = fixture(t, [...planning,
      { id: 'proposal', kind: 'llm-call', config: { provider: 'cli', format: 'json', instructions: 'Return the bounded proposal' } },
      { id: 'apply', kind: 'workspace-apply', config: { source: '{{steps.proposal.output}}', specification: '{{steps.specification.output}}' } },
    ]);
    const manifest = loadWorkflow(f.file), store = new RunStore(f.file);
    const run = createRun(manifest);
    run.workspacePolicy = validateWorkspacePolicy(f.policy);
    const opts = { store, callerProvider, settings: manifest.settings };
    await driveRun(run, opts);
    assert.equal(run.status, 'waiting_inference', run.summary);
    if (changed === 'workspace') writeFileSync(join(f.root, 'value.txt'), 'changed independently');
    if (changed === 'policy') run.workspacePolicy.intent = 'Changed scope after planning';
    if (changed === 'verifier') writeFileSync(join(f.root, 'verify.mjs'), 'process.exit(1);');
    const job = run.pendingInference;
    await driveRun(run, { ...opts, inferenceReply: { jobId: job.jobId, hash: job.hash, output: { text: JSON.stringify(proposal) } } });
    assert.equal(run.status, 'failed');
    assert.match(run.summary, /workspace changed|policy changed|verifier source changed/i);
    assert.equal(f.text('value.txt'), changed === 'workspace' ? 'changed independently' : 'original');
    assert.equal(f.text('outside.txt'), 'outside-original');
  });
});

test('an invalid explicit approval binding never falls back to autonomous workspace policy', t => {
  const f = fixture(t);
  const policy = validateWorkspacePolicy(f.policy);
  for (const approval of [null, {}, { subject: {}, approvalHash: '0'.repeat(64) }]) {
    assert.throws(() => runWorkspaceApply({ config: { source: '{{inputs.proposal}}', approval: '{{inputs.approval}}' } }, { workspacePolicy: policy, inputs: { proposal, approval }, priorOutputs: {}, priorStepNames: {} }), /Exact approved specification required/);
    assert.equal(f.text('value.txt'), 'original');
  }
  for (const config of [{ approval: null }, { specification: null }]) {
    assert.throws(() => runWorkspaceApply({ config: { source: '{{inputs.proposal}}', ...config } }, { workspacePolicy: policy, inputs: { proposal }, priorOutputs: {}, priorStepNames: {} }), /Exact (approved )?specification required/);
    assert.equal(f.text('value.txt'), 'original');
  }
});

test('a matching specification hash cannot replace a missing planning snapshot with a fresh one', t => {
  const f = fixture(t), policy = validateWorkspacePolicy(f.policy);
  const workspace = runWorkspaceRead({}, { workspacePolicy: policy }).output;
  delete workspace.before;
  const specification = { hash: 'planned-specification', workspace };
  const approval = { subject: specification, approvalHash: hash(specification) };
  for (const binding of [{ specification: '{{inputs.specification}}' }, { approval: '{{inputs.approval}}' }]) {
    assert.throws(() => runWorkspaceApply({ config: { source: '{{inputs.proposal}}', ...binding } }, { workspacePolicy: policy, inputs: { proposal, specification, approval }, priorOutputs: {}, priorStepNames: {} }), /snapshot/i);
    assert.equal(f.text('value.txt'), 'original');
  }
});
