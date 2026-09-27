/* Core38: the q-core agent / q-core content JSON protocols take no decision from the
   caller. A person decides with `q-core agent|content approve` at a terminal; the
   agent then resends the same request without approval. */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { AGENT_SESSION_ENV } from "../src/human-confirmation.mjs";
import { recordHumanDecision, humanApproveCli } from "../src/human-decision.mjs";
import { runAgent } from "../src/agent.mjs";
import { runContent } from "../src/content.mjs";
import { runContentRequest } from "../src/content-runner.mjs";
import { personDecides } from "./human-decision-helper.mjs";
import { atTerminal, ptyAvailable } from "./fixtures/human-terminal.mjs";

const cli = resolve("bin/q-core.mjs");
for (const name of AGENT_SESSION_ENV) delete process.env[name];
const cleanEnv = () => {
  const env = { ...process.env, QF_NO_UPDATE_CHECK: "1" };
  for (const name of AGENT_SESSION_ENV) delete env[name];
  return env;
};
const spec = { summary: "Implement add", criteria: ["verify.mjs passes"], plan: ["Edit value.mjs only"] };
const HASH = /^[a-f0-9]{64}$/;

function sdd(t) {
  const workspace = realpathSync(mkdtempSync(join(tmpdir(), "core38-sdd-")));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  writeFileSync(join(workspace, "value.mjs"), "export const add=()=>0;");
  writeFileSync(join(workspace, "verify.mjs"), "import {add} from './value.mjs'; if(add(2,3)!==5)process.exit(1);");
  return {
    protocolVersion: "qf.agent/v1",
    requestId: "core38",
    workflow: { id: "synthetic-sdd", version: "1.0.0" },
    intent: "Implement add",
    workspace,
    allowedPaths: ["value.mjs"],
    allowedTools: [process.execPath],
    provider: { kind: "claude", model: "fixture", executable: resolve("test/fixtures/claude.mjs"), payerScope: "local-cli" },
    deadlineMs: 5000,
    maxRepairAttempts: 0,
    verifier: { command: process.execPath, args: ["verify.mjs"] },
    specification: spec,
  };
}
const agentJson = (request, env = cleanEnv()) => {
  const p = spawnSync(process.execPath, [cli, "agent", "-"], { input: JSON.stringify(request), encoding: "utf8", env, cwd: request.workspace });
  return { code: p.status, result: JSON.parse(p.stdout) };
};
const agentState = (r, runId) => JSON.parse(readFileSync(join(r.workspace, ".qf", `agent-${runId}.json`), "utf8"));
const value = (r) => readFileSync(join(r.workspace, "value.mjs"), "utf8");

async function waitingSdd(t) {
  const r = sdd(t);
  const first = agentJson(r);
  assert.equal(first.code, 2);
  const a = first.result.nextAction;
  assert.equal(first.result.status, "needs_human");
  assert.equal(a.type, "ask_human_to_approve");
  assert.equal(a.humanOnly, true);
  assert.equal(a.subject, "specification");
  assert.match(a.approvalHash, HASH);
  assert.equal(a.hash, a.approvalHash);
  assert.ok(a.command.endsWith(` agent approve ${r.workspace} ${first.result.runId} --approval-hash ${a.approvalHash}`), a.command);
  assert.match(a.instruction, /Do not run it yourself/);
  return { r, first: first.result, resume: { ...r, resumeRunId: first.result.runId } };
}

const content = (t) => {
  const workspace = realpathSync(mkdtempSync(join(tmpdir(), "core38-content-")));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  return {
    workspace,
    requestId: "core38-content",
    sources: [{ id: "one", url: "https://example.com/one", text: "One source" }],
    profile: { tone: "concise" },
    provider: { id: "fixture", version: "1" },
    receiver: { id: "test-only", version: "1" },
  };
};
const adapters = (sent) => ({
  generate: async () => ({ text: "One sourced draft" }),
  check: async () => ({ outcome: "pass", rule: "synthetic@1" }),
  publish: async () => { sent.push(1); return { id: "receipt-1", delivered: true }; },
});
const publication = (r, runId) => Object.values(JSON.parse(readFileSync(join(r.workspace, ".qf", "content-state.json"), "utf8")).publications).find((p) => p.runId === runId);

