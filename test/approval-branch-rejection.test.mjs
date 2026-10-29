import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRun, driveRun, resumeRun, RunStore } from '../src/run.mjs';
import { validateManifest } from '../src/manifest.mjs';
import { loadWorkflow } from '../src/workflow-policy.mjs';
import { AGENT_SESSION_ENV } from '../src/human-confirmation.mjs';
import { APPROVAL_TTL_MS, issueApprovalChallenge } from '../src/approval-anchor.mjs';
import { deliveryFor } from '../src/approval-delivery.mjs';
import { hash } from '../src/contracts.mjs';
import { persistenceEnvironment } from '../src/persistence.mjs';
import { createLocalHost } from '../src/host.mjs';
import { createTestTouchIdAnchor } from './helpers/touchid-anchor.mjs';

const document = (id, extra = {}) => ({ manifest: 'q-core.workflow/v1', id, version: '1.0.0', ...extra });
const yaml = doc => Object.entries(doc).map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join('\n') + '\n';
const review = { id: 'review', kind: 'approval-gate', config: { reviewer: 'human', bind: 'sha256' } };
const branch = (id, then) => ({ id, kind: 'if', config: { condition: 'true' }, then });
const status = (run, id) => run.steps.find(row => row.stepId === id)?.status;

async function fixture(t) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'q-core-reject-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const requests = [];
  const server = createServer((req, res) => {
    requests.push(req.url);
    res.statusCode = req.url === '/error' ? 500 : 200;
    res.end('synthetic local response');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}`;
  const file = join(dir, 'workflow.yaml');
  const store = new RunStore(file);
  const request = (id, suffix = id) => ({ id, kind: 'api-request', config: { url: `${url}/${suffix}`, method: 'GET', body: '{}' } });
  const start = async (steps, extra = {}) => {
    const doc = document('reject-branch', { steps, ...extra });
    writeFileSync(file, yaml(doc));
    return driveRun(createRun(validateManifest(doc)), { store });
  };
  return { dir, file, store, requests, request, start };
}

// Synthetic terminal record, scoped to this test process and local HTTP fixtures.
// Never invokes the approve CLI, a real terminal, or the native Touch ID helper.
async function terminalReject(run, store, opts = {}) {
  const env = process.env;
  const terminalEnv = { ...env };
  for (const key of AGENT_SESSION_ENV) delete terminalEnv[key];
  process.env = terminalEnv;
  try {
    const gate = run.steps.find(row => row.status === 'waiting_human');
    return await resumeRun(run, { decision: 'reject', approvalHash: gate.output.approvalHash,
      confirmation: { channel: 'tty-code', decision: 'reject' }, store, ...opts });
  } finally { process.env = env; }
}

function signedReject(f, run, signer) {
  const gate = run.steps.find(row => row.status === 'waiting_human');
  const payload = issueApprovalChallenge(f.store, { runId: run.runId, gateId: gate.rowId,
    runHash: hash(run), deliveryHash: hash(deliveryFor(run, gate, f.store)),
    environmentHash: hash(persistenceEnvironment(run)) }, 'reject');
  return { decision: 'reject', approvalHash: gate.output.approvalHash, store: f.store,
    confirmation: { channel: 'approval-anchor', anchor_id: 'touchid', decision: 'reject', payload, signature: signer.sign(payload) } };
}

test('reject skips only its branch, completes independent HTTP, persists and never replays effects', async t => {
  const f = await fixture(t);
  const run = await f.start([
    branch('first', [review, f.request('blocked'), branch('unexpanded', [f.request('also-blocked')])]),
    branch('second', [f.request('independent')]),
  ], { outputs: { blocked: { type: 'object', value: '{{steps.blocked.output}}' } } });
  assert.equal(run.status, 'waiting_human');
  let consumedBeforeEffect = false;
  const fetch = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', async (...args) => {
    const saved = f.store.load(run.runId);
    consumedBeforeEffect = status(saved, 'review') === 'rejected' && status(saved, 'blocked') === 'skipped';
    assert.equal(consumedBeforeEffect, true, 'the rejected decision is persisted before any HTTP effect');
    return fetch(...args);
  });
  const result = await terminalReject(run, f.store);
  assert.equal(status(result, 'review'), 'rejected');
  assert.equal(status(result, 'blocked'), 'skipped');
  assert.equal(status(result, 'unexpanded'), 'skipped');
  assert.equal(status(result, 'also-blocked'), undefined);
  assert.equal(status(result, 'independent'), 'success');
  assert.equal(result.status, 'rejected');
  assert.match(result.summary, /1 approval\(s\) rejected/);
  assert.ok(result.finishedAt);
  assert.equal(result.output, undefined, 'missing rejected outputs are not bound as a failure');
  assert.equal(consumedBeforeEffect, true);
  assert.deepEqual(f.requests, ['/independent']);
  const saved = f.store.load(result.runId);
  assert.deepEqual(await driveRun(saved, { store: f.store }), saved);
  await assert.rejects(terminalReject(saved, f.store));
  assert.deepEqual(f.requests, ['/independent']);
  f.store.saveLastRun(saved);
  assert.equal(f.store.lastRun().status, 'rejected');
  assert.equal(f.store.lastRun().failedStep, null);
  assert.equal(f.store.lastRun().exitCode, 1);
  for (const flags of [[], ['--json']]) {
    const cli = spawnSync(process.execPath, [resolve('bin/q-core.mjs'), 'status', f.file, ...flags],
      { encoding: 'utf8', env: { ...process.env, QF_NO_UPDATE_CHECK: '1' } });
    assert.equal(cli.status, 1, cli.stderr);
    assert.match(cli.stdout, /rejected/);
    assert.doesNotMatch(cli.stdout, /last run FAILED/);
  }
});

for (const kind of ['each', 'fan-out']) test(`${kind}: rejection is isolated to one item and the next gate still requires a decision`, async t => {
  const f = await fixture(t);
  const signer = createTestTouchIdAnchor(t, f.dir);
  const driven = await f.start([{ id: 'items', kind, config: { over: '{{inputs.items}}' },
    then: [{ id: 'candidate', kind: 'fetch', config: { url: f.request('candidate').config.url, format: 'text' } },
      review, f.request('blocked')] }], { inputs: { items: { type: 'array', default: ['a', 'b'] } } });
  const run = f.store.load(driven.runId);
  const args = signedReject(f, run, signer);
  const first = await resumeRun(run, args);
  assert.equal(first.status, 'waiting_human');
  assert.equal(first.finishedAt, null);
  assert.deepEqual(first.steps.filter(row => row.stepId === 'review').map(row => row.status), ['rejected', 'waiting_human']);
  assert.deepEqual(first.steps.filter(row => row.stepId === 'blocked').map(row => row.status), ['skipped', 'pending']);
  const second = f.store.load(run.runId);
  await assert.rejects(resumeRun(second, args), /unknown|already used|match/);
  const result = await resumeRun(second, signedReject(f, second, signer));
  assert.equal(result.status, 'rejected');
  assert.match(result.summary, /2 approval\(s\) rejected/);
  assert.deepEqual(f.requests, ['/candidate', '/candidate']);
});

test('reject inside a bounded loop skips its remaining iterations and continues the next branch', async t => {
  const f = await fixture(t);
  const run = await f.start([{ id: 'repeat', kind: 'loop', config: { maxIterations: 2 }, then: [review, f.request('blocked')] },
    branch('second', [f.request('independent')])]);
  const result = await terminalReject(run, f.store);
  assert.equal(result.status, 'rejected');
  assert.deepEqual(result.steps.filter(row => row.stepId === 'review').map(row => row.status), ['rejected', 'skipped']);
  assert.deepEqual(f.requests, ['/independent']);
});

test('nested branch rejection leaves the enclosing branch continuation runnable', async t => {
  const f = await fixture(t);
  const run = await f.start([branch('outer', [branch('inner', [review, f.request('blocked')]), f.request('outer-next')]),
    branch('independent', [f.request('other')])]);
  const result = await terminalReject(run, f.store);
  assert.equal(result.status, 'rejected');
  assert.equal(status(result, 'blocked'), 'skipped');
  assert.deepEqual(f.requests, ['/outer-next', '/other']);
});

test('a rejected nested workflow skips its parent branch after the return without binding absent outputs', async t => {
  const f = await fixture(t);
  const child = document('child', { outputs: { delivery: { type: 'object', value: '{{steps.blocked.output}}' } },
    steps: [review, f.request('blocked')] });
  const bytes = yaml(child);
  writeFileSync(join(f.dir, 'child.yaml'), bytes);
  const doc = document('parent', { dependencies: { child: { kind: 'workflow', id: 'child', version: '1.0.0', path: 'child.yaml', sha256: hash(bytes) } },
    outputs: { delivery: { type: 'object', value: '{{steps.call.output.delivery}}' } }, steps: [
      branch('first', [{ id: 'call', kind: 'workflow-call', config: { ref: 'child' } }, f.request('parent-blocked')]),
      branch('second', [{ id: 'independent', kind: 'fetch', config: { url: f.request('independent').config.url, format: 'text' } }]),
    ] });
  writeFileSync(f.file, yaml(doc));
  const run = await driveRun(createRun(loadWorkflow(f.file)), { store: f.store });
  const result = await terminalReject(run, f.store);
  assert.equal(result.status, 'rejected', result.summary);
  assert.equal(status(result, 'blocked'), 'skipped');
  assert.equal(status(result, 'parent-blocked'), 'skipped');
  const call = result.steps.find(row => row.stepId === 'call');
  assert.equal(call.status, 'rejected');
  assert.equal(call.childStatus, 'rejected');
  assert.equal(call.output, null);
  assert.equal(result.invocations[call.childInvocationId].status, 'rejected');
  assert.equal(result.steps.find(row => row.kind === 'workflow-return').status, 'rejected');
  assert.equal(status(result, 'independent'), 'success');
  assert.deepEqual(f.requests, ['/independent']);
});

test('a real independent branch error still fails the run after a rejection', async t => {
  const f = await fixture(t);
  const run = await f.start([branch('first', [review, f.request('blocked')]), branch('second', [f.request('error')])]);
  const result = await terminalReject(run, f.store);
  assert.equal(result.status, 'failed');
  assert.equal(status(result, 'review'), 'rejected');
  assert.equal(status(result, 'error'), 'failed');
  assert.ok(f.requests.length > 0);
  assert.ok(f.requests.every(url => url === '/error'), 'only the independent failing request may run, including its retries');
});

for (const mutation of ['none', 'signature', 'hash', 'expired', 'snapshot']) test(`signed reject preserves verification and single use: ${mutation}`, async t => {
  const f = await fixture(t);
  const signer = createTestTouchIdAnchor(t, f.dir);
  const driven = await f.start([review, f.request('blocked')]);
  const run = f.store.load(driven.runId);
  const args = signedReject(f, run, signer);
  if (mutation === 'signature') args.confirmation.signature = Buffer.alloc(64).toString('base64');
  if (mutation === 'hash') args.approvalHash = '0'.repeat(64);
  if (mutation === 'expired') t.mock.method(Date, 'now', () => Date.parse(args.confirmation.payload.issued_at) + APPROVAL_TTL_MS);
  if (mutation === 'snapshot') { const changed = f.store.load(run.runId); changed.summary = 'changed'; f.store.save(changed); }
  if (mutation !== 'none') {
    const errors = { signature: /signature is invalid/, hash: /exact subject/, expired: /expired/, snapshot: /persisted run/ };
    await assert.rejects(resumeRun(run, args), errors[mutation]);
    assert.equal(f.store.load(run.runId).status, 'waiting_human');
    assert.equal(f.store.load(run.runId).steps[0].decision, null);
  } else {
    const result = await resumeRun(run, args);
    assert.equal(result.status, 'rejected');
    assert.equal(status(result, 'blocked'), 'skipped');
    await assert.rejects(resumeRun(f.store.load(run.runId), args));
  }
  assert.deepEqual(f.requests, []);
});

test('a hosted rejected run is terminal and allows the next event without approving it', async t => {
  const f = await fixture(t);
  writeFileSync(f.file, yaml(document('host-reject', { enabled: true, triggers: [{ kind: 'manual' }], steps: [review] })));
  const host = createLocalHost({ manifest: f.file, manifestSha256: hash(readFileSync(f.file)) });
  const first = await host.dispatch('manual', 'first');
  assert.equal(first.status, 'waiting_human');
  const rejected = await terminalReject(f.store.load(first.runId), f.store);
  assert.equal(rejected.status, 'rejected');
  const next = await host.dispatch('manual', 'second');
  assert.notEqual(next.runId, first.runId);
  assert.equal(next.status, 'waiting_human');
  assert.equal(f.store.load(next.runId).steps[0].decision, null);
});
