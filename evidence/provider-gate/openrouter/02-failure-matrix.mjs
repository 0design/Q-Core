// Step 2 — failure matrix on the pinned Core29 adapter, without paid inference.
// "real" rows reach OpenRouter or the macOS Keychain but can never be billed:
// a bogus credential (401), an invalid model id (400), a 1 ms deadline or a
// pre-aborted signal. "stub" rows inject a transport to prove classification,
// retry bounds and body limits deterministically. No row uses the stored key
// for inference.
// Usage: QCORE_PKG=<pkg dir> node 02-failure-matrix.mjs
import { mkdirSync } from "node:fs";
import { loadCore, OUT, MODEL, writeEvidence } from "./common.mjs";

mkdirSync(OUT, { recursive: true });
const { core, version } = await loadCore();
const { openRouter } = core;

const messages = [{ role: "user", content: "Say: ok" }];
const base = { messages, model: MODEL, payerScope: "local-byok", maxTokens: 8, temperature: 0, retries: 0, timeoutMs: 20000 };
// Not key-shaped on purpose: it must not look like, or be, a real credential.
const bogus = async () => "qf-evidence-invalid-credential";

const json = (status, body) =>
  new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
const ok = (extra = {}) => ({
  id: "gen-stub",
  model: MODEL,
  choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 5, completion_tokens: 1, cost: 0.0000001 },
  ...extra,
});

async function attempt(fn) {
  const t0 = Date.now();
  try {
    const r = await fn();
    return { outcome: "success", ms: Date.now() - t0, result: { requestId: r.requestId, model: r.provider.model, usage: r.usage } };
  } catch (e) {
    return { outcome: "error", ms: Date.now() - t0, code: e.code ?? e.name, message: e.message };
  }
}

// Replace global fetch for stubbed transport rows while keeping Core's own fetchWithRetry.
async function withFetch(stub, fn) {
  const real = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (...a) => { calls++; return stub(calls, ...a); };
  try { return { ...(await fn()), networkAttempts: calls }; } finally { globalThis.fetch = real; }
}

const rows = [];
const row = async (id, kind, expect, fn) => {
  const r = await fn();
  const pass = typeof expect === "function" ? expect(r) : r.code === expect;
  rows.push({ id, kind, expect: typeof expect === "function" ? "see check" : expect, pass, ...r });
};

// ── Credential boundary ───────────────────────────────────────────────
await row("missing-key-other-keyRef-keychain", "real-keychain", "SECRET_MISSING", () =>
  withFetch(() => { throw new Error("network must not be reached"); }, () =>
    attempt(() => openRouter({ ...base, keyRef: "QF_EVIDENCE_ABSENT_KEY", secretSource: "keychain" }))));
await row("missing-key-env-no-fallback", "real", "AUTH_REQUIRED", () =>
  withFetch(() => { throw new Error("network must not be reached"); }, () =>
    attempt(() => openRouter({ ...base, keyRef: "QF_EVIDENCE_ABSENT_KEY", secretSource: "env" }, { env: {} }))));
await row("invalid-secretSource", "real", "INVALID_REQUEST", () =>
  attempt(() => openRouter({ ...base, secretSource: "vault" })));
await row("401-invalid-credential", "real-network", "AUTH_REQUIRED", () =>
  attempt(() => openRouter(base, { secretResolver: bogus })));

// ── Invalid model: reaches OpenRouter with the stored key; 400, not billed ──
await row("invalid-model-id", "real-network-stored-key", (r) => r.code === "PROVIDER_ERROR" && /OpenRouter 400/.test(r.message), () =>
  attempt(() => openRouter({ ...base, model: "qf-evidence/not-a-model", secretSource: "keychain" })));
// ── Caps: rejected before any network ─────────────────────────────────
for (const [id, patch] of [
  ["cap-maxTokens-over-32000", { maxTokens: 32001 }],
  ["cap-maxTokens-zero", { maxTokens: 0 }],
  ["cap-retries-over-10", { retries: 11 }],
  ["cap-messages-over-128000-bytes", { messages: [{ role: "user", content: "x".repeat(128001) }] }],
  ["missing-payerScope", { payerScope: undefined }],
  ["missing-model", { model: "" }],
]) {
  await row(id, "real-precheck", (r) => r.code === "INVALID_REQUEST" && r.networkAttempts === 0, () =>
    withFetch(() => { throw new Error("network must not be reached"); }, () =>
      attempt(() => openRouter({ ...base, ...patch }, { secretResolver: bogus }))));
}

