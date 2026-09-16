import test from 'node:test';
import assert from 'node:assert/strict';
import { runLlmCall, runApprovalGate } from '../src/steps.mjs';
import { resolveKnobs } from '../src/run.mjs';

test('YAML model steps refuse an unconfigured model before any network request', async t => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; throw Error('unexpected network'); });
  const ctx = { apiKey: 'fixture-only', priorOutputs: {}, priorStepNames: {} };
  await assert.rejects(runLlmCall({kind:'llm-call',config:{instructions:'Summarize the supplied text.'}},ctx,null,100), /model is not configured/);
  await assert.rejects(runApprovalGate({kind:'approval-gate',config:{reviewer:'agent',rubric:'Contains a source.'}},ctx,null,100), /model is not configured/);
  assert.equal(calls,0);
  const human=await runApprovalGate({kind:'approval-gate',config:{reviewer:'human'}},ctx,null,100);
  assert.equal(human.waitingHuman,true);
  assert.equal(resolveKnobs({model:'explicit/model'}).model,'explicit/model');
});

test('YAML provider alias is forwarded for llm and agent gate without default-key fallback', async t => {
  const alias = 'QF_TEST_CUSTOM_ALIAS';
  const previous = process.env[alias];
  const previousDefault = process.env.OPENROUTER_API_KEY;
  process.env[alias] = 'custom-secret';
  delete process.env.OPENROUTER_API_KEY;
  t.after(() => {
    if (previous === undefined) delete process.env[alias];
    else process.env[alias] = previous;
    if (previousDefault === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = previousDefault;
  });
  const authHeaders = [];
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    authHeaders.push(init.headers.Authorization);
    const body = JSON.stringify({ id: 'fixture', model: 'test/model', choices: [{ message: { content: '{"pass":true,"reason":"ok"}' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, cost: 0 } });
    return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
  });
  const config = { instructions: 'write', keyRef: alias, secretSource: 'env' };
  const gateConfig = { reviewer: 'agent', rubric: 'pass', keyRef: alias, secretSource: 'env' };
  const ctx = { apiKey: undefined, priorOutputs: { candidate: { text: 'x' } }, priorStepNames: {} };
  await runLlmCall({ kind: 'llm-call', config }, ctx, 'test/model', 10);
  await runApprovalGate({ kind: 'approval-gate', config: gateConfig }, ctx, 'test/model', 10);

  // Supplying both credentials still selects the explicitly named alias.
  ctx.apiKey = 'default-secret';
  await runLlmCall({ kind: 'llm-call', config: { instructions: 'write', keyRef: alias, secretSource: 'env' } }, ctx, 'test/model', 10);
  await runApprovalGate({ kind: 'approval-gate', config: { reviewer: 'agent', rubric: 'pass', keyRef: alias, secretSource: 'env' } }, ctx, 'test/model', 10);
  assert.deepEqual(authHeaders, ['Bearer custom-secret', 'Bearer custom-secret', 'Bearer custom-secret', 'Bearer custom-secret']);

  const callsBeforeMissing = authHeaders.length;
  delete process.env[alias];
  await assert.rejects(
    runLlmCall({ kind: 'llm-call', config }, ctx, 'test/model', 10),
    (error) => error.code === 'AUTH_REQUIRED',
  );
  await assert.rejects(
    runApprovalGate({ kind: 'approval-gate', config: gateConfig }, ctx, 'test/model', 10),
    (error) => error.code === 'AUTH_REQUIRED',
  );
  assert.equal(authHeaders.length, callsBeforeMissing);
});
