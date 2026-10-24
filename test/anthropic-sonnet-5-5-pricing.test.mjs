import { test } from "node:test";
import assert from "node:assert/strict";
import {
  anthropicModel, anthropicUsageCost, anthropicUsdForModelTokens,
  rateForModel, worstCaseAnthropicCallUsd,
} from "../src/cost.mjs";

const model = "claude-sonnet-5-5";
const near = (actual, expected) => assert.ok(typeof actual === "number" && Math.abs(actual - expected) < 1e-12,
  `${actual} != ${expected}`);

test("Sonnet 5.5 pricing: canonical model and native alias use standard input/output rates", () => {
  for (const id of [model, "anthropic/claude-sonnet-5.5"]) {
    assert.equal(anthropicModel(id).id, model);
    near(anthropicUsdForModelTokens(id, 1_000_000, 1_000_000), 12);
    assert.deepEqual(anthropicUsageCost(id, { input_tokens: 1000, output_tokens: 100 }),
      { tokensIn: 1000, tokensOut: 100, costUsd: 0.003 });
  }
  assert.equal(rateForModel("anthropic/claude-sonnet-5.5"), null,
    "support in the native provider must not invent an OpenRouter price");
});

// Independent expectations: task-supplied $2/$10 standard prices and the
// Anthropic cache multipliers documented in docs/reference.md: 0.1x/1.25x/2x.
for (const [category, usage, expected] of [
  ["ordinary input", { input_tokens: 1_000_000, output_tokens: 0 }, 2],
  ["output", { input_tokens: 0, output_tokens: 1_000_000 }, 10],
  ["cache reads", { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 1_000_000 }, 0.20],
  ["five-minute writes", { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 1_000_000,
    cache_creation: { ephemeral_5m_input_tokens: 1_000_000 } }, 2.50],
  ["one-hour writes", { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 1_000_000,
    cache_creation: { ephemeral_1h_input_tokens: 1_000_000 } }, 4],
]) {
  test(`Sonnet 5.5 pricing: ${category} retains its own rate`, () => {
    near(anthropicUsageCost(model, usage).costUsd, expected);
  });
}

test("Sonnet 5.5 pricing: mixed usage counts every category once", () => {
  assert.deepEqual(anthropicUsageCost(model, {
    input_tokens: 1000, output_tokens: 100, cache_read_input_tokens: 30,
    cache_creation_input_tokens: 30,
    cache_creation: { ephemeral_5m_input_tokens: 10, ephemeral_1h_input_tokens: 20 },
  }), { tokensIn: 1060, tokensOut: 100, costUsd: 0.003111 });
});

test("Sonnet 5.5 pricing: each reserved attempt covers one-hour cache writes", () => {
  near(worstCaseAnthropicCallUsd({ model, messagesBytes: 1000, maxTokens: 100, attempts: 3 }),
    3 * (1064 * 4 + 100 * 10) / 1_000_000);
});

test("Sonnet 5.5 pricing: missing or inconsistent cache durations remain unpriced", () => {
  for (const usage of [
    { input_tokens: 1000, output_tokens: 100, cache_creation_input_tokens: 30 },
    { input_tokens: 1000, output_tokens: 100, cache_creation_input_tokens: 30,
      cache_creation: { ephemeral_5m_input_tokens: 10, ephemeral_1h_input_tokens: 19 } },
    { input_tokens: 1000, output_tokens: 100, cache_read_input_tokens: -1 },
  ]) assert.equal(anthropicUsageCost(model, usage).costUsd, null);
});

test("Sonnet 5.5 pricing: an arbitrary snapshot cannot borrow the alias price", () => {
  const unknown = "claude-sonnet-5-5-20261024";
  assert.equal(anthropicModel(unknown), null);
  assert.equal(anthropicUsageCost(unknown, { input_tokens: 1000, output_tokens: 100 }).costUsd, null);
  assert.equal(worstCaseAnthropicCallUsd({ model: unknown, messagesBytes: 1000, maxTokens: 100 }), null);
});