test("negative: a JSON approve or reject is refused, with or without agent markers; the run keeps waiting", async (t) => {
  const { r, first, resume } = await waitingSdd(t);
  const envs = [["no markers", cleanEnv()], ["CLAUDECODE", { ...cleanEnv(), CLAUDECODE: "1" }], ["CODEX_SANDBOX", { ...cleanEnv(), CODEX_SANDBOX: "seatbelt" }]];
  for (const decision of ["approve", "reject"])
    for (const [label, env] of envs) {
      const p = agentJson({ ...resume, approval: { hash: first.nextAction.approvalHash, decision } }, env);
      assert.equal(p.code, 2, `${decision} ${label}`);
      assert.equal(p.result.status, "needs_human");
      assert.equal(p.result.error.code, "HUMAN_APPROVAL_REQUIRED", `${decision} ${label}`);
      assert.equal(p.result.nextAction.type, "ask_human_to_approve");
      assert.equal(p.result.nextAction.command, first.nextAction.command);
      const state = agentState(r, first.runId);
      assert.equal(state.phase, "approval");
      assert.equal(state.humanDecision, undefined);
      assert.equal(value(r), "export const add=()=>0;");
    }
  // A new request that carries approval is refused too; nothing starts.
  const fresh = await runAgent({ ...sdd(t), approval: { hash: "a".repeat(64), decision: "approve" } });
  assert.equal(fresh.error.code, "HUMAN_APPROVAL_REQUIRED");
  assert.equal(fresh.runId, null);
});

test("negative: a JSON approval is refused even after a person approved; the recorded decision alone continues", async (t) => {
  const { r, first, resume } = await waitingSdd(t);
  personDecides("agent", r.workspace, first);
  const refused = await runAgent({ ...resume, approval: { hash: first.nextAction.approvalHash, decision: "approve" } });
  assert.equal(refused.error.code, "HUMAN_APPROVAL_REQUIRED");
  assert.equal(value(r), "export const add=()=>0;");
  const done = agentJson(resume);
  assert.equal(done.code, 0, JSON.stringify(done.result));
  assert.equal(done.result.status, "success");
  assert.notEqual(value(r), "export const add=()=>0;");
});

test("negative: the content JSON protocol refuses approve and reject before any fetch or send", async (t) => {
  const r = content(t);
  const sent = [];
  const first = await runContent(r, adapters(sent));
  assert.equal(first.nextAction.type, "ask_human_to_approve");
  assert.equal(first.nextAction.subject, "publication");
  assert.ok(first.nextAction.command.endsWith(` content approve ${r.workspace} ${first.runId} --approval-hash ${first.nextAction.approvalHash}`));
  for (const decision of ["approve", "reject"]) {
    const refused = await runContent({ ...r, approval: { hash: first.nextAction.approvalHash, decision } }, adapters(sent));
    assert.equal(refused.status, "needs_human");
    assert.equal(refused.error.code, "HUMAN_APPROVAL_REQUIRED");
    assert.equal(publication(r, first.runId).phase, "approval");
    assert.equal(publication(r, first.runId).humanDecision, undefined);
  }
  assert.equal(sent.length, 0);
  // The HTTP/CLI runner refuses before fetching any source.
  const request = { protocolVersion: "qf.content-request/v1", requestId: "x", workspace: r.workspace, allowedOrigins: ["http://127.0.0.1:9"], deadlineMs: 1000,
    sources: [{ id: "one", url: "http://127.0.0.1:9/source" }], profile: {}, provider: { kind: "codex", model: "fixture", executable: resolve("test/fixtures/codex.mjs"), payerScope: "local-cli" },
    receiver: { kind: "webhook", url: "http://127.0.0.1:9/receive" }, approval: { hash: first.nextAction.approvalHash, decision: "approve" } };
  assert.equal((await runContentRequest(request)).error.code, "HUMAN_APPROVAL_REQUIRED");
  const file = join(r.workspace, "request.json");
  writeFileSync(file, JSON.stringify(request));
  const p = spawnSync(process.execPath, [cli, "content", file], { encoding: "utf8", env: cleanEnv() });
  assert.equal(p.status, 2);
  assert.equal(JSON.parse(p.stdout).error.code, "HUMAN_APPROVAL_REQUIRED");
});

