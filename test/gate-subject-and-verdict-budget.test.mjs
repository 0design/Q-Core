import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { anthropic } from '../src/providers/anthropic.mjs';
import { createRun, driveRun, waitingGate } from '../src/run.mjs';
import { validateManifest } from '../src/manifest.mjs';
import { approvalSubjectWarnings } from '../src/workflow-policy.mjs';
import { hash } from '../src/contracts.mjs';

// Synthetic markers only: a fake secret resolver and transport; real fetch is forbidden.
const KEY = 'fixture-only-gate-subject-credential';
const MODEL = 'claude-sonnet-5-5';
beforeEach(t => t.mock.method(globalThis, 'fetch', async () => {
  assert.fail('Gate tests must never dispatch a real network request');
}));

const DRAFT = 'Release notes: the gate shows what is sent.';
const DRAFT_OUT = { text: DRAFT, model: MODEL };
const draft = { id: 'draft', kind: 'llm-call', config: { provider: 'anthropic', model: MODEL, retries: '0', format: 'text',
  instructions: 'Write the release notes.' } };
const agent = (config = {}) => ({ id: 'rules', kind: 'approval-gate', config: {
  reviewer: 'agent', provider: 'anthropic', model: MODEL, rubric: 'The draft names what is sent.', retries: '0', ...config } });
const human = (config = {}) => ({ id: 'approve', kind: 'approval-gate', config: { reviewer: 'human', bind: 'sha256', ...config } });
const manifest = steps => validateManifest({ manifest: 'q-core.workflow/v1', id: 'gate-subject', settings: { budgetUsd: 1 }, steps });
function completion({ text = JSON.stringify({ pass: true, reason: 'Names it.' }), stop = 'end_turn', usage } = {}) {
  return Response.json({ id: 'msg-gate-subject-fixture', model: MODEL, stop_reason: stop,
    content: [{ type: 'text', text }], usage: usage ?? { input_tokens: 1000, output_tokens: 100 } });
}
// The writer always answers DRAFT; `reply` answers the agent gate, whose calls alone are recorded.
function probe(reply = () => completion()) {
  const calls = [];
  return { calls, providers: { anthropic: args => anthropic({ ...args, delaysMs: [0] }, {
    env: {}, secretResolver: async () => KEY,
    fetcher: async (url, init) => {
      const body = JSON.parse(init.body);
      if (!JSON.stringify(body.system ?? '').includes('validation gate')) return completion({ text: DRAFT });
      calls.push(body); return reply(calls.length);
    },
  }) } };
}
const run = (m, p) => driveRun(createRun(m), { settings: m.settings, providers: p.providers });

test('the writer fixture yields the draft as its output', async () => {
  const done = await run(manifest([draft]), probe());
  assert.equal(done.status, 'success', done.summary);
  assert.deepEqual(done.steps[0].output, DRAFT_OUT);
});

test('a human gate after an agent gate shows and hashes the content, with the verdict beside it', async () => {
  const done = await run(manifest([draft, agent(), human()]), probe());
  assert.equal(done.status, 'waiting_human', done.summary);
  const gate = done.steps[2];
  assert.deepEqual(gate.output.subject, DRAFT_OUT);
  assert.equal(gate.output.approvalHash, hash(DRAFT_OUT));
  assert.deepEqual(gate.output.reviews, [{ step: 'rules', verdict: { pass: true, reason: 'Names it.' } }]);
  assert.equal(gate.boundSubjectRowId, done.steps[0].rowId);
  // The approve-time check derives the same subject: the person's hash is accepted, a verdict hash is not.
  assert.equal(waitingGate(done, hash(DRAFT_OUT)).stepId, 'approve');
  assert.throws(() => waitingGate(done, hash(done.steps[1].output)), { code: 'STALE_APPROVAL' });
});

test('subject: previous keeps the legacy subject (the agent verdict) for old descriptions', async () => {
  const done = await run(manifest([draft, agent(), human({ subject: 'previous' })]), probe());
  const gate = done.steps[2];
  assert.deepEqual(gate.output.subject, done.steps[1].output);
  assert.equal(gate.output.approvalHash, hash(done.steps[1].output));
  assert.equal(waitingGate(done, hash(done.steps[1].output)).stepId, 'approve');
});

