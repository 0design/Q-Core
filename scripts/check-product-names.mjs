import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { resolve, join } from "node:path";

export function verifyPackageSurface(pkg, binFiles) {
  assert.equal(pkg.name, "q-core", "package must use the Q-Core name");
  assert.ok(pkg.version.endsWith("-q-core.23"), "candidate version must identify Q-Core");
  assert.deepEqual(pkg.bin, {
    "q-core": "bin/q-core.mjs",
    "q-core-host": "bin/q-core-host.mjs",
  }, "only Q-Core CLI names are public");
  assert.equal(binFiles.some((file) => /^qloops?(?:-|\.)/.test(file)), false, "retired qloop binaries must not ship");
}

export function verifyPackagedReadmeAliasBoundary(root) {
  const source = readFileSync(join(root, "README.md"), "utf8");
  assert.match(source, /`q-core` is the only installed executable\./, "README must state the single Q-Core executable");
  assert.equal(
    /Both `q-core` and legacy `q-core` are installed\./.test(source),
    false,
    "README must not describe Q-Core as its own legacy alias",
  );
}

const scannedRoots = ["src", "bin", "launchd", "examples", "contracts", "docs"];
const scannedFiles = ["README.md", "CONTRIBUTING.md", "SPEC-MANIFEST.md", ".github/PULL_REQUEST_TEMPLATE.md", ".github/workflows/validate.yml"];
const hostSkillFiles = [
  "bin/q-core-host.mjs",
  "src/host.mjs",
  "src/skill.mjs",
  "contracts/v1/host.md",
  "contracts/v1/skill.md",
  "examples/skill-caller.mjs",
  "examples/skill-demo/contract.json",
  "examples/skill-demo/human-contract.json",
  "examples/skill-demo/instructions.md",
  "examples/skill-demo/verify.mjs",
  "test/host.test.mjs",
  "test/skill.test.mjs",
];

function filesBelow(root, relative) {
  const path = join(root, relative);
  if (!existsSync(path)) return [];
  if (statSync(path).isFile()) return [relative];
  return readdirSync(path, { withFileTypes: true }).flatMap((entry) =>
    filesBelow(root, join(relative, entry.name)),
  );
}

export function assertNoRetiredProductNames(files) {
  for (const { path, source } of files) {
    // The manifest deliberately rejects the retired namespace. It is not an
    // accepted alias, and keeping the exact rejected token makes that boundary
    // explicit for callers and tests.
    const inspectable = path === "src/manifest.mjs"
      ? source.replaceAll("qloops.loop", "")
      : source;
    assert.equal(/\bqloops?\b/i.test(inspectable), false, `${path} retains a qloops compatibility alias`);
    assert.equal(/\bloopId\b/.test(inspectable), false, `${path} retains the retired loopId contract`);
    assert.equal(/\bloops?\s+(?:catalog|manifest|version|id)\b/i.test(inspectable), false, `${path} retains a retired product loop term`);
  }
}

export function verifyWorkflowConsumerNames(root) {
  const files = filesBelow(root, "registry/workflows")
    .map((path) => ({ path, source: readFileSync(join(root, path), "utf8") }));
  assert.ok(files.length > 0, "Registry must contain at least one workflow consumer");
  assertNoRetiredProductNames(files);
}

export function verifyDemoNames(root) {
  const files = filesBelow(root, "registry/demos")
    .filter((path) => path.endsWith(".json"))
    .map((path) => ({ path, source: readFileSync(join(root, path), "utf8") }));
  assert.ok(files.length > 0, "Registry must contain live demo metadata");
  assertNoRetiredProductNames(files);
  for (const { path, source } of files) {
    assert.equal(
      /\b(?:a|an|the|this|that|selected|installed|pinned|target)\s+loops?\b|\bloops?\s+(?:is|are|acceptance|sequence)\b/i.test(source),
      false,
      path + " retains loop as the product unit; use workflow",
    );
  }
}

