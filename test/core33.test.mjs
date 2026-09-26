// Core33: the manifest llm-call route bounds its billable attempts, keeps the provider's
// own cost, prices no model at another model's rate, and the run budget stays
// fail-closed when a cost is unknown. Every test here is offline: fetch is stubbed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { validateManifest } from "../src/manifest.mjs";
import { createRun, driveRun } from "../src/run.mjs";
import { llmCallPolicy, runLlmCall } from "../src/steps.mjs";
import { openRouter } from "../src/providers/openrouter.mjs";
import { rateForModel, stepCostUsd, worstCaseCallUsd } from "../src/cost.mjs";

const KNOWN = "anthropic/claude-sonnet-5"; // priced in src/cost.mjs: $2 / $10 per 1M
const UNKNOWN = "example/unpriced-model";

function reply({ model = KNOWN, cost, tokensIn = 1000, tokensOut = 100, content = "done", finish = "stop" } = {}) {
  const usage = { prompt_tokens: tokensIn, completion_tokens: tokensOut };
  if (cost !== undefined) usage.cost = cost;
  return new Response(JSON.stringify({ id: "gen-1", model, choices: [{ message: { content }, finish_reason: finish }], usage }), {
    status: 200, headers: { "content-type": "application/json" },
  });
}

async function withFetch(handler, work) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => { calls.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : null }); return handler(calls.length, url, init); };
  try { return await work(calls); } finally { globalThis.fetch = original; }
}

function manifest(steps, settings = {}) {
  return validateManifest({ manifest: "q-core.workflow/v1", id: "core33", settings, steps });
}
const llm = (id, config = {}) => ({ id, kind: "llm-call", config: { instructions: "Say done.", ...config } });
const run = (m, opts = {}) => driveRun(createRun(m), { apiKey: "test-key", settings: m.settings, ...opts });

// ── (a) retries / timeout: set by the workflow, bounded, explicit ────────────

test("policy: defaults are unchanged (2 retries, 90 s) and explicit values are honoured", () => {
  assert.deepEqual(llmCallPolicy({}, "s"), { retries: 2, timeoutMs: 90_000 });
  assert.deepEqual(llmCallPolicy({ retries: "0", timeoutSec: "30", maxCallCostUsd: "0.05" }, "s"), { retries: 0, timeoutMs: 30_000, maxCallCostUsd: 0.05 });
  assert.deepEqual(llmCallPolicy({ retries: "5", timeoutSec: "600" }, "s"), { retries: 5, timeoutMs: 600_000 });
});

test("policy: out-of-bound or malformed values are refused, never clamped (negative examples)", () => {
  const bad = {
    "retries above 5": { retries: "6" }, "negative retries": { retries: "-1" }, "fractional retries": { retries: "1.5" }, "word retries": { retries: "two" },
    "timeout 0": { timeoutSec: "0" }, "timeout above 600": { timeoutSec: "601" }, "fractional timeout": { timeoutSec: "2.5" },
    "timeoutMs instead of timeoutSec": { timeoutMs: "1000" },
    "cap 0": { maxCallCostUsd: "0" }, "negative cap": { maxCallCostUsd: "-1" }, "cap above 100": { maxCallCostUsd: "101" }, "word cap": { maxCallCostUsd: "cheap" },
  };
  for (const [name, config] of Object.entries(bad)) assert.throws(() => llmCallPolicy(config, "s"), (e) => e.code === "INVALID_REQUEST", name);
});

test("retries: 0 means exactly one billable attempt, even on 429 and 5xx", async () => {
  for (const status of [429, 500, 503]) {
    const calls = await withFetch(() => new Response("busy", { status }), async (calls) => {
      await assert.rejects(() => runLlmCall(llm("s", { retries: "0" }), { apiKey: "k", priorOutputs: {} }, KNOWN, 50), (e) => /RATE_LIMITED|PROVIDER_ERROR/.test(e.code));
      return calls;
    });
    assert.equal(calls.length, 1, `status ${status}`);
  }
});

