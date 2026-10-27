// Controlled, disposable fixtures ONLY. The parent starts a test process with an
// explicit fixture environment to exercise the human-host branch. No real user,
// real credentials, existing workspace, Telegram transport or external receiver.
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, symlinkSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createLocalHost } from '../../src/host.mjs';
import { RunStore } from '../../src/state.mjs';
import { driveRun } from '../../src/run.mjs';
import { canonical, hash } from '../../src/contracts.mjs';
import { registerPersistenceSecret, guardedStreamWrite } from '../../src/persistence.mjs';
import { enrollRemoteHumanProvider, requestRemoteHumanDecision, consumeRemoteHumanDecision, resumeRemoteHumanWorkflow } from '../../src/remote-human-host.mjs';
import { acquireWorkflowLease } from '../../src/workflow-lease.mjs';

const scenario = process.argv[2];
const nativeExecution = scenario.startsWith('native-');
const at = n => nativeExecution ? Date.now() - 5000 + n : n;
const root = mkdtempSync(join(tmpdir(), 'qf-remote-fixture-'));
const file = join(root, 'workflow.yaml'), sink = join(root, 'fixture.jsonl');
const laterSink = join(root, 'later.jsonl');
const sourceText = 'Disposable fixture source; never a customer draft or live approval.';
const server = createServer((req, res) => res.end(sourceText));
const io = { env: {}, stdinIsTTY: true, stdoutIsTTY: true, code: 'ABC234',
  openTerminal: () => ({ write() {}, readLine: () => 'ABC234', close() {} }) };
