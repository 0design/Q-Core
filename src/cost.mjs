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
