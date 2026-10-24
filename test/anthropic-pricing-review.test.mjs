import { test } from "node:test";
import assert from "node:assert/strict";
import { anthropicModel, anthropicUsageCost, anthropicUsdForModelTokens, worstCaseAnthropicCallUsd } from "../src/cost.mjs";
import { anthropic } from "../src/providers/anthropic.mjs";

const near = (actual, expected) => assert.ok(typeof actual === "number" && Math.abs(actual - expected) < 1e-12, `${actual} != ${expected}`);
const model = "claude-sonnet-5";
const ordinary = { input_tokens: 1000, output_tokens: 100 };
const cached = {
  ...ordinary, cache_read_input_tokens: 30, cache_creation_input_tokens: 30,
  cache_creation: { ephemeral_5m_input_tokens: 10, ephemeral_1h_input_tokens: 20 },
};
const request = {
  model: "anthropic/claude-haiku-4.5", messages: [{ role: "user", content: "hello" }],
  payerScope: "local-byok", maxTokens: 100, retries: 0, timeoutMs: 1000,
};
function response(usage, answeredModel = "claude-haiku-4-5-20251001") {
  return new Response(JSON.stringify({
    id: "msg-pricing-review", model: answeredModel, content: [{ type: "text", text: "Done" }],
    stop_reason: "end_turn", usage,
  }), { status: 200, headers: { "content-type": "application/json" } });
}
const run = (usage, answeredModel, overrides = {}) => anthropic({ ...request, ...overrides }, {
  env: {}, secretResolver: async () => "fixture-only-pricing-key",
  fetcher: async () => response(usage, answeredModel),
});

test("Anthropic snapshot pricing: documented Haiku response ID resolves explicitly", async () => {
  assert.equal(anthropicModel("claude-haiku-4-5-20251001").id, "claude-haiku-4-5-20251001");
  near(anthropicUsdForModelTokens("claude-haiku-4-5-20251001", 1000, 100), 0.0015);
  const result = await run(ordinary);
  assert.equal(result.provider.requestedModel, "anthropic/claude-haiku-4.5");
  assert.equal(result.provider.model, "claude-haiku-4-5-20251001");
  near(result.usage.costUsd, 0.0015);
  let sent;
  await anthropic({ ...request, model: "claude-haiku-4-5-20251001" }, {
    env: {}, secretResolver: async () => "fixture-only-pricing-key",
    fetcher: async (_url, init) => { sent = JSON.parse(init.body); return response(ordinary); },
  });
  assert.equal(sent.model, "claude-haiku-4-5-20251001", "a pinned request must not be rewritten to a mutable alias");
});

test("Anthropic snapshot pricing: arbitrary dated IDs remain unknown", async () => {
  for (const unknown of ["claude-haiku-4-5-20251002", "claude-haiku-5-5-20261001", "claude-sonnet-5-20261001", "claude-opus-5-5-20261001"]) {
    assert.equal(anthropicModel(unknown), null, unknown);
    assert.equal(anthropicUsdForModelTokens(unknown, 1000, 100), null, unknown);
    const result = await run(ordinary, unknown);
    assert.equal(result.usage.costUsd, null, "unknown answering model must not borrow the requested alias price");
  }
});

test("Anthropic snapshot pricing: each supported alias and canonical response ID agree", () => {
  for (const [alias, actual, cost] of [
    ["anthropic/claude-haiku-5.5", "claude-haiku-5-5", 0.00015],
    ["anthropic/claude-sonnet-5", "claude-sonnet-5", 0.003],
    ["anthropic/claude-opus-5.5", "claude-opus-5-5", 0.006],
    ["anthropic/claude-haiku-4.5", "claude-haiku-4-5-20251001", 0.0015],
  ]) {
    assert.deepEqual([anthropicModel(alias).in, anthropicModel(alias).out], [anthropicModel(actual).in, anthropicModel(actual).out]);
    near(anthropicUsageCost(actual, ordinary).costUsd, cost);
    near(anthropicUsageCost(alias, ordinary).costUsd, cost);
  }
});

