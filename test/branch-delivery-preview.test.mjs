// Approval preview for a gate inside a fan-out lane (one workflow-call per item).
// The preview must end at the lane's own return, and the bytes delivered after the
// Touch ID decision must be exactly the previewed ones. No network, no paid model.
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRun, driveRun, resumeRun, RunStore } from '../src/run.mjs';
import { loadWorkflow } from '../src/workflow-policy.mjs';
import { digest } from '../src/material-graph.mjs';
import { deliveryFor } from '../src/approval-delivery.mjs';
import { requestApproval } from '../src/mcp-approval.mjs';
import { issueApprovalChallenge } from '../src/approval-anchor.mjs';
import { persistenceEnvironment } from '../src/persistence.mjs';
import { hash } from '../src/contracts.mjs';
import { createTestTouchIdAnchor } from './helpers/touchid-anchor.mjs';

beforeEach(t => t.mock.method(globalThis, 'fetch', async () => {
  assert.fail('Branch delivery tests must not dispatch network requests');
}));

const ITEMS = [{ title: 'First item' }, { title: 'Second item' }, { title: 'Third item' }];
const yaml = doc => Object.entries(doc).map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join('\n') + '\n';
const gateStep = id => ({ id, kind: 'approval-gate', config: { reviewer: 'human', bind: 'sha256', anchor: 'Approve this lane exactly' } });

function directory(t) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'q-core-branch-delivery-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function write(dir, path, doc) {
  const file = join(dir, path), bytes = yaml(doc);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, bytes);
  return { kind: doc.manifest === 'q-core.component/v1' ? 'component' : 'workflow', id: doc.id, version: doc.version, path, sha256: digest(bytes) };
}

/** Lane without a model (the shape of the wide fan-out case): switch captures the input, gate, file delivery. */
const switchLane = (output, extraCases = {}, extra = {}) => ({
  manifest: 'q-core.workflow/v1', id: 'lane', version: '1.0.0',
  inputs: { item: { type: 'object', required: true }, index: { type: 'integer', required: true } },
  steps: [{ id: 'capture', kind: 'switch', config: { on: '{{inputs}}' }, cases: { '[object Object]': [
    gateStep('lane-approval'),
    { id: 'lane-send', kind: 'api-request', config: { url: pathToFileURL(output).href,
      body: JSON.stringify({ i: '{{steps.lane-approval.output.subject.selector.index}}', title: '{{steps.lane-approval.output.subject.selector.item.title}}' }) } },
  ] }, ...extraCases }],
  ...extra,
});

/** Lane with a model call before its gate (the shape of the feed fan-out case). The model is a local mock. */
const modelLane = output => ({
  manifest: 'q-core.component/v1', id: 'model-lane', version: '1.0.0',
  inputs: { item: { type: 'object' }, index: { type: 'integer' } },
  steps: [
    { id: 'take', kind: 'llm-call', config: { provider: 'anthropic', model: 'claude-haiku-5-5', input: '{{inputs.item}}',
      instructions: 'One sentence about {{inputs.item.title}}.', maxTokens: '50', retries: '0' } },
    gateStep('lane-approval'),
    { id: 'lane-send', kind: 'api-request', config: { url: pathToFileURL(output).href } },
  ],
});

const parentDoc = (ref, after = []) => ({
  manifest: 'q-core.workflow/v1', id: 'fan-parent', version: '1.0.0', settings: { budgetUsd: 1 },
  inputs: { items: { type: 'array' } },
  dependencies: { lane: ref },
  steps: [
    { id: 'per-item', kind: 'fan-out', config: { over: '{{inputs.items}}', maxItems: '5' }, then: [
      { id: 'call-lane', kind: 'workflow-call', config: { ref: 'lane', inputs: '{"item":"{{item}}","index":"{{index}}"}' } },
    ] },
    ...after,
  ],
});

