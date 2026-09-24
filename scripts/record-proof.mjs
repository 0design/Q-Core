#!/usr/bin/env node
/** Record a successful workflow run as catalog evidence.
 * Usage: node scripts/record-proof.mjs <workflow-id> [runId]
 * Write measured trace data and actual output, never estimated proof.
 * Review public output for secrets: URL/token scrubbing is not a complete audit.
 */
import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PKG = join(dirname(fileURLToPath(import.meta.url)), "..");
const [id, wantRun] = process.argv.slice(2);
if (!id) { console.error("usage: record-proof.mjs <workflow-id> [runId]"); process.exit(64); }

const runsDir = join(PKG, "registry", "workflows", ".qf", "runs");
if (!existsSync(runsDir)) { console.error(`no runs at ${runsDir} — run the workflow first`); process.exit(1); }

const runs = readdirSync(runsDir).filter((f) => f.endsWith(".json"))
  .map((f) => { try { return JSON.parse(readFileSync(join(runsDir, f), "utf8")); } catch { return null; } })
  .filter((r) => r && r.workflowId === id && (!wantRun || r.runId === wantRun))
  .sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));

/* Only successful runs may supply catalog evidence. */
const run = runs.find((r) => r.status === "success") ?? null;
if (!run) { console.error(`no successful run for "${id}"`); process.exit(1); }

/** Keep URL origins and redact known token patterns before public review. */
const clean = (s) => String(s)
  .replace(/https?:\/\/[^\s"']+/g, (u) => { try { return new URL(u).origin + "/…"; } catch { return "…"; } })
  .replace(/sk-or-[A-Za-z0-9._-]{8,}/g, "sk-or-…")
  .replace(/\b\d{8,10}:[A-Za-z0-9_-]{30,}\b/g, "…:…");

const trace = {
  runId: run.runId, workflowId: run.workflowId, status: run.status, summary: clean(run.summary),
  startedAt: run.startedAt, costUsd: run.costUsd, tokensIn: run.tokensIn, tokensOut: run.tokensOut,
  steps: run.steps.map((s) => ({
    kind: s.kind, name: s.name, status: s.status,
    itemIndex: s.itemIndex ?? null, costUsd: s.costUsd,
  })),
};

/* Record actual delivered/model output. Do not emit an empty proof file. */
const last = [...run.steps].reverse().find((s) => s.output && (s.output.text || s.output.response || s.output.markdown));
const text = last ? clean(last.output.text ?? last.output.markdown ?? last.output.response) : "";

mkdirSync(join(PKG, "examples"), { recursive: true });
writeFileSync(join(PKG, "examples", `${id}.run.json`), JSON.stringify(trace, null, 2) + "\n");
if (text.trim()) writeFileSync(join(PKG, "examples", `${id}.txt`), text.trim() + "\n");

console.log(`${id}: ${trace.steps.length} steps · $${Number(run.costUsd).toFixed(4)}${text.trim() ? " · text recorded" : " · no text output"}`);
