import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { anthropic } from '../src/providers/anthropic.mjs';
import { createRun, driveRun, resumeRun, waitingGate } from '../src/run.mjs';
import { AGENT_SESSION_ENV } from '../src/human-confirmation.mjs';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { validateManifest } from '../src/manifest.mjs';
import { approvalSubjectWarnings, loadWorkflow } from '../src/workflow-policy.mjs';
import { digest, loadManifestGraph } from '../src/material-graph.mjs';
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
function completion({ text = JSON.stringify({ pass: true, reason: 'Names it.' }), stop = 'end_turn', usage, model = MODEL } = {}) {
  return Response.json({ id: 'msg-gate-subject-fixture', model, stop_reason: stop,
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
  // The writer is uncapped; the gate's cap sits between its reservation and the reported bill.
  const capped = { maxCallCostUsd: '0.025', maxTokens: '100' };
  const costly = probe(() => completion({ usage: { input_tokens: 20000, output_tokens: 100 } }));
  const overCap = await run(manifest([draft, agent(capped)]), costly);
  assert.equal(costly.calls.length, 1);
  assert.equal(overCap.status, 'failed');
  assert.match(overCap.steps[1].errorText, /maxCallCostUsd/);
  const cutAndCostly = probe(() => completion({ stop: 'max_tokens', usage: { input_tokens: 20000, output_tokens: 100 } }));
  const both = await run(manifest([draft, agent(capped)]), cutAndCostly);
  assert.equal(cutAndCostly.calls.length, 1);
  assert.equal(both.status, 'failed', 'a cut-off answer over the cost cap is not handed on');
  assert.notEqual(both.steps[1].status, 'waiting_human');
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

/* ── What a person approves is what goes on: one subject for the hash and the delivery, whatever the step IDs ── */

// Two writers answer different texts; the approved one must be the one delivered.
const writer = (id, text) => ({ id, kind: 'llm-call', config: { provider: 'anthropic', model: MODEL, retries: '0', format: 'text',
  instructions: `Write ${text}.` } });
function textProbe() {
  const judged = [];
  return { judged, providers: { anthropic: args => anthropic({ ...args, delaysMs: [0] }, {
    env: {}, secretResolver: async () => KEY,
    fetcher: async (url, init) => {
      const body = JSON.stringify(JSON.parse(init.body));
      if (body.includes('validation gate')) { judged.push(body); return completion(); }
      return completion({ text: body.includes('Write text B') ? 'text B' : 'text A' });
    },
  }) } };
}
async function approvedDelivery(ids, t) {
  for (const name of AGENT_SESSION_ENV) if (process.env[name] !== undefined) {
    const value = process.env[name]; delete process.env[name]; t.after(() => { process.env[name] = value; });
  }
  const dir = mkdtempSync(join(tmpdir(), 'q-gate-subject-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const out = join(dir, 'sent.jsonl');
  const m = manifest([writer(ids.a, 'text A'), writer(ids.b, 'text B'), agent({ maxTokens: '200' }), human(),
    { id: ids.send, kind: 'api-request', config: { url: pathToFileURL(out).href } }]
    .map((step, i) => i === 2 ? { ...step, id: ids.agent } : i === 3 ? { ...step, id: ids.human } : step));
  const p = textProbe();
  const parked = await run(m, p);
  assert.equal(parked.status, 'waiting_human', parked.summary);
  const gate = parked.steps.find(row => row.stepId === ids.human);
  assert.deepEqual(gate.output.subject, { text: 'text B', model: MODEL }, 'the person sees the output directly before the agent gate');
  const done = await resumeRun(parked, { decision: 'approve', approvalHash: gate.output.approvalHash, confirmation: { channel: 'test' },
    settings: m.settings, providers: p.providers });
  assert.equal(done.status, 'success', done.summary);
  const [line, ...rest] = readFileSync(out, 'utf8').trim().split('\n');
  assert.equal(rest.length, 0);
  // The agent gate judged the same text the person approves.
  assert.equal(p.judged.length, 1);
  assert.ok(p.judged[0].includes('text B') && !p.judged[0].includes('text A'), 'the agent gate judges the subject');
  return { sent: JSON.parse(line), gate };
}

for (const [label, ids] of [
  ['numeric IDs', { a: 'alpha', b: '0', agent: '2', human: '1', send: '3' }],
  ['string IDs', { a: 'draft-a', b: 'draft-b', agent: 'rules', human: 'approve', send: 'send' }],
  ['a gate with a smaller numeric ID than the content', { a: '7', b: '9', agent: '5', human: '1', send: '0' }],
]) test(`the approved subject is what the delivery sends (${label})`, async t => {
  const { sent, gate } = await approvedDelivery(ids, t);
  // Without a body the delivery sends the output before it: the approved gate, which carries the subject.
  assert.equal(sent.payload.approvalHash, gate.output.approvalHash);
  assert.deepEqual(sent.payload.subject, { text: 'text B', model: MODEL });
  assert.equal(hash(sent.payload.subject), gate.output.approvalHash);
  assert.ok(!JSON.stringify(sent).includes('text A'), 'the unapproved text is not sent');
});

/* ── The run budget stops a run before it is handed to a person ── */

// Writer: 1000 in + 100 out = $0.003. Gate: 20000 in + 100 out = $0.041 at $2/$10 per Mtok,
// billed after a reservation that fits (the reservation counts the request bytes, not the billed input).
const OVER = { input_tokens: 20000, output_tokens: 100 };
const budgeted = (budgetUsd, steps) => validateManifest({ manifest: 'q-core.workflow/v1', id: 'gate-budget', settings: { budgetUsd }, steps });
for (const [label, reply] of [
  ['a cut-off answer', () => completion({ stop: 'max_tokens', usage: OVER })],
  ['an objection', () => completion({ text: JSON.stringify({ pass: false, reason: 'Too vague.' }), usage: OVER })],
  ['an unreadable answer', () => completion({ text: 'Looks fine to me.', usage: OVER })],
]) test(`${label} over the run budget stops the run, it is not handed to a person`, async () => {
  const m = budgeted(0.03, [draft, agent({ maxTokens: '100' }), human()]);
  const p = probe(reply), seen = [];
  const done = await driveRun(createRun(m), { settings: m.settings, providers: p.providers,
    onStep: row => seen.push({ stepId: row.stepId, status: row.status }) });
  assert.equal(p.calls.length, 1, 'the call was made and billed, not refused at reservation');
  // Not even for a moment: no observer ever sees the gate parked for a person.
  assert.ok(!seen.some(event => event.status === 'waiting_human'), JSON.stringify(seen));
  assert.equal(done.status, 'failed', done.summary);
  const row = done.steps[1];
  assert.equal(row.status, 'failed');
  assert.equal(row.gateReason, 'budget');
  assert.match(row.errorText, /budget/i);
  assert.ok(!done.steps.some(s => s.status === 'waiting_human'));
  assert.equal(done.costUsd, 0.044, 'the writer and the gate, counted once');
});

test('a cut-off answer within the run budget is still handed to a person', async () => {
  const m = budgeted(0.05, [draft, agent({ maxTokens: '100' }), human()]);
  const done = await driveRun(createRun(m), { settings: m.settings,
    providers: probe(() => completion({ stop: 'max_tokens', usage: OVER })).providers });
  assert.equal(done.status, 'waiting_human', done.summary);
  assert.equal(done.steps[1].status, 'waiting_human');
});

test('an escalation over an enclosing child workflow budget stops the run, it is not handed to a person', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'q-gate-child-budget-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const yaml = doc => Object.entries(doc).map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join('\n') + '\n';
  const childBytes = yaml({ manifest: 'q-core.workflow/v1', id: 'reviewed', version: '1.0.0', settings: { budgetUsd: 0.03 },
    outputs: {}, steps: [draft, agent({ maxTokens: '100' }), human()] });
  writeFileSync(join(dir, 'reviewed.yaml'), childBytes);
  writeFileSync(join(dir, 'parent.yaml'), yaml({ manifest: 'q-core.workflow/v1', id: 'parent', version: '1.0.0', settings: { budgetUsd: 1 },
    dependencies: { reviewed: { kind: 'workflow', id: 'reviewed', version: '1.0.0', path: 'reviewed.yaml', sha256: digest(childBytes) } },
    outputs: {}, steps: [{ id: 'call', kind: 'workflow-call', config: { ref: 'reviewed' } }] }));
  const m = loadWorkflow(join(dir, 'parent.yaml'));
  const p = probe(() => completion({ stop: 'max_tokens', usage: OVER })), seen = [];
  const done = await driveRun(createRun(m), { settings: m.settings, providers: p.providers, onStep: row => seen.push(row.status) });
  assert.equal(p.calls.length, 1);
  assert.equal(done.status, 'failed', done.summary);
  const row = done.steps.find(s => s.stepId === 'rules');
  assert.equal(row.gateReason, 'budget');
  assert.match(row.errorText, /Child reviewed(\.yaml)? budget exceeded/);
  assert.ok(!seen.includes('waiting_human'));
  assert.ok(!done.steps.some(s => s.status === 'waiting_human'));
});

async function verdictBudgetRun(t, { scope, reply, laterHuman, budgetUsd = 0.03, gateConfig = {} }) {
  const dir = mkdtempSync(join(tmpdir(), 'q-gate-verdict-budget-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const out = join(dir, 'sent.jsonl');
  const steps = [draft, agent({ maxTokens: '100', ...gateConfig }), ...(laterHuman ? [human()] : []),
    { id: 'deliver', kind: 'api-request', config: { url: pathToFileURL(out).href } }];
  let m = budgeted(budgetUsd, steps);
  if (scope === 'child') {
    const yaml = doc => Object.entries(doc).map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join('\n') + '\n';
    const bytes = yaml({ manifest: 'q-core.workflow/v1', id: 'reviewed', version: '1.0.0', settings: { budgetUsd }, outputs: {}, steps });
    writeFileSync(join(dir, 'reviewed.yaml'), bytes);
    writeFileSync(join(dir, 'parent.yaml'), yaml({ manifest: 'q-core.workflow/v1', id: 'parent', version: '1.0.0',
      settings: { budgetUsd: null }, outputs: {},
      dependencies: { reviewed: { kind: 'workflow', id: 'reviewed', version: '1.0.0', path: 'reviewed.yaml', sha256: digest(bytes) } },
      steps: [{ id: 'call', kind: 'workflow-call', config: { ref: 'reviewed' } }] }));
    // Exercise the driver directly, like budgeted() above, including workflows without a human gate.
    m = loadManifestGraph(join(dir, 'parent.yaml'));
  }
  const p = probe(reply), saved = [], seen = [];
  const done = await driveRun(createRun(m), { settings: m.settings, providers: p.providers,
    store: { save: record => saved.push(structuredClone(record)) },
    onStep: row => seen.push(structuredClone(row)) });
  return { done, out, saved, seen, calls: p.calls, scope };
}

function assertBudgetStopped({ done, out, saved, seen, calls, scope }, expectedCost) {
  assert.equal(calls.length, 1, 'the gate was called and billed, not refused at reservation');
  const row = done.steps.find(s => s.stepId === 'rules');
  assert.equal(done.status, 'failed', done.summary);
  assert.equal(row.status, 'failed');
  assert.equal(row.gateReason, 'budget');
  assert.match(row.errorText, /budget.*(?:exceeded|unknown)/i);
  assert.match(row.errorText, scope === 'child' ? /^Child reviewed(\.yaml)? budget/ : /^Run budget/);
  assert.equal(done.costUsd, expectedCost, 'the writer and the gate are counted once, or remain unknown');
  assert.equal(done.steps.find(s => s.stepId === 'deliver').status, 'pending');
  assert.equal(existsSync(out), false, 'no delivery happened');
  assert.ok(!saved.some(record => record.status === 'success' || record.steps.some(s =>
    s.status === 'waiting_human' || (s.stepId === 'rules' && s.status === 'success'))), 'no success or human handoff was saved');
  assert.ok(!seen.some(s => s.status === 'waiting_human' || (s.stepId === 'rules' && s.status === 'success')),
    'no success or human handoff was reported');
  const humanRow = done.steps.find(s => s.stepId === 'approve');
  if (humanRow) assert.equal(humanRow.status, 'pending', 'the later human gate never starts');
}

for (const scope of ['run', 'child']) {
  for (const laterHuman of [false, true]) {
    const tail = laterHuman ? 'a later human gate' : 'delivery';
    test(`a passing agent verdict over the ${scope} budget stops before ${tail} or a saved success`, async t => {
      const result = await verdictBudgetRun(t, { scope, laterHuman, reply: () => completion({ usage: OVER }) });
      assertBudgetStopped(result, 0.044);
      assert.equal(result.done.steps.find(s => s.stepId === 'rules').output.verdict.pass, true);
    });
    test(`a passing agent verdict with unknown cost under the ${scope} budget stops before ${tail}`, async t => {
      const result = await verdictBudgetRun(t, { scope, laterHuman, reply: () => completion({ model: 'claude-unpriced-answer' }) });
      assertBudgetStopped(result, null);
      assert.equal(result.done.steps.find(s => s.stepId === 'rules').costSource, 'unknown');
    });
    test(`a passing agent verdict within the ${scope} budget still reaches ${tail}`, async t => {
      const { done, out } = await verdictBudgetRun(t, { scope, laterHuman, budgetUsd: 0.05, reply: () => completion({ usage: OVER }) });
      assert.equal(done.status, laterHuman ? 'waiting_human' : 'success', done.summary);
      assert.equal(done.steps.find(s => s.stepId === 'rules').status, 'success');
      assert.equal(done.costUsd, 0.044);
      assert.equal(existsSync(out), !laterHuman);
    });
  }
  for (const unknown of [false, true]) test(`a refused agent verdict ${unknown ? 'with unknown cost' : 'over budget'} stops on the ${scope} budget`, async t => {
    const result = await verdictBudgetRun(t, { scope, laterHuman: true, gateConfig: { escalateOn: 'refuse' },
      reply: () => completion({ text: JSON.stringify({ pass: false, reason: 'Too vague.' }),
        ...(unknown ? { model: 'claude-unpriced-answer' } : { usage: OVER }) }) });
    assertBudgetStopped(result, unknown ? null : 0.044);
  });
}

test('a passing agent verdict with unknown cost still delivers when the budget is explicitly lifted', async t => {
  const { done, out } = await verdictBudgetRun(t, { scope: 'child', laterHuman: false, budgetUsd: null,
    reply: () => completion({ model: 'claude-unpriced-answer' }) });
  assert.equal(done.status, 'success', done.summary);
  assert.equal(done.costUsd, null);
  assert.equal(existsSync(out), true);
});