// ── Timeout / cancellation ────────────────────────────────────────────
await row("timeout-1ms-client-deadline", "real-client-deadline", "TIMEOUT", () =>
  attempt(() => openRouter({ ...base, timeoutMs: 1 }, { secretResolver: bogus })));
{
  const ac = new AbortController();
  ac.abort();
  await row("cancel-pre-aborted", "real", "CANCELLED", () =>
    attempt(() => openRouter({ ...base, signal: ac.signal }, { secretResolver: bogus })));
}
{
  const ac = new AbortController();
  await row("cancel-in-flight", "stub", (r) => r.code === "CANCELLED" && r.networkAttempts === 1, () =>
    withFetch((n, _u, init) => new Promise((_, rej) => {
      init.signal.addEventListener("abort", () => rej(init.signal.reason));
      setTimeout(() => ac.abort(), 20);
    }), () => attempt(() => openRouter({ ...base, signal: ac.signal }, { secretResolver: bogus }))));
}

// ── 429 / 5xx and retry bounds ────────────────────────────────────────
for (const [status, code] of [[429, "RATE_LIMITED"], [500, "PROVIDER_ERROR"], [503, "PROVIDER_ERROR"]]) {
  await row(`${status}-retries-0`, "stub", (r) => r.code === code && r.networkAttempts === 1, () =>
    withFetch(() => json(status, { error: { code: status } }), () => attempt(() => openRouter(base, { secretResolver: bogus }))));
}
await row("429-retries-2-bounded-to-3-attempts", "stub", (r) => r.code === "RATE_LIMITED" && r.networkAttempts === 3, () =>
  withFetch(() => json(429, {}), () => attempt(() => openRouter({ ...base, retries: 2, delaysMs: [0] }, { secretResolver: bogus }))));
await row("503-then-success-retries-1", "stub", (r) => r.outcome === "success" && r.networkAttempts === 2, () =>
  withFetch((n) => (n === 1 ? json(503, {}) : json(200, ok())), () =>
    attempt(() => openRouter({ ...base, retries: 1, delaysMs: [0] }, { secretResolver: bogus }))));
await row("400-not-retried", "stub", (r) => r.code === "PROVIDER_ERROR" && r.networkAttempts === 1, () =>
  withFetch(() => json(400, {}), () => attempt(() => openRouter({ ...base, retries: 3, delaysMs: [0] }, { secretResolver: bogus }))));

// ── Response shape ────────────────────────────────────────────────────
await row("success-with-usage-cost", "stub", (r) => r.outcome === "success" && r.result.usage.costUsd === 0.0000001, () =>
  withFetch(() => json(200, ok()), () => attempt(() => openRouter(base, { secretResolver: bogus }))));
await row("missing-usage-and-cost-are-null", "stub", (r) => r.outcome === "success" && r.result.usage.tokensIn === null && r.result.usage.costUsd === null, () =>
  withFetch(() => json(200, ok({ usage: undefined })), () => attempt(() => openRouter(base, { secretResolver: bogus }))));
await row("invalid-metrics-are-null", "stub", (r) => r.outcome === "success" && r.result.usage.costUsd === null && r.result.usage.tokensOut === null, () =>
  withFetch(() => json(200, ok({ usage: { prompt_tokens: 3, completion_tokens: -1, cost: "0.1" } })), () => attempt(() => openRouter(base, { secretResolver: bogus }))));
await row("malformed-json", "stub", "INVALID_RESPONSE", () =>
  withFetch(() => json(200, "{not json"), () => attempt(() => openRouter(base, { secretResolver: bogus }))));
await row("empty-completion", "stub", "INVALID_RESPONSE", () =>
  withFetch(() => json(200, ok({ choices: [{ message: { content: "  " } }] })), () => attempt(() => openRouter(base, { secretResolver: bogus }))));
await row("error-field-in-200", "stub", "INVALID_RESPONSE", () =>
  withFetch(() => json(200, ok({ error: { message: "upstream" } })), () => attempt(() => openRouter(base, { secretResolver: bogus }))));
await row("truncated-finish-length", "stub", "OUTPUT_LIMIT", () =>
  withFetch(() => json(200, ok({ choices: [{ message: { content: "partial" }, finish_reason: "length" }] })), () => attempt(() => openRouter(base, { secretResolver: bogus }))));
await row("oversized-body-over-512000", "stub", "INVALID_RESPONSE", () =>
  withFetch(() => json(200, JSON.stringify(ok({ pad: "x".repeat(600000) }))), () => attempt(() => openRouter(base, { secretResolver: bogus }))));

const summary = { total: rows.length, pass: rows.filter((r) => r.pass).length };
const doc = { checkedAt: new Date().toISOString(), coreVersion: version, model: MODEL, summary, paidInferenceCalls: 0, rows };
writeEvidence("02-failure-matrix.json", doc);
for (const r of rows) console.log(`${r.pass ? "PASS" : "FAIL"}  ${r.id.padEnd(40)} ${r.kind.padEnd(24)} ${r.code ?? r.outcome}  attempts=${r.networkAttempts ?? "-"}`);
console.log(JSON.stringify(summary));
process.exitCode = summary.pass === summary.total ? 0 : 1;
