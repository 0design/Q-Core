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

test("live run 58c169c9: a quote may mark omissions with an ellipsis; a word left out silently, added or reordered is refused", async () => {
  const { runVerifySources } = await import("../src/registry-data-steps.mjs");
  const URL_ = "https://the-decoder.com/sol-pi";
  const TEXT = "SoL-Pi cuts coding agents' token usage by up to 49 percent with little change in performance by optimizing the control layer between the model and its environment.";
  const HEADER = "**Штучно-інтелектуальний дайджест під суботню каву на [ХУЇКС](https://t.me/xyiikc)і by [QFactory.io](https://QFactory.io) 🧋26.09**\n\n";
  const text = `${HEADER}- SoL-Pi скорочує використання токенів агентами для програмування до 49% ([The Decoder](${URL_}))`;
  const config = { draft: "{{steps.factcheck.output}}", factCheck: "{{steps.factcheck.output}}", sources: "{{steps.clusters.output}}", language: "uk", citation: "links", forbidLocalLinks: "true", fixedLinks: '["https://t.me/xyiikc","https://QFactory.io"]', requiredPrefix: HEADER, nestedList: "3" };
  const run = (quote) => runVerifySources({ config }, { priorOutputs: { clusters: { sources: [{ url: URL_, title: "Nvidia's SoL-Pi system", text: TEXT }] }, factcheck: { text, claims: [{ item: 1, verdict: "supported", sources: [URL_], quote: [quote] }] } }, priorStepNames: {} });
  process.env.QF_DIGEST_DATE = "26.09";
  assert.doesNotThrow(() => run("SoL-Pi cuts coding agents' token usage by up to 49 percent"), "verbatim");
  assert.doesNotThrow(() => run("SoL-Pi cuts … token usage by up to 49 percent with little change in performance"), "an omission marked with …");
  assert.doesNotThrow(() => run("SoL-Pi cuts ... token usage by up to 49 percent"), "an omission marked with ...");
  for (const [bad, why] of [
    ["cuts token usage by up to 49 percent with little change in performance", "the live quote: two words left out silently"],
    ["SoL-Pi cuts … token usage by up to 60 percent", "a piece the source does not have"],
    ["token usage by up to 49 percent … SoL-Pi cuts coding", "pieces out of order"],
    ["cuts … 49 percent", "a one-word piece"],
  ]) assert.throws(() => run(bad), /the quote is not in the text of its linked sources/, why);
});
