import test from 'node:test';
import assert from 'node:assert/strict';
import { registryCliStep } from '../src/registry-cli-step.mjs';
const provider = { kind: 'caller', agent: 'codex', model: 'caller-selected', payerScope: 'local-cli' };
function setup() {
  const state = { runId: 'run-test', loopId: 'example' };
  let persisted;
  const args = { stepId: 'draft', instructions: 'Summarize the supplied source.', input: { source: 'A real input is required in acceptance.' }, provider, save: () => { persisted = structuredClone(state); } };
  return { state, args, snapshot: () => persisted };
}
test('pending Registry inference survives persistence and binds reply to the exact job', () => {
  const { state, args, snapshot } = setup();
  assert.throws(() => registryCliStep(state, args), e => e.code === 'INFERENCE_REQUIRED');
  const restored = snapshot();
  const job = restored.pendingInference;
  const result = registryCliStep(restored, { ...args, reply: { jobId: job.jobId, hash: job.hash, output: { text: 'Test response, not live CLI evidence.' } } });
  assert.equal(result.provider.evidenceKind, 'caller-supplied-inference');
  assert.equal(result.usage.costUsd, null);
  assert.equal(restored.pendingInference, undefined);
  assert.equal(restored.inferenceHistory[0].status, 'consumed');
  assert.throws(() => registryCliStep(restored, { ...args, reply: { jobId: job.jobId, hash: job.hash, output: { text: 'Replay' } } }), e => e.code === 'STALE_INFERENCE');
});
test('changed instructions and another step cannot consume a pending reply', () => {
  for (const change of [{ instructions: 'Changed requirements' }, { stepId: 'other' }]) {
    const { state, args } = setup();
    assert.throws(() => registryCliStep(state, args), e => e.code === 'INFERENCE_REQUIRED');
    const job = state.pendingInference;
    assert.throws(() => registryCliStep(state, { ...args, ...change, reply: { jobId: job.jobId, hash: job.hash, output: { text: 'Answer' } } }), e => e.code === 'STALE_INFERENCE');
    assert.equal(state.pendingInference.jobId, job.jobId);
  }
});
test('missing provider and oversized input fail without fallback', () => {
  const { state, args } = setup();
  assert.throws(() => registryCliStep(state, { ...args, provider: undefined }));
  assert.throws(() => registryCliStep(state, { ...args, input: 'x'.repeat(60001) }));
  assert.throws(() => registryCliStep(state, { ...args, provider: { ...provider, token: 'must-not-be-stored' } }));
  assert.equal(state.pendingInference, undefined);
});
