/* Core39: bounded reasoning for OpenRouter calls (live Digest run 6d9d6559, 27.09: the fact-check call spent all
   14000 max_tokens on reasoning and returned an empty completion). */
import assert from "node:assert/strict";
import test from "node:test";
import { resolve } from "node:path";
import { openRouter } from "../src/providers/openrouter.mjs";
import { loadManifest } from "../src/manifest.mjs";

const base = { model: "anthropic/claude-sonnet-5", messages: [{ role: "user", content: "hi" }], payerScope: "local-byok", maxTokens: 100, retries: 0 };
const env = { OPENROUTER_API_KEY: "fixture-secret" };
const reply = (body) => async (url, init) => { reply.last = JSON.parse(init.body); return new Response(JSON.stringify(body)); };

test("reasoning is sent only when set: off disables it, low/medium/high bound it; other values are refused", async () => {
  const ok = { choices: [{ message: { content: "OK" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, cost: 0.000001 } };
  await openRouter(base, { env, fetcher: reply(ok) });
  assert.equal("reasoning" in reply.last, false, "no reasoning field unless the step sets one");
  await openRouter({ ...base, reasoning: "off" }, { env, fetcher: reply(ok) });
  assert.deepEqual(reply.last.reasoning, { enabled: false });
  for (const effort of ["low", "medium", "high"]) {
    await openRouter({ ...base, reasoning: effort }, { env, fetcher: reply(ok) });
    assert.deepEqual(reply.last.reasoning, { effort });
  }
  for (const bad of ["none", "LOW", "", "max"]) await assert.rejects(openRouter({ ...base, reasoning: bad }, { env, fetcher: reply(ok) }), /reasoning must be/, bad);
});

test("negative: all max_tokens spent before any content is OUTPUT_LIMIT with the reason, not a bare empty completion", async () => {
  const spent = { choices: [{ message: { content: "" }, finish_reason: "length" }], usage: { prompt_tokens: 6549, completion_tokens: 14000, cost: 0.153098 } };
  await assert.rejects(openRouter(base, { env, fetcher: reply(spent) }), (e) => e.code === "OUTPUT_LIMIT" && /before any content/.test(e.message) && e.usage.costUsd === 0.153098);
  const empty = { choices: [{ message: { content: "" }, finish_reason: "stop" }] };
  await assert.rejects(openRouter(base, { env, fetcher: reply(empty) }), { code: "INVALID_RESPONSE" });
});

test("Digest 0.6.x bounds the fact-check call's reasoning", () => {
  const m = loadManifest(resolve("registry/workflows/digest.yaml"));
  assert.equal(m.steps.find((s) => s.id === "factcheck").config.reasoning, "low");
});
