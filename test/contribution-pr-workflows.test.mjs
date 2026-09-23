import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { assertContributionPrWorkflows } from "../scripts/check-contribution-pr-workflows.mjs";

const validate = readFileSync(new URL("../.github/workflows/validate.yml", import.meta.url), "utf8");
const registry = readFileSync(new URL("../.github/workflows/registry.yml", import.meta.url), "utf8");

test("all pull requests, including root .gitignore changes, receive unprivileged baseline validation", () => {
  assert.doesNotThrow(() => assertContributionPrWorkflows({ validate, registry }));
});

test("workflow policy rejects a restored path filter or privileged trigger", () => {
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
});
