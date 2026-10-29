import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRun, driveRun, resumeRun, RunStore } from '../src/run.mjs';
import { validateManifest } from '../src/manifest.mjs';
import { loadWorkflow } from '../src/workflow-policy.mjs';
import { AGENT_SESSION_ENV } from '../src/human-confirmation.mjs';
import { issueApprovalChallenge } from '../src/approval-anchor.mjs';
import { deliveryFor } from '../src/approval-delivery.mjs';
import { hash } from '../src/contracts.mjs';
import { persistenceEnvironment } from '../src/persistence.mjs';
import { createTestTouchIdAnchor } from './helpers/touchid-anchor.mjs';

const document = (id, extra = {}) => ({ manifest: 'q-core.workflow/v1', id, version: '1.0.0', ...extra });
const yaml = doc => Object.entries(doc).map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join('\n') + '\n';
const gate = id => ({ id, kind: 'approval-gate', config: { reviewer: 'human', bind: 'sha256' } });
const branch = (id, then) => ({ id, kind: 'if', config: { condition: 'true' }, then });
const row = (run, id) => run.steps.find(step => step.stepId === id);

async function fixture(t) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'q-core-reject-recovery-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const requests = [];
  const server = createServer((req, res) => {
    requests.push(req.url);
    res.end('synthetic local response');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const file = join(dir, 'workflow.yaml'), store = new RunStore(file);
  const request = (id, suffix = id) => ({ id, kind: 'fetch',
    config: { url: `http://127.0.0.1:${server.address().port}/${suffix}`, format: 'text' } });
  const start = async (steps, extra = {}) => {
    const doc = document('reject-recovery', { steps, ...extra });
    writeFileSync(file, yaml(doc));
    return driveRun(createRun(validateManifest(doc)), { store });
  };
  return { dir, file, store, requests, request, start };
}

// Test-only terminal record for synthetic local HTTP fixtures. This never calls
// the CLI, a real terminal, or a native human-presence helper.
async function terminalDecision(run, store, decision, opts = {}) {
  const env = process.env, terminalEnv = { ...env };
  for (const key of AGENT_SESSION_ENV) delete terminalEnv[key];
  process.env = terminalEnv;
  try {
    const pending = run.steps.find(step => step.status === 'waiting_human');
    assert.ok(pending, 'the fixture must supply a genuinely pending gate');
    return await resumeRun(run, { decision, approvalHash: pending.output.approvalHash,
      confirmation: { channel: 'tty-code', decision }, store, ...opts });
  } finally { process.env = env; }
}

function signedReject(run, store, signer) {
  const pending = run.steps.find(step => step.status === 'waiting_human');
  const payload = issueApprovalChallenge(store, { runId: run.runId, gateId: pending.rowId,
    runHash: hash(run), deliveryHash: hash(deliveryFor(run, pending, store)),
    environmentHash: hash(persistenceEnvironment(run)) }, 'reject');
  return { decision: 'reject', approvalHash: pending.output.approvalHash, store,
    confirmation: { channel: 'approval-anchor', anchor_id: 'touchid', decision: 'reject',
      payload, signature: signer.sign(payload) } };
}

test('an old signed rejection cannot decide the next independent gate', async t => {
  const f = await fixture(t), signer = createTestTouchIdAnchor(t, f.dir);
  const delivery = f.request('delivery');
  delivery.kind = 'api-request';
  delivery.config = { url: delivery.config.url, method: 'GET', body: '{}' };
  const started = await f.start([{ id: 'items', kind: 'each', config: { over: '{{inputs.items}}' },
    then: [gate('review'), delivery] }], { inputs: { items: { type: 'array', default: ['a', 'b'] } } });
  const first = f.store.load(started.runId), oldDecision = signedReject(first, f.store, signer);
  const next = await resumeRun(first, oldDecision);
  assert.equal(next.status, 'waiting_human');
  assert.deepEqual(next.steps.filter(step => step.stepId === 'review').map(step => step.status), ['rejected', 'waiting_human']);
  assert.deepEqual(next.steps.filter(step => step.stepId === 'delivery').map(step => step.status), ['skipped', 'pending']);
  const before = f.store.load(next.runId);
  await assert.rejects(resumeRun(f.store.load(next.runId), oldDecision), { code: 'STALE_APPROVAL' });
  assert.deepEqual(f.store.load(next.runId), before, 'replay must not mutate the next gate or snapshot');
  assert.deepEqual(f.requests, []);
});

test('approving the next independent gate executes only its permitted effect', async t => {
  const f = await fixture(t);
  const started = await f.start([
    branch('first', [gate('first-review'), f.request('blocked')]),
    branch('second', [gate('next-review'), f.request('independent')]),
  ]);
  const next = await terminalDecision(started, f.store, 'reject');
  assert.equal(next.status, 'waiting_human');
  assert.equal(row(next, 'next-review').decision, null);
  assert.deepEqual(f.requests, []);
  const result = await terminalDecision(f.store.load(next.runId), f.store, 'approve');
  assert.equal(result.status, 'rejected');
  assert.equal(row(result, 'first-review').status, 'rejected');
  assert.equal(row(result, 'blocked').status, 'skipped');
  assert.equal(row(result, 'next-review').status, 'success');
  assert.equal(row(result, 'next-review').decision, 'approve');
  assert.equal(row(result, 'independent').status, 'success');
  assert.deepEqual(f.requests, ['/independent']);
  assert.deepEqual(await driveRun(f.store.load(result.runId), { store: f.store }), result);
  assert.deepEqual(f.requests, ['/independent']);
});

for (const reason of ['legacy human rejection', 'technical failure']) test(`old failed snapshot stays terminal: ${reason}`, async t => {
  const f = await fixture(t);
  const started = await f.start([gate('review'), f.request('blocked')]);
  const saved = f.store.load(started.runId), failedGate = row(saved, 'review');
  const approvalHash = failedGate.output.approvalHash;
  saved.status = failedGate.status = 'failed';
  saved.finishedAt = failedGate.finishedAt = new Date().toISOString();
  saved.summary = failedGate.errorText = reason === 'legacy human rejection'
    ? 'Rejected at the gate by a human.' : 'Synthetic technical failure before delivery.';
  failedGate.decision = reason === 'legacy human rejection' ? 'reject' : null;
  f.store.save(saved);
  const loaded = f.store.load(saved.runId);
  assert.deepEqual(await driveRun(loaded, { store: f.store }), saved);
  const env = process.env, terminalEnv = { ...env };
  for (const key of AGENT_SESSION_ENV) delete terminalEnv[key];
  process.env = terminalEnv;
  try {
    await assert.rejects(resumeRun(f.store.load(saved.runId), { decision: 'reject', approvalHash,
      confirmation: { channel: 'tty-code', decision: 'reject' }, store: f.store }), { code: 'STALE_APPROVAL' });
  } finally { process.env = env; }
  assert.deepEqual(f.store.load(saved.runId), saved, 'no automatic reclassification or restart of old failures');
  assert.equal(row(f.store.load(saved.runId), 'blocked').status, 'pending');
  assert.deepEqual(f.requests, []);
});

test('recovery from an interruption after persisted rejection starts only the independent effect', async t => {
  const f = await fixture(t);
  const started = await f.start([
    branch('first', [gate('review'), f.request('blocked')]),
    branch('second', [f.request('independent')]),
  ]);
  const save = f.store.save.bind(f.store);
  let interrupted = false;
  t.mock.method(f.store, 'save', run => {
    save(run);
    if (!interrupted && row(run, 'review').status === 'rejected') {
      interrupted = true;
      throw new Error('Synthetic interruption immediately after saving the reject');
    }
  });
  await assert.rejects(terminalDecision(started, f.store, 'reject'), /Synthetic interruption immediately after saving the reject/);
  const checkpoint = f.store.load(started.runId);
  assert.equal(checkpoint.status, 'running');
  assert.equal(row(checkpoint, 'review').status, 'rejected');
  assert.equal(row(checkpoint, 'blocked').status, 'skipped');
  assert.equal(row(checkpoint, 'second').status, 'pending', 'the independent branch is not expanded yet');
  assert.deepEqual(f.requests, [], 'the interruption occurs before any HTTP effect');
  const result = await driveRun(checkpoint, { store: f.store });
  assert.equal(result.status, 'rejected');
  assert.equal(row(result, 'independent').status, 'success');
  assert.deepEqual(f.requests, ['/independent']);
  await driveRun(f.store.load(result.runId), { store: f.store });
  assert.deepEqual(f.requests, ['/independent']);
});

test('rejection propagates through two workflow-call boundaries without executing rejected continuations', async t => {
  const f = await fixture(t);
  const writeDependency = (filename, doc) => {
    const bytes = yaml(doc);
    writeFileSync(join(f.dir, filename), bytes);
    return { kind: 'workflow', id: doc.id, version: doc.version, path: filename, sha256: hash(bytes) };
  };
  const leaf = writeDependency('leaf.yaml', document('leaf-reject', {
    steps: [gate('review'), f.request('leaf-blocked')],
  }));
  const middle = writeDependency('middle.yaml', document('middle-reject', {
    dependencies: { leaf }, steps: [branch('middle-branch', [
      { id: 'leaf-call', kind: 'workflow-call', config: { ref: 'leaf' } }, f.request('middle-blocked'),
    ])],
  }));
  const parent = document('root-reject', { dependencies: { middle }, steps: [
    branch('first', [{ id: 'middle-call', kind: 'workflow-call', config: { ref: 'middle' } }, f.request('root-blocked')]),
    branch('second', [f.request('independent')]),
  ] });
  writeFileSync(f.file, yaml(parent));
  const started = await driveRun(createRun(loadWorkflow(f.file)), { store: f.store });
  const result = await terminalDecision(started, f.store, 'reject');
  assert.equal(result.status, 'rejected', result.summary);
  for (const id of ['leaf-blocked', 'middle-blocked', 'root-blocked']) assert.equal(row(result, id).status, 'skipped', id);
  for (const id of ['leaf-call', 'middle-call']) {
    assert.equal(row(result, id).status, 'rejected', id);
    assert.equal(row(result, id).childStatus, 'rejected', id);
    assert.equal(row(result, id).output, null, id);
  }
  assert.equal(result.steps.filter(step => step.kind === 'workflow-return' && step.status === 'rejected').length, 2);
  assert.deepEqual(f.requests, ['/independent']);
});

for (const innerKind of ['each', 'fan-out']) test(`nested each → ${innerKind} keeps other items and enclosing continuations independent`, async t => {
  const f = await fixture(t);
  const started = await f.start([{ id: 'outer-items', kind: 'each', config: { over: '{{inputs.outerItems}}' }, then: [
    { id: 'inner-items', kind: innerKind, config: { over: '{{inputs.innerItems}}' },
      then: [gate('review'), f.request('allowed', 'allowed-{{index}}')] },
    f.request('outer-next', 'outer-{{index}}'),
  ] }], { inputs: { outerItems: { type: 'array', default: ['outer-a', 'outer-b'] },
    innerItems: { type: 'array', default: ['inner-a', 'inner-b'] } } });
  let current = started;
  for (const decision of ['reject', 'approve', 'reject', 'approve']) {
    assert.equal(current.status, 'waiting_human');
    current = await terminalDecision(f.store.load(current.runId), f.store, decision);
  }
  assert.equal(current.status, 'rejected', current.summary);
  assert.deepEqual(current.steps.filter(step => step.stepId === 'review').map(step => step.status), ['rejected', 'success', 'rejected', 'success']);
  assert.deepEqual(current.steps.filter(step => step.stepId === 'allowed').map(step => step.status), ['skipped', 'success', 'skipped', 'success']);
  assert.deepEqual(current.steps.filter(step => step.stepId === 'outer-next').map(step => step.status), ['success', 'success']);
  assert.deepEqual(f.requests, ['/allowed-1', '/outer-0', '/allowed-1', '/outer-1']);
});