test("retries: an explicit 1 allows exactly two attempts; the default still allows three", async () => {
  const one = await withFetch(() => new Response("busy", { status: 503 }), async (calls) => {
    await assert.rejects(() => runLlmCall(llm("s", { retries: "1" }), { apiKey: "k", priorOutputs: {} }, KNOWN, 50), (e) => e.code === "PROVIDER_ERROR");
    return calls.length;
  });
  assert.equal(one, 2);
  const two = await withFetch((n) => (n < 3 ? new Response("busy", { status: 503 }) : reply({ cost: 0.001 })), async (calls) => {
    await runLlmCall(llm("s"), { apiKey: "k", priorOutputs: {} }, KNOWN, 50);
    return calls.length;
  });
  assert.equal(two, 3);
});

test("retries: an invalid policy fails before the key is read or anything is sent", async () => {
  const calls = await withFetch(() => reply(), async (calls) => {
    await assert.rejects(() => runLlmCall(llm("s", { retries: "9" }), { apiKey: "", priorOutputs: {} }, KNOWN, 50), /retries must be an integer from 0 to 5/);
    return calls.length;
  });
  assert.equal(calls, 0);
});

test("timeout: timeoutSec bounds each attempt", async () => {
  // A ref'd timer keeps the process alive; the per-attempt timeout (unref'd) must win first.
  const hang = (n, url, init) => new Promise((_, reject) => {
    const keepAlive = setTimeout(() => reject(new Error("timeout did not fire")), 10_000);
    init.signal.addEventListener("abort", () => { clearTimeout(keepAlive); reject(init.signal.reason); });
  });
  const started = Date.now();
  await withFetch(hang, async (calls) => {
    await assert.rejects(() => runLlmCall(llm("s", { retries: "0", timeoutSec: "1" }), { apiKey: "k", priorOutputs: {} }, KNOWN, 50), (e) => e.code === "TIMEOUT");
    assert.equal(calls.length, 1);
  });
  assert.ok(Date.now() - started < 5_000);
});

test("dry run reports the call policy and refuses an invalid one without executing", async () => {
  const ok = await run(manifest([llm("s", { retries: "0", timeoutSec: "45", maxCallCostUsd: "0.02", model: KNOWN })]), { dryRun: true });
  assert.equal(ok.status, "success");
  assert.deepEqual({ ...ok.steps[0].output, step: undefined }, { planned: true, step: undefined, model: KNOWN, maxTokens: 1200, retries: 0, maxAttempts: 1, timeoutSec: 45, maxCallCostUsd: 0.02 });
  const bad = await run(manifest([llm("s", { retries: "7", model: KNOWN })]), { dryRun: true });
  assert.equal(bad.status, "failed");
  assert.match(bad.steps[0].errorText, /retries must be an integer from 0 to 5/);
});

test("the hosted validator (manifest.mjs, unchanged) still accepts the new optional fields as scalars", () => {
  const m = manifest([llm("s", { retries: 1, timeoutSec: 120, maxCallCostUsd: 0.05 })]);
  assert.deepEqual([m.steps[0].config.retries, m.steps[0].config.timeoutSec, m.steps[0].config.maxCallCostUsd], ["1", "120", "0.05"]);
});

// ── (b) the provider's own cost is kept ─────────────────────────────────────

test("cost: the provider's usage.cost is recorded as the step and run cost", async () => {
  const done = await withFetch(() => reply({ cost: 0.01234567, tokensIn: 1000, tokensOut: 100 }), () =>
    run(manifest([llm("s", { model: KNOWN })])));
  assert.equal(done.status, "success");
  assert.equal(done.steps[0].costUsd, 0.012346);
  assert.equal(done.steps[0].costSource, "provider");
  assert.equal(done.costUsd, 0.012346);
});

test("cost: a tiny real provider cost is not rounded to zero", async () => {
  const done = await withFetch(() => reply({ model: "mistralai/mistral-nemo", cost: 0.00000082 }), () =>
    run(manifest([llm("s", { model: "mistralai/mistral-nemo" })])));
  assert.equal(done.steps[0].costUsd, 0.000001);
  assert.ok(done.steps[0].costUsd > 0);
});

