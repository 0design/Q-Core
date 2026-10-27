import assert from 'node:assert/strict';
import test from 'node:test';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestTouchIdAnchor } from './helpers/touchid-anchor.mjs';
import { APPROVAL_TTL_MS, canonicalApprovalPayload, issueApprovalChallenge, consumeAnchorDecision, P256ApprovalAnchor, ApprovalAnchorRegistry, loadApprovalAnchor } from '../src/approval-anchor.mjs';
import { createRun, driveRun, resumeRun, RunStore } from '../src/run.mjs';
import { loadWorkflow } from '../src/workflow-policy.mjs';
import { hash } from '../src/contracts.mjs';
import { deliveryFor } from '../src/approval-delivery.mjs';
import { persistenceEnvironment } from '../src/persistence.mjs';

async function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'q-core-anchor-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const signer = createTestTouchIdAnchor(t, dir);
  const manifestFile = join(dir, 'workflow.yaml');
  writeFileSync(manifestFile, 'manifest: q-core.workflow/v1\nid: anchor-test\nversion: 1.0.0\nsteps:\n  - id: review\n    kind: approval-gate\n    config:\n      reviewer: human\n      bind: sha256\n      anchor: Exact delivery\n');
  const store = new RunStore(manifestFile);
  const driven = await driveRun(createRun(loadWorkflow(manifestFile)), { store });
  const run = store.load(driven.runId);
  const gate = run.steps[0];
  const snapshot = { runId: run.runId, gateId: gate.rowId, runHash: hash(run),
    deliveryHash: hash(deliveryFor(run, gate, store)), environmentHash: hash(persistenceEnvironment(run)) };
  const payload = issueApprovalChallenge(store, snapshot, 'approve');
  const signed = p => ({ channel: 'approval-anchor', anchor_id: 'touchid', decision: p.decision, payload: p, signature: signer.sign(p) });
  const resume = confirmation => resumeRun(run, { decision: confirmation.decision, approvalHash: gate.output.approvalHash, confirmation, store });
  return { dir, store, run, gate, signer, snapshot, payload, signed, resume };
}

test('a registered P-256 signature is verified and permits the exact pending gate', async t => {
  const f = await fixture(t);
  assert.equal(new P256ApprovalAnchor('callback-adapter', f.signer.publicPem).verify(f.signed(f.payload)), true);
  assert.equal((await f.resume(f.signed(f.payload))).status, 'success');
});

test('nonce is single-use even while the same run snapshot is supplied again', async t => {
  const f = await fixture(t);
  const confirmation = f.signed(f.payload);
  await f.store.withRunLock(f.run.runId, () => consumeAnchorDecision(confirmation, f.store, f.snapshot, 'approve'));
  await assert.rejects(f.store.withRunLock(f.run.runId, () => consumeAnchorDecision(confirmation, f.store, f.snapshot, 'approve')), /unknown|already used/);
  assert.equal(f.store.load(f.run.runId).status, 'waiting_human');
});

test('an expired signed nonce refuses the gate', async t => {
  const f = await fixture(t);
  const issued = Date.parse(f.payload.issued_at);
  t.mock.method(Date, 'now', () => issued + APPROVAL_TTL_MS);
  await assert.rejects(f.resume(f.signed(f.payload)), /expired/);
  assert.equal(f.store.load(f.run.runId).status, 'waiting_human');
});

for (const [field, value] of [
  ['content_hash', '0'.repeat(64)], ['run_id', 'another-run'], ['gate_id', 'another-gate'],
  ['decision', 'reject'], ['issued_at', '2026-01-01T00:00:00.000Z'],
]) test(`a valid signature cannot change the issued ${field}`, async t => {
  const f = await fixture(t);
  const changed = { ...f.payload, [field]: value };
  await assert.rejects(f.resume(f.signed(changed)), /match|expired/);
  assert.equal(f.store.load(f.run.runId).status, 'waiting_human');
  assert.equal(f.store.load(f.run.runId).steps[0].decision, null);
});

test('a valid signature from the wrong key refuses the gate', async t => {
  const f = await fixture(t);
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const confirmation = { ...f.signed(f.payload), signature: sign('sha256', Buffer.from(canonicalApprovalPayload(f.payload)), privateKey).toString('base64') };
  await assert.rejects(f.resume(confirmation), /signature is invalid/);
  assert.equal(f.store.load(f.run.runId).status, 'waiting_human');
});

test('a changed persisted run is refused after the native prompt returns', async t => {
  const f = await fixture(t);
  const changed = structuredClone(f.run);
  changed.summary = 'Changed while the person was confirming';
  f.store.save(changed);
  await assert.rejects(f.resume(f.signed(f.payload)), /persisted run/);
  assert.equal(f.store.load(f.run.runId).steps[0].decision, null);
});

test('a signature with an unknown nonce or an unregistered anchor refuses the gate', async t => {
  const f = await fixture(t);
  const unknown = f.signed({ ...f.payload, nonce: '0'.repeat(64) });
  await assert.rejects(f.resume(unknown), /unknown|already used/);
  await assert.rejects(f.resume({ ...f.signed(f.payload), anchor_id: 'client-supplied' }), /not registered/);
  assert.equal(f.store.load(f.run.runId).status, 'waiting_human');
});

test('a public-key registration cannot contain a private key or client verifier', async t => {
  const f = await fixture(t);
  const path = join(f.dir, '.q-core', 'approvers', 'touchid.json');
  const record = JSON.parse(readFileSync(path, 'utf8'));
  writeFileSync(path, JSON.stringify({ ...record, verify: true }));
  await assert.rejects(f.resume(f.signed(f.payload)), /registration/);
});


test('a caller-created registry cannot register an anchor in the production gate', async t => {
  const f = await fixture(t);
  const registry = new ApprovalAnchorRegistry().register({ id: 'untrusted-callback', verify: () => true });
  assert.equal(registry.get('untrusted-callback').verify({}), true);
  assert.throws(() => loadApprovalAnchor('untrusted-callback'), /not registered/);
  await assert.rejects(f.resume({ ...f.signed(f.payload), anchor_id: 'untrusted-callback' }), /not registered/);
  assert.equal(f.store.load(f.run.runId).status, 'waiting_human');
});
