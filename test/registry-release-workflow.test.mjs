import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { assertRegistryReleaseWorkflows } from "../scripts/check-registry-release-workflows.mjs";

const publish = readFileSync(new URL("../.github/workflows/publish-registry.yml", import.meta.url), "utf8");
const registry = readFileSync(new URL("../.github/workflows/registry.yml", import.meta.url), "utf8");
const check = 'node scripts/build-registry.mjs --check --core-artifact "/tmp/core-package/$CORE_ARCHIVE"';
const pack = "npm pack --ignore-scripts --pack-destination /tmp/core-package --json > /tmp/core-package/pack.json";

test("publish job builds the release with the same commands as the Registry pull request job", () => {
  assert.doesNotThrow(() => assertRegistryReleaseWorkflows({ publish, registry }));
});

test("a Registry check without the packed Core archive is rejected", () => {
  const withoutArtifact = publish.replace(check, "node scripts/build-registry.mjs --check");
  assert.notEqual(withoutArtifact, publish);
  assert.throws(() => assertRegistryReleaseWorkflows({ publish: withoutArtifact, registry }), /--core-artifact/);
});

test("npm pack --json with lifecycle scripts enabled is rejected", () => {
  const withScripts = publish.replace(pack, pack.replace("--ignore-scripts ", ""));
  assert.notEqual(withScripts, publish);
  assert.throws(() => assertRegistryReleaseWorkflows({ publish: withScripts, registry }), /--ignore-scripts/);
});

test("checking before the Core archive exists is rejected", () => {
  const reordered = publish.replace(`          ${check}\n`, "").replace(`          ${pack}\n`, `          ${check}\n          ${pack}\n`);
  assert.notEqual(reordered, publish);
  assert.throws(() => assertRegistryReleaseWorkflows({ publish: reordered, registry }), /pack Core, then check, then export/);
});

test("a publish build that diverges from the pull request build is rejected", () => {
  const diverged = publish.replace("node scripts/test-registry-export.mjs /tmp/registry", "true");
  assert.notEqual(diverged, publish);
  assert.throws(() => assertRegistryReleaseWorkflows({ publish: diverged, registry }), /same release build commands/);
});