function mockModel() {
  const calls = [];
  return { calls, providers: { anthropic: async args => {
    calls.push(args);
    return { content: `Summary ${calls.length}.`, usage: { tokensIn: 1, tokensOut: 1, costUsd: 0.000001 },
      provider: { kind: 'anthropic', model: args.model } };
  } } };
}

// `reviewed` loads the files as a reviewed install would: the load-time gate policy is skipped, so the
// preview itself must refuse what would run unseen.
async function fanFixture(t, { lane = switchLane, after = [], model = null, reviewed } = {}) {
  const dir = directory(t);
  const output = join(dir, 'delivery.jsonl');
  const anchor = createTestTouchIdAnchor(t, dir);
  const ref = write(dir, 'lane.yaml', lane(output));
  write(dir, 'parent.yaml', parentDoc(ref, after(output)));
  const manifestFile = join(dir, 'parent.yaml');
  const manifest = loadWorkflow(manifestFile, { reviewed });
  const store = new RunStore(manifestFile);
  const run = createRun(manifest, { inputs: { items: ITEMS } });
  await driveRun(run, { store, settings: manifest.settings, ...(model ? { providers: model.providers } : {}) });
  assert.equal(run.status, 'waiting_human', run.summary);
  const gate = run.steps.find(row => row.status === 'waiting_human');
  assert.notEqual(gate.invocationId ?? 'root', 'root', 'the gate is inside a lane');
  return { dir, output, anchor, manifestFile, store, run: store.load(run.runId), gateRow: gate };
}
const waitingGateOf = run => run.steps.find(row => row.status === 'waiting_human');
const delivered = f => existsSync(f.output) ? readFileSync(f.output, 'utf8') : '';
const noAfter = () => [];

test('a lane gate previews only its own lane delivery and stops at the lane return', async t => {
  const f = await fanFixture(t, { after: noAfter });
  const gate = waitingGateOf(f.run);
  const preview = deliveryFor(f.run, gate, f.store);
  assert.equal(preview.deliveries.length, 1);
  assert.equal(preview.deliveries[0].step, 'lane-send');
  assert.equal(preview.deliveries[0].destination, pathToFileURL(f.output).href);
  assert.equal(preview.deliveries[0].body, `${JSON.stringify({ i: '0', title: 'First item' })}\n`);
  assert.deepEqual(preview.subject.selector, { item: ITEMS[0], index: 0 });
});

test('MCP preview, Touch ID decision and delivery agree byte for byte for each lane', async t => {
  const f = await fanFixture(t, { after: noAfter });
  const context = { manifestFile: f.manifestFile, capabilities: { elicitation: {} } };
  for (const [index, item] of ITEMS.entries()) {
    const run = f.store.load(f.run.runId);
    const gate = waitingGateOf(run);
    const preview = deliveryFor(run, gate, f.store);
    const before = delivered(f);
    let shown;
    const result = await requestApproval({ run_id: run.runId, gate_id: gate.rowId },
      { ...context, elicit: async params => { shown = params.message; return { action: 'accept', content: { decision: 'approve' } }; } });
    assert.equal(result.decision, 'approve');
    assert.equal(result.delivery_hash, hash(preview), 'the hash shown is the hash of the lane preview');
    assert.equal(f.anchor.payloads.at(-1).content_hash, hash(preview), 'Touch ID signs the same lane preview');
    assert.ok(shown.includes(hash(preview)));
    assert.equal(delivered(f).slice(before.length), preview.deliveries[0].body, 'appended bytes equal the previewed body');
    assert.equal(preview.deliveries[0].body, `${JSON.stringify({ i: String(index), title: item.title })}\n`);
    assert.equal(result.status, index < ITEMS.length - 1 ? 'waiting_human' : 'success', 'the next lane stops at its own gate');
  }
  assert.equal(f.anchor.payloads.length, ITEMS.length, 'one Touch ID decision per lane');
});