test("cost: without a provider cost a known model is priced at ITS OWN rate, not the old default rate", async () => {
  const done = await withFetch(() => reply({ tokensIn: 1000, tokensOut: 100 }), () => run(manifest([llm("s", { model: KNOWN })])));
  // 1000 × $2/1M + 100 × $10/1M = $0.003 (the old default-model rate would give $0.00025).
  assert.equal(done.steps[0].costUsd, 0.003);
  assert.equal(done.steps[0].costSource, "rate-table");
});

test("cost: the answering model's price is used, not the requested alias's", () => {
  assert.deepEqual(stepCostUsd({ providerCostUsd: null, model: "openai/gpt-4o-mini", tokensIn: 1_000_000, tokensOut: 0 }), { costUsd: 0.15, costSource: "rate-table" });
});

// ── (c) an unknown model costs null, not an invented $3/$15 ─────────────────

test("cost: unknown model without provider cost → null / unknown, never a fallback price", async () => {
  assert.equal(rateForModel(UNKNOWN), null);
  assert.deepEqual(stepCostUsd({ providerCostUsd: undefined, model: UNKNOWN, tokensIn: 1000, tokensOut: 100 }), { costUsd: null, costSource: "unknown" });
  const done = await withFetch(() => reply({ model: UNKNOWN }), () => run(manifest([llm("s", { model: UNKNOWN })], { budgetUsd: null })));
  assert.equal(done.status, "success");
  assert.equal(done.steps[0].costUsd, null);
  assert.equal(done.steps[0].costSource, "unknown");
  assert.equal(done.costUsd, null);
  // Negative example: the old table billed an unknown model at $3/$15 → $0.0045 here.
  assert.notEqual(done.steps[0].costUsd, 0.0045);
});

test("cost: an unknown model WITH a provider cost is exact", async () => {
  const done = await withFetch(() => reply({ model: UNKNOWN, cost: 0.0042 }), () => run(manifest([llm("s", { model: UNKNOWN })])));
  assert.deepEqual([done.steps[0].costUsd, done.steps[0].costSource, done.costUsd], [0.0042, "provider", 0.0042]);
});

// ── budget: fail-closed before every paid step ──────────────────────────────

test("budget: an unknown spend stops the next paid step under a finite ceiling (no call is made)", async () => {
  const calls = [];
  const done = await withFetch((n) => { calls.push(n); return reply({ model: UNKNOWN }); }, () =>
    run(manifest([llm("a", { model: UNKNOWN }), llm("b", { model: UNKNOWN })], { budgetUsd: 5 })));
  assert.equal(calls.length, 1, "the second paid step must not call the provider");
  assert.equal(done.status, "failed");
  assert.equal(done.steps[1].gateReason, "budget");
  assert.match(done.steps[1].errorText, /cost of step "a" is unknown/);
});

test("budget: lifting the ceiling on purpose (null) lets unknown-cost steps run", async () => {
  const done = await withFetch(() => reply({ model: UNKNOWN }), () =>
    run(manifest([llm("a", { model: UNKNOWN }), llm("b", { model: UNKNOWN })], { budgetUsd: null })));
  assert.equal(done.status, "success");
});

test("budget: spend at or over the ceiling still stops before the paid step (provider cost counts)", async () => {
  const calls = [];
  const done = await withFetch((n) => { calls.push(n); return reply({ cost: 0.3 }); }, () =>
    run(manifest([llm("a", { model: KNOWN }), llm("b", { model: KNOWN })], { budgetUsd: 0.25 })));
  assert.equal(calls.length, 1);
  assert.equal(done.steps[1].gateReason, "budget");
  assert.equal(done.costUsd, 0.3);
});

test("budget: budgetUsd 0 stops the first paid step before any call", async () => {
  const calls = await withFetch(() => reply({ cost: 0.001 }), async (calls) => {
    const done = await run(manifest([llm("a", { model: KNOWN })], { budgetUsd: 0 }));
    assert.equal(done.steps[0].gateReason, "budget");
    return calls.length;
  });
  assert.equal(calls, 0);
});

