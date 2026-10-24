/**
 * Tokens → USD, used for two things only:
 *
 *   1. What a finished OpenRouter step cost, when the provider did NOT report a
 *      cost itself. The provider's own `usage.cost` always wins (see
 *      `stepCostUsd`). The table below is a fallback for the exact model that
 *      answered; it never prices one model at another model's rate.
 *   2. The worst case of a call BEFORE it is made (`worstCaseCallUsd`), for the
 *      per-call money cap `maxCallCostUsd`.
 *
 * An unknown model has NO price here. Its cost is `null` (unknown), never an
 * invented figure: a made-up rate either under-reports spend or looks like a
 * receipt that never existed. Budget safety does not depend on guessing — the
 * runner stops before the next paid step while any spend is unknown (see the
 * budget gate in run.mjs), and a per-call cap refuses a model it cannot price.
 */

/** USD per 1M tokens: [prompt, completion]. Source: OpenRouter's public model list
    (https://openrouter.ai/api/v1/models), checked on 2026-09-26. Models that
    left the list are removed rather than kept at a stale price. */
const PRICE_PER_MTOK = {
  "anthropic/claude-haiku-4.5": [1, 5],
  // Added 2026-09-27 from the OpenRouter listing, so a step can run it under a budget.
  "anthropic/claude-opus-5.5": [4, 20],
  "anthropic/claude-sonnet-4": [3, 15],
  "anthropic/claude-sonnet-4.5": [3, 15],
  "anthropic/claude-sonnet-4.6": [3, 15],
  "anthropic/claude-sonnet-5": [2, 10],
  "mistralai/mistral-nemo": [0.019, 0.03],
  "openai/gpt-4o-mini": [0.15, 0.6],
};

/** [USD per prompt token, USD per completion token], or null when the model is not priced here. */
export function rateForModel(model) {
  const key = String(model ?? "").trim().toLowerCase();
  const rate = PRICE_PER_MTOK[key];
  return rate ? [rate[0] / 1_000_000, rate[1] / 1_000_000] : null;
}

const count = (n) => (Number.isFinite(n) && n >= 0 ? n : null);

/** Table price of a finished call for the model that answered, or null (unknown model or token counts). */
export function usdForModelTokens(model, tokensIn, tokensOut) {
  const rate = rateForModel(model);
  const tin = count(tokensIn), tout = count(tokensOut);
  if (!rate || tin === null || tout === null) return null;
  return tin * rate[0] + tout * rate[1];
}

/**
 * The cost of one finished OpenRouter step and where the number came from:
 * the provider's `usage.cost` → the table price of the model that answered →
 * `{ costUsd: null, costSource: "unknown" }`. Never a fallback rate.
 */
export function stepCostUsd({ providerCostUsd, model, tokensIn, tokensOut }) {
  if (Number.isFinite(providerCostUsd) && providerCostUsd >= 0)
    return { costUsd: providerCostUsd, costSource: "provider" };
  const table = usdForModelTokens(model, tokensIn, tokensOut);
  return table === null ? { costUsd: null, costSource: "unknown" } : { costUsd: table, costSource: "rate-table" };
}

/**
 * Upper bound, in USD, of one call BEFORE it is made, or null when the model is
 * not priced. Prompt tokens are bounded by the UTF-8 byte length of the request
 * messages (a token covers at least one byte) plus a per-message allowance;
 * completion tokens by `maxTokens`. Every billable attempt counts: retries
 * multiply the bound.
 */
export function worstCaseCallUsd({ model, messagesBytes, maxTokens, attempts = 1 }) {
  const rate = rateForModel(model);
  if (!rate) return null;
  const promptTokens = messagesBytes + 64;
  return attempts * (promptTokens * rate[0] + maxTokens * rate[1]);
}

/** First-party Anthropic prices in USD per 1M tokens, checked 2026-10-23:
 * https://platform.claude.com/docs/en/about-claude/pricing
 * https://platform.claude.com/docs/en/models/haiku-5-5/overview
 * https://platform.claude.com/docs/en/models/sonnet-5/overview
 * https://platform.claude.com/docs/en/models/opus-5-5/overview
 * https://platform.claude.com/docs/en/models/haiku-4-5/overview
 * Keep every cache rate explicit: Opus 5.5 reads cost $0.20, not 0.1x input.
 * These are separate from the OpenRouter fallback table: choosing a provider
 * must not change what an existing OpenRouter call is charged or can spend. */
