// Step 3 — the ONE bounded live OpenRouter call through Q-Core's public adapter.
// One-shot: refuses to run when 03-live-call.json already exists or the preflight
// was not GO. retries:0 means at most one billable attempt.
// Usage: QCORE_PKG=<pkg dir> node 03-live-call.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  loadCore, sha256, OUT, MODEL, LIVE, PER_CALL_CAP_USD, exists, writeEvidence,
  keyUsage, generationCost, strip,
} from "./common.mjs";

if (exists("03-live-call.json") || exists("03-live-call.started")) throw new Error("One-shot guard: live call evidence already exists; not calling again");
const pre = JSON.parse(readFileSync(join(OUT, "01-preflight.json"), "utf8"));
if (!pre.decision.startsWith("GO")) throw new Error("Preflight is not GO");
if (pre.worstCaseUsd.total > PER_CALL_CAP_USD) throw new Error("Worst case above per-call cap");

const { core, version } = await loadCore();
const messages = [
  { role: "system", content: "Reply with exactly one lowercase word." },
  { role: "user", content: "Say: ok" },
];
if (Buffer.byteLength(JSON.stringify(messages)) !== pre.callConfig.inputBytes) throw new Error("Prompt differs from preflight");

const known = [];
const before = await keyUsage(core);
known.push(...before._known);

const startedAt = new Date().toISOString();
writeFileSync(join(OUT, "03-live-call.started"), startedAt + "\n"); // sentinel survives a failed evidence write
let result, error;
try {
  result = await core.openRouter({
    messages,
    model: MODEL,
    keyRef: LIVE.keyRef,
    secretSource: LIVE.secretSource,
    payerScope: LIVE.payerScope,
    maxTokens: LIVE.maxTokens,
    temperature: LIVE.temperature,
    timeoutMs: LIVE.timeoutMs,
    retries: LIVE.retries,
  });
} catch (e) {
  error = { code: e.code ?? e.name, message: e.message };
}
const finishedAt = new Date().toISOString();

// Usage accounting can lag a few seconds behind the response.
await new Promise((r) => setTimeout(r, 4000));
let generation = null;
if (result?.requestId) {
  generation = await generationCost(core, result.requestId);
  known.push(...generation._known);
  generation = strip(generation);
}
const after = await keyUsage(core);
known.push(...after._known);

const evidence = {
  gate: "openrouter-provider",
  coreVersion: version,
  coreSha256: pre.core.sha256,
  startedAt,
  finishedAt,
  call: { ...LIVE, model: MODEL, inputBytes: pre.callConfig.inputBytes, attemptsAllowed: LIVE.retries + 1 },
  outcome: error ? "error" : "success",
  error: error ?? null,
  response: result
    ? {
        requestId: result.requestId,
        provider: result.provider,
        usage: result.usage,
        output: result.content,
        outputSha256: sha256(result.content),
      }
    : null,
  generation,
  keyAccount: { before: strip(before), after: strip(after) },
  ledger: {
    worstCaseUsd: pre.worstCaseUsd.total,
    reportedCostUsd: result?.usage?.costUsd ?? generation?.totalCost ?? null,
    keyUsageDeltaUsd:
      before.usage !== null && after.usage !== null ? Number((after.usage - before.usage).toFixed(10)) : null,
  },
};
process.stdout.write(writeEvidence("03-live-call.json", evidence, known));
process.exitCode = error ? 1 : 0;
