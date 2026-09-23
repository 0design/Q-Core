import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

function assertReadOnlyPermissions(source, workflow) {
  const match = source.match(/^permissions:\n((?:  [^\n]+\n)+)\n*jobs:/m);
  assert.ok(match, `${workflow} must declare permissions before jobs`);
  const entries = match[1].trim().split("\n").map(line => line.trim());
  assert.deepEqual(entries, ["contents: read"], `${workflow} must declare exactly read-only contents permission`);
}

export function assertContributionPrWorkflows({ validate, registry }) {
  assert.doesNotMatch(validate, /\bpull_request_target\b/, "baseline validation must stay unprivileged");
  assert.match(
    validate,
    /^on:\n  pull_request:\s*\n  push:/m,
    "baseline validation must run on every pull request without a path filter",
  );
  assertReadOnlyPermissions(validate, "baseline validation");
  assert.doesNotMatch(validate, /\$\{\{\s*secrets\s*\./, "baseline validation must not access secrets");
  assert.match(validate, /node --test test\/\*\.test\.mjs/, "baseline validation must run Core tests");
  assert.match(validate, /node scripts\/build-registry\.mjs --check/, "baseline validation must check Registry integrity");

  assert.match(
    registry,
    /^on:\n  pull_request:\n    paths:/m,
    "Registry candidate export must remain limited to Registry-relevant pull requests",
  );
  assert.match(registry, /'registry\/\*\*'/, "Registry path filter must include Registry files");
  assert.match(registry, /'scripts\/\*registry\*'/, "Registry path filter must include its builder");
  assert.doesNotMatch(registry, /\bpull_request_target\b/, "Registry candidate export must stay unprivileged");
  assertReadOnlyPermissions(registry, "Registry candidate export");
  assert.doesNotMatch(registry, /\$\{\{\s*secrets\s*\./, "Registry candidate export must not access secrets");
  assert.match(registry, /node scripts\/build-registry\.mjs --check/, "Registry candidate export must validate before export");
}

if (import.meta.url === new URL(process.argv[1], "file:").href) {
  assertContributionPrWorkflows({
    validate: readFileSync(new URL("../.github/workflows/validate.yml", import.meta.url), "utf8"),
    registry: readFileSync(new URL("../.github/workflows/registry.yml", import.meta.url), "utf8"),
  });
}