test('a run parked before this change keeps its recorded subject row', async () => {
  const done = await run(manifest([draft, agent(), human()]), probe());
  const legacy = structuredClone(done), gate = legacy.steps[2], verdictRow = legacy.steps[1];
  Object.assign(gate, { boundSubjectRowId: verdictRow.rowId, boundSubjectHash: hash(verdictRow.output) });
  Object.assign(gate.output, { subject: verdictRow.output, approvalHash: hash(verdictRow.output) });
  delete gate.output.reviews;
  assert.equal(waitingGate(legacy, hash(verdictRow.output)).stepId, 'approve');
});

test('an escalated agent gate shows the candidate it judged, bound under sha256', async () => {
  const p = probe(() => completion({ text: JSON.stringify({ pass: false, reason: 'Too vague.' }) }));
  const done = await run(manifest([draft, agent({ bind: 'sha256' })]), p);
  assert.equal(done.status, 'waiting_human', done.summary);
  assert.deepEqual(done.steps[1].output.subject, DRAFT_OUT);
  assert.equal(waitingGate(done, hash(DRAFT_OUT)).stepId, 'rules');
});

test('the agent gate budget comes from maxTokens, with a default above the old 300', async () => {
  const p = probe();
  await run(manifest([draft, agent({ maxTokens: '2000' })]), p);
  assert.equal(p.calls[0].max_tokens, 2000);
  const d = probe();
  await run(manifest([draft, agent()]), d);
  assert.equal(d.calls[0].max_tokens, 1024);
});

test('an answer cut off at maxTokens escalates to a person and keeps its bill', async () => {
  const p = probe(() => completion({ text: '{"pass": false, "reason": "The draft', stop: 'max_tokens', usage: { input_tokens: 1000, output_tokens: 1024 } }));
  const done = await run(manifest([draft, agent(), human()]), p);
  assert.equal(done.status, 'waiting_human', done.summary);
  const row = done.steps[1];
  assert.equal(row.status, 'waiting_human');
  assert.equal(row.output.escalated, true);
  assert.equal(row.output.verdict.pass, false);
  assert.match(row.output.verdict.reason, /cut off at maxTokens 1024/);
  assert.deepEqual(row.output.subject, DRAFT_OUT);
  assert.deepEqual([row.tokensIn, row.tokensOut], [1000, 1024]);
  assert.ok(row.costUsd > 0);
});

test('a cut-off answer follows escalateOn like a failed check; other provider failures still fail', async () => {
  const cut = probe(() => completion({ stop: 'max_tokens' }));
  const refused = await run(manifest([draft, agent({ escalateOn: 'refuse' })]), cut);
  assert.equal(refused.status, 'failed');
  assert.match(refused.steps[1].errorText, /cut off at maxTokens/);
  const costly = probe(() => completion({ usage: { input_tokens: 1000, output_tokens: 100 } }));
  const overCap = await run(manifest([draft, agent({ maxCallCostUsd: '0.000001' })]), costly);
  assert.equal(overCap.status, 'failed');
});

test('an unreadable verdict escalates to a person, it does not fail the run', async () => {
  const done = await run(manifest([draft, agent()]), probe(() => completion({ text: 'Looks fine to me.' })));
  assert.equal(done.status, 'waiting_human', done.summary);
  assert.equal(done.steps[1].output.escalated, true);
});

test('validation: maxTokens on an agent gate and subject on a human gate are bounded', () => {
  for (const maxTokens of ['0', '32001', '1.5', 'many'])
    assert.throws(() => manifest([draft, agent({ maxTokens })]), /maxTokens/);
  assert.throws(() => manifest([draft, human({ subject: 'content' })]), /subject/);
  assert.throws(() => manifest([draft, agent({ subject: 'previous' })]), /subject/);
  manifest([draft, agent({ maxTokens: '32000' }), human({ subject: 'previous' })]);
});

test('GATE_SUBJECT_PARTIAL judges a human gate after an agent gate against the content', () => {
  const write = id => ({ id, kind: 'llm-call', config: { provider: 'cli', format: 'text', instructions: `Write ${id}.` } });
  const send = { id: 'deliver', kind: 'api-request', config: { method: 'POST', url: '{{env.QCORE_WEBHOOK_URL}}',
    body: '{"a":"{{steps.a.output.text}}","b":"{{steps.b.output.text}}"}' } };
  const [warning] = approvalSubjectWarnings([write('a'), write('b'), agent(), human(), send]);
  assert.equal(warning?.subject, 'b');
  assert.deepEqual(warning.uncovered, ['a']);
  assert.deepEqual(approvalSubjectWarnings([write('a'), write('b'), agent(), human({ subject: 'previous' }), send]), []);
});
