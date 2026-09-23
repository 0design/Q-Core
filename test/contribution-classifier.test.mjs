import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyPaths, parseNameStatus } from "../scripts/classify-contribution.mjs";

test("Registry-only component, workflow and demo paths use the Registry funnel", () => {
  const result = classifyPaths([
    "registry/components/source-check.json",
    "registry/workflows/source-check.yaml",
    "registry/demos/source-check.txt",
    "registry/catalog.source.json",
  ]);
  assert.equal(result.funnel, "registry");
  assert.deepEqual(result.corePaths, []);
});

test("the current Registry loops path remains classifiable during the workflow rename", () => {
  assert.equal(classifyPaths(["registry/loops/source-check.yaml"]).funnel, "registry");
});

test("every non-Registry change takes the strict Core funnel", () => {
  const result = classifyPaths([".gitignore"]);
  assert.equal(result.funnel, "core");
  assert.deepEqual(result.corePaths, [".gitignore"]);
});

test("mixed Registry and Core changes take the strict Core funnel", () => {
  const result = classifyPaths(["registry/components/source-check.json", "src/manifest.mjs"]);
  assert.equal(result.funnel, "core");
  assert.deepEqual(result.registryPaths, ["registry/components/source-check.json"]);
});

test("renames across the Registry boundary take the strict Core funnel", () => {
  const paths = parseNameStatus("R100\tregistry/workflows/source-check.yaml\tdocs/source-check.yaml\n");
  assert.equal(classifyPaths(paths).funnel, "core");
});

test("an empty or unrecognised diff fails safely into the Core funnel", () => {
  assert.equal(classifyPaths([]).funnel, "core");
  assert.equal(classifyPaths(["future/unknown.txt"]).funnel, "core");
});
