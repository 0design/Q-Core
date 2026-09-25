// Step 2b — workflow ceiling: `budgetUsd: 0` in front of one keychain-backed
// OpenRouter llm-call, run through the q-core CLI. run.mjs checks the budget
// before a paid step executes, so the step (secret resolution and request) never
// starts. Limit: the ceiling compares spend accumulated BEFORE a step; it cannot
// stop a single call from exceeding it — that bound is maxTokens + the ledger.
// Usage: QCORE_PKG=<pkg dir> node 02b-budget-cap.mjs
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HERE, sha256, writeEvidence } from "./common.mjs";

const manifest = join(HERE, "budget-cap.yaml");
const dir = realpathSync(mkdtempSync(join(tmpdir(), "qf-budget-cap-")));
copyFileSync(manifest, join(dir, "budget-cap.yaml"));
const env = { ...process.env, QF_NO_UPDATE_CHECK: "1" };
delete env.OPENROUTER_API_KEY; // the env route must not be what makes this pass
let stdout, exitCode = 0;
try {
  stdout = execFileSync(process.execPath, [join(process.env.QCORE_PKG, "bin/q-core.mjs"), "run", "budget-cap.yaml", "--json"], { cwd: dir, env, encoding: "utf8" });
} catch (e) {
  stdout = e.stdout; exitCode = e.status;
}
const run = JSON.parse(stdout);
const step = run.steps[0];
writeEvidence("02b-budget-cap-run.json", {
  checkedAt: new Date().toISOString(),
  manifestSha256: sha256(readFileSync(manifest)),
  command: "q-core run budget-cap.yaml --json",
  exitCode,
  pass: exitCode !== 0 && run.status === "failed" && step.gateReason === "budget" && step.output === null && step.costUsd === 0,
  run,
});
console.log(JSON.stringify({ exitCode, status: run.status, gateReason: step.gateReason, summary: run.summary }));
