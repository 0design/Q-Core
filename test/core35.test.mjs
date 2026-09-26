/* Core35: a human gate continues only with a decision typed by a person at a terminal. */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { AGENT_SESSION_ENV, agentSessionMarker, confirmHumanDecision, HumanConfirmationError } from "../src/human-confirmation.mjs";
import { createRun, driveRun, resumeRun, RunStore } from "../src/run.mjs";
import { loadManifest } from "../src/manifest.mjs";

const cli = resolve("bin/q-core.mjs");
const cleanEnv = () => {
  const env = { ...process.env, QF_NO_UPDATE_CHECK: "1" };
  for (const name of AGENT_SESSION_ENV) delete env[name];
  return env;
};
const GATE = `manifest: q-core.workflow/v1
id: human-gate-only
name: Human gate only
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

function fakeTerminal(answer) {
  const written = [];
  return { written, open: () => ({ write: (t) => written.push(t), readLine: () => answer, close: () => {} }) };
}
const tty = { stdinIsTTY: true, stdoutIsTTY: true, env: {} };

test("confirmHumanDecision refuses inside every known agent session before touching the terminal", () => {
  for (const name of AGENT_SESSION_ENV) {
    let opened = false;
    assert.throws(
      () => confirmHumanDecision({ decision: "approve" }, { ...tty, env: { [name]: "1" }, openTerminal: () => { opened = true; } }),
      (e) => e instanceof HumanConfirmationError && e.code === "HUMAN_CONFIRMATION_REQUIRED" && e.reason === "agent-session" && e.message.includes(name),
    );
    assert.equal(opened, false, name);
  }
  assert.equal(agentSessionMarker({ CLAUDECODE: "" }), null);
  assert.equal(agentSessionMarker({ PATH: "/bin" }), null);
});

test("confirmHumanDecision refuses a pipe or file on stdin/stdout and a process without a controlling terminal", () => {
  for (const [stdinIsTTY, stdoutIsTTY] of [[false, true], [true, false], [false, false]])
    assert.throws(() => confirmHumanDecision({ decision: "approve" }, { env: {}, stdinIsTTY, stdoutIsTTY, openTerminal: fakeTerminal("X").open }), /not a pipe or a file/);
  assert.throws(
    () => confirmHumanDecision({ decision: "approve" }, { ...tty, openTerminal: () => { throw new HumanConfirmationError("no-terminal", "This process has no controlling terminal."); } }),
    (e) => e.reason === "no-terminal",
  );
});

test("the one-time code is shown only on the terminal and must be typed back exactly", () => {
  const wrong = fakeTerminal("y");
  assert.throws(() => confirmHumanDecision({ decision: "approve", lines: ["run r1"] }, { ...tty, code: "K7PQ3X", openTerminal: wrong.open }), (e) => e.reason === "code-mismatch");
  assert.match(wrong.written.join(""), /type the code K7PQ3X/);
  for (const blind of ["", "yes", "approve", "K7PQ3"])
    assert.throws(() => confirmHumanDecision({ decision: "approve" }, { ...tty, code: "K7PQ3X", openTerminal: fakeTerminal(blind).open }), /not confirmed/);
  const ok = fakeTerminal(" k7p-q3x ");
  const record = confirmHumanDecision({ decision: "reject", lines: ["run r1"] }, { ...tty, code: "K7PQ3X", openTerminal: ok.open });
  assert.equal(record.decision, "reject");
  assert.equal(record.channel, "tty-code");
  assert.match(ok.written.join(""), /To REJECT this exact subject/);
});

test("resumeRun does not continue a human gate without a confirmation record", async () => {
  const dir = mkdtempSync(join(tmpdir(), "core35-resume-"));
  try {
    const file = join(dir, "gate.yaml");
    writeFileSync(file, GATE);
    const store = new RunStore(file);
    const manifest = loadManifest(file);
    const run = await driveRun(createRun(manifest, { trigger: "manual" }), { store });
    assert.equal(run.status, "waiting_human");
    const approvalHash = run.steps[0].output.approvalHash;
    for (const confirmation of [undefined, {}, { channel: "" }, { channel: "tty-code", decision: "reject" }])
      await assert.rejects(resumeRun(run, { decision: "approve", approvalHash, confirmation, store }), (e) => e.code === "HUMAN_CONFIRMATION_REQUIRED");
    assert.equal(store.load(run.runId).status, "waiting_human");
    const done = await resumeRun(run, { decision: "approve", approvalHash, confirmation: { channel: "embedding-host" }, store });
    assert.equal(done.status, "success");
    assert.equal(done.steps[0].confirmation.channel, "embedding-host");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function startWaitingRun(dir) {
  const file = join(dir, "gate.yaml");
  writeFileSync(file, GATE);
  const run = spawnSync(process.execPath, [cli, "run", file, "--json"], { cwd: dir, encoding: "utf8", env: cleanEnv() });
  assert.equal(run.status, 2, run.stderr);
  const out = JSON.parse(run.stdout);
  assert.equal(out.status, "waiting_human");
  assert.equal(out.nextAction.type, "ask_human_to_approve");
  assert.equal(out.nextAction.humanOnly, true);
  assert.match(out.nextAction.command, / approve .*gate\.yaml [0-9a-f-]{36} --approval-hash [0-9a-f]{64}$/);
  assert.match(out.nextAction.instruction, /Do not run it yourself/);
  return { file, runId: out.runId, hash: out.nextAction.approvalHash };
}
const runStatus = (file, runId) => new RunStore(file).load(runId).status;

test("negative: an agent's non-terminal q-core approve is refused and the run keeps waiting", () => {
  const dir = mkdtempSync(join(tmpdir(), "core35-cli-"));
  try {
    const { file, runId, hash } = startWaitingRun(dir);
    const approve = (env, input) => spawnSync(process.execPath, [cli, "approve", file, runId, "--approval-hash", hash], { cwd: dir, encoding: "utf8", env, input });
    const cases = [
      ["agent session (CLAUDECODE)", { ...cleanEnv(), CLAUDECODE: "1" }, undefined, /CLAUDECODE is set/],
      ["agent session (CODEX_SANDBOX)", { ...cleanEnv(), CODEX_SANDBOX: "seatbelt" }, undefined, /CODEX_SANDBOX is set/],
      ["no terminal, nothing piped", cleanEnv(), undefined, /not a pipe or a file|no controlling terminal/],
      ["blind yes piped into stdin", cleanEnv(), "y\ny\ny\n", /not a pipe or a file|no controlling terminal/],
    ];
    for (const [label, env, input, reason] of cases) {
      const r = approve(env, input);
      assert.equal(r.status, 2, label);
      assert.match(r.stderr, /HUMAN_CONFIRMATION_REQUIRED/, label);
      assert.match(r.stderr, reason, label);
      assert.match(r.stderr, /ask them to run, in their own terminal/, label);
      assert.doesNotMatch(r.stdout + r.stderr, /type the code/, label);
      assert.equal(runStatus(file, runId), "waiting_human", label);
    }
    const reject = spawnSync(process.execPath, [cli, "approve", file, runId, "--approval-hash", hash, "--reject"], { cwd: dir, encoding: "utf8", env: { ...cleanEnv(), CLAUDECODE: "1" } });
    assert.equal(reject.status, 2);
    assert.equal(runStatus(file, runId), "waiting_human");
    const json = spawnSync(process.execPath, [cli, "approve", file, runId, "--approval-hash", hash, "--json"], { cwd: dir, encoding: "utf8", env: { ...cleanEnv(), AI_AGENT: "claude-code" } });
    const body = JSON.parse(json.stdout);
    assert.equal(body.status, "waiting_human");
    assert.equal(body.error.code, "HUMAN_CONFIRMATION_REQUIRED");
    assert.equal(body.nextAction.humanOnly, true);
    const stale = spawnSync(process.execPath, [cli, "approve", file, runId, "--approval-hash", "0".repeat(64)], { cwd: dir, encoding: "utf8", env: cleanEnv() });
    assert.equal(stale.status, 1);
    assert.match(stale.stderr, /Approval does not match/);
    assert.equal(runStatus(file, runId), "waiting_human");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* A real pseudo-terminal stands in for the person: it reads the code from the terminal and types it. */
const PTY = `
import json, os, pty, re, select, sys
argv, env, answer = json.loads(sys.argv[1]), json.loads(sys.argv[2]), sys.argv[3]
pid, fd = pty.fork()
if pid == 0:
    os.execve(argv[0], argv, env)
