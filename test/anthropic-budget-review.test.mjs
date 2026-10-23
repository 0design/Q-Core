import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRun, driveRun, RunStore } from '../src/run.mjs';
import { validateManifest } from '../src/manifest.mjs';
import { loadWorkflow } from '../src/workflow-policy.mjs';
import { digest } from '../src/material-graph.mjs';
import { worstCaseAnthropicCallUsd } from '../src/cost.mjs';

const llm = (id = 'answer', extra = {}) => ({ id, kind: 'llm-call', config: {
  provider: 'anthropic', model: 'claude-sonnet-5', instructions: 'Say done.', maxTokens: '100', ...extra,
} });
const manifest = (steps, budgetUsd) => validateManifest({
  manifest: 'q-core.workflow/v1', id: 'native-reservation', version: '1.0.0', settings: { budgetUsd }, steps,
});
function providerProbe() {
  const calls = [];
  return { calls, providers: { anthropic: async args => {
    calls.push(args);
    return { content: 'Done', usage: { tokensIn: 1, tokensOut: 1, costUsd: 0.000012 },
      provider: { kind: 'anthropic', model: args.model } };
  } } };
}
async function drive(m, probe, run = createRun(m), opts = {}) {
  return driveRun(run, { settings: m.settings, providers: probe.providers, ...opts });
}

test('Anthropic budget reserves all default attempts without an optional per-call cap', async () => {
  const probe = providerProbe();
  const m = manifest([llm()], 0.002);
  const done = await drive(m, probe);
  assert.equal(done.status, 'failed');
  assert.equal(done.steps[0].gateReason, 'budget');
  assert.match(done.summary, /reserve Anthropic worst-case/);
  assert.equal(probe.calls.length, 0, 'no dispatch or secret resolution can start');
  assert.equal(done.costUsd, 0);
});

test('Anthropic single attempt fits the same budget and only actual spend is recorded', async () => {
  const probe = providerProbe();
  const m = manifest([llm('answer', { retries: '0' })], 0.002);
  const done = await drive(m, probe);
  assert.equal(done.status, 'success', done.summary);
  assert.equal(probe.calls.length, 1);
  assert.equal(probe.calls[0].retries, 0);
  assert.equal(done.costUsd, 0.000012);
});

test('Anthropic reservations are released to actual usage before the next sequential call', async () => {
  const probe = providerProbe();
  const m = manifest([llm('first'), llm('second')], 0.007);
  const done = await drive(m, probe);
  assert.equal(done.status, 'success', done.summary);
  assert.equal(probe.calls.length, 2, 'full worst-case reservations must not accumulate as spend');
  assert.equal(done.costUsd, 0.000024);
});

test('Anthropic root reservation subtracts prior spend, not just the original ceiling', async () => {
  const probe = providerProbe();
  const m = manifest([llm('earlier'), llm('answer', { retries: '0' })], 0.003);
  const run = createRun(m);
  Object.assign(run.steps[0], { status: 'success', output: { text: 'Earlier' }, costUsd: 0.0015 });
  run.costUsd = 0.0015;
  const done = await drive(m, probe, run);
  assert.equal(done.status, 'failed');
  assert.equal(done.steps[1].gateReason, 'budget');
  assert.match(done.summary, /remaining/);
  assert.equal(probe.calls.length, 0);
  assert.equal(done.costUsd, 0.0015);
});

test('Anthropic exact-bound reservation fits, while fractional prior spend must also fit', async () => {
  // Resolve the request with a probe first, then use that exact full bound as
  // the ceiling. This tests the equality boundary, not an approximate cap.
  const roomy = manifest([llm('earlier'), llm('answer', { retries: '0' })], 1);
  const seed = m => {
    const run = createRun(m);
    Object.assign(run.steps[0], { status: 'success', output: { text: 'Earlier' }, costUsd: 0.0000001 });
    run.costUsd = 0; // persisted display can have rounded this tiny bill down
    return run;
  };
  const probe = providerProbe();
  await drive(roomy, probe, seed(roomy));
  const args = probe.calls[0];
  const worst = worstCaseAnthropicCallUsd({ model: args.model, messagesBytes: Buffer.byteLength(JSON.stringify(args.messages)),
    maxTokens: args.maxTokens, attempts: args.retries + 1 });
  for (const [cap, expectedCalls] of [[worst, 0], [worst + 0.0000001, 1]]) {
    const m = manifest(roomy.steps, cap);
    const p = providerProbe();
    const done = await drive(m, p, seed(m));
    assert.equal(p.calls.length, expectedCalls);
    assert.equal(done.status, expectedCalls ? 'success' : 'failed', done.summary);
    if (!expectedCalls) assert.equal(done.steps[1].gateReason, 'budget');
  }
});

