import assert from "node:assert/strict";
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const source = resolve("scripts/record-proof.mjs");

function invoke(root, args = []) {
  return spawnSync(process.execPath, [join(root, "scripts/record-proof.mjs"), ...args], {
    cwd: root,
    encoding: "utf8",
  });
}

test("proof writer records a successful workflow trace and never presents loop as the product unit", () => {
  const root = mkdtempSync(join(tmpdir(), "q-core-proof-writer-"));
  try {
    mkdirSync(join(root, "scripts"), { recursive: true });
    cpSync(source, join(root, "scripts/record-proof.mjs"));

    const usage = invoke(root);
    assert.equal(usage.status, 64);
    assert.match(usage.stderr, /<workflow-id>/);
    assert.doesNotMatch(usage.stderr, /<loop-id>/);

    const absent = invoke(root, ["webhook-relay"]);
    assert.equal(absent.status, 1);
    assert.match(absent.stderr, /run the workflow first/);
    assert.doesNotMatch(absent.stderr, /run the loop first/);

    const runs = join(root, "registry/workflows/.qf/runs");
    mkdirSync(runs, { recursive: true });
    writeFileSync(join(runs, "accepted.json"), JSON.stringify({
      runId: "run-accepted",
      workflowId: "webhook-relay",
      status: "success",
      summary: "Workflow delivered https://example.test/token",
      startedAt: "2026-09-24T18:00:00.000Z",
      costUsd: 0.0123,
      tokensIn: 12,
      tokensOut: 34,
      steps: [{ kind: "fetch", name: "source", status: "success", output: { text: "delivered" } }],
    }) + "\n");

    const recorded = invoke(root, ["webhook-relay"]);
    assert.equal(recorded.status, 0, recorded.stderr);
    assert.match(recorded.stdout, /webhook-relay: 1 steps/);
    assert.equal(existsSync(join(root, "examples/webhook-relay.run.json")), true);
    const trace = JSON.parse(readFileSync(join(root, "examples/webhook-relay.run.json"), "utf8"));
    assert.equal(trace.workflowId, "webhook-relay");
    assert.equal(trace.status, "success");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
