import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { anthropic } from '../src/providers/anthropic.mjs';
import { runApprovalGate } from '../src/steps.mjs';
import { createRun, driveRun, RunStore } from '../src/run.mjs';
import { validateManifest } from '../src/manifest.mjs';
import { worstCaseAnthropicCallUsd } from '../src/cost.mjs';

// Synthetic markers only. Every provider call injects an empty environment,
// a fake secret resolver, and a fake transport; real fetch is also forbidden.
const KEY = 'fixture-only-native-agent-gate-credential';
const MODEL = 'claude-sonnet-5-5';
const API = 'https://api.anthropic.com/v1/messages';
const INVALID_VERDICT = 'Invalid agent verdict — expected one unambiguous JSON object with a boolean pass.';
const unicode = value => [...value].map(char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`).join('');
beforeEach(t => t.mock.method(globalThis, 'fetch', async () => {
  assert.fail('Agent-gate tests must never dispatch a real network request');
}));

const gate = (id = 'review', config = {}) => ({ id, kind: 'approval-gate', config: {
  reviewer: 'agent', provider: 'anthropic', model: MODEL, rubric: 'The candidate cites its source.',
  retries: '0', maxTokens: '100', ...config,
} });
const manifest = (steps, budgetUsd = 1) => validateManifest({
  manifest: 'q-core.workflow/v1', id: 'native-agent-gate', settings: { budgetUsd }, steps,
});
function completion({ pass = true, reason = 'Source verified.', text, usage, model = MODEL, stop = 'end_turn' } = {}) {
  return Response.json({ id: 'msg-agent-gate-fixture', model, stop_reason: stop,
    content: [{ type: 'text', text: text ?? JSON.stringify({ pass, reason }) }],
    usage: usage ?? { input_tokens: 1000, output_tokens: 100 },
  });
}
function probe({ reply = () => completion(), resolve = async () => KEY } = {}) {
  const requests = [], reads = [], calls = [];
  return { requests, reads, calls, providers: { anthropic: args => {
    requests.push(args);
    return anthropic({ ...args, delaysMs: [0] }, {
      env: {}, secretResolver: async (request, options) => {
        assert.deepEqual(request.env, {});
        assert.equal(request.provider, 'anthropic');
        reads.push(request);
        return resolve(request, options);
      },
      fetcher: async (url, init, options) => {
        assert.equal(url, API);
        assert.equal(init.method, 'POST');
        assert.equal(init.headers['x-api-key'], KEY);
        assert.equal(init.headers.Authorization, undefined, 'no OpenRouter credential is used');
        assert.equal(options.retries, 0, 'the shared transport must not replay a paid POST');
        const call = { body: JSON.parse(init.body), headers: init.headers };
        calls.push(call);
        return reply(calls.length, call);
      },
    });
  } } };
}
async function run(m, p, extra = {}) {
  return driveRun(createRun(m), { settings: m.settings, providers: p.providers,
    apiKey: 'fixture-only-unrelated-openrouter-credential', ...extra });
}
async function disk(t) {
  const directory = await mkdtemp(join(tmpdir(), 'q-core-native-gate-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return new RunStore(join(directory, 'workflow.yaml'));
}
async function assertSafeReceipt(done, store) {
  const receipt = JSON.stringify(done);
  assert.equal(receipt.includes(KEY), false);
  assert.equal(receipt.includes(unicode(KEY)), false);
  if (store) {
    const persisted = await readFile(store.runFile(done.runId), 'utf8');
    assert.equal(persisted.includes(KEY), false);
    assert.equal(persisted.includes(unicode(KEY)), false);
  }
}

test('Anthropic agent gate passes through native Messages, keychain alias, metadata and billed usage', async t => {
  const store = await disk(t), p = probe();
  const m = manifest([gate('review', { keyRef: 'OWNER_GATE_KEY', secretSource: 'keychain',
    workspaceId: 'workspace-agent-fixture', reasoning: 'high', timeoutSec: '12' })]);
  const done = await run(m, p, { store });
  assert.equal(done.status, 'success', done.summary);
  assert.equal(p.calls.length, 1);
  assert.deepEqual([p.reads[0].keyRef, p.reads[0].secretSource], ['OWNER_GATE_KEY', 'keychain']);
  assert.equal(p.calls[0].headers['anthropic-workspace-id'], 'workspace-agent-fixture');
  assert.equal(p.calls[0].body.model, MODEL);
  assert.equal(p.calls[0].body.max_tokens, 100);
  assert.deepEqual(p.calls[0].body.output_config, { effort: 'high' });
  assert.equal(p.requests[0].timeoutMs, 12_000);
  assert.equal(p.requests[0].retries, 0);
  assert.deepEqual(done.steps[0].output.verdict, { pass: true, reason: 'Source verified.' });
  assert.deepEqual(done.steps[0].provider, { kind: 'anthropic', version: '1', requestedModel: MODEL,
    model: MODEL, payerScope: 'local-byok' });
  assert.deepEqual([done.steps[0].tokensIn, done.steps[0].tokensOut], [1000, 100]);
  assert.equal(done.steps[0].costSource, 'provider');
  assert.equal(done.steps[0].costUsd, 0.003);
  assert.equal(done.costUsd, 0.003);
  assert.deepEqual(store.load(done.runId).steps[0].provider, done.steps[0].provider);
  await assertSafeReceipt(done, store);
});

test('Anthropic agent gate objection escalates with the actual bill and provider metadata', async () => {
  const p = probe({ reply: () => completion({ pass: false, reason: 'Source is missing.' }) });
  const done = await run(manifest([gate()]), p);
  assert.equal(done.status, 'waiting_human', done.summary);
  assert.equal(done.steps[0].output.escalated, true);
  assert.deepEqual(done.steps[0].output.verdict, { pass: false, reason: 'Source is missing.' });
  assert.equal(done.steps[0].provider.kind, 'anthropic');
  assert.equal(done.steps[0].costUsd, 0.003);
  assert.equal(p.calls.length, 1);
  await assertSafeReceipt(done);
});

test('Anthropic agent gate refusal fails but retains the machine-check bill', async () => {
  const p = probe({ reply: () => completion({ pass: false, reason: 'Source is missing.' }) });
  const done = await run(manifest([gate('review', { escalateOn: 'refuse' })]), p);
  assert.equal(done.status, 'failed');
  assert.match(done.steps[0].errorText, /Agent-Gate did not pass.*Source is missing/);
  assert.equal(done.steps[0].costUsd, 0.003);
  assert.equal(done.steps[0].costSource, 'provider');
  assert.deepEqual([done.steps[0].tokensIn, done.steps[0].tokensOut], [1000, 100]);
  assert.equal(done.costUsd, 0.003);
  assert.equal(p.calls.length, 1);
  await assertSafeReceipt(done);
});

const ambiguousVerdicts = [
  ['contradictory prose with a passing example', 'FAIL: source missing. Example: {"pass":true,"reason":"verified"}'],
  ['prose before the object', 'The source is verified. {"pass":true,"reason":"verified"}'],
  ['prose after the object', '{"pass":true,"reason":"verified"} Source is missing; FAIL.'],
  ['array wrapper', '[{"pass":true,"reason":"verified"}]'],
  ['nested array wrapper', '[[{"pass":true,"reason":"verified"}]]'],
  ['two top-level objects', '{"pass":false,"reason":"missing"} {"pass":true,"reason":"verified"}'],
  ['two code fences', '```json\n{"pass":false}\n```\n```json\n{"pass":true}\n```'],
  ['prose before a code fence', 'FAIL: source missing.\n```json\n{"pass":true,"reason":"verified"}\n```'],
  ['prose after a code fence', '```json\n{"pass":true,"reason":"verified"}\n```\nFAIL: source missing.'],
  ['an object after a code fence', '```json\n{"pass":true}\n```\n{"pass":true}'],
  ['duplicate pass, last value true', '{"pass":false,"pass":true,"reason":"verified"}'],
  ['duplicate pass, last value false', '{"pass":true,"pass":false,"reason":"missing"}'],
  ['Unicode-equivalent duplicate pass', '{"pass":false,"p\\u0061ss":true,"reason":"verified"}'],
  ['duplicate reason', '{"pass":true,"reason":"missing","reason":"verified"}'],
  ['Unicode-equivalent duplicate reason', '{"pass":true,"reason":"missing","rea\\u0073on":"verified"}'],
  ['duplicate unrelated key', '{"pass":true,"evidence":false,"evidence":true}'],
  ['duplicate nested key', '{"pass":true,"reason":"verified","evidence":{"source":false,"source":true}}'],
  ['Unicode-equivalent duplicate nested key', '{"pass":true,"reason":"verified","evidence":{"source":false,"sou\\u0072ce":true}}'],
  ['duplicate key inside an array object', '{"pass":true,"reason":"verified","evidence":[{"source":false,"source":true}]}'],
  ['string pass', '{"pass":"true","reason":"verified"}'],
  ['number pass', '{"pass":1,"reason":"verified"}'],
  ['null pass', '{"pass":null,"reason":"verified"}'],
  ['array pass', '{"pass":[true],"reason":"verified"}'],
  ['object pass', '{"pass":{"value":true},"reason":"verified"}'],
  ['missing pass', '{"reason":"verified"}'],
  ['a nested pass only', '{"verdict":{"pass":true,"reason":"verified"}}'],
  ['JSON null', 'null'],
  ['JSON boolean', 'true'],
  ['JSON string', '"verified"'],
  ['trailing comma', '{"pass":true,"reason":"verified",}'],
  ['JSON comment', '{"pass":true,/* verified */"reason":"verified"}'],
  ['truncated object', '{"pass":true,"reason":"verified"'],
  ['invalid string escape', '{"pass":true,"reason":"\\q"}'],
  ['unclosed code fence', '```json\n{"pass":true,"reason":"verified"}'],
];

