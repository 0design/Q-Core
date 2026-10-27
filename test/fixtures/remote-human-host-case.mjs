// Controlled, disposable fixtures ONLY. The parent starts a test process with an
// explicit fixture environment to exercise the human-host branch. No real user,
// real credentials, existing workspace, Telegram transport or external receiver.
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, symlinkSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { createLocalHost } from '../../src/host.mjs';
import { RunStore } from '../../src/state.mjs';
import { driveRun } from '../../src/run.mjs';
import { canonical, hash } from '../../src/contracts.mjs';
import { registerPersistenceSecret, guardedStreamWrite } from '../../src/persistence.mjs';
import { enrollRemoteHumanProvider, requestRemoteHumanDecision, consumeRemoteHumanDecision } from '../../src/remote-human-host.mjs';

const scenario = process.argv[2];
const root = mkdtempSync(join(tmpdir(), 'qf-remote-fixture-'));
const file = join(root, 'workflow.yaml'), sink = join(root, 'fixture.jsonl');
const sourceText = 'Disposable fixture source; never a customer draft or live approval.';
const server = createServer((req, res) => res.end(sourceText));
const io = { env: {}, stdinIsTTY: true, stdoutIsTTY: true, code: 'ABC234',
  openTerminal: () => ({ write() {}, readLine: () => 'ABC234', close() {} }) };
