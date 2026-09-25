// Step 4 — reconcile the live call with OpenRouter's own accounting (read-only, free).
// Usage: QCORE_PKG=<pkg dir> node 04-reconcile.mjs
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadCore, OUT, TOTAL_AUTHORIZATION_USD, keyUsage, generationCost, strip, writeEvidence } from "./common.mjs";

const { core } = await loadCore();
const live = JSON.parse(readFileSync(join(OUT, "03-live-call.json"), "utf8"));
const gen = await generationCost(core, live.response.requestId);
const key = await keyUsage(core);
const spent = gen.totalCost ?? live.response.usage.costUsd;
const doc = {
  checkedAt: new Date().toISOString(),
  requestId: live.response.requestId,
  generation: strip(gen),
  keyAccount: strip(key),
  ledger: {
    authorizationUsd: TOTAL_AUTHORIZATION_USD,
    paidCallsUnderGate: 1,
    responseCostUsd: live.response.usage.costUsd,
    generationCostUsd: gen.totalCost,
    spentUsd: spent,
    remainingOfAuthorizationUsd: Number((TOTAL_AUTHORIZATION_USD - spent).toFixed(10)),
    costSourcesAgree: gen.totalCost === null ? null : Math.abs(gen.totalCost - live.response.usage.costUsd) < 1e-9,
  },
};
process.stdout.write(writeEvidence("04-reconcile.json", doc, [...gen._known, ...key._known]));