// ── adapter money cap (maxCallCostUsd) ──────────────────────────────────────

const call = (over = {}) => ({ model: KNOWN, messages: [{ role: "user", content: "hi" }], payerScope: "local-byok", maxTokens: 100, retries: 0, ...over });
const env = { env: { OPENROUTER_API_KEY: "k" } };

test("cap: a call whose worst case fits the cap is made; the bound counts every attempt", async () => {
  const worst1 = worstCaseCallUsd({ model: KNOWN, messagesBytes: Buffer.byteLength(JSON.stringify(call().messages)), maxTokens: 100, attempts: 1 });
  assert.ok(worst1 > 0);
  const worst3 = worstCaseCallUsd({ model: KNOWN, messagesBytes: Buffer.byteLength(JSON.stringify(call().messages)), maxTokens: 100, attempts: 3 });
  assert.equal(Number((worst3 / worst1).toFixed(9)), 3);
  const out = await withFetch(() => reply({ cost: 0.0001 }), () => openRouter(call({ maxCallCostUsd: 0.01 }), env));
  assert.equal(out.usage.costUsd, 0.0001);
});

test("cap: over the cap, or an unpriced model, is refused before the key is read or anything is sent", async () => {
  let secretReads = 0;
  const secretResolver = async () => { secretReads += 1; return "k"; };
  const calls = await withFetch(() => reply(), async (calls) => {
    await assert.rejects(() => openRouter(call({ maxTokens: 32000, maxCallCostUsd: 0.01 }), { ...env, secretResolver }), (e) => e.code === "COST_LIMIT");
    await assert.rejects(() => openRouter(call({ maxTokens: 1000, retries: 5, maxCallCostUsd: 0.05 }), { ...env, secretResolver }), (e) => e.code === "COST_LIMIT");
    await assert.rejects(() => openRouter(call({ model: UNKNOWN, maxCallCostUsd: 1 }), { ...env, secretResolver }), (e) => e.code === "COST_UNKNOWN");
    await assert.rejects(() => openRouter(call({ maxCallCostUsd: 0 }), { ...env, secretResolver }), /maxCallCostUsd must be a number/);
    return calls.length;
  });
  assert.equal(calls, 0);
  assert.equal(secretReads, 0);
});

test("cap: a provider bill above the cap fails the step but the run keeps the spend", async () => {
  const done = await withFetch(() => reply({ cost: 0.5 }), () =>
    run(manifest([llm("a", { model: KNOWN, maxCallCostUsd: "0.05", retries: "0" })], { budgetUsd: 1 })));
  assert.equal(done.status, "failed");
  assert.match(done.steps[0].errorText, /above maxCallCostUsd/);
  assert.equal(done.steps[0].costUsd, 0.5);
  assert.equal(done.costUsd, 0.5);
});

test("billed failures keep their cost: truncated output is recorded, not lost", async () => {
  const done = await withFetch(() => reply({ cost: 0.02, finish: "length" }), () =>
    run(manifest([llm("a", { model: KNOWN, retries: "0" })])));
  assert.equal(done.status, "failed");
  assert.match(done.steps[0].errorText, /truncated/);
  assert.deepEqual([done.steps[0].costUsd, done.steps[0].costSource, done.costUsd], [0.02, "provider", 0.02]);
});

test("billed failure of an unknown model marks the run cost unknown, so a later paid step is gated", async () => {
  const done = await withFetch(() => reply({ model: UNKNOWN, finish: "length" }), () =>
    run(manifest([llm("a", { model: UNKNOWN, retries: "0" })])));
  assert.equal(done.steps[0].costUsd, null);
  assert.equal(done.costUsd, null);
});