let probes = 0;
const rejects = (fn, code) => { assert.throws(fn, error => !code || error.code === code); probes++; };
try {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  writeFileSync(file, `manifest: q-core.workflow/v1\nid: remote-fixture\nname: Remote fixture\nversion: 1.0.0\nowner: test\nenabled: true\ntriggers:\n  - kind: manual\nsteps:\n  - id: source\n    kind: fetch\n    config:\n      url: "http://127.0.0.1:${server.address().port}/"\n      format: text\n  - id: human_review\n    kind: approval-gate\n    config:\n      reviewer: human\n      bind: sha256\n  - id: local_receipt\n    kind: api-request\n    config:\n      url: "file://${sink}"\n      receiptKey: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n`);
  const pair = generateKeyPairSync('ed25519');
  const policy = { publicKey: pair.publicKey.export({ type: 'spki', format: 'pem' }),
    endpoint: 'https://approval.example.test/', reviewerId: '12345678', chatId: '-100123456789', manifestHash: hash(readFileSync(file)) };
  const store = new RunStore(file), policyFile = join(store.dir, 'remote-human-provider.json');
  if (scenario === 'agent-refusal') {
    rejects(() => enrollRemoteHumanProvider(file, policy, io), 'HUMAN_CONFIRMATION_REQUIRED');
    rejects(() => consumeRemoteHumanDecision(file, randomUUID(), '{}'), 'HUMAN_CONFIRMATION_REQUIRED');
    assert.equal(existsSync(policyFile), false); probes++;
  } else {
    if (scenario === 'enrollment') {
      rejects(() => enrollRemoteHumanProvider(file, policy, { ...io, openTerminal: () => ({ write() {}, readLine: () => 'WRONG', close() {} }) }), 'HUMAN_CONFIRMATION_REQUIRED');
      assert.equal(existsSync(policyFile), false); probes++;
      for (const delta of [{ manifestHash: 'a'.repeat(64) }, { endpoint: 'http://approval.example.test/' },
        { endpoint: 'https://approval.example.test/?token=bad' }, { reviewerId: '0' }, { extra: 'untrusted' }])
        rejects(() => enrollRemoteHumanProvider(file, { ...policy, ...delta }, io));
    }
    enrollRemoteHumanProvider(file, policy, io);
    const hosted = await createLocalHost({ manifest: file, manifestSha256: policy.manifestHash }).dispatch('manual', 'fixture');
    assert.equal(hosted.status, 'waiting_human'); probes++;
    const runId = hosted.runId, runFile = store.runFile(runId);
    const request = requestRemoteHumanDecision(file, runId, { nowMs: 1000, ttlMs: 10000 });
    const snapshot = readFileSync(runFile, 'utf8');
    assert.deepEqual(requestRemoteHumanDecision(file, runId, { nowMs: 2000 }), request); probes++;
    assert.equal(readFileSync(runFile, 'utf8'), snapshot); probes++;
    const receipt = (decision = 'approve', req = request) => {
      const { issuedAt, requestHash, ...fields } = req;
      const body = { ...fields, protocol: 'qf.remote-human-receipt/v1', requestHash,
        receiptId: randomUUID(), decision, decidedAt: 2000 };
      return canonical({ body, signature: sign(null, Buffer.from(canonical(body)), pair.privateKey).toString('base64') });
    };
    if (['approve','reject'].includes(scenario)) {
      const signed = receipt(scenario);
      const result = consumeRemoteHumanDecision(file, runId, signed, { nowMs: 2500 });
      assert.equal(result.authorizationApplied, true); assert.equal(result.effectExecuted, false); probes += 2;
      const committed = new RunStore(file).load(runId), gate = committed.steps[1];
      assert.equal(committed.remoteHuman.phase, 'consumed'); assert.equal(gate.decision, scenario); probes += 2;
      assert.equal(existsSync(sink), false); probes++;
      // Both same-ID replay and a second legitimate signature for this challenge
      // fail after a fresh disk load. No receipt-ID-only replay ledger shortcut.
      rejects(() => consumeRemoteHumanDecision(file, runId, signed, { nowMs: 2600 }), 'REMOTE_APPROVAL_INVALID');
      rejects(() => consumeRemoteHumanDecision(file, runId, receipt(scenario), { nowMs: 2600 }), 'REMOTE_APPROVAL_INVALID');
      if (scenario === 'approve') {
        // Explicit fixture-only driver after a simulated stop at the commit.
        // Proves compatibility and a local effect; it is not an installed host.
        const resumed = await driveRun(committed, { store, knobs: committed.executionKnobs });
        assert.equal(resumed.status, 'success', resumed.summary); probes++;
        const first = readFileSync(sink, 'utf8'); assert.equal(first.trim().split('\n').length, 1); probes++;
        await driveRun(new RunStore(file).load(runId), { store });
        assert.equal(readFileSync(sink, 'utf8'), first); probes++;
      } else { assert.equal(committed.status, 'failed'); probes++; }
    } else if (scenario === 'mutations') {
      for (const change of [run => { run.steps[0].output = 'edited'; },
        run => { run.steps[2].config.url = 'https://another.example.test/'; },
        run => { run.callerProvider = { kind: 'caller', model: 'swapped' }; },
        run => { run.status = 'cancelled'; }, run => { run.hostEvent.manifestSha256 = 'f'.repeat(64); }]) {
        const changed = JSON.parse(snapshot); change(changed); const bytes = JSON.stringify(changed);
        writeFileSync(runFile, bytes);
        rejects(() => consumeRemoteHumanDecision(file, runId, receipt(), { nowMs: 2500 }));
        assert.equal(readFileSync(runFile, 'utf8'), bytes); probes++;
        writeFileSync(runFile, snapshot);
      }
      const manifest = readFileSync(file, 'utf8'); writeFileSync(file, manifest + '\n# changed\n');
      rejects(() => consumeRemoteHumanDecision(file, runId, receipt(), { nowMs: 2500 }));
      writeFileSync(file, manifest);
      enrollRemoteHumanProvider(file, policy, io);
      rejects(() => consumeRemoteHumanDecision(file, runId, receipt(), { nowMs: 2500 }), 'REMOTE_APPROVAL_INVALID');
    } else if (scenario === 'cached-corruption') {
      const edits = [state => { state.protocol = 'wrong'; },
        state => { state.request.approvalHash = 'f'.repeat(64); },
        state => { state.request.runId = randomUUID(); }, state => { state.request.nonce = '0'.repeat(64); },
        state => { state.request.requestHash = 'a'.repeat(64); }, state => { state.request.expiresAt = '11000'; },
        state => { state.request.protocol = 'wrong'; }, state => { state.request.extra = true; },
        state => { state.request = null; }, state => {
          // A self-consistent request hash still cannot change its gate binding.
          state.request.approvalHash = 'f'.repeat(64);
          const { requestHash, ...body } = state.request; state.request.requestHash = hash(body);
        }];
      for (const edit of edits) for (const nowMs of [2500, 12000]) {
        const changed = JSON.parse(snapshot); edit(changed.remoteHuman); const bytes = JSON.stringify(changed);
        writeFileSync(runFile, bytes);
        rejects(() => requestRemoteHumanDecision(file, runId, { nowMs }), 'REMOTE_APPROVAL_INVALID');
        assert.equal(readFileSync(runFile, 'utf8'), bytes); probes++;
        assert.equal(existsSync(sink), false); probes++;
        writeFileSync(runFile, snapshot);
      }
    } else if (scenario === 'expiration') {
      rejects(() => consumeRemoteHumanDecision(file, runId, receipt(), { nowMs: 11000 }), 'REMOTE_APPROVAL_INVALID');
      rejects(() => requestRemoteHumanDecision(file, runId, { nowMs: 999 }));
      const next = requestRemoteHumanDecision(file, runId, { nowMs: 11000, ttlMs: 10000 });
      assert.notEqual(next.requestId, request.requestId); probes++;
      rejects(() => consumeRemoteHumanDecision(file, runId, receipt(), { nowMs: 11500 }), 'REMOTE_APPROVAL_INVALID');
    } else if (scenario === 'failed-write') {
      registerPersistenceSecret(sourceText);
      rejects(() => consumeRemoteHumanDecision(file, runId, receipt(), { nowMs: 2500 }));
      assert.equal(readFileSync(runFile, 'utf8'), snapshot); probes++;
      assert.equal(existsSync(sink), false); probes++;
    } else if (scenario === 'symlinks-lock') {
      const outside = join(root, 'outside.json'); writeFileSync(outside, snapshot);
      unlinkSync(runFile); symlinkSync(outside, runFile);
      rejects(() => consumeRemoteHumanDecision(file, runId, receipt(), { nowMs: 2500 }));
      assert.equal(readFileSync(outside, 'utf8'), snapshot); probes++;
      unlinkSync(runFile); writeFileSync(runFile, snapshot);
      const lock = join(store.dir, 'agent.lock'); writeFileSync(lock, 'interrupted');
      rejects(() => consumeRemoteHumanDecision(file, runId, receipt(), { nowMs: 2500 }), 'WORKSPACE_LOCKED');
      assert.equal(readFileSync(runFile, 'utf8'), snapshot); probes++;
    }
  }
  guardedStreamWrite(process.stdout, JSON.stringify({ scenario, passed: true, probes }) + '\n');
} finally {
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  rmSync(root, { recursive: true, force: true });
}
