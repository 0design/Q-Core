import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  realpathSync,
  writeFileSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { subprocess, scopedEnvironment } from "../src/subprocess.mjs";
const caller = async (r) => {
  const p = await subprocess(
    process.execPath,
    [resolve("bin/qloops.mjs"), "agent", "-"],
    {
      input: JSON.stringify(r),
      env: scopedEnvironment({ QLOOPS_TEST_SECRET: "must-not-leak" }),
      timeoutMs: 5000,
    },
  );
  return { ...p, result: JSON.parse(p.stdout) };
};
const setup = (t) => {
  const workspace = mkdtempSync(join(tmpdir(), "qloops-caller-"));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  writeFileSync(join(workspace, "value.mjs"), "export const add=()=>0;");
  writeFileSync(
    join(workspace, "verify.mjs"),
    "import {add} from './value.mjs'; if(add(2,3)!==5)process.exit(1);",
  );
  return {
    protocolVersion: "qf.agent/v1",
    requestId: "caller",
    loop: { id: "synthetic-sdd", version: "1.0.0" },
    intent: "Implement add",
    workspace,
    allowedPaths: ["value.mjs"],
    allowedTools: [process.execPath],
    provider: {
      kind: "claude",
      model: "fixture",
      executable: resolve("test/fixtures/claude.mjs"),
      payerScope: "local-cli",
    },
    deadlineMs: 2000,
    maxRepairAttempts: 0,
    verifier: { command: process.execPath, args: ["verify.mjs"] },
  };
};
test("real caller -> qloops -> subprocess fixture -> approved change -> verifier -> resume", async (t) => {
  const r = setup(t);
  let p = await caller(r);
  assert.equal(p.code, 2);
  assert.equal(p.result.nextAction.type, "approve_spec");
  const next = {
    ...r,
    resumeRunId: p.result.runId,
    approval: { hash: p.result.nextAction.hash, decision: "approve" },
  };
  p = await caller(next);
  assert.equal(p.code, 0);
  assert.equal(p.result.status, "success");
  assert.equal(p.stderr, "");
  const invocation = JSON.parse(
    readFileSync(join(r.workspace, "fixture-invocation.json")),
  );
  assert.equal(invocation.secretLeaked, false);
  assert.equal(invocation.depth, "1");
  assert.equal(invocation.cwd, realpathSync(r.workspace));
  assert.ok(invocation.args.includes("--strict-mcp-config"));
  assert.equal((await caller(next)).result.status, "success");
});
for (const [mode, code] of [
  ["invalid", "INVALID_RESPONSE"],
  ["auth", "AUTH_REQUIRED"],
  ["denied", "PERMISSION_DENIED"],
  ["timeout", "TIMEOUT"],
])
  test(`subprocess fixture ${mode} never success`, async (t) => {
    const r = setup(t);
    r.deadlineMs = 150;
    writeFileSync(join(r.workspace, "fixture-mode.txt"), mode);
    const p = await caller(r);
    assert.notEqual(p.code, 0);
    assert.equal(p.result.error.code, code);
  });

test("changed verifier bytes invalidate approved resume", async (t) => {
  const r = setup(t);
  const first = await caller(r);
  writeFileSync(join(r.workspace, "verify.mjs"), "process.exit(0)");
  const result = await caller({
    ...r,
    resumeRunId: first.result.runId,
    approval: { hash: first.result.nextAction.hash, decision: "approve" },
  });
  assert.equal(result.result.error.code, "WORKSPACE_CHANGED");
});