test("agent gate uses the same policy: retries 0 is one attempt and the provider cost is kept", async () => {
  const gate = { id: "g", kind: "approval-gate", config: { reviewer: "agent", rubric: "is it done", retries: "0", model: KNOWN } };
  const busy = await withFetch(() => new Response("busy", { status: 503 }), async (calls) => {
    const done = await run(manifest([gate]));
    assert.equal(done.status, "failed");
    return calls.length;
  });
  assert.equal(busy, 1);
  const done = await withFetch(() => reply({ cost: 0.0007, content: '{"pass": true, "reason": "ok"}' }), () => run(manifest([gate])));
  assert.equal(done.status, "success");
  assert.deepEqual([done.steps[0].costUsd, done.steps[0].costSource], [0.0007, "provider"]);
});

// ── the Registry template that uses this route ──────────────────────────────

test("podcast-digest 0.3.1 sets explicit retries and timeout, runs on a priced model, and plans one bounded call", async () => {
  const { loadManifest } = await import("../src/manifest.mjs");
  const m = loadManifest(new URL("../registry/workflows/podcast-digest.yaml", import.meta.url).pathname);
  assert.equal(m.version, "0.3.1");
  const draft = m.steps.find((s) => s.id === "draft");
  assert.deepEqual([draft.config.retries, draft.config.timeoutSec], ["1", "180"]);
  assert.deepEqual(llmCallPolicy(draft.config, "draft"), { retries: 1, timeoutMs: 180_000 });
  assert.equal(m.settings.budgetUsd, 0.25);
  assert.ok(rateForModel(m.settings.model), "the template's model has a listed price, so a missing provider cost is still priced at its own rate");
});