const ANTHROPIC_MODELS = Object.freeze({
  "claude-haiku-5-5": Object.freeze({ id: "claude-haiku-5-5",
    in: 0.10, out: 0.50, cacheWrite5m: 0.125, cacheWrite1h: 0.20, cacheRead: 0.01,
    longIn: 0.50, longOut: 2.50, longCacheWrite5m: 0.625, longCacheWrite1h: 1, longCacheRead: 0.05,
    longAbove: 100_000, sampling: false, canDisable: true }),
  "claude-sonnet-5": Object.freeze({ id: "claude-sonnet-5",
    in: 2, out: 10, cacheWrite5m: 2.50, cacheWrite1h: 4, cacheRead: 0.20,
    sampling: false, canDisable: true }),
  // Standard $2/$10 rates supplied for Sonnet 5.5; Anthropic cache multipliers
  // are 1.25x for 5m writes, 2x for 1h writes, and 0.1x for reads.
  "claude-sonnet-5-5": Object.freeze({ id: "claude-sonnet-5-5",
    in: 2, out: 10, cacheWrite5m: 2.50, cacheWrite1h: 4, cacheRead: 0.20,
    sampling: false, canDisable: true }),
  "claude-opus-5-5": Object.freeze({ id: "claude-opus-5-5",
    in: 4, out: 20, cacheWrite5m: 5, cacheWrite1h: 8, cacheRead: 0.20,
    sampling: false, canDisable: false }),
  "claude-haiku-4-5": Object.freeze({ id: "claude-haiku-4-5",
    in: 1, out: 5, cacheWrite5m: 1.25, cacheWrite1h: 2, cacheRead: 0.10,
    sampling: true, legacy: true }),
});
const ANTHROPIC_ALIASES = Object.freeze({
  "anthropic/claude-haiku-5.5": "claude-haiku-5-5",
  "anthropic/claude-sonnet-5": "claude-sonnet-5",
  "anthropic/claude-sonnet-5.5": "claude-sonnet-5-5",
  "anthropic/claude-opus-5.5": "claude-opus-5-5",
  "anthropic/claude-haiku-4.5": "claude-haiku-4-5",
});
// Explicit response IDs only: a suffix is not proof of a supported snapshot.
// Haiku 4.5's documented dated ID is also the model returned for alias calls.
const ANTHROPIC_SNAPSHOTS = Object.freeze({
  "claude-haiku-4-5-20251001": Object.freeze({ ...ANTHROPIC_MODELS["claude-haiku-4-5"], id: "claude-haiku-4-5-20251001" }),
});

/** Canonical first-party model and capabilities, or null for an unknown model. */
export function anthropicModel(model) {
  const key = String(model ?? "").trim().toLowerCase();
  const id = Object.hasOwn(ANTHROPIC_ALIASES, key) ? ANTHROPIC_ALIASES[key] : key;
  return Object.hasOwn(ANTHROPIC_MODELS, id) ? ANTHROPIC_MODELS[id]
    : Object.hasOwn(ANTHROPIC_SNAPSHOTS, id) ? ANTHROPIC_SNAPSHOTS[id] : null;
}

/** Ordinary-input compatibility helper. Cache-bearing responses must use
 * anthropicUsageCost so their distinct input rates and durations are retained. */
export function anthropicUsdForModelTokens(model, tokensIn, tokensOut) {
  const entry = anthropicModel(model);
  const tin = count(tokensIn), tout = count(tokensOut);
  if (!entry || tin === null || tout === null) return null;
  const long = entry.longAbove !== undefined && tin > entry.longAbove;
  return (tin * (long ? entry.longIn : entry.in) + tout * (long ? entry.longOut : entry.out)) / 1_000_000;
}

const anthropicCount = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const optionalAnthropicCount = value => value === undefined ? 0 : anthropicCount(value);

/** Price the native usage fields separately at explicit model-specific rates.
 * Total input selects the context tier for every token category.
 * A positive aggregate write count without a valid duration breakdown cannot
 * establish a price. Never silently treat unknown writes as ordinary input. */
export function anthropicUsageCost(model, usage) {
  const entry = anthropicModel(model);
  const regular = anthropicCount(usage?.input_tokens);
  const read = optionalAnthropicCount(usage?.cache_read_input_tokens);
  const write = optionalAnthropicCount(usage?.cache_creation_input_tokens);
  const total = regular === null || read === null || write === null ? null : regular + read + write;
  const tokensIn = Number.isSafeInteger(total) ? total : null;
  const tokensOut = anthropicCount(usage?.output_tokens);
  const unknown = { tokensIn, tokensOut, costUsd: null };
  if (!entry || tokensIn === null || tokensOut === null) return unknown;

  let write5m = 0, write1h = 0;
  if (usage?.cache_creation !== undefined) {
    const creation = usage.cache_creation;
    if (!creation || typeof creation !== "object" || Array.isArray(creation)
      || Object.keys(creation).some(key => !["ephemeral_5m_input_tokens", "ephemeral_1h_input_tokens"].includes(key))) return unknown;
    write5m = optionalAnthropicCount(creation.ephemeral_5m_input_tokens);
    write1h = optionalAnthropicCount(creation.ephemeral_1h_input_tokens);
    if (write5m === null || write1h === null || write5m + write1h !== write) return unknown;
  } else if (write > 0) return unknown;

  const long = entry.longAbove !== undefined && tokensIn > entry.longAbove;
  const inputRate = long ? entry.longIn : entry.in;
  const outputRate = long ? entry.longOut : entry.out;
  const readRate = long ? entry.longCacheRead : entry.cacheRead;
  const write5mRate = long ? entry.longCacheWrite5m : entry.cacheWrite5m;
  const write1hRate = long ? entry.longCacheWrite1h : entry.cacheWrite1h;
  return { tokensIn, tokensOut,
    costUsd: (regular * inputRate + read * readRate + write5m * write5mRate + write1h * write1hRate + tokensOut * outputRate) / 1_000_000 };
}

/** Conservative prompt-byte and all-attempt bound for the native provider.
 * Bound every input token at the highest cache-write rate (1h, 2x), including
 * any context-tier change, even though normal string requests do not ask to
 * populate the cache. */
export function worstCaseAnthropicCallUsd({ model, messagesBytes, maxTokens, attempts = 1 }) {
  if (!Number.isSafeInteger(messagesBytes) || messagesBytes < 0
    || !Number.isSafeInteger(maxTokens) || maxTokens <= 0
    || !Number.isSafeInteger(attempts) || attempts <= 0) return null;
  const input = messagesBytes + 64;
  const { costUsd: single } = anthropicUsageCost(model, { input_tokens: 0, output_tokens: maxTokens,
    cache_creation_input_tokens: input, cache_creation: { ephemeral_1h_input_tokens: input } });
  return single === null ? null : attempts * single;
}