for (const [name, text] of ambiguousVerdicts) {
  test(`Anthropic agent gate rejects an invalid verdict: ${name}`, async () => {
    const p = probe({ reply: () => completion({ text }) });
    const done = await run(manifest([gate()]), p);
    assert.equal(done.status, 'waiting_human', done.summary);
    assert.deepEqual(done.steps[0].output.verdict, { pass: false, reason: INVALID_VERDICT });
    assert.equal(done.steps[0].output.escalated, true);
    assert.equal(done.steps[0].costUsd, 0.003, 'a rejected verdict still incurred a native model bill');
    assert.equal(done.steps[0].costSource, 'provider');
    assert.deepEqual([done.steps[0].tokensIn, done.steps[0].tokensOut], [1000, 100]);
    assert.equal(done.costUsd, 0.003);
    assert.equal(p.calls.length, 1);
  });
}

const validVerdicts = [
  ['plain object', '{"pass":true,"reason":"Source verified."}', true, 'Source verified.'],
  ['objection object', '{"pass":false,"reason":"Source missing."}', false, 'Source missing.'],
  ['JSON code fence', '```json\n{"pass":true,"reason":"Source verified."}\n```', true, 'Source verified.'],
  ['uppercase JSON code fence with CRLF', '```JSON\r\n{"pass":true,"reason":"Source verified."}\r\n```', true, 'Source verified.'],
  ['unlabelled code fence', '```\n{"pass":false,"reason":"Source missing."}\n```', false, 'Source missing.'],
  ['outer whitespace', ' \t\n {"pass":true,"reason":"Source verified."} \r\n', true, 'Source verified.'],
  ['an escaped pass key', '{"p\\u0061ss":true,"reason":"Source verified."}', true, 'Source verified.'],
  ['JSON punctuation in strings', JSON.stringify({ pass: true, reason: 'Quoted "pass": false, {braces}, [arrays], slash \\ and ```json are evidence text.' }), true,
    'Quoted "pass": false, {braces}, [arrays], slash \\ and ```json are evidence text.'],
  ['nested objects and arrays with distinct key scopes', JSON.stringify({ pass: true, reason: 'Source verified.',
    evidence: [{ source: { id: 'first', pass: false } }, { source: { id: 'second', pass: true } }],
    metadata: { reason: 'A separate scope', empty: {}, values: [null, true, false, 0, -1.2e3] } }), true, 'Source verified.'],
];