test("negative: the human command refuses in an agent session, with piped stdin and without a terminal", async (t) => {
  const { r, first } = await waitingSdd(t);
  const c = content(t);
  const draft = await runContent(c, adapters([]));
  const cases = [
    ["agent", r.workspace, first.runId, first.nextAction.approvalHash, () => agentState(r, first.runId)],
    ["content", c.workspace, draft.runId, draft.nextAction.approvalHash, () => publication(c, draft.runId)],
  ];
  for (const [kind, workspace, runId, hash, state] of cases) {
    const run = (env, input, extra = []) => spawnSync(process.execPath, [cli, kind, "approve", workspace, runId, "--approval-hash", hash, ...extra], { encoding: "utf8", env, input });
    for (const [label, env, input, reason] of [
      ["CLAUDECODE", { ...cleanEnv(), CLAUDECODE: "1" }, undefined, /CLAUDECODE is set/],
      ["AI_AGENT reject", { ...cleanEnv(), AI_AGENT: "x" }, undefined, /AI_AGENT is set/],
      ["no terminal", cleanEnv(), undefined, /not a pipe or a file|no controlling terminal/],
      ["piped yes", cleanEnv(), "y\ny\n", /not a pipe or a file|no controlling terminal/],
    ]) {
      const p = run(env, input, label.includes("reject") ? ["--reject"] : []);
      assert.equal(p.status, 2, `${kind} ${label}`);
      assert.match(p.stderr, /HUMAN_CONFIRMATION_REQUIRED/);
      assert.match(p.stderr, reason, `${kind} ${label}`);
      assert.match(p.stderr, /ask them to run, in their own terminal/);
      assert.doesNotMatch(p.stdout + p.stderr, /type the code/);
      assert.equal(state().humanDecision, undefined, `${kind} ${label}`);
      assert.equal(state().phase, "approval");
    }
    const json = JSON.parse(run({ ...cleanEnv(), CLAUDECODE: "1" }, undefined, ["--json"]).stdout);
    assert.equal(json.error.code, "HUMAN_CONFIRMATION_REQUIRED");
    assert.equal(json.nextAction.humanOnly, true);
  }
  // The library record refuses in an agent session and without a confirmation record.
  const args = { kind: "agent", workspace: r.workspace, runId: first.runId, approvalHash: first.nextAction.approvalHash, decision: "approve" };
  assert.throws(() => recordHumanDecision({ ...args }), (e) => e.code === "HUMAN_CONFIRMATION_REQUIRED");
  assert.throws(() => recordHumanDecision({ ...args, confirmation: { channel: "tty-code", decision: "reject" } }), (e) => e.code === "HUMAN_CONFIRMATION_REQUIRED");
  process.env.CLAUDECODE = "1";
  try {
    assert.throws(() => recordHumanDecision({ ...args, confirmation: { channel: "tty-code" } }), (e) => e.code === "HUMAN_CONFIRMATION_REQUIRED" && /CLAUDECODE/.test(e.message));
  } finally { delete process.env.CLAUDECODE; }
  assert.equal(agentState(r, first.runId).humanDecision, undefined);
});

