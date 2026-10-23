import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/* The committed SHA256SUMS pins the packed Core archive, so a Registry check
   without --core-artifact always reports checksum drift. The production publish
   job is not run on pull requests; its build commands must therefore be the same
   commands the Registry pull request workflow executes. */
const BUILD_COMMAND = /^\s*(npm pack|node scripts\/build-registry\.mjs|node scripts\/test-registry-export\.mjs|CORE_ARCHIVE=|npm run check:)/;

function buildCommands(source, workflow) {
  const lines = source.split("\n").filter(line => BUILD_COMMAND.test(line)).map(line => line.trim());
  assert.ok(lines.length > 0, `${workflow} must build the Registry release`);
  for (const line of lines) {
    if (/build-registry\.mjs\b.*--check/.test(line))
      assert.match(line, /--core-artifact "\/tmp\/core-package\/\$CORE_ARCHIVE"/, `${workflow}: Registry --check must pass the packed Core archive with --core-artifact`);
    if (/^npm pack\b.*--json/.test(line))
      assert.match(line, /--ignore-scripts/, `${workflow}: npm pack --json must use --ignore-scripts so prepack output does not corrupt the pack JSON`);
  }
  const check = lines.findIndex(line => /build-registry\.mjs --check/.test(line));
  const pack = lines.findIndex(line => /^npm pack\b/.test(line));
  const exported = lines.findIndex(line => /build-registry\.mjs --export/.test(line));
  assert.ok(pack >= 0 && check > pack && exported > check, `${workflow} must pack Core, then check, then export`);
  const artifactGuard = lines.findIndex(line => /^npm run check:artifact-secrets -- --archive "\/tmp\/core-package\/\$CORE_ARCHIVE"$/.test(line));
  assert.ok(artifactGuard > pack && artifactGuard < check, `${workflow} must scan the exact packed Core archive for secret-shaped strings before Registry checks`);
  assert.ok(lines.slice(0, pack).some(line => /npm run check:persistence-writes/.test(line)), `${workflow} must check guarded persistence before packing Core`);
  return lines;
}

export function assertRegistryReleaseWorkflows({ publish, registry }) {
  const published = buildCommands(publish, "Publish Registry");
  const reviewed = buildCommands(registry, "Registry");
  assert.deepEqual(published, reviewed, "Publish Registry must run the same release build commands as the Registry pull request workflow");
}

if (import.meta.url === new URL(process.argv[1], "file:").href) {
  assertRegistryReleaseWorkflows({
    publish: readFileSync(new URL("../.github/workflows/publish-registry.yml", import.meta.url), "utf8"),
    registry: readFileSync(new URL("../.github/workflows/registry.yml", import.meta.url), "utf8"),
  });
  console.log("Registry release workflows: publish build matches the pull request build");
}