for (const [name, text, pass, reason] of validVerdicts) {
  test(`Anthropic agent gate accepts one unambiguous verdict: ${name}`, async () => {
    const p = probe({ reply: () => completion({ text }) });
    const done = await run(manifest([gate()]), p);
    assert.equal(done.status, pass ? 'success' : 'waiting_human', done.summary);
    assert.deepEqual(done.steps[0].output.verdict, { pass, reason });
    assert.equal(done.steps[0].costUsd, 0.003);
    assert.equal(p.calls.length, 1);
  });
}

for (const [reasonKind, reasonField] of [
  ['absent', ''],
  ['non-string', `,"reason":{"private":"${unicode(KEY)}"}`],
]) {
  for (const [pass, escalateOn, status] of [[true, 'objection', 'success'],
    [false, 'objection', 'waiting_human'], [false, 'refuse', 'failed']]) {
    test(`Anthropic valid verdict with ${reasonKind} reason uses a safe fallback for ${status}`, async () => {
      const text = `{"pass":${pass}${reasonField},"evidence":"untrusted-reason-fallback-marker ${unicode(KEY)}"}`;
      const p = probe({ reply: () => completion({ text }) });
      const done = await run(manifest([gate('review', { escalateOn })]), p);
      assert.equal(done.status, status, done.summary);
      if (status === 'failed') {
        assert.equal(done.steps[0].output, null);
        assert.ok(done.steps[0].errorText.endsWith('No reason provided.'));
      } else {
        assert.deepEqual(done.steps[0].output.verdict, { pass, reason: 'No reason provided.' });
        assert.equal(done.steps[0].output.escalated, pass ? undefined : true);
      }
      const receipt = JSON.stringify(done);
      assert.equal(receipt.includes('untrusted-reason-fallback-marker'), false);
      assert.equal(receipt.includes(KEY), false);
      assert.equal(receipt.includes(unicode(KEY)), false);
      assert.equal(done.steps[0].costUsd, 0.003);
      assert.equal(p.calls.length, 1);
    });
  }
}

