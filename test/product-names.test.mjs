import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { assertNoRetiredProductNames, verifyPackageSurface, verifyProductNames, verifyWorkflowConsumerNames } from "../scripts/check-product-names.mjs";

test("Q-Core and workflow Registry surface has no qloops aliases", () => {
  assert.doesNotThrow(() => verifyProductNames());
});

test("old qloops package name is rejected by the negative naming guard", () => {
  assert.throws(
    () => verifyPackageSurface({ name: "qloops", version: "0.2.0-q-core.21", bin: {} }, []),
    /Q-Core name/,
  );
});

test("hostile qloops compatibility alias in any Core source is rejected", () => {
  assert.throws(
    () => assertNoRetiredProductNames([{ path: "src/agent.mjs", source: "export const legacy = 'qloops compatibility alias';" }]),
    /qloops compatibility alias/,
  );
});

test("Registry6 workflow consumers reject retired product loop terms while generic feedback loop remains valid", () => {
  const root = mkdtempSync(join(tmpdir(), "q-core-workflow-name-guard-"));
  const file = join(root, "registry/workflows/digest.yaml");
  mkdirSync(join(root, "registry/workflows"), { recursive: true });
  try {
    writeFileSync(file, "Read the loops catalog and validate the selected loop manifest at its loop version by loop ID.");
    assert.throws(() => verifyWorkflowConsumerNames(root), /retired product loop term/);
    writeFileSync(file, "Close the feedback loop before reporting completion. kind: loop");
    assert.doesNotThrow(() => verifyWorkflowConsumerNames(root));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