let probes = 0;
const rejects = (fn, code) => { assert.throws(fn, error => !code || error.code === code); probes++; };
try {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  writeFileSync(file, `manifest: q-core.workflow/v1\nid: remote-fixture\nname: Remote fixture\nversion: 1.0.0\nowner: test\nenabled: true\ntriggers:\n  - kind: manual\nsteps:\n  - id: source\n    kind: fetch\n    config:\n      url: "http://127.0.0.1:${server.address().port}/"\n      format: text\n  - id: human_review\n    kind: approval-gate\n    config:\n      reviewer: human\n      bind: sha256\n  - id: local_receipt\n    kind: api-request\n    config:\n      url: "file://${sink}"\n      receiptKey: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n`);
  if (['native-interrupted','native-expiry-between-steps'].includes(scenario))
    writeFileSync(file, readFileSync(file, 'utf8') + `  - id: later_receipt\n    kind: api-request\n    config:\n      url: "file://${laterSink}"\n      receiptKey: bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\n`);
  const caller = ['native-inference','native-expired-inference','native-ordinary-writers'].includes(scenario);
  if (caller) writeFileSync(file, readFileSync(file, 'utf8').replace('steps:\n', 'settings:\n  budgetUsd: null\nsteps:\n')
    .replace('  - id: local_receipt\n', '  - id: followup\n    kind: llm-call\n    config:\n      provider: cli\n      instructions: "Return synthetic fixture text only."\n      format: text\n  - id: local_receipt\n'));
  const pair = generateKeyPairSync('ed25519');
  const policy = { publicKey: pair.publicKey.export({ type: 'spki', format: 'pem' }),
    endpoint: 'https://approval.example.test/', reviewerId: '12345678', chatId: '-100123456789', manifestHash: hash(readFileSync(file)) };
  const store = new RunStore(file), policyFile = join(store.dir, 'remote-human-provider.json');
  if (scenario === 'agent-refusal') {
    rejects(() => enrollRemoteHumanProvider(file, policy, io), 'HUMAN_CONFIRMATION_REQUIRED');
    rejects(() => consumeRemoteHumanDecision(file, randomUUID(), '{}'), 'HUMAN_CONFIRMATION_REQUIRED');
    await assert.rejects(resumeRemoteHumanWorkflow(join(root, 'never-read.yaml'), randomUUID()), error => error.code === 'HUMAN_CONFIRMATION_REQUIRED'); probes++;
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
    const hosted = await createLocalHost({ manifest: file, manifestSha256: policy.manifestHash,
      ...(caller ? { callerProvider: { kind: 'caller', agent: 'codex', model: 'fixture', payerScope: 'local-cli' } } : {}) }).dispatch('manual', 'fixture');
    assert.equal(hosted.status, 'waiting_human'); probes++;
    const runId = hosted.runId, runFile = store.runFile(runId);
    const request = requestRemoteHumanDecision(file, runId, { nowMs: at(1000), ttlMs: nativeExecution ? 60000 : 10000 });
    const snapshot = readFileSync(runFile, 'utf8');
    assert.deepEqual(requestRemoteHumanDecision(file, runId, { nowMs: at(2000) }), request); probes++;
    assert.equal(readFileSync(runFile, 'utf8'), snapshot); probes++;
    const receipt = (decision = 'approve', req = request) => {
      const { issuedAt, requestHash, ...fields } = req;
      const body = { ...fields, protocol: 'qf.remote-human-receipt/v1', requestHash,
        receiptId: randomUUID(), decision, decidedAt: at(2000) };
      return canonical({ body, signature: sign(null, Buffer.from(canonical(body)), pair.privateKey).toString('base64') });
    };
    if (nativeExecution) {
      const signed = receipt(scenario === 'native-reject' ? 'reject' : 'approve');
      consumeRemoteHumanDecision(file, runId, signed, { nowMs: at(2500) });
      const consumed = readFileSync(runFile, 'utf8');
      const resume = options => resumeRemoteHumanWorkflow(file, runId, options);
      if (scenario === 'native-mutations') {
        for (const change of [run => { run.summary = 'unexpected revision'; },
          run => { run.remoteHuman.receiptJson = '{}'; }, run => { run.remoteHuman.evidence.decision = 'reject'; },
          run => { run.remoteHuman.checkpointHash = 'f'.repeat(64); }, run => { delete run.remoteHuman.receiptJson; },
          run => { run.steps[1].confirmation.channel = 'imported-json'; }, run => { run.remoteHuman.execution = false; }]) {
          const changed = JSON.parse(consumed); change(changed); const bytes = JSON.stringify(changed); writeFileSync(runFile, bytes);
          await assert.rejects(resume()); assert.equal(readFileSync(runFile, 'utf8'), bytes); probes += 2;
          assert.equal(existsSync(sink), false); writeFileSync(runFile, consumed);
        }
      } else if (scenario === 'native-expired') {
        await assert.rejects(resume({ clock: () => request.expiresAt }), error => error.code === 'REMOTE_APPROVAL_INVALID'); probes++;
        assert.equal(readFileSync(runFile, 'utf8'), consumed); assert.equal(existsSync(sink), false); probes += 2;
      } else if (scenario === 'native-preflight') {
        const stopped = async () => { throw Error('fixture current-source/STOP hold'); };
        for (let i=0;i<2;i++) await assert.rejects(resume({ beforeStep: stopped }), /fixture current-source\/STOP hold/);
        const current = store.load(runId); assert.equal(current.steps[2].status, 'pending'); probes += 3;
        assert.equal(existsSync(sink), false); probes++;
      } else if (scenario === 'native-interrupted') {
        const current = store.load(runId); current.steps[2].status = 'running';
        const { remoteHuman, ...rest } = current; current.remoteHuman.checkpointHash = hash(rest);
        store.save(current); // Explicit corruption/crash simulation in this NEW fixture only.
        const result = await resume(); assert.equal(result.status, 'needs_human'); probes++;
        assert.equal(existsSync(sink), false); assert.equal(existsSync(laterSink), false); probes += 2;
        assert.equal((await resume()).executionResumed, false); probes++;
      } else if (scenario === 'native-expiry-between-steps') {
        let clock = request.expiresAt - 2;
        await assert.rejects(resume({ clock: () => clock, beforeStep: async () => { clock=request.expiresAt; } }),
          error => error.code === 'REMOTE_APPROVAL_INVALID'); probes++;
        assert.equal(existsSync(sink), false); probes++;
        assert.equal(existsSync(laterSink), false); probes++;
        assert.equal(store.load(runId).steps[2].status, 'pending'); probes++;
        assert.equal(store.load(runId).steps[3].status, 'pending'); probes++;
      } else if (scenario === 'native-enrollment-during-preflight') {
        const original = readFileSync(policyFile, 'utf8');
        await assert.rejects(resume({ beforeStep: async () => {
          await Promise.resolve();
          const changed = JSON.parse(original); changed.enrollmentId = randomUUID();
          writeFileSync(policyFile, JSON.stringify(changed));
        } }), error => error.code === 'REMOTE_APPROVAL_INVALID'); probes++;
        assert.equal(existsSync(sink), false); assert.equal(store.load(runId).steps[2].status, 'pending'); probes += 2;
        writeFileSync(policyFile, original);
      } else if (caller) {
        assert.equal((await resume()).status, 'waiting_inference'); probes++;
        const paused = readFileSync(runFile, 'utf8'), job = store.load(runId).pendingInference;
        const reply = { jobId: job.jobId, hash: job.hash, output: { text: 'Synthetic fixture continuation.' } };
        assert.equal((await resume()).executionResumed, false); assert.equal(readFileSync(runFile, 'utf8'), paused); probes += 2;
        if (scenario === 'native-ordinary-writers') {
          for (const record of [snapshot, consumed, paused,
            ...[null, false, {}].map(remoteHuman => JSON.stringify({ ...JSON.parse(paused), remoteHuman }))]) {
            writeFileSync(runFile, record);
            for (const command of ['reply','clarify','resume']) {
              const child = spawnSync(process.execPath, [new URL('../../bin/q-core.mjs', import.meta.url).pathname,
                command, file, runId, join(root, 'must-not-read.json'), '--json'],
                { env: { PATH: process.env.PATH, AI_AGENT: 'disposable-fixture' }, encoding: 'utf8', timeout: 5000 });
              assert.equal(child.status, 1, child.stderr); assert.match(child.stderr, /Native-owned run/);
              assert.equal(readFileSync(runFile, 'utf8'), record); assert.equal(existsSync(sink), false); probes += 2;
            }
          }
          writeFileSync(runFile, paused);
          const child = spawnSync(process.execPath, [new URL('../../bin/q-core.mjs', import.meta.url).pathname,
            'cancel', file, runId, '--json'], { env: { PATH: process.env.PATH, AI_AGENT: 'disposable-fixture' }, encoding: 'utf8', timeout: 5000 });
          assert.equal(child.status, 130, child.stderr); assert.equal(store.load(runId).status, 'cancelled'); probes += 2;
          await assert.rejects(resume()); assert.equal(existsSync(sink), false); probes += 2;
          // approve is never invoked from an agent, even on this fixture. Verify
          // its early ownership refusal precedes terminal interaction in source.
          const cli = readFileSync(new URL('../../bin/q-workflow.mjs', import.meta.url), 'utf8');
          const approve = cli.slice(cli.indexOf('async function cmdApprove('), cli.indexOf('/* ── catalog'));
          assert.ok(approve.indexOf('refuseNativeContinuation(run)') > 0);
          assert.ok(approve.indexOf('refuseNativeContinuation(run)') < approve.indexOf('confirmHumanDecision(')); probes += 2;
        } else if (scenario === 'native-expired-inference') {
          await assert.rejects(resume({ inferenceReply: reply, clock: () => request.expiresAt }), error => error.code === 'REMOTE_APPROVAL_INVALID');
          assert.equal(readFileSync(runFile, 'utf8'), paused); assert.equal(existsSync(sink), false); probes += 3;
        } else {
          for (const bad of [{ ...reply, jobId: randomUUID() }, { ...reply, hash: 'f'.repeat(64) },
            { ...reply, extra: true }, { ...reply, output: null }, { ...reply, output: { text: 17 } },
            { ...reply, output: { text: ' ' } }, { ...reply, output: {} },
            { ...reply, output: { text: 'fixture', extra: true } }]) {
            await assert.rejects(resume({ inferenceReply: bad }));
            assert.equal(readFileSync(runFile, 'utf8'), paused); assert.equal(existsSync(sink), false); probes += 3;
          }
          assert.equal((await resume({ inferenceReply: reply })).status, 'success'); probes++;
          assert.equal(readFileSync(sink, 'utf8').trim().split('\n').length, 1); probes++;
          await assert.rejects(resume({ inferenceReply: reply }), error => error.code === 'STALE_INFERENCE'); probes++;
          assert.equal((await resume()).executionResumed, false); probes++;
          assert.equal(readFileSync(sink, 'utf8').trim().split('\n').length, 1); probes++;
        }
      } else if (scenario === 'native-legacy-locks') {
        const lease = acquireWorkflowLease(file);
        try {
          for (const command of ['run','reply','clarify','cancel','resume']) {
            const child = spawnSync(process.execPath, [new URL('../../bin/q-core.mjs', import.meta.url).pathname,
              command, file, runId, join(root,'unused.json'), '--json'],
              { env: { PATH: process.env.PATH }, encoding: 'utf8', timeout: 5000 });
            assert.equal(child.status, 1, child.stderr); assert.match(child.stderr, /Workspace already locked/);
            assert.equal(readFileSync(runFile, 'utf8'), consumed); probes++;
          }
          await assert.rejects(createLocalHost({ manifest:file,manifestSha256:policy.manifestHash }).dispatch('manual','overlap'), error => error.code === 'WORKSPACE_LOCKED'); probes++;
          await assert.rejects(resume(), error => error.code === 'WORKSPACE_LOCKED'); probes++;
        } finally { lease.release(); }
        assert.equal(existsSync(sink), false); probes++;
      } else if (scenario === 'native-overlap') {
        let preflight = 0;
        const result = await resume({ beforeStep: async () => {
          preflight++;
          await assert.rejects(resume(), error => error.code === 'WORKSPACE_LOCKED');
          rejects(() => requestRemoteHumanDecision(file, runId), 'WORKSPACE_LOCKED');
          await assert.rejects(createLocalHost({ manifest:file,manifestSha256:policy.manifestHash }).dispatch('manual','overlap'), error => error.code === 'WORKSPACE_LOCKED');
          probes += 2;
        } });
        assert.equal(preflight, 1); assert.equal(result.status, 'success'); probes += 2;
        assert.equal(readFileSync(sink, 'utf8').trim().split('\n').length, 1); probes++;
      } else if (scenario === 'native-restart') {
        const code = `import {resumeRemoteHumanWorkflow} from ${JSON.stringify(new URL('../../src/remote-human-host.mjs', import.meta.url).href)};
          const result=await resumeRemoteHumanWorkflow(process.argv[1],process.argv[2]);process.stdout.write(JSON.stringify(result));`;
        for (let i=0;i<2;i++) {
          // Only the newly allocated disposable manifest/run is passed onward.
          const child=spawnSync(process.execPath,['--input-type=module','-e',code,file,runId],
            {env:{PATH:process.env.PATH},encoding:'utf8',timeout:10000});
          assert.equal(child.status,0,child.stderr);assert.equal(JSON.parse(child.stdout).status,'success');probes++;
        }
        assert.equal(readFileSync(sink,'utf8').trim().split('\n').length,1);probes++;
      } else {
        const result = await resume(); assert.equal(result.status, scenario === 'native-reject' ? 'failed' : 'success'); probes++;
        assert.equal(result.executionResumed, scenario !== 'native-reject'); probes++;
        const first = existsSync(sink) ? readFileSync(sink, 'utf8') : null;
        const repeat = await resume({ clock: () => request.expiresAt + 1 });
        assert.equal(repeat.executionResumed, false); probes++;
        assert.equal(existsSync(sink) ? readFileSync(sink, 'utf8') : null, first); probes++;
        if (scenario !== 'native-reject') assert.equal(first.trim().split('\n').length, 1);
      }
    } else if (['approve','reject'].includes(scenario)) {
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
      for (const invalid of [null, false, 0, '', true, 1, [], {}, { ...JSON.parse(snapshot).remoteHuman, extra: true }])
        for (const nowMs of [2500, 12000]) {
          const changed = JSON.parse(snapshot); changed.remoteHuman = invalid; const bytes = JSON.stringify(changed);
          writeFileSync(runFile, bytes);
          rejects(() => requestRemoteHumanDecision(file, runId, { nowMs }), 'REMOTE_APPROVAL_INVALID');
          rejects(() => consumeRemoteHumanDecision(file, runId, receipt(), { nowMs }), 'REMOTE_APPROVAL_INVALID');
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
      const lock = join(store.dir, 'workflow.lock'); writeFileSync(lock, 'interrupted');
      rejects(() => consumeRemoteHumanDecision(file, runId, receipt(), { nowMs: 2500 }), 'WORKSPACE_LOCKED');
      assert.equal(readFileSync(runFile, 'utf8'), snapshot); probes++;
    }
  }
  guardedStreamWrite(process.stdout, JSON.stringify({ scenario, passed: true, probes }) + '\n');
} finally {
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  rmSync(root, { recursive: true, force: true });
}