for (const escalateOn of ['objection', 'refuse']) {
  for (const [name, modelText] of [
    ['malformed JSON', `{"pass":true,"reason":"untrusted-invalid-verdict-marker ${KEY} ${unicode(KEY)}"`],
    ['contradictory envelope', `FAIL: untrusted-invalid-verdict-marker ${KEY} ${unicode(KEY)}. Example: {"pass":true,"reason":"verified"}`],
  ]) {
    test(`Anthropic invalid verdict ${name} uses a fixed safe diagnostic for ${escalateOn}`, async t => {
      const store = await disk(t);
      const p = probe({ reply: () => completion({ text: modelText }) });
      const done = await run(manifest([gate('review', { escalateOn })]), p, { store });
      assert.equal(done.status, escalateOn === 'objection' ? 'waiting_human' : 'failed', done.summary);
      if (escalateOn === 'objection') {
        assert.deepEqual(done.steps[0].output.verdict, { pass: false, reason: INVALID_VERDICT });
        assert.equal(done.steps[0].output.escalated, true);
      } else {
        assert.equal(done.steps[0].output, null);
        assert.match(done.steps[0].errorText, /Agent-Gate did not pass/);
        assert.ok(done.steps[0].errorText.endsWith(INVALID_VERDICT));
      }
      assert.equal(done.steps[0].costUsd, 0.003);
      assert.equal(done.steps[0].costSource, 'provider');
      assert.deepEqual([done.steps[0].tokensIn, done.steps[0].tokensOut], [1000, 100]);
      assert.equal(done.costUsd, 0.003);
      assert.equal(p.calls.length, 1);
      for (const receipt of [JSON.stringify(done), await readFile(store.runFile(done.runId), 'utf8')]) {
        assert.equal(receipt.includes('untrusted-invalid-verdict-marker'), false, 'model content never becomes a diagnostic');
        assert.equal(receipt.includes(KEY), false, 'the resolved fixture key is absent');
        assert.equal(receipt.includes(unicode(KEY)), false, 'the Unicode-escaped fixture key is absent');
      }
      await assertSafeReceipt(done, store);
    });
  }
}

const openRouterFalsePassAttacks = ambiguousVerdicts.filter(([name]) => [
  'contradictory prose with a passing example', 'array wrapper', 'duplicate pass, last value true',
].includes(name));

async function openRouterVerdict(t, content, config = {}, extra = {}) {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    calls++;
    assert.equal(url, 'https://openrouter.ai/api/v1/chat/completions');
    assert.equal(init.headers.Authorization, `Bearer ${KEY}`);
    return Response.json({ id: 'openrouter-verdict-fixture', model: 'test/model',
      choices: [{ message: { content }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1000, completion_tokens: 100, cost: 0.003 } });
  });
  const done = await run(manifest([gate('review', { provider: 'openrouter', model: 'test/model', ...config })]),
    { providers: {} }, { apiKey: KEY, ...extra });
  assert.equal(calls, 1);
  return done;
}

for (const [name, content] of openRouterFalsePassAttacks) {
  test(`OpenRouter known risk: reject the false-PASS attack ${name}`, async t => {
    const done = await openRouterVerdict(t, content);
    assert.equal(done.status, 'waiting_human');
    assert.deepEqual(done.steps[0].output.verdict, { pass: false, reason: INVALID_VERDICT });
    assert.equal(done.steps[0].output.escalated, true);
  });
}

for (const [name, content] of ambiguousVerdicts.filter(([name]) =>
  !openRouterFalsePassAttacks.some(([attack]) => attack === name))) {
  test(`OpenRouter agent gate rejects an invalid verdict: ${name}`, async t => {
    const done = await openRouterVerdict(t, content);
    assert.equal(done.status, 'waiting_human', done.summary);
    assert.deepEqual(done.steps[0].output.verdict, { pass: false, reason: INVALID_VERDICT });
    assert.equal(done.steps[0].output.escalated, true);
    assert.equal(done.steps[0].costUsd, 0.003, 'a rejected verdict retains the actual provider bill');
    assert.equal(done.steps[0].costSource, 'provider');
    assert.deepEqual([done.steps[0].tokensIn, done.steps[0].tokensOut], [1000, 100]);
    assert.equal(done.costUsd, 0.003);
  });
}

