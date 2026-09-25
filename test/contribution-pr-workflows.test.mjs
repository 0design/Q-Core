import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { assertContributionPrWorkflows } from "../scripts/check-contribution-pr-workflows.mjs";

const validate = readFileSync(new URL("../.github/workflows/validate.yml", import.meta.url), "utf8");
const registry = readFileSync(new URL("../.github/workflows/registry.yml", import.meta.url), "utf8");

test("all pull requests, including root .gitignore changes, receive unprivileged baseline validation", () => {
  assert.doesNotThrow(() => assertContributionPrWorkflows({ validate, registry }));
});

test("workflow policy rejects restored filters, privileged triggers, secrets, and write permissions", () => {
  const pathFiltered = validate.replace("  pull_request:\n", "  pull_request:\n    paths: ['src/**']\n");
  assert.throws(
    () => assertContributionPrWorkflows({ validate: pathFiltered, registry }),
    /without a path filter/,
  );

  const privileged = validate.replace("  pull_request:\n", "  pull_request_target:\n");
  assert.throws(
    () => assertContributionPrWorkflows({ validate: privileged, registry }),
    /must stay unprivileged/,
  );

  const secret = validate.replace("permissions:\n", "env:\n  TOKEN: ${{ secrets.TOKEN }}\npermissions:\n");
  assert.throws(
    () => assertContributionPrWorkflows({ validate: secret, registry }),
    /must not access secrets/,
  );

  for (const [name, workflow] of [["baseline", validate], ["registry", registry]]) {
    const writeEnabled = workflow.replace("  contents: read\n", "  contents: read\n  pull-requests: write\n");
    assert.throws(
      () => assertContributionPrWorkflows(name === "baseline" ? { validate: writeEnabled, registry } : { validate, registry: writeEnabled }),
      /must declare exactly read-only contents permission/,
    );
    const jobWrite = workflow.replace(/(\n    runs-on: [^\n]+\n)/, "$1    permissions:\n      contents: write\n");
    assert.notEqual(jobWrite, workflow);
    assert.throws(
      () => assertContributionPrWorkflows(name === "baseline" ? { validate: jobWrite, registry } : { validate, registry: jobWrite }),
      /must not declare job-level permissions/,
    );
  }
});
