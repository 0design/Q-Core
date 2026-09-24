import assert from "node:assert/strict";
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { assertNoRetiredProductNames, verifyHostSkillNames, verifyPackageSurface, verifyProductNames, verifyWorkflowConsumerNames } from "../scripts/check-product-names.mjs";

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

test("host and skill entrypoints reject product loop wording while generic loop terminology remains valid", () => {
  const root = mkdtempSync(join(tmpdir(), "q-core-host-skill-name-guard-"));
  const files = [
    "bin/q-core-host.mjs",
    "src/host.mjs",
    "src/skill.mjs",
    "contracts/v1/host.md",
    "contracts/v1/skill.md",
    "examples/skill-caller.mjs",
    "examples/skill-demo",
    "test/host.test.mjs",
    "test/skill.test.mjs",
  ];
  try {
    for (const relative of files) {
      const target = join(root, relative);
      mkdirSync(dirname(target), { recursive: true });
      cpSync(relative, target, { recursive: true });
    }
    const host = join(root, "src/host.mjs");
    const source = readFileSync(host, "utf8");
    writeFileSync(host, `${source}\n// The pinned loop is accepted by this host.\n`);
    assert.throws(() => verifyHostSkillNames(root), /product unit/);
    writeFileSync(host, `${source}\n// Close the feedback loop; control step kind: loop.\n`);
    assert.doesNotThrow(() => verifyHostSkillNames(root));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