for (const [name, content, pass, reason] of validVerdicts) {
  test(`OpenRouter compatibility: accepts one unambiguous verdict: ${name}`, async t => {
    const done = await openRouterVerdict(t, content);
    assert.equal(done.status, pass ? 'success' : 'waiting_human', done.summary);
    assert.deepEqual(done.steps[0].output.verdict, { pass, reason });
    assert.equal(done.steps[0].output.escalated, pass ? undefined : true);
    assert.equal(done.steps[0].costUsd, 0.003);
    assert.equal(done.steps[0].costSource, 'provider');
  });
}

for (const pass of [true, false]) {
  test(`OpenRouter compatibility: a valid ${pass ? 'passing' : 'failing'} verdict preserves its reason with refusal policy`, async t => {
    const reason = pass ? 'Source verified.' : 'Source is missing.';
    const done = await openRouterVerdict(t, JSON.stringify({ pass, reason }), { escalateOn: 'refuse' });
    assert.equal(done.status, pass ? 'success' : 'failed', done.summary);
    if (pass) assert.deepEqual(done.steps[0].output.verdict, { pass, reason });
    else {
      assert.equal(done.steps[0].output, null);
      assert.ok(done.steps[0].errorText.endsWith(reason));
    }
    assert.equal(done.steps[0].costUsd, 0.003);
    assert.equal(done.steps[0].costSource, 'provider');
  });
}

for (const [reasonKind, reasonField] of [['absent', {}], ['non-string', { reason: { source: 'missing' } }]]) {
  for (const [pass, escalateOn, status] of [[true, 'objection', 'success'],
    [false, 'objection', 'waiting_human'], [false, 'refuse', 'failed']]) {
    test(`OpenRouter compatibility: valid verdict with ${reasonKind} reason preserves its bounded fallback for ${status}`, async t => {
      const content = JSON.stringify({ pass, ...reasonField, evidence: 'Fixture evidence for the original reason fallback. '.repeat(10) });
      const reason = content.slice(0, 300);
      const done = await openRouterVerdict(t, content, { escalateOn });
      assert.equal(done.status, status, done.summary);
      if (status === 'failed') {
        assert.equal(done.steps[0].output, null);
        assert.ok(done.steps[0].errorText.endsWith(reason));
      } else {
        assert.deepEqual(done.steps[0].output.verdict, { pass, reason });
        assert.equal(done.steps[0].output.escalated, pass ? undefined : true);
      }
      assert.equal(done.steps[0].costUsd, 0.003);
    });
  }
}

for (const escalateOn of ['objection', 'refuse']) {
  for (const [name, content] of [
    ['malformed JSON', `{"pass":true,"reason":"untrusted-invalid-verdict-marker ${KEY} ${unicode(KEY)}"`],
    ['contradictory envelope', `FAIL: untrusted-invalid-verdict-marker ${KEY} ${unicode(KEY)}. Example: {"pass":true,"reason":"verified"}`],
  ]) {
    test(`OpenRouter invalid verdict ${name} uses a fixed safe diagnostic for ${escalateOn}`, async t => {
      const store = await disk(t);
      const done = await openRouterVerdict(t, content, { escalateOn }, { store });
      assert.equal(done.status, escalateOn === 'objection' ? 'waiting_human' : 'failed', done.summary);
      if (escalateOn === 'objection') {
        assert.deepEqual(done.steps[0].output.verdict, { pass: false, reason: INVALID_VERDICT });
        assert.equal(done.steps[0].output.escalated, true);
      } else {
        assert.equal(done.steps[0].output, null);
        assert.match(done.steps[0].errorText, /Agent-Gate did not pass/);
        assert.ok(done.steps[0].errorText.endsWith(INVALID_VERDICT));
      }
      assert.equal(done.steps[0].costUsd, 0.003);
      assert.equal(done.steps[0].costSource, 'provider');
      assert.deepEqual([done.steps[0].tokensIn, done.steps[0].tokensOut], [1000, 100]);
      assert.equal(done.costUsd, 0.003);
      for (const receipt of [JSON.stringify(done), await readFile(store.runFile(done.runId), 'utf8')]) {
        assert.equal(receipt.includes('untrusted-invalid-verdict-marker'), false, 'model content never becomes a diagnostic');
        assert.equal(receipt.includes(KEY), false, 'the fixture key is absent');
        assert.equal(receipt.includes(unicode(KEY)), false, 'the Unicode-escaped fixture key is absent');
      }
      await assertSafeReceipt(done, store);
    });
  }
}

