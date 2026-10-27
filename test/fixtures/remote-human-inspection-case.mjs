// Fresh disposable authority fixture only. No existing run/key or live endpoint.
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { canonical, hash } from '../../src/contracts.mjs';
import { createLocalHost } from '../../src/host.mjs';
import { RunStore } from '../../src/state.mjs';
import { enrollRemoteHumanProvider, requestRemoteHumanDecision, consumeRemoteHumanDecision,
  resumeRemoteHumanWorkflow, inspectRemoteHumanExecution } from '../../src/remote-human-host.mjs';

let probes = 0;
const root = mkdtempSync(join(tmpdir(), 'qf-native-inspection-fixture-'));
const file = join(root, 'workflow.yaml');
if (process.env.AI_AGENT) {
  try {
    assert.throws(() => inspectRemoteHumanExecution(join(root, 'never-read'), randomUUID()), e => e.code === 'HUMAN_CONFIRMATION_REQUIRED');
    assert.deepEqual(await import('node:fs').then(fs => fs.readdirSync(root)), []);
    console.log(JSON.stringify({ passed: true, probes: 2 }));
  } finally { rmSync(root, { recursive: true, force: true }); }
} else {
  let runId, request, receipt, received = 0, failures = [];
  const store = new RunStore(file);
  const rejects = fn => { const before = readFileSync(store.runFile(runId)); assert.throws(fn);
    assert.deepEqual(readFileSync(store.runFile(runId)), before); probes++; };
  const server = createServer((req, res) => {
    if (req.method === 'GET') return res.end('Synthetic inspection source');
    try {
      const before = readFileSync(store.runFile(runId));
      const proof = inspectRemoteHumanExecution(file, runId);
      assert.equal(proof.protocol, 'qf.remote-human-execution/v1');
      assert.equal(proof.requestId, request.requestId); assert.equal(proof.requestHash, request.requestHash);
      assert.equal(proof.approvalHash, request.approvalHash); assert.equal(proof.receiptHash, hash(receipt));
      assert.equal(proof.step.kind, 'api-request'); assert.equal(proof.step.stepId, 'publish');
      assert.equal(proof.step.final, true); assert.equal(proof.leasePid, process.pid);
      assert.equal(typeof proof.executionId, 'string'); assert.ok(proof.checkpointHash);
      assert.deepEqual(readFileSync(store.runFile(runId)), before); probes += 6;
      rejects(() => inspectRemoteHumanExecution(file, runId, { nowMs: request.expiresAt }));
      const original = readFileSync(store.runFile(runId), 'utf8');
      const corrupt = JSON.parse(original); corrupt.remoteHuman.evidence.decision = 'reject';
      writeFileSync(store.runFile(runId), JSON.stringify(corrupt));
      rejects(() => inspectRemoteHumanExecution(file, runId));
      writeFileSync(store.runFile(runId), original);
      received++; res.end(JSON.stringify({ received: true }));
    } catch (error) { failures.push(error); res.statusCode = 500; res.end('{}'); }
  });
  try {
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    writeFileSync(file, `manifest: q-core.workflow/v1\nid: native-inspection-fixture\nname: Native inspection fixture\nversion: 1.0.0\nowner: fixture\nenabled: true\ntriggers:\n  - kind: manual\nsteps:\n  - id: source\n    kind: fetch\n    config:\n      url: "http://127.0.0.1:${server.address().port}/source"\n      format: text\n  - id: review\n    kind: approval-gate\n    config:\n      reviewer: human\n      bind: sha256\n  - id: publish\n    kind: api-request\n    config:\n      url: "http://127.0.0.1:${server.address().port}/publish"\n      body: "{}"\n      receiptKey: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n`);
    assert.throws(() => inspectRemoteHumanExecution(file, randomUUID()));
    assert.equal(existsSync(store.dir), false); probes += 2;
    const pair = generateKeyPairSync('ed25519');
    const policy = { publicKey: pair.publicKey.export({ type: 'spki', format: 'pem' }), endpoint: 'https://approval.example.test/',
      reviewerId: '12345678', chatId: '-100123456789', manifestHash: hash(readFileSync(file)) };
    const io = { env: {}, stdinIsTTY: true, stdoutIsTTY: true, code: 'ABC234',
      openTerminal: () => ({ write() {}, readLine: () => 'ABC234', close() {} }) };
    enrollRemoteHumanProvider(file, policy, io);
    runId = (await createLocalHost({ manifest: file, manifestSha256: policy.manifestHash }).dispatch('manual', 'new-fixture')).runId;
    request = requestRemoteHumanDecision(file, runId);
    rejects(() => inspectRemoteHumanExecution(file, runId));
    const { issuedAt, requestHash, ...fields } = request;
    const body = { ...fields, requestHash, protocol: 'qf.remote-human-receipt/v1', receiptId: randomUUID(), decision: 'approve', decidedAt: Date.now() };
    receipt = canonical({ body, signature: sign(null, Buffer.from(canonical(body)), pair.privateKey).toString('base64') });
    consumeRemoteHumanDecision(file, runId, receipt);
    rejects(() => inspectRemoteHumanExecution(file, runId));
    const result = await resumeRemoteHumanWorkflow(file, runId, { beforeStep: () => rejects(() => inspectRemoteHumanExecution(file, runId)) });
    if (failures.length) throw failures[0];
    assert.equal(result.status, 'success'); assert.equal(received, 1); probes += 2;
    rejects(() => inspectRemoteHumanExecution(file, runId));
    console.log(JSON.stringify({ passed: true, probes, actual_local_HTTP_effect: 1, social_posted: false }));
  } finally { server.closeAllConnections(); await new Promise(r => server.close(r)); rmSync(root, { recursive: true, force: true }); }
}