buf, sent = b"", False
while True:
    r, _, _ = select.select([fd], [], [], 30)
    if not r: break
    try: data = os.read(fd, 4096)
    except OSError: break
    if not data: break
    buf += data
    m = re.search(rb"type the code ([A-Z0-9]{6})", buf)
    if m and not sent and buf.rstrip().endswith(b"code:"):
        os.write(fd, (m.group(1).decode() if answer == "CODE" else answer).encode() + b"\\n")
        sent = True
_, status = os.waitpid(pid, 0)
print(json.dumps({"exit": os.waitstatus_to_exitcode(status), "out": buf.decode(errors="replace")}))
`;
const python = spawnSync("python3", ["-c", "import pty"], { encoding: "utf8" });
const ptyAvailable = process.platform !== "win32" && python.status === 0;

test("positive: a person at a real terminal types the code and the run continues; a wrong code changes nothing", { skip: !ptyAvailable && "python3 pty unavailable" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "core35-pty-"));
  try {
    const { file, runId, hash } = startWaitingRun(dir);
    const atTerminal = (answer) => {
      const r = spawnSync("python3", ["-c", PTY, JSON.stringify([process.execPath, cli, "approve", file, runId, "--approval-hash", hash]), JSON.stringify(cleanEnv()), answer], { cwd: dir, encoding: "utf8" });
      assert.equal(r.status, 0, r.stderr);
      return JSON.parse(r.stdout);
    };
    const wrong = atTerminal("y");
    assert.equal(wrong.exit, 2, wrong.out);
    assert.match(wrong.out, /Approve the exact subject/);
    assert.match(wrong.out, /HUMAN_CONFIRMATION_REQUIRED/);
    assert.equal(runStatus(file, runId), "waiting_human");
    const right = atTerminal("CODE");
    assert.equal(right.exit, 0, right.out);
    assert.match(right.out, /Confirmed: approve/);
    const state = new RunStore(file).load(runId);
    assert.equal(state.status, "success");
    assert.equal(state.steps[0].confirmation.channel, "tty-code");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Digest 0.4.1 has no numeric length limit for a case, in the prompt or in the check", () => {
  const digest = readFileSync(resolve("registry/workflows/digest.yaml"), "utf8");
  const manifest = loadManifest(resolve("registry/workflows/digest.yaml"));
  assert.equal(manifest.version, "0.4.1");
  assert.doesNotMatch(digest, /itemMaxWords/);
  const draft = manifest.steps.find((s) => s.id === "draft").config.instructions;
  const cases = draft.slice(draft.indexOf('"Кейси":'));
  assert.doesNotMatch(cases, /\d+\s+words|at most two|sentences? and \d+/);
  assert.match(cases, /thesis style/);
  assert.match(cases, /2 or 3 items/);
});
