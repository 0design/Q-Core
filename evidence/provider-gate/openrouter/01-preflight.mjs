// Step 1 — prerequisites and budget ledger, before any paid call.
// Usage: QCORE_PKG=<pkg dir> QCORE_TARBALL=<Core29 .tgz> REGISTRY_SUMS=<registry/SHA256SUMS> node 01-preflight.mjs
import { readFileSync, mkdirSync } from "node:fs";
import { basename } from "node:path";
import {
  loadCore, sha256, OUT, MODEL, LIVE, TOTAL_AUTHORIZATION_USD, TARGET_CEILING_USD, PER_CALL_CAP_USD,
  modelPricing, keyUsage, strip, writeEvidence, worstCaseUsd,
} from "./common.mjs";

mkdirSync(OUT, { recursive: true });
const { core, version } = await loadCore();

const tarball = process.env.QCORE_TARBALL;
const sums = readFileSync(process.env.REGISTRY_SUMS, "utf8");
const tarballSha = sha256(readFileSync(tarball));
const pinned = sums.split("\n").find((l) => l.endsWith(`vendor/${basename(tarball)}`))?.split("  ")[0] ?? null;

const stored = await core.hasKeychainSecret({ provider: "openrouter", keyRef: LIVE.keyRef });
const pricing = await modelPricing(MODEL);
const usage = await keyUsage(core);

// Bounded prompt used by the live call (kept identical in 03-live-call.mjs).
const messages = [
  { role: "system", content: "Reply with exactly one lowercase word." },
  { role: "user", content: "Say: ok" },
];
const inputBytes = Buffer.byteLength(JSON.stringify(messages));
const worst = worstCaseUsd({
  inputBytes: inputBytes + 64, // chat-template overhead, over-estimated
  maxTokens: LIVE.maxTokens,
  promptPerToken: pricing.maxPromptPerToken,
  completionPerToken: pricing.maxCompletionPerToken,
  requestUsd: pricing.maxRequestUsd,
});
const attempts = LIVE.retries + 1;

const ledger = {
  checkedAt: new Date().toISOString(),
  core: { version, tarball: basename(tarball), sha256: tarballSha, registryPin: pinned, pairMatches: pinned === tarballSha },
  credential: { provider: "openrouter", keyRef: LIVE.keyRef, secretSource: LIVE.secretSource, stored },
  keyAccount: strip(usage),
  budget: {
    authorizationUsd: TOTAL_AUTHORIZATION_USD,
    targetCeilingUsd: TARGET_CEILING_USD,
    perCallCapUsd: PER_CALL_CAP_USD,
    historicalConsumptionUsdByThisGate: 0,
    note: "No paid OpenRouter call was made under this gate before this run (the key was absent until 2026-09-25). keyAccount.usage is the account-level consumption of this key as OpenRouter reports it.",
  },
  model: {
    id: MODEL,
    endpoints: pricing.endpoints,
    maxPromptUsdPerMTok: pricing.maxPromptPerToken * 1e6,
    maxCompletionUsdPerMTok: pricing.maxCompletionPerToken * 1e6,
  },
  callConfig: { ...LIVE, inputBytes, attempts },
  worstCaseUsd: { perAttempt: worst, total: worst * attempts },
};
ledger.decision =
  ledger.core.pairMatches && stored && usage.httpStatus === 200 &&
  ledger.worstCaseUsd.total <= PER_CALL_CAP_USD &&
  (usage.limitRemaining === null || usage.limitRemaining >= ledger.worstCaseUsd.total)
    ? "GO: one bounded call is within the per-call cap and the $5 authorization"
    : "NO-GO";
process.stdout.write(writeEvidence("01-preflight.json", ledger, usage._known));