test("Registry contract: llm-call/openrouter 1.1.0 documents keyRef, secretSource, retries, timeoutSec, maxCallCostUsd and the cost record", async () => {
  const { readFileSync } = await import("node:fs");
  const catalog = JSON.parse(readFileSync(new URL("../registry/catalog.source.json", import.meta.url)));
  const component = JSON.parse(readFileSync(new URL("../registry/components/llm-call-openrouter.json", import.meta.url)));
  const entry = catalog.components.find((c) => c.id === "llm-call-openrouter");
  assert.equal(entry.version, "1.1.0");
  for (const record of [entry, component]) {
    for (const field of ["keyRef", "secretSource", "retries", "timeoutSec", "maxCallCostUsd"]) assert.ok(record.input[field], `${field} missing`);
    assert.match(record.output.costUsd.notes, /provider's reported cost/);
  }
  for (const workflow of catalog.workflows)
    for (const dep of workflow.dependencies ?? [])
      if (dep.id === "llm-call-openrouter") assert.equal(dep.version, "1.1.0", workflow.id);
});

// ── review round 1: attempts without an answer, {{run.costUsd}}, agent-gate dry run, human gate ──

test("a timed-out attempt followed by a successful retry makes the call's cost unknown, and the next model call is gated", async () => {
  const hangOnce = (n, url, init) => n === 1
    ? new Promise((_, reject) => { const keep = setTimeout(() => reject(new Error("timeout did not fire")), 10_000); init.signal.addEventListener("abort", () => { clearTimeout(keep); reject(init.signal.reason); }); })
    : reply({ cost: 0.001 });
  const calls = [];
  const done = await withFetch((n, url, init) => { calls.push(n); return hangOnce(n, url, init); }, () =>
    run(manifest([llm("a", { model: KNOWN, retries: "1", timeoutSec: "1" }), llm("b", { model: KNOWN })], { budgetUsd: 1 })));
  assert.equal(calls.length, 2, "one timed-out attempt, one answered retry, and no call for step b");
  assert.deepEqual([done.steps[0].costUsd, done.steps[0].costSource], [null, "unknown"]);
  assert.equal(done.steps[1].gateReason, "budget");
});

test("an exhausted timeout or an unreadable 200 body leaves the failed step's cost unknown, not 0", async () => {
  const hang = (n, url, init) => new Promise((_, reject) => { const keep = setTimeout(() => reject(new Error("timeout did not fire")), 10_000); init.signal.addEventListener("abort", () => { clearTimeout(keep); reject(init.signal.reason); }); });
  const timedOut = await withFetch(hang, () => run(manifest([llm("a", { model: KNOWN, retries: "0", timeoutSec: "1" })])));
  assert.equal(timedOut.status, "failed");
  assert.deepEqual([timedOut.steps[0].costUsd, timedOut.costUsd], [null, null]);
  const garbled = await withFetch(() => new Response("{not json", { status: 200 }), () => run(manifest([llm("a", { model: KNOWN, retries: "0" })])));
  assert.equal(garbled.status, "failed");
  assert.deepEqual([garbled.steps[0].costUsd, garbled.costUsd], [null, null]);
  // Negative: a plain 503 answer is not billed; the cost stays 0.
  const busy = await withFetch(() => new Response("busy", { status: 503 }), () => run(manifest([llm("a", { model: KNOWN, retries: "0" })])));
  assert.equal(busy.steps[0].costUsd, 0);
});

test("{{run.costUsd}} renders six decimals, and 'unknown' (never $0) after an unknown spend", async () => {
  const sent = [];
  const handler = (n, url, init) => {
    if (String(url).startsWith("http://127.0.0.1:9/")) { sent.push(init.body); return new Response("ok", { status: 200 }); }
    return reply({ model: UNKNOWN, cost: n === 1 ? 0.0000042 : undefined });
  };
  const post = { id: "post", kind: "api-request", config: { url: "http://127.0.0.1:9/hook", body: '{"cost":"{{run.costUsd}}"}' } };
  await withFetch(handler, () => run(manifest([llm("a", { model: UNKNOWN }), post], { budgetUsd: null })));
  assert.equal(JSON.parse(sent[0]).cost, "0.000004");
  sent.length = 0;
  await withFetch((n, url, init) => String(url).startsWith("http://127.0.0.1:9/") ? (sent.push(init.body), new Response("ok")) : reply({ model: UNKNOWN }), () =>
    run(manifest([llm("a", { model: UNKNOWN }), post], { budgetUsd: null })));
  assert.equal(JSON.parse(sent[0]).cost, "unknown");
});

test("dry run validates and reports the policy of an agent approval-gate too", async () => {
  const gate = (config) => ({ id: "g", kind: "approval-gate", config: { reviewer: "agent", rubric: "ok", model: KNOWN, ...config } });
  const ok = await run(manifest([gate({ retries: "0", timeoutSec: "20" })]), { dryRun: true });
  assert.equal(ok.status, "success");
  assert.deepEqual([ok.steps[0].output.retries, ok.steps[0].output.maxAttempts, ok.steps[0].output.timeoutSec], [0, 1, 20]);
  const bad = await run(manifest([gate({ retries: "99" })]), { dryRun: true });
  assert.equal(bad.status, "failed");
  assert.match(bad.steps[0].errorText, /retries must be an integer from 0 to 5/);
});

test("an unknown spend does not stop a human gate (it calls no model); it still stops an agent gate", async () => {
  const human = { id: "h", kind: "approval-gate", config: { reviewer: "human" } };
  const toHuman = await withFetch(() => reply({ model: UNKNOWN }), () => run(manifest([llm("a", { model: UNKNOWN }), human], { budgetUsd: 1 })));
  assert.equal(toHuman.status, "waiting_human");
  const agent = { id: "g", kind: "approval-gate", config: { reviewer: "agent", rubric: "ok", model: KNOWN } };
  const toAgent = await withFetch(() => reply({ model: UNKNOWN }), () => run(manifest([llm("a", { model: UNKNOWN }), agent], { budgetUsd: 1 })));
  assert.equal(toAgent.steps[1].gateReason, "budget");
});

test("openRouter(): after an attempt without an answer, a successful retry reports costUsd null (billingUnknown), so every caller sees unknown", async () => {
  const out = await withFetch((n, url, init) => n === 1
    ? new Promise((_, reject) => { const keep = setTimeout(() => reject(new Error("timeout did not fire")), 10_000); init.signal.addEventListener("abort", () => { clearTimeout(keep); reject(init.signal.reason); }); })
    : reply({ cost: 0.001 }), () => openRouter({ ...call(), retries: 1, timeoutMs: 1000, delaysMs: [0] }, env));
  assert.deepEqual([out.usage.costUsd, out.usage.billingUnknown], [null, true]);
});