test('a lane with a model call before its gate: preview equals delivery, next lane stops at its gate', async t => {
  const model = mockModel();
  const f = await fanFixture(t, { lane: modelLane, after: noAfter, model });
  assert.equal(model.calls.length, 1, 'only the first lane has called the model');
  const gate = waitingGateOf(f.run);
  const preview = deliveryFor(f.run, gate, f.store);
  assert.equal(preview.deliveries.length, 1);
  const snapshot = { runId: f.run.runId, gateId: gate.rowId, runHash: hash(f.run),
    deliveryHash: hash(preview), environmentHash: hash(persistenceEnvironment(f.run)) };
  const payload = issueApprovalChallenge(f.store, snapshot, 'approve');
  const confirmation = { channel: 'approval-anchor', anchor_id: 'touchid', decision: 'approve', payload, signature: f.anchor.sign(payload) };
  const result = await resumeRun(f.run, { decision: 'approve', approvalHash: gate.output.approvalHash, confirmation,
    store: f.store, settings: f.run.executionKnobs, providers: model.providers });
  assert.equal(delivered(f), preview.deliveries[0].body, 'the delivered bytes are the previewed bytes');
  assert.equal(result.status, 'waiting_human');
  assert.equal(model.calls.length, 2, 'the next lane made its own model call and stopped at its own gate');
  const next = waitingGateOf(result);
  assert.notEqual(next.invocationId, gate.invocationId);
  assert.notEqual(hash(deliveryFor(result, next, f.store)), hash(preview), 'the next lane has its own preview');
});

test('an ungated delivery after the fan-out is refused, not hidden behind a lane approval', async t => {
  const after = output => [{ id: 'after-all', kind: 'api-request', config: { url: pathToFileURL(output).href, body: '{"all":"done"}' } }];
  const f = await fanFixture(t, { after, reviewed: true });
  const gate = waitingGateOf(f.run);
  assert.throws(() => deliveryFor(f.run, gate, f.store), error => error.code === 'DELIVERY_NOT_READY' && /without their own human gate/.test(error.message));
});

test('a later lane path that delivers without a gate is refused', async t => {
  const lane = output => switchLane(output, { default: [{ id: 'ungated-send', kind: 'api-request', config: { url: pathToFileURL(output).href, body: '{"x":"1"}' } }] });
  const f = await fanFixture(t, { lane, after: noAfter, reviewed: true });
  const gate = waitingGateOf(f.run);
  assert.throws(() => deliveryFor(f.run, gate, f.store), error => error.code === 'DELIVERY_NOT_READY' && /without their own human gate/.test(error.message));
});

test('a root gate preview is unchanged by the lane boundary', async t => {
  const dir = directory(t);
  const output = join(dir, 'root.jsonl');
  write(dir, 'root.yaml', {
    manifest: 'q-core.workflow/v1', id: 'root-gate', version: '1.0.0', inputs: { note: { type: 'string' } },
    steps: [
      { id: 'pick', kind: 'switch', config: { on: '{{inputs.note}}' }, cases: { hello: [gateStep('root-approval'),
        { id: 'first', kind: 'api-request', config: { url: pathToFileURL(output).href, body: '{"n":"{{inputs.note}}"}' } },
        { id: 'second', kind: 'api-request', config: { url: pathToFileURL(output).href, body: '{"again":"{{inputs.note}}"}' } },
      ] } },
    ],
  });
  const manifestFile = join(dir, 'root.yaml');
  const store = new RunStore(manifestFile);
  const run = createRun(loadWorkflow(manifestFile), { inputs: { note: 'hello' } });
  await driveRun(run, { store });
  const gate = waitingGateOf(run);
  assert.equal(gate.invocationId ?? 'root', 'root');
  assert.deepEqual(deliveryFor(run, gate, store).deliveries, [
    { step: 'first', destination: pathToFileURL(output).href, method: 'APPEND', body: '{"n":"hello"}\n' },
    { step: 'second', destination: pathToFileURL(output).href, method: 'APPEND', body: '{"again":"hello"}\n' },
  ]);
});
