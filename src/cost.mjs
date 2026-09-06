/**
 * Tokens → USD. The runner's copy of the rate table in `lib/cost/estimate.ts`.
 *
 * The figure matters for one reason only: the budget knob cuts BEFORE a paid
 * step, and it cuts on this number. If the two homes priced a run differently,
 * the same manifest would stop at a different step depending on where it ran —
 * which would make the parity test a lie even while it passed.
 *
 * ⚠️ Carried over verbatim, including its known quirk: the engine's
 * `usdForTokens` bills at the DEFAULT model's rate, not the rate of the model the
 * step actually used. Reproduced here rather than corrected — a runner that is
 * "more correct" than the engine still disagrees with it, and the point of this
 * file is agreement. Fixing it is a change to both, at once, on purpose.
 */

/** USD per 1M tokens: [prompt, completion]. Source: OpenRouter's public price list. */
const PRICE_PER_MTOK = {
  /* Verified against https://openrouter.ai/api/v1/models on 2026-08-01, not
     remembered. `anthropic/claude-3.5-haiku` used to sit here and DOES NOT
     EXIST on OpenRouter — a manifest naming it got a 404 from the provider,
     caught by running a catalogue loop rather than by reading it. */
  "anthropic/claude-3-haiku": [0.25, 1.25],
  "anthropic/claude-haiku-4.5": [1, 5],
  "anthropic/claude-sonnet-4": [3, 15],
  "anthropic/claude-sonnet-4.5": [3, 15],
  "anthropic/claude-sonnet-4.6": [3, 15],
  "openai/gpt-4o-mini": [0.15, 0.6],
};

/* Unknown model → the most expensive rate. The error may only lean towards
   OVERestimating: underestimating would let a run spend past its ceiling. */
const FALLBACK_PER_MTOK = [3, 15];

/** The model the factory bills at by default — `lib/tasks/executor.ts#MODEL`. */
export const DEFAULT_MODEL = "anthropic/claude-3-haiku";

function rateFor(model) {
  const key = String(model ?? "").trim().toLowerCase();
  return PRICE_PER_MTOK[key] ?? FALLBACK_PER_MTOK;
}

export function usdPerTokenIn(model) {
  return rateFor(model ?? DEFAULT_MODEL)[0] / 1_000_000;
}
export function usdPerTokenOut(model) {
  return rateFor(model ?? DEFAULT_MODEL)[1] / 1_000_000;
}

const USD_PER_TOKEN_IN = usdPerTokenIn();
const USD_PER_TOKEN_OUT = usdPerTokenOut();

/** What a completed step costs. Matches `usdForTokens` in the engine, quirk included. */
export function usdForTokens(tokensIn, tokensOut) {
  const tin = Number.isFinite(tokensIn) ? Math.max(0, tokensIn) : 0;
  const tout = Number.isFinite(tokensOut) ? Math.max(0, tokensOut) : 0;
  return tin * USD_PER_TOKEN_IN + tout * USD_PER_TOKEN_OUT;
}
