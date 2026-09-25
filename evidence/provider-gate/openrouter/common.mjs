// Shared helpers for the OpenRouter provider-gate evidence scripts.
// The Q-Core package under test is passed as QCORE_PKG (a directory path, not a secret).
// No script prints, logs or persists a credential value; every evidence write is
// scanned for OpenRouter key prefixes before it touches disk.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const HERE = dirname(fileURLToPath(import.meta.url));
export const OUT = join(HERE, "out");

export async function loadCore() {
  const pkg = process.env.QCORE_PKG;
  if (!pkg) throw new Error("Set QCORE_PKG to the installed q-core package directory");
  const meta = JSON.parse(readFileSync(join(pkg, "package.json"), "utf8"));
  const core = await import(pathToFileURL(join(pkg, "src/index.mjs")).href);
  return { core, version: meta.version, pkg };
}

export const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

// The chosen model and the call bounds. Rationale lives in README.md.
export const MODEL = "mistralai/mistral-nemo";
export const LIVE = Object.freeze({
  maxTokens: 16,
  temperature: 0,
  retries: 0,
  timeoutMs: 30000,
  payerScope: "local-byok",
  keyRef: "OPENROUTER_API_KEY",
  secretSource: "keychain",
});
export const TOTAL_AUTHORIZATION_USD = 5;
export const TARGET_CEILING_USD = 0.5;
export const PER_CALL_CAP_USD = 0.01;

const KEY_PATTERN = /sk-or-[A-Za-z0-9_-]{8,}/;

export function assertNoSecret(text, known = []) {
  if (KEY_PATTERN.test(text)) throw new Error("Refusing to write evidence: key-shaped value present");
  for (const k of known) if (k && text.includes(k)) throw new Error("Refusing to write evidence: credential value present");
  const home = process.env.HOME;
  if (home && text.includes(home)) throw new Error("Refusing to write evidence: local home path present");
}

export function writeEvidence(name, data, known = []) {
  const text = JSON.stringify(data, null, 2) + "\n";
  assertNoSecret(text, known);
  writeFileSync(join(OUT, name), text);
  return text;
}

export const exists = (name) => existsSync(join(OUT, name));

export async function publicJson(url, timeoutMs = 20000) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`GET ${url} → ${res.status}`);
  return res.json();
}

// Worst-case USD for one attempt: every input byte counted as a token (a strict
// over-estimate) and the full output cap, at the most expensive live endpoint.
export function worstCaseUsd({ inputBytes, maxTokens, promptPerToken, completionPerToken, requestUsd = 0 }) {
  return inputBytes * promptPerToken + maxTokens * completionPerToken + requestUsd;
}

export async function modelPricing(model = MODEL) {
  const ep = await publicJson(`https://openrouter.ai/api/v1/models/${model}/endpoints`);
  const endpoints = ep.data.endpoints.map((e) => ({
    provider: e.provider_name,
    promptPerToken: Number(e.pricing.prompt),
    completionPerToken: Number(e.pricing.completion),
    requestUsd: Number(e.pricing.request ?? 0),
    status: e.status,
  }));
  const max = (f) => Math.max(...endpoints.map(f));
  return {
    model: ep.data.id,
    endpoints,
    maxPromptPerToken: max((e) => e.promptPerToken),
    maxCompletionPerToken: max((e) => e.completionPerToken),
    maxRequestUsd: max((e) => e.requestUsd),
  };
}

// Read-only key usage (no inference, no charge). The credential is resolved by
// Q-Core's own keychain resolver, used only as a request header and never returned.
export async function keyUsage(core, { keyRef = LIVE.keyRef } = {}) {
  const key = await core.resolveProviderSecret({ provider: "openrouter", keyRef, secretSource: "keychain" }, { timeoutMs: 10000 });
  try {
    const res = await fetch("https://openrouter.ai/api/v1/key", {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(20000),
    });
    const body = res.ok ? await res.json() : null;
    const d = body?.data ?? {};
    const num = (x) => (typeof x === "number" && Number.isFinite(x) ? x : null);
    return {
      httpStatus: res.status,
      usage: num(d.usage),
      usageDaily: num(d.usage_daily),
      usageMonthly: num(d.usage_monthly),
      limit: num(d.limit),
      limitRemaining: num(d.limit_remaining),
      isFreeTier: typeof d.is_free_tier === "boolean" ? d.is_free_tier : null,
      _known: [key],
    };
  } catch (e) {
    return { httpStatus: null, error: e.name, _known: [key] };
  }
}

export async function generationCost(core, id) {
  const key = await core.resolveProviderSecret({ provider: "openrouter", keyRef: LIVE.keyRef, secretSource: "keychain" }, { timeoutMs: 10000 });
  const res = await fetch(`https://openrouter.ai/api/v1/generation?id=${encodeURIComponent(id)}`, {
    headers: { Authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(20000),
  });
  const body = res.ok ? await res.json() : null;
  const d = body?.data ?? {};
  return {
    httpStatus: res.status,
    totalCost: typeof d.total_cost === "number" ? d.total_cost : null,
    model: d.model ?? null,
    providerName: d.provider_name ?? null,
    tokensPrompt: d.tokens_prompt ?? null,
    tokensCompletion: d.tokens_completion ?? null,
    nativeTokensPrompt: d.native_tokens_prompt ?? null,
    nativeTokensCompletion: d.native_tokens_completion ?? null,
    finishReason: d.finish_reason ?? null,
    _known: [key],
  };
}

export const strip = ({ _known, ...rest }) => rest;