test("Anthropic cache pricing: ordinary input, reads and both write durations retain distinct rates", () => {
  const actual = anthropicUsageCost(model, cached);
  assert.deepEqual([actual.tokensIn, actual.tokensOut], [1060, 100]);
  near(actual.costUsd, 0.003111);
  near(anthropicUsageCost(model, { ...ordinary, cache_read_input_tokens: 1000 }).costUsd, 0.0032);
  near(anthropicUsageCost(model, { ...ordinary, cache_creation_input_tokens: 1000,
    cache_creation: { ephemeral_5m_input_tokens: 1000 } }).costUsd, 0.0055);
  near(anthropicUsageCost(model, { ...ordinary, cache_creation_input_tokens: 1000,
    cache_creation: { ephemeral_1h_input_tokens: 1000 } }).costUsd, 0.007);
  near(anthropicUsageCost(model, ordinary).costUsd, 0.003);
});

// Independent USD/MTok expectations from the official pricing/model pages,
// checked 2026-10-23; do not derive cache prices from the implementation table.
for (const [name, pricedModel, tokens, input, output, write5m, write1h, read] of [
  ["Haiku 5.5 short context", "claude-haiku-5-5", 1000, 0.10, 0.50, 0.125, 0.20, 0.01],
  ["Haiku 5.5 long context", "claude-haiku-5-5", 100_001, 0.50, 2.50, 0.625, 1, 0.05],
  ["Sonnet 5", "claude-sonnet-5", 1000, 2, 10, 2.50, 4, 0.20],
  ["Opus 5.5", "claude-opus-5-5", 1000, 4, 20, 5, 8, 0.20],
  ["Haiku 4.5 alias", "claude-haiku-4-5", 1000, 1, 5, 1.25, 2, 0.10],
  ["Haiku 4.5 snapshot", "claude-haiku-4-5-20251001", 1000, 1, 5, 1.25, 2, 0.10],
]) {
  test(`Anthropic official pricing: ${name} prices each token category independently`, () => {
    near(anthropicUsageCost(pricedModel, { input_tokens: tokens, output_tokens: 0 }).costUsd, tokens * input / 1_000_000);
    near(anthropicUsageCost(pricedModel, { input_tokens: 0, cache_read_input_tokens: tokens, output_tokens: 0 }).costUsd, tokens * read / 1_000_000);
    near(anthropicUsageCost(pricedModel, { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: tokens,
      cache_creation: { ephemeral_5m_input_tokens: tokens } }).costUsd, tokens * write5m / 1_000_000);
    near(anthropicUsageCost(pricedModel, { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: tokens,
      cache_creation: { ephemeral_1h_input_tokens: tokens } }).costUsd, tokens * write1h / 1_000_000);
    // A long-context output charge needs a long prompt to select that tier.
    const prompt = tokens > 100_000 ? tokens : 0;
    near(anthropicUsageCost(pricedModel, { input_tokens: prompt, output_tokens: 1000 }).costUsd,
      (prompt * input + 1000 * output) / 1_000_000);
  });
}

test("Anthropic official pricing: Opus 5.5 cache reads reject the former universal 0.1x price", async () => {
  const usage = { input_tokens: 0, cache_read_input_tokens: 1_000_000, output_tokens: 0 };
  const priced = anthropicUsageCost("claude-opus-5-5", usage);
  assert.equal(priced.costUsd, 0.20);
  assert.notEqual(priced.costUsd, 0.40, "Opus 5.5 reads must not use 10% of its $4 input rate");
  const result = await run(usage, "claude-opus-5-5", { model: "claude-opus-5-5" });
  assert.equal(result.usage.costUsd, 0.20, "the native provider must record the model-specific read cost");
});

test("Anthropic cache pricing: JSON provider response prices the dated answering model and durations", async () => {
  const actual = await run(cached);
  assert.deepEqual([actual.usage.tokensIn, actual.usage.tokensOut], [1060, 100]);
  near(actual.usage.costUsd, 0.0015555);
});

