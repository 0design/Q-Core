import assert from "node:assert/strict";
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { assertNoRetiredProductNames, verifyDemoNames, verifyHostSkillNames, verifyPackageSurface, verifyPackagedReadmeAliasBoundary, verifyProductNames, verifyReachableCliProductNames, verifyWorkflowConsumerNames } from "../scripts/check-product-names.mjs";

test("Q-Core and workflow Registry surface has no qloops aliases", () => {
  assert.doesNotThrow(() => verifyProductNames());
});

test("old qloops package name is rejected by the negative naming guard", () => {
  assert.throws(
    () => verifyPackageSurface({ name: "qloops", version: "0.2.0-q-core.23", bin: {} }, []),
    /Q-Core name/,
  );
});

test("packaged README rejects a duplicate Q-Core legacy-alias claim", () => {
  const root = mkdtempSync(join(tmpdir(), "q-core-readme-name-guard-"));
  try {
    writeFileSync(join(root, "README.md"), "Both `q-core` and legacy `q-core` are installed.\n");
    assert.throws(() => verifyPackagedReadmeAliasBoundary(root), /single Q-Core executable/);
    writeFileSync(join(root, "README.md"), "`q-core` is the only installed executable. No other CLI alias is provided.\n");
    assert.doesNotThrow(() => verifyPackagedReadmeAliasBoundary(root));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
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

test("Registry demo metadata rejects product loop wording while generic terminology remains valid", () => {
  const root = mkdtempSync(join(tmpdir(), "q-core-demo-name-guard-"));
  const file = join(root, "registry/demos/webhook-relay.json");
  mkdirSync(join(root, "registry/demos"), { recursive: true });
  try {
    writeFileSync(file, "The target loop acceptance must be reported.");
    assert.throws(() => verifyDemoNames(root), /product unit/);
    writeFileSync(file, "Close the feedback loop before reporting; control kind: loop.");
    assert.doesNotThrow(() => verifyDemoNames(root));
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

test("reachable CLI output rejects product loop wording while generic control flow remains valid", () => {
  const root = mkdtempSync(join(tmpdir(), "q-core-cli-name-guard-"));
  const cli = join(root, "bin/q-workflow.mjs");
  mkdirSync(dirname(cli), { recursive: true });
  try {
    writeFileSync(cli, "q-core doctor checks this machine before blaming the loop.\n");
    assert.throws(() => verifyReachableCliProductNames(root), /product unit/);
    writeFileSync(cli, "const controlKind = 'loop'; // generic control flow\n");
    assert.doesNotThrow(() => verifyReachableCliProductNames(root));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
