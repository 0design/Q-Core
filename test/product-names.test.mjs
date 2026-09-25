import assert from "node:assert/strict";
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { assertNoRetiredProductNames, assertNoRetiredProductUnitTerms, verifyDemoNames, verifyHostSkillNames, verifyPackageSurface, verifyPackagedReadmeAliasBoundary, verifyProductNames, verifyProofCliNames, verifyReachableCliProductNames, verifyRegistryComposition, verifyWorkflowConsumerNames } from "../scripts/check-product-names.mjs";

test("Q-Core and workflow Registry surface has no qloops aliases", () => {
  assert.doesNotThrow(() => verifyProductNames());
});

test("old qloops package name is rejected by the negative naming guard", () => {
  assert.throws(
    () => verifyPackageSurface({ name: "qloops", version: "0.2.0-q-core.32", bin: {} }, []),
    /Q-Core name/,
  );
});

test("packaged README rejects a duplicate Q-Core legacy-alias claim", () => {
  const root = mkdtempSync(join(tmpdir(), "q-core-readme-name-guard-"));
  try {
    writeFileSync(join(root, "README.md"), "Both `q-core` and legacy `q-core` are installed.\n");
    assert.throws(() => verifyPackagedReadmeAliasBoundary(root), /installed Q-Core executables/);
    writeFileSync(join(root, "README.md"), "Q-Core installs `q-core` and `q-core-host`. No other CLI alias is provided.\n");
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

test("Core product prose rejects a retired loop unit while control-flow loop stays valid", () => {
  assert.throws(
    () => assertNoRetiredProductUnitTerms([{ path: "SPEC-MANIFEST.md", source: "A workflow is written in a loop manifest." }]),
    /product unit/,
  );
  assert.doesNotThrow(() => assertNoRetiredProductUnitTerms([
    { path: "SPEC-MANIFEST.md", source: "A workflow may contain kind: loop with loop.maxIterations." },
  ]));
});

test("Registry composition rejects stale builtin pins and product loop prose", () => {
  const root = mkdtempSync(join(tmpdir(), "q-core-composition-name-guard-"));
  const pkg = { name: "q-core", version: "0.2.0-q-core.32" };
  const builtins = ["api-request", "fan-out", "fetch", "schedule"].map((id) => ({
    id,
    engine: { package: pkg.name, version: pkg.version, manifest: "q-core.workflow/v1" },
  }));
  const composition = { builtins, description: "A workflow may contain kind: loop." };
  try {
    mkdirSync(join(root, "registry"), { recursive: true });
    const file = join(root, "registry", "composition.json");
    writeFileSync(file, JSON.stringify({ ...composition, description: "A selected loop manifest is accepted." }));
    assert.throws(() => verifyRegistryComposition(root, pkg), /product unit/);
    writeFileSync(file, JSON.stringify({ ...composition, builtins: [{ ...builtins[0], engine: { ...builtins[0].engine, version: "0.2.0-q-core.25" } }, ...builtins.slice(1)] }));
    assert.throws(() => verifyRegistryComposition(root, pkg), /exact Q-Core candidate/);
    writeFileSync(file, JSON.stringify(composition));
    assert.doesNotThrow(() => verifyRegistryComposition(root, pkg));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
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
    writeFileSync(cli, "published catalogue · ${extra.length} loop(s) newer than this build\n");
    assert.throws(() => verifyReachableCliProductNames(root), /product unit/);
    writeFileSync(cli, "const controlKind = 'loop'; // generic control flow\n");
    assert.doesNotThrow(() => verifyReachableCliProductNames(root));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("proof CLI rejects a retired workflow spelling but permits feedback loop", () => {
  const root = mkdtempSync(join(tmpdir(), "q-core-proof-cli-name-guard-"));
  const file = join(root, "scripts/record-proof.mjs");
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, "// usage: record-proof <loop-id>\n");
    assert.throws(() => verifyProofCliNames(root), /retired loop-id contract/);
    writeFileSync(file, "// Close the feedback loop after recording a workflow run.\n");
    assert.doesNotThrow(() => verifyProofCliNames(root));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Core28 guard rejects loop-input, loop engine names, Loop identifiers and component loop prose", () => {
  for (const source of [
    'export const TRIGGER_KINDS = ["intent-input", "loop-input"];',
    'headers: { "User-Agent": "q-factory-loop-engine/1" }',
    "function printLoops(workflows) {}",
    '{ "reusableLoopComponents": [] }',
    "as stored in qf_loop_template",
  ]) {
    assert.throws(() => assertNoRetiredProductNames([{ path: "src/x.mjs", source }]), /loop-input|loop engine|Loop identifier/, source);
  }
  assert.throws(
    () => assertNoRetiredProductUnitTerms([{ path: "registry/components/x.json", source: '"notes": "overrides the loop\'s model."' }]),
    /product unit/,
  );
  assert.throws(
    () => assertNoRetiredProductUnitTerms([{ path: "registry/components/x.json", source: "when it is last, the loop is complete." }]),
    /product unit/,
  );
  assert.doesNotThrow(() => assertNoRetiredProductNames([{ path: "src/x.mjs", source: 'if (step.kind === "loop") {} // workflow-input trigger' }]));
});