for (const status of [400, 401, 403, 429, 500, 503]) {
  test(`Anthropic agent gate HTTP ${status} stays a typed provider failure with bounded retries`, async t => {
    const store = await disk(t);
    const p = probe({ reply: () => Response.json({ error: { message: `Untrusted ${KEY}` },
      model: KEY, id: KEY }, { status, statusText: 'Untrusted response', headers: { 'request-id': KEY } }) });
    const done = await run(manifest([gate('review', { retries: '2' })]), p, { store });
    assert.equal(done.status, 'failed', 'an HTTP auth rejection is distinct from an absent secret');
    assert.equal(done.steps[0].output, null);
    assert.match(done.steps[0].errorText, new RegExp(`Anthropic ${status}`));
    assert.equal(p.calls.length, status === 429 || status >= 500 ? 3 : 1);
    assert.equal(done.steps[0].costUsd, 0, 'rejected requests do not invent billed usage');
    await assertSafeReceipt(done, store);
  });
}

for (const status of [429, 500, 503]) {
  test(`Anthropic agent gate retries an unbilled HTTP ${status} rejection and records only successful usage`, async () => {
    const p = probe({ reply: attempt => attempt === 1
      ? Response.json({ error: { message: `Untrusted ${KEY}` } }, { status }) : completion() });
    const done = await run(manifest([gate('review', { retries: '2' })]), p);
    assert.equal(done.status, 'success', done.summary);
    assert.equal(p.calls.length, 2);
    assert.equal(done.steps[0].costUsd, 0.003);
    assert.equal(done.costUsd, 0.003);
    await assertSafeReceipt(done);
  });
}

for (const failure of ['network interruption', 'accepted stream interruption']) {
  test(`Anthropic agent gate ${failure} keeps billing unknown and never replays the POST`, async t => {
    const store = await disk(t);
    const p = probe({ reply: () => {
      if (failure === 'network interruption') throw new TypeError(`fetch failed ${KEY}`);
      return new Response(new ReadableStream({ start(controller) {
        controller.enqueue(Buffer.from('data: {"type":"message_start","message":{"model":"claude-sonnet-5-5","usage":{"input_tokens":1,"output_tokens":0}}}\n\n'));
        controller.error(new TypeError(`body dropped ${KEY}`));
      } }), { headers: { 'content-type': 'text/event-stream' } });
    } });
    const done = await run(manifest([gate('review', { retries: '3' }), gate('second')]), p, { store });
    assert.equal(done.status, 'failed');
    assert.equal(p.calls.length, 1);
    assert.equal(done.steps[0].costUsd, null);
    assert.equal(done.steps[0].costSource, 'unknown');
    assert.equal(done.costUsd, null);
    assert.equal(done.steps[1].status, 'pending');
    await assertSafeReceipt(done, store);
  });
}

for (const secretSource of ['env', 'keychain']) for (const code of ['AUTH_REQUIRED', 'SECRET_MISSING']) {
  test(`Anthropic agent gate missing ${secretSource} secret (${code}) hands the unperformed check to a human`, async () => {
    const p = probe({ resolve: async () => { const error = new Error(`unavailable ${KEY}`); error.code = code; throw error; } });
    const done = await run(manifest([gate('review', { secretSource, keyRef: 'MISSING_GATE_KEY' })]), p);
    assert.equal(done.status, 'waiting_human', done.summary);
    assert.equal(p.reads.length, 1);
    assert.equal(p.calls.length, 0);
    assert.deepEqual([p.reads[0].secretSource, p.reads[0].keyRef], [secretSource, 'MISSING_GATE_KEY']);
    assert.equal(done.steps[0].output.verdict, null);
    assert.equal(done.steps[0].output.escalated, true);
    assert.match(done.steps[0].output.reason, /Anthropic/);
    assert.equal(done.steps[0].costUsd, 0);
    await assertSafeReceipt(done);
  });
}

test('Anthropic agent gate empty resolved key escalates without trying another provider', async () => {
  const p = probe({ resolve: async () => ' \t\r\n' });
  const done = await run(manifest([gate()]), p);
  assert.equal(done.status, 'waiting_human', done.summary);
  assert.equal(done.steps[0].output.verdict, null);
  assert.equal(p.calls.length, 0);
});

