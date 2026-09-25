import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { checkNamingInventory, classifyFiles, loadRules, summarize } from "../scripts/check-naming-inventory.mjs";

const root = resolve(".");
const allowlist = join(root, "scripts", "naming-inventory.allowlist.json");
const rules = loadRules(allowlist);

test("every tracked loop token is classified (QF-NAMING-01 negative inventory)", () => {
  const result = checkNamingInventory(root, allowlist);
  assert.deepEqual(result.unclassified, [], JSON.stringify(result.unclassified.slice(0, 10)));
  assert.equal(result.passed, true);
});

test("a revived qloops alias or product loop in a new active file is rejected", () => {
  for (const source of [
    "import { run } from 'qloops';",
    "export function installLoop(id) {}",
    "Pick a loop from the catalog.",
    "const url = '/loops/brand-mentions';",
  ]) {
    const result = summarize(classifyFiles([{ path: "src/new-surface.mjs", source }], rules));
    assert.equal(result.passed, false, source);
  }
});

test("release mode refuses transitional remote identity until the coordinated rename", () => {
  const files = [{ path: "package.json", source: '"url": "git+https://github.com/0design/qloops.git"' }];
  assert.equal(summarize(classifyFiles(files, rules)).passed, true);
  assert.equal(summarize(classifyFiles(files, rules), { release: true }).passed, false);
});

test("allowlist rules need a declared class and a reason", () => {
  const dir = mkdtempSync(join(tmpdir(), "q-naming-allowlist-"));
  try {
    const file = join(dir, "allowlist.json");
    writeFileSync(file, JSON.stringify({ schema: "qf.naming-inventory-allowlist/v1", classes: { x: {} }, rules: [{ class: "x", path: ".*" }] }));
    assert.throws(() => loadRules(file), /needs a reason/);
    writeFileSync(file, JSON.stringify({ schema: "qf.naming-inventory-allowlist/v1", classes: {}, rules: [{ class: "x", path: ".*", reason: "r" }] }));
    assert.throws(() => loadRules(file), /undeclared class/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
