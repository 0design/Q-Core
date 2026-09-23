import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve, join } from "node:path";

export function verifyPackageSurface(pkg, binFiles) {
  assert.equal(pkg.name, "q-core", "package must use the Q-Core name");
  assert.ok(pkg.version.endsWith("-q-core.21"), "candidate version must identify Q-Core");
  assert.deepEqual(pkg.bin, {
    "q-core": "bin/q-core.mjs",
    "q-core-host": "bin/q-core-host.mjs",
  }, "only Q-Core CLI names are public");
  assert.equal(binFiles.some((file) => /^qloops?(?:-|\.)/.test(file)), false, "retired qloop binaries must not ship");
}

export function verifyProductNames(root = resolve(".")) {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  verifyPackageSurface(pkg, readdirSync(join(root, "bin")));

  const manifest = readFileSync(join(root, "src", "manifest.mjs"), "utf8");
  assert.match(manifest, /MANIFEST_TAG = "q-core\.workflow\/v1"/);
  assert.match(manifest, /family === "qloops\.loop"/, "the only retired manifest reference must fail closed");

  for (const file of ["catalog.mjs", "registry.mjs", "registry-release.mjs", "index.mjs"]) {
    const source = readFileSync(join(root, "src", file), "utf8");
    assert.equal(/qloops|qloop\b/.test(source), false, `active Core API must not retain ${file} aliases`);
  }

  assert.equal(existsSync(join(root, "registry", "workflows")), true, "Registry must expose workflows/");
  assert.equal(existsSync(join(root, "registry", "loops")), false, "Registry must not retain loops/");
  const catalog = JSON.parse(readFileSync(join(root, "registry", "catalog.source.json"), "utf8"));
  assert.ok(Array.isArray(catalog.workflows), "Registry catalog must expose workflows");
  assert.equal(Object.hasOwn(catalog, "loops"), false, "Registry catalog must not retain loops alias");
  assert.deepEqual(
    { package: catalog.core.package, version: catalog.core.version, manifest: catalog.core.manifest },
    { package: pkg.name, version: pkg.version, manifest: "q-core.workflow/v1" },
    "Registry Core pin must name this exact candidate",
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
