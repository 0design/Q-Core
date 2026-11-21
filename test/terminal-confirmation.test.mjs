/* A human gate continues with channel `tty-code` only when the one-time code was
   really typed back at the terminal: a record written by hand is refused, and a
   confirmed record is spent by its first use. Simulation only: a fake terminal,
   no real approve, no agent-session markers in this process. */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AGENT_SESSION_ENV } from "../src/human-confirmation.mjs";
import { createRun, driveRun, resumeRun, RunStore } from "../src/run.mjs";
import { loadManifest } from "../src/manifest.mjs";
import { typedAtTerminal } from "./terminal-confirmation-helper.mjs";

// Without this the marker check refuses first and the tests would pass for the wrong reason.
const markers = Object.fromEntries(AGENT_SESSION_ENV.map((name) => [name, process.env[name]]));
for (const name of AGENT_SESSION_ENV) delete process.env[name];
test.after(() => { for (const [name, value] of Object.entries(markers)) if (value !== undefined) process.env[name] = value; });

const GATE = `manifest: q-core.workflow/v1
id: terminal-confirmation
name: Terminal confirmation
version: 1.0.0
enabled: true
settings:
  budgetUsd: null
steps:
  - id: gate
    kind: approval-gate
    config:
      reviewer: human
      bind: sha256
      anchor: "Approve the exact subject"
`;

async function parked(t) {
  const dir = mkdtempSync(join(tmpdir(), "terminal-confirmation-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "gate.yaml");
  writeFileSync(file, GATE);
  const store = new RunStore(file);
  const run = await driveRun(createRun(loadManifest(file), { trigger: "manual" }), { store });
  assert.equal(run.status, "waiting_human");
  return { store, run, approvalHash: run.steps[0].output.approvalHash };
}
const notTyped = (e) => e.code === "HUMAN_CONFIRMATION_REQUIRED" && /one-time code was not typed/.test(e.message);

test("a direct resumeRun with a hand-written tty-code record and no code typed is refused", async (t) => {
  const { store, run, approvalHash } = await parked(t);
  for (const confirmation of [
    { channel: "tty-code" },
    { channel: "tty-code", decision: "approve", confirmedAt: new Date().toISOString() },
    { ...typedAtTerminal("approve") },
    Object.freeze({ channel: "tty-code", decision: "approve" }),
  ]) await assert.rejects(resumeRun(run, { decision: "approve", approvalHash, confirmation, store }), notTyped);
  assert.equal(store.load(run.runId).status, "waiting_human");
});

test("a confirmed terminal record continues the gate once; a replay of the same record is refused", async (t) => {
  const first = await parked(t), second = await parked(t);
  const confirmation = typedAtTerminal("approve");
  const done = await resumeRun(first.run, { decision: "approve", approvalHash: first.approvalHash, confirmation, store: first.store });
  assert.equal(done.status, "success");
  assert.equal(done.steps[0].confirmation.channel, "tty-code");
  await assert.rejects(resumeRun(second.run, { decision: "approve", approvalHash: second.approvalHash, confirmation, store: second.store }), notTyped);
  assert.equal(second.store.load(second.run.runId).status, "waiting_human");
});

test("a code confirmed for reject does not approve", async (t) => {
  const { store, run, approvalHash } = await parked(t);
  const rejected = typedAtTerminal("reject");
  await assert.rejects(resumeRun(run, { decision: "approve", approvalHash, confirmation: rejected, store }), (e) => e.code === "HUMAN_CONFIRMATION_REQUIRED");
  assert.equal(store.load(run.runId).status, "waiting_human");
  const done = await resumeRun(run, { decision: "reject", approvalHash, confirmation: typedAtTerminal("reject"), store });
  assert.equal(done.status, "failed");
});
