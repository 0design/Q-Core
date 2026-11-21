/* `q-core agent approve` / `q-core content approve` record a decision only with a
   terminal record that confirmHumanDecision issued after the one-time code was typed
   back, and only once. A hand-written `{channel: "tty-code"}`, another channel, a
   replay or a record confirmed for the other decision is refused and nothing is
   recorded. Simulation only: a fake terminal, no agent-session markers here. */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { AGENT_SESSION_ENV } from "../src/human-confirmation.mjs";
import { recordHumanDecision } from "../src/human-decision.mjs";
import { typedAtTerminal } from "./terminal-confirmation-helper.mjs";

// Without this the marker check refuses first and the tests would pass for the wrong reason.
const markers = Object.fromEntries(AGENT_SESSION_ENV.map((name) => [name, process.env[name]]));
for (const name of AGENT_SESSION_ENV) delete process.env[name];
test.after(() => { for (const [name, value] of Object.entries(markers)) if (value !== undefined) process.env[name] = value; });

function waitingAgentRun(t) {
  const workspace = realpathSync(mkdtempSync(join(tmpdir(), "human-decision-")));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  const runId = randomUUID(), approvalHash = "a".repeat(64);
  mkdirSync(join(workspace, ".qf"), { mode: 0o700 });
  const file = join(workspace, ".qf", `agent-${runId}.json`);
  writeFileSync(file, JSON.stringify({ runId, phase: "approval", approvalHash }));
  const args = { kind: "agent", workspace, runId, approvalHash, decision: "approve" };
  return { args, decisionOnDisk: () => JSON.parse(readFileSync(file, "utf8")).humanDecision };
}
const refused = (e) => e.code === "HUMAN_CONFIRMATION_REQUIRED";

test("a hand-written tty-code record or another channel does not record a decision", (t) => {
  const { args, decisionOnDisk } = waitingAgentRun(t);
  for (const confirmation of [
    { channel: "tty-code" },
    { channel: "tty-code", decision: "approve", confirmedAt: new Date().toISOString() },
    Object.freeze({ channel: "tty-code", decision: "approve" }),
    { ...typedAtTerminal("approve") },
    { channel: "chat-form", decision: "approve" },
  ]) assert.throws(() => recordHumanDecision({ ...args, confirmation }), refused, JSON.stringify(confirmation));
  assert.equal(decisionOnDisk(), undefined);
});

test("a typed terminal record records the decision once; its replay and the other decision are refused", (t) => {
  const { args, decisionOnDisk } = waitingAgentRun(t);
  assert.throws(() => recordHumanDecision({ ...args, confirmation: typedAtTerminal("reject") }), refused);
  assert.equal(decisionOnDisk(), undefined);
  const confirmation = typedAtTerminal("approve");
  const recorded = recordHumanDecision({ ...args, confirmation });
  assert.equal(recorded.decision, "approve");
  assert.equal(decisionOnDisk().channel, "tty-code");
  const other = waitingAgentRun(t);
  assert.throws(() => recordHumanDecision({ ...other.args, confirmation }), refused);
  assert.equal(other.decisionOnDisk(), undefined);
});