export function verifyHostSkillNames(root) {
  const files = hostSkillFiles.map((path) => {
    const absolute = join(root, path);
    assert.equal(existsSync(absolute), true, `${path} must remain in the host/skill package surface`);
    return { path, source: readFileSync(absolute, "utf8") };
  });
  assertNoRetiredProductNames(files);
  for (const { path, source } of files) {
    assert.equal(
      /\b(?:a|an|the|this|that|selected|installed|pinned)\s+loops?\b|\bloops?\s+(?:is|are)\s+(?:disabled|enabled|installed|selected|pinned)\b/i.test(source),
      false,
      `${path} retains loop as the product unit; use workflow`,
    );
  }
}

export function verifyReachableCliProductNames(root) {
  const source = readFileSync(join(root, "bin", "q-workflow.mjs"), "utf8");
  assert.equal(
    /before blaming the loop|this loop only runs|this loop stops for a human|no human gate — this loop runs/i.test(source),
    false,
    "reachable q-core CLI output retains loop as the product unit; use workflow",
  );
}

export function verifyProductNames(root = resolve(".")) {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  verifyPackageSurface(pkg, readdirSync(join(root, "bin")));

  const manifest = readFileSync(join(root, "src", "manifest.mjs"), "utf8");
  assert.match(manifest, /MANIFEST_TAG = "q-core\.workflow\/v1"/);
  assert.match(manifest, /family === "qloops\.loop"/, "the only retired manifest reference must fail closed");

  const activeSources = [...scannedRoots.flatMap((relative) => filesBelow(root, relative)), ...scannedFiles]
    .map((path) => ({ path, source: readFileSync(join(root, path), "utf8") }));
  assertNoRetiredProductNames(activeSources);
  verifyPackagedReadmeAliasBoundary(root);
  verifyWorkflowConsumerNames(root);
  verifyDemoNames(root);
  verifyHostSkillNames(root);
  verifyReachableCliProductNames(root);

  assert.equal(existsSync(join(root, "registry", "workflows")), true, "Registry must expose workflows/");
  assert.equal(existsSync(join(root, "registry", "loops")), false, "Registry must not retain loops/");
  const catalog = JSON.parse(readFileSync(join(root, "registry", "catalog.source.json"), "utf8"));
  const contractVersion = JSON.parse(readFileSync(join(root, "contracts", "v1", "version.json"), "utf8"));
  const requestSchema = readFileSync(join(root, "contracts", "v1", "request.schema.json"));
  assert.ok(Array.isArray(catalog.workflows), "Registry catalog must expose workflows");
  assert.equal(Object.hasOwn(catalog, "loops"), false, "Registry catalog must not retain loops alias");
  assert.deepEqual(
    { package: catalog.core.package, version: catalog.core.version, manifest: catalog.core.manifest },
    { package: pkg.name, version: pkg.version, manifest: "q-core.workflow/v1" },
    "Registry Core pin must name this exact candidate",
  );
  assert.equal(catalog.core.contractRevision, contractVersion.revision, "Registry must pin this contract revision");
  assert.equal(
    catalog.core.requestSchemaSha256,
    createHash("sha256").update(requestSchema).digest("hex"),
    "Registry must pin this exact request schema",
  );
  for (const entry of [...catalog.workflows, ...catalog.components, ...catalog.demos]) {
    assert.equal(entry.engine?.package, pkg.name, `${entry.id} must pin Q-Core`);
    assert.equal(entry.engine?.version, pkg.version, `${entry.id} must pin this Q-Core version`);
    assert.equal(entry.engine?.manifest, "q-core.workflow/v1", `${entry.id} must pin the workflow manifest`);
  }
  for (const demo of catalog.demos) {
    assert.equal(typeof demo.workflowId, "string", `${demo.id} must use workflowId`);
    assert.equal(Object.hasOwn(demo, "loopId"), false, `${demo.id} must not retain loopId`);
  }
}

if (import.meta.url === new URL(process.argv[1], "file:").href) {
  verifyProductNames(resolve(process.env.QCORE_NAMING_ROOT ?? "."));
  console.log(JSON.stringify({ qCore: true, workflowRegistry: true, oldAliases: false }));
}