for (const failure of [false, true]) test(`Anthropic ${failure ? 'billed failure' : 'success'} preserves fractional spend for persisted future reservations`, async t => {
  const dir = mkdtempSync(join(tmpdir(), 'q-core-fractional-spend-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = new RunStore(join(dir, 'workflow.yaml'));
  const m = manifest([llm('answer', { retries: '0' })], 1);
  const preciseCost = 0.0000001;
  const native = async () => {
    const result = { content: 'Done', usage: { tokensIn: 1, tokensOut: 0, costUsd: preciseCost }, provider: { kind: 'anthropic', model: 'claude-sonnet-5' } };
    if (failure) {
      const error = new Error('Completion truncated');
      error.code = 'OUTPUT_LIMIT'; error.usage = result.usage; error.model = result.provider.model;
      throw error;
    }
    return result;
  };
  const done = await driveRun(createRun(m), { settings: m.settings, providers: { anthropic: native }, store });
  assert.equal(done.status, failure ? 'failed' : 'success');
  assert.equal(done.steps[0].costUsd, preciseCost);
  assert.equal(store.load(done.runId).steps[0].costUsd, preciseCost);
});

test('Anthropic bound uses resolved instructions and prior output bytes', async () => {
  const probe = providerProbe();
  const m = manifest([llm('earlier'), llm('answer', { retries: '0', instructions: '{{steps.earlier.output.text}}' })], 0.01);
  const run = createRun(m);
  Object.assign(run.steps[0], { status: 'success', output: { text: 'large prior output '.repeat(400) } });
  const done = await drive(m, probe, run);
  assert.equal(done.status, 'failed');
  assert.equal(done.steps[1].gateReason, 'budget');
  assert.equal(probe.calls.length, 0);
});

test('Anthropic unknown model price cannot dispatch under a finite budget', async () => {
  const probe = providerProbe();
  const m = manifest([llm('answer', { model: 'claude-unpriced-model' })], 1);
  const done = await drive(m, probe);
  assert.equal(done.status, 'failed');
  assert.equal(done.steps[0].gateReason, 'budget');
  assert.match(done.summary, /cost is unknown/);
  assert.equal(probe.calls.length, 0);
});

test('Anthropic explicitly unbounded root allows dispatch without inventing a monetary cap', async () => {
  const probe = providerProbe();
  const m = manifest([llm('answer', { maxTokens: '32000' })], null);
  const done = await drive(m, probe);
  assert.equal(done.status, 'success', done.summary);
  assert.equal(probe.calls.length, 1);
});

function nested(t, caps, { spent = 0 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'q-core-native-budget-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const write = (name, doc) => {
    const body = Object.entries(doc).map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join('\n') + '\n';
    writeFileSync(join(dir, name), body);
    return { kind: 'workflow', id: doc.id, version: doc.version, path: name, sha256: digest(body) };
  };
  const doc = (id, budgetUsd, steps, dependencies = {}) => ({
    manifest: 'q-core.workflow/v1', id, version: '1.0.0', settings: { budgetUsd }, steps, dependencies,
  });
  const call = { id: 'call', kind: 'workflow-call', config: { ref: 'child' } };
  const leaf = write('leaf.yaml', doc('leaf', caps.leaf, [llm('answer', { retries: '2' })]));
  const middle = write('middle.yaml', doc('middle', caps.middle, [call], { child: leaf }));
  write('root.yaml', doc('root', caps.root, [call], { child: middle }));
  const m = loadWorkflow(join(dir, 'root.yaml'));
  const run = createRun(m);
  if (spent) {
    // A persisted successful row in the root is outside child budgets, but
    // still reduces the run's remaining budget for a nested provider call.
    run.steps.unshift({ ...run.steps[0], rowId: 'earlier', stepId: 'earlier', kind: 'llm-call', seq: -1,
      status: 'success', costUsd: spent, output: { text: 'Earlier' } });
    run.costUsd = spent;
  }
  return { m, run };
}

for (const scope of ['root', 'middle', 'leaf']) test(`Anthropic nested dispatch reserves against the ${scope} ceiling`, async t => {
  const caps = { root: null, middle: null, leaf: null, [scope]: 0.002 };
  const { m, run } = nested(t, caps);
  const probe = providerProbe();
  const done = await drive(m, probe, run);
  const answer = done.steps.find(row => row.stepId === 'answer');
  assert.equal(done.status, 'failed');
  assert.equal(answer.gateReason, 'budget');
  assert.match(answer.errorText, /reserve Anthropic/);
  assert.equal(probe.calls.length, 0);
});

test('Anthropic nested reservation respects remaining root spend outside the child', async t => {
  const { m, run } = nested(t, { root: 0.006, middle: null, leaf: null }, { spent: 0.002 });
  const probe = providerProbe();
  const done = await drive(m, probe, run);
  assert.equal(done.status, 'failed');
  assert.equal(probe.calls.length, 0);
  assert.equal(done.costUsd, 0.002);
});

test('Anthropic nested call succeeds when every ancestor can reserve all attempts', async t => {
  const { m, run } = nested(t, { root: 0.02, middle: 0.01, leaf: 0.006 });
  const probe = providerProbe();
  const done = await drive(m, probe, run);
  assert.equal(done.status, 'success', done.summary);
  assert.equal(probe.calls.length, 1);
  assert.equal(done.costUsd, 0.000012);
  assert.equal(done.steps.find(row => row.stepId === 'answer').costUsd, 0.000012);
});