test("negative: a decision recorded for hash A cannot approve the run once its hash is B", async (t) => {
  const { r, first, resume } = await waitingSdd(t);
  personDecides("agent", r.workspace, first);
  const revised = await runAgent({
    ...resume,
    specChange: { expectedHash: first.nextAction.approvalHash, expectedRevision: 1, reason: "Narrow the plan", specification: { ...spec, plan: ["Edit value.mjs only, keep the export name"] } },
  });
  assert.equal(revised.status, "needs_human");
  assert.equal(revised.nextAction.type, "ask_human_to_approve");
  assert.notEqual(revised.nextAction.approvalHash, first.nextAction.approvalHash);
  const again = agentJson(resume);
  assert.equal(again.result.nextAction.approvalHash, revised.nextAction.approvalHash);
  assert.equal(value(r), "export const add=()=>0;");
  assert.throws(() => personDecides("agent", r.workspace, first), (e) => e.code === "STALE_APPROVAL");
  const stale = spawnSync(process.execPath, [cli, "agent", "approve", r.workspace, first.runId, "--approval-hash", first.nextAction.approvalHash], { encoding: "utf8", env: cleanEnv() });
  assert.equal(stale.status, 1);
  assert.match(stale.stderr, /STALE_APPROVAL/);
  // The stored decision still names hash A; it does not count for hash B.
  const state = agentState(r, first.runId);
  assert.equal(state.humanDecision.hash, first.nextAction.approvalHash);
  assert.equal(agentJson(resume).result.status, "needs_human");
  assert.equal(value(r), "export const add=()=>0;");
});

test("a recorded reject stops the run (SDD cancelled, content not sent)", async (t) => {
  const { r, first, resume } = await waitingSdd(t);
  personDecides("agent", r.workspace, first, "reject");
  const stopped = agentJson(resume);
  assert.equal(stopped.result.status, "cancelled");
  assert.equal(agentJson(resume).result.status, "cancelled");
  assert.equal(value(r), "export const add=()=>0;");
  const c = content(t);
  const sent = [];
  const draft = await runContent(c, adapters(sent));
  personDecides("content", c.workspace, draft, "reject");
  assert.equal((await runContent(c, adapters(sent))).status, "cancelled");
  assert.equal(sent.length, 0);
});

test("the human command validates its arguments", () => {
  const err = [];
  const io = { stdout: { write: () => {} }, stderr: { write: (s) => err.push(s) } };
  assert.equal(humanApproveCli("agent", ["/tmp"], io), 64);
  assert.equal(humanApproveCli("agent", ["/tmp", "r"], io), 64);
  assert.equal(humanApproveCli("content", ["/tmp", "r", "--approval-hash", "0".repeat(64), "--force"], io), 64);
  assert.match(err.join(""), /q-core agent approve <workspace> <runId> --approval-hash/);
});

test("positive: a person at a real terminal approves; the JSON resume proceeds (SDD and content)", { skip: !ptyAvailable && "python3 pty unavailable" }, async (t) => {
  const { r, first, resume } = await waitingSdd(t);
  const argv = [process.execPath, cli, "agent", "approve", r.workspace, first.runId, "--approval-hash", first.nextAction.approvalHash];
  const wrong = atTerminal(argv, { env: cleanEnv(), cwd: r.workspace, answer: "y" });
  assert.equal(wrong.exit, 2, wrong.out);
  assert.match(wrong.out, /Implement add/);
  assert.equal(agentState(r, first.runId).humanDecision, undefined);
  const right = atTerminal(argv, { env: cleanEnv(), cwd: r.workspace });
  assert.equal(right.exit, 0, right.out);
  assert.match(right.out, /Confirmed: approve/);
  const decision = agentState(r, first.runId).humanDecision;
  assert.equal(decision.channel, "tty-code");
  assert.equal(decision.hash, first.nextAction.approvalHash);
  assert.equal(decision.decision, "approve");
  const done = agentJson(resume);
  assert.equal(done.result.status, "success", JSON.stringify(done.result));

  const c = content(t);
  const sent = [];
  const draft = await runContent(c, adapters(sent));
  const approved = atTerminal([process.execPath, cli, "content", "approve", c.workspace, draft.runId, "--approval-hash", draft.nextAction.approvalHash], { env: cleanEnv(), cwd: c.workspace });
  assert.equal(approved.exit, 0, approved.out);
  assert.match(approved.out, /One sourced draft/);
  assert.equal(publication(c, draft.runId).humanDecision.channel, "tty-code");
  const delivered = await runContent(c, adapters(sent));
  assert.equal(delivered.status, "success");
  assert.equal(sent.length, 1);
});