test("Anthropic cache pricing: streaming keeps the start-event duration breakdown through output usage", async () => {
  const event = value => `event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`;
  const stream = event({ type: "message_start", message: { id: "msg-cache-stream", model: "claude-haiku-4-5-20251001", usage: { ...cached, output_tokens: 0 } } })
    + event({ type: "content_block_delta", delta: { type: "text_delta", text: "Done" } })
    + event({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 100 } })
    + event({ type: "message_stop" });
  const actual = await anthropic(request, { env: {}, secretResolver: async () => "fixture-only-pricing-key",
    fetcher: async () => new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } }) });
  assert.deepEqual([actual.usage.tokensIn, actual.usage.tokensOut], [1060, 100]);
  near(actual.usage.costUsd, 0.0015555);
});

test("Anthropic cache pricing: total input alone selects the context tier at the threshold", () => {
  const usage = {
    input_tokens: 99_999, cache_read_input_tokens: 1, cache_creation_input_tokens: 0, output_tokens: 100,
  };
  near(anthropicUsageCost("claude-haiku-5-5", usage).costUsd, 0.01004991);
  const over = { ...usage, cache_creation_input_tokens: 1, cache_creation: { ephemeral_5m_input_tokens: 1 } };
  const actual = anthropicUsageCost("claude-haiku-5-5", over);
  assert.equal(actual.tokensIn, 100_001);
  near(actual.costUsd, 0.050250175);
  // Cache-heavy prompts also select the higher tier even with no ordinary input.
  near(anthropicUsageCost("claude-haiku-5-5", { input_tokens: 0, cache_read_input_tokens: 100_001, output_tokens: 100 }).costUsd, 0.00525005);
});

test("Anthropic cache pricing: unknown duration, inconsistent totals and malformed fields fail closed", async () => {
  const invalid = [
    { ...ordinary, cache_creation_input_tokens: 30 },
    { ...cached, cache_creation: null },
    { ...cached, cache_creation: [] },
    { ...cached, cache_creation: { ephemeral_5m_input_tokens: 10, ephemeral_1h_input_tokens: 19 } },
    { ...cached, cache_creation: { ephemeral_5m_input_tokens: 10, ephemeral_1h_input_tokens: 20, ephemeral_2h_input_tokens: 1 } },
    { ...cached, cache_creation_input_tokens: undefined },
    { ...cached, cache_creation: { ephemeral_5m_input_tokens: "10", ephemeral_1h_input_tokens: 20 } },
    { ...cached, cache_read_input_tokens: -1 },
    { ...cached, input_tokens: 0.5 },
    { ...cached, input_tokens: Number.MAX_SAFE_INTEGER },
    { ...cached, output_tokens: null },
  ];
  for (const usage of invalid) {
    assert.equal(anthropicUsageCost(model, usage).costUsd, null, JSON.stringify(usage));
    assert.equal((await run(usage)).usage.costUsd, null, "provider must preserve the unknown price");
  }
});

test("Anthropic cache pricing: no-cache and explicitly empty cache counts remain valid", () => {
  for (const usage of [ordinary, { ...ordinary, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    { ...ordinary, cache_creation_input_tokens: 0, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 } }]) {
    near(anthropicUsageCost(model, usage).costUsd, 0.003);
  }
});

test("Anthropic cost reservation: every attempt covers 1h cache writes and the resulting context tier", () => {
  const worst = worstCaseAnthropicCallUsd({ model: "claude-haiku-5-5", messagesBytes: 100_000, maxTokens: 100, attempts: 3 });
  near(worst, 3 * (100_064 * 2 * 0.5 + 100 * 2.5) / 1_000_000);
  const actual = anthropicUsageCost("claude-haiku-5-5", { input_tokens: 0, cache_creation_input_tokens: 100_064,
    cache_creation: { ephemeral_1h_input_tokens: 100_064 }, output_tokens: 100 });
  near(worst, actual.costUsd * 3);
});

test("Anthropic cost reservation: unpriced models and invalid bounds never yield a usable price", () => {
  const bounds = { model, messagesBytes: 1000, maxTokens: 100, attempts: 1 };
  for (const bad of [{ model: "claude-haiku-4-5-20251002" }, { messagesBytes: -1 }, { maxTokens: 0 }, { attempts: 0 }, { attempts: 0.5 }, { messagesBytes: Number.MAX_SAFE_INTEGER }]) {
    assert.equal(worstCaseAnthropicCallUsd({ ...bounds, ...bad }), null);
  }
});