test('Anthropic agent gate default environment resolver hands an absent native key to a human', async () => {
  let calls = 0;
  const native = args => anthropic(args, { env: {}, fetcher: async () => {
    calls++;
    assert.fail('An absent native environment key must stop before transport');
  } });
  const m = manifest([gate()]);
  const done = await driveRun(createRun(m), { settings: m.settings, providers: { anthropic: native },
    apiKey: 'fixture-only-unrelated-openrouter-credential' });
  assert.equal(done.status, 'waiting_human', done.summary);
  assert.equal(done.steps[0].output.verdict, null);
  assert.equal(done.steps[0].output.escalated, true);
  assert.match(done.steps[0].output.reason, /Anthropic/);
  assert.equal(done.steps[0].costUsd, 0);
  assert.equal(calls, 0);
});

test('Anthropic agent gate refuses an unsupported provider before dispatch instead of falling back', async () => {
  const p = probe();
  await assert.rejects(runApprovalGate(gate('review', { provider: 'unsupported-fixture' }), {
    priorOutputs: {}, priorStepNames: {}, providers: p.providers,
    apiKey: 'fixture-only-unrelated-openrouter-credential',
  }, MODEL, 100), /Unknown API provider; no fallback is allowed/);
  assert.equal(p.requests.length, 0);
  assert.equal(p.reads.length, 0);
  assert.equal(p.calls.length, 0);
});

test('Anthropic agent gate refuses a missing native model before secret resolution or transport', async () => {
  const p = probe();
  await assert.rejects(runApprovalGate(gate(), { priorOutputs: {}, priorStepNames: {}, providers: p.providers },
    null, 100), /Anthropic model is not configured/);
  assert.equal(p.requests.length, 0);
  assert.equal(p.reads.length, 0);
  assert.equal(p.calls.length, 0);
});

for (const code of ['SECRET_STORE_DENIED', 'SECRET_STORE_UNSUPPORTED']) {
  test(`Anthropic agent gate keychain ${code} remains a failure instead of concealing a secret-store problem`, async () => {
    const p = probe({ resolve: async () => { const error = new Error(`keychain ${KEY}`); error.code = code; throw error; } });
    const done = await run(manifest([gate('review', { secretSource: 'keychain' })]), p);
    assert.equal(done.status, 'failed', done.summary);
    assert.match(done.steps[0].errorText, /secret retrieval failed/);
    assert.equal(done.steps[0].output, null);
    assert.equal(p.reads.length, 1);
    assert.equal(p.calls.length, 0);
    await assertSafeReceipt(done);
  });
}

for (const pass of [true, false]) {
  test(`Anthropic agent gate ${pass ? 'passed output' : 'refusal error'} redacts Unicode-decoded credential echoes before persistence`, async t => {
    const store = await disk(t);
    const p = probe({ reply: () => completion({ text: `{"pass":${pass},"reason":"Echo ${unicode(KEY)}"}` }) });
    const done = await run(manifest([gate('review', { escalateOn: 'refuse' })]), p, { store });
    assert.equal(done.status, pass ? 'success' : 'failed', done.summary);
    const exposed = pass ? done.steps[0].output.verdict.reason : done.steps[0].errorText;
    assert.match(exposed, /\[REDACTED\]/);
    assert.equal(exposed.includes(KEY), false, 'check the in-memory boundary before the persistence guard');
    assert.equal(done.steps[0].costUsd, 0.003);
    await assertSafeReceipt(done, store);
  });
}

for (const pass of [true, false]) {
  test(`Anthropic agent gate ${pass ? 'success' : 'billed refusal'} preserves sub-micro-dollar native cache spend`, async t => {
    const store = await disk(t);
    const p = probe({ reply: () => completion({ pass, usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 1 } }) });
    const done = await run(manifest([gate('review', { escalateOn: 'refuse' })]), p, { store });
    assert.equal(done.status, pass ? 'success' : 'failed', done.summary);
    const preciseCost = 0.20 / 1_000_000;
    assert.equal(done.steps[0].costUsd, preciseCost);
    assert.equal(store.load(done.runId).steps[0].costUsd, preciseCost);
    assert.equal(done.steps[0].costSource, 'provider');
  });
}

test('Anthropic agent gate per-call cap rejects before secret resolution or paid transport', async () => {
  const p = probe();
  const done = await run(manifest([gate('review', { maxCallCostUsd: '0.000001' })]), p);
  assert.equal(done.status, 'failed');
  assert.match(done.steps[0].errorText, /maxCallCostUsd/);
  assert.equal(p.reads.length, 0);
  assert.equal(p.calls.length, 0);
});

