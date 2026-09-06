import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { buildCatalog, resolveCatalogRoots } from "../src/catalog.mjs";

test("resolveCatalogRoots uses QFACTORY_REGISTRY overlay", () => {
  const r = resolveCatalogRoots({ env: { QFACTORY_REGISTRY: "/tmp/reg" }, here: "/pkg/bin" });
  assert.equal(r.loopsDir, join("/tmp/reg", "loops"));
  assert.equal(r.registryDir, "/tmp/reg");
});

test("buildCatalog returns empty loops when dir is missing", () => {
  const cat = buildCatalog("/no/such/loops-dir-qloops", { registryDir: "/no/such/registry" });
  assert.equal(cat.loops.length, 0);
  assert.equal(cat.components.length, 0);
});
