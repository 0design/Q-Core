import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, copyFileSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadManifest } from '../src/manifest.mjs';
import { createRun, driveRun, resumeRun, RunStore } from '../src/run.mjs';
const callerProvider = { kind: 'caller', agent: 'codex', model: 'test-double', payerScope: 'local-cli' };
const spec = { summary: 'Return sum', criteria: ['sum(2,3) equals 5'], plan: ['Update sum.mjs', 'Run independent verifier'] };

test('Registry SDD manifest preserves spec approval, repairs a real failed file and rejects verifier mutation', async () => {
  const root = mkdtempSync(join(tmpdir(), 'qf-registry-sdd-')), file = join(root, 'sdd.yaml');
  copyFileSync(new URL('../registry/loops/sdd-pipeline.yaml', import.meta.url), file);
  writeFileSync(join(root, 'sum.mjs'), 'export const sum=(a,b)=>a-b;');
  writeFileSync(join(root, 'verify.mjs'), 'import assert from "node:assert/strict"; import {sum} from "./sum.mjs"; assert.equal(sum(2,3),5);');
  const manifest = loadManifest(file), store = new RunStore(file);
  const policy = { workspace: root, allowedPaths: ['sum.mjs'], intent: 'Make sum add two numbers', maxRepairAttempts: 1, verifier: { command: process.execPath, args: ['verify.mjs'], timeoutMs: 5000 } };
  const opts = { store, callerProvider, settings: manifest.settings };
  async function answer(run, output) {
    const job = run.pendingInference;
    return driveRun(run, { ...opts, inferenceReply: { jobId: job.jobId, hash: job.hash, output: { text: JSON.stringify(output) } } });
  }
  async function start(overrides = {}) {
    const run = createRun(manifest); run.workspacePolicy = { ...policy, ...overrides };
    await driveRun(run, opts); assert.equal(run.status, 'waiting_inference');
    await answer(run, spec); assert.equal(run.status, 'waiting_human');
    return run;
  }
  async function approve(run) { const gate = run.steps.find(s => s.status === 'waiting_human'); await resumeRun(run, { ...opts, decision: 'approve', approvalHash: gate.output.approvalHash }); }
  try {
    const run = await start();
    await approve(run);
    await answer(run, { files: [{ path: 'sum.mjs', content: 'export const sum=(a,b)=>a*b;' }] });
    assert.equal(run.status, 'waiting_inference');
    assert.equal(run.repairAttempt, 1);
    assert.equal(run.repairHistory[0].outcome, 'fail');
    await answer(run, { files: [{ path: 'sum.mjs', content: 'export const sum=(a,b)=>a+b;' }] });
    assert.equal(run.status, 'success');
    assert.equal(run.steps.at(-1).output.outcome, 'pass');
    assert.equal(run.steps.at(-1).output.revision, 2);
    const firstRevision = run.steps.find(s => s.kind === 'specification').output.revision;
    const changed = await start({ intent: 'Add two numbers, including zero' });
    assert.equal(changed.steps.find(s => s.kind === 'specification').output.revision, firstRevision + 1);
    await approve(changed);
    writeFileSync(join(root, 'verify.mjs'), 'process.exit(0);');
    await answer(changed, { files: [{ path: 'sum.mjs', content: 'export const sum=(a,b)=>0;' }] });
    assert.equal(changed.status, 'failed');
    assert.match(changed.summary, /Verifier source changed/);
    assert.match(readFileSync(join(root, 'sum.mjs'), 'utf8'), /a\+b/);
    await driveRun(run, opts);
    assert.equal(run.status, 'needs_human');
    assert.match(run.summary, /stale/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('failed verification reaches needs_human at zero repair bound and a direct drive cannot bypass approval', async () => {
  const root = mkdtempSync(join(tmpdir(), 'qf-registry-limit-')), file = join(root, 'sdd.yaml');
  copyFileSync(new URL('../registry/loops/sdd-pipeline.yaml', import.meta.url), file);
  writeFileSync(join(root, 'value.txt'), 'original');
  writeFileSync(join(root, 'verify.mjs'), 'process.exit(1);');
  const manifest = loadManifest(file), store = new RunStore(file), run = createRun(manifest);
  run.workspacePolicy = { workspace: root, allowedPaths: ['value.txt'], intent: 'Write approved output', maxRepairAttempts: 0, verifier: { command: process.execPath, args: ['verify.mjs'], timeoutMs: 3000 } };
  const opts = { store, callerProvider, settings: manifest.settings };
  const answer = async output => { const job = run.pendingInference; return driveRun(run, { ...opts, inferenceReply: { jobId: job.jobId, hash: job.hash, output: { text: JSON.stringify(output) } } }); };
  try {
    await driveRun(run, opts); await answer(spec);
    await driveRun(run, opts);
    assert.equal(run.status, 'waiting_human');
    assert.equal(readFileSync(join(root, 'value.txt'), 'utf8'), 'original');
    const approvalHash = run.steps.find(s => s.status === 'waiting_human').output.approvalHash;
    await resumeRun(run, { ...opts, decision: 'approve', approvalHash });
    await answer({ files: [{ path: 'value.txt', content: 'changed' }] });
    assert.equal(run.status, 'needs_human');
    assert.equal(run.repairHistory.length, 1);
    await driveRun(run, opts);
    assert.equal(run.status, 'needs_human');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('paused caller cancellation invalidates old job and resumes without repeating completed steps', async () => {
  const { cancelWaitingRun, resumeCancelledRun } = await import('../src/run.mjs');
  const manifest = { id: 'paused', name: 'Paused', steps: [{ id: 'call', kind: 'llm-call', config: { provider: 'cli', instructions: 'Return text' } }] };
  const run = createRun(manifest), opts = { callerProvider, settings: { budgetUsd: null } };
  await driveRun(run, opts);
  const old = structuredClone(run.pendingInference);
  cancelWaitingRun(run);
  assert.equal(run.status, 'cancelled');
  assert.equal(run.pendingInference, undefined);
  await resumeCancelledRun(run, opts);
  assert.equal(run.status, 'waiting_inference');
  assert.notEqual(run.pendingInference.jobId, old.jobId);
  await assert.rejects(driveRun(run, { ...opts, inferenceReply: { jobId: old.jobId, hash: old.hash, output: { text: 'stale' } } }), /stale/);
  const job = run.pendingInference;
  await driveRun(run, { ...opts, inferenceReply: { jobId: job.jobId, hash: job.hash, output: { text: 'fresh' } } });
  assert.equal(run.status, 'success');
});