test('Anthropic agent gate actual usage above its cap fails while retaining the bill', async () => {
  const p = probe({ reply: () => completion({ usage: { input_tokens: 100_000, output_tokens: 100 } }) });
  const done = await run(manifest([gate('review', { maxCallCostUsd: '0.05' })]), p);
  assert.equal(done.status, 'failed');
  assert.match(done.steps[0].errorText, /above maxCallCostUsd/);
  assert.equal(done.steps[0].costUsd, 0.201);
  assert.equal(done.costUsd, 0.201);
  assert.equal(p.calls.length, 1);
});

test('Anthropic agent gate reserves every configured attempt before secret resolution', async () => {
  const p = probe();
  const done = await run(manifest([gate('review', { retries: '2' })], 0.002), p);
  assert.equal(done.status, 'failed');
  assert.equal(done.steps[0].gateReason, 'budget');
  assert.match(done.summary, /reserve Anthropic worst-case/);
  assert.equal(p.requests.length, 0);
  assert.equal(p.reads.length, 0);
  assert.equal(p.calls.length, 0);
});

test('Anthropic agent gate bound uses its actual 300-token completion cap', async () => {
  const p = probe();
  const done = await run(manifest([gate('review', { maxTokens: '32000' })], 0.02), p);
  assert.equal(done.status, 'success', done.summary);
  assert.equal(p.requests[0].maxTokens, 300);
  assert.equal(p.calls[0].body.max_tokens, 300);
});

test('Anthropic agent gate releases its reservation to actual usage before the next paid check', async () => {
  const p = probe();
  const done = await run(manifest([gate('first'), gate('second')], 0.01), p);
  assert.equal(done.status, 'success', done.summary);
  assert.equal(p.calls.length, 2);
  assert.equal(done.costUsd, 0.006);
});

test('Anthropic agent gate reservations include its resolved candidate bytes and previous fractional spend', async () => {
  const p = probe();
  const m = manifest([gate()]);
  await run(m, p);
  const request = p.requests[0];
  const worst = worstCaseAnthropicCallUsd({ model: request.model,
    messagesBytes: Buffer.byteLength(JSON.stringify(request.messages)), maxTokens: request.maxTokens,
    attempts: request.retries + 1 });
  const reservations = [];
  await runApprovalGate(gate(), { priorOutputs: {}, priorStepNames: {}, providers: p.providers,
    reserveAnthropicCost: bound => reservations.push(bound) }, MODEL, 100);
  assert.deepEqual(reservations, [worst]);
  const larger = probe();
  await assert.rejects(runApprovalGate(gate(), { priorOutputs: { draft: { text: 'source '.repeat(10_000) } },
    priorStepNames: {}, providers: larger.providers, reserveAnthropicCost: bound => {
      assert.ok(bound > worst);
      const error = new Error('candidate budget refused'); error.code = 'BUDGET_EXCEEDED'; throw error;
    } }, MODEL, 100), { code: 'BUDGET_EXCEEDED' });
  assert.equal(larger.reads.length, 0);
  assert.equal(larger.calls.length, 0);

  const finite = manifest([gate('earlier'), gate('review')], worst);
  const seeded = createRun(finite);
  Object.assign(seeded.steps[0], { status: 'success', output: null, costUsd: 0.0000002 });
  seeded.costUsd = 0; // The persisted display may have rounded this tiny bill.
  const fresh = probe();
  const done = await driveRun(seeded, { settings: finite.settings, providers: fresh.providers });
  assert.equal(done.status, 'failed');
  assert.equal(done.steps[1].gateReason, 'budget');
  assert.equal(fresh.calls.length, 0);
});

test('Anthropic agent gate answering model with unknown price never borrows the requested model rate', async () => {
  const p = probe({ reply: () => completion({ model: 'claude-unpriced-answer' }) });
  const done = await run(manifest([gate('first'), gate('second')]), p);
  assert.equal(done.steps[0].status, 'success');
  assert.equal(done.steps[0].costUsd, null);
  assert.equal(done.steps[0].costSource, 'unknown');
  assert.equal(done.steps[0].provider.model, 'claude-unpriced-answer');
  assert.equal(done.status, 'failed');
  assert.equal(done.steps[1].gateReason, 'budget');
  assert.equal(p.calls.length, 1);
});

test('an Agent-Gate provider must be exact: padded or mis-cased values cannot skip budget reservation', () => {
  for (const provider of [' anthropic ', 'anthropic ', 'Anthropic', ' openrouter', 'ANTHROPIC']) {
    assert.throws(() => manifest([gate('review', { provider })], 0.000001), /exactly "openrouter" or "anthropic"/, JSON.stringify(provider));
  }
  for (const provider of ['anthropic', 'openrouter']) assert.doesNotThrow(() => manifest([gate('review', { provider })]));
});
