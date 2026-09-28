import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { checkNamingInventory, classifyFiles, loadRules, summarize, trackedFiles } from "../scripts/check-naming-inventory.mjs";

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

test("release mode refuses a transitional class that default mode tolerates", () => {
  const dir = mkdtempSync(join(tmpdir(), "q-naming-release-"));
  try {
    const file = join(dir, "allowlist.json");
    writeFileSync(file, JSON.stringify({
      schema: "qf.naming-inventory-allowlist/v1",
      classes: { pending: { transitional: true } },
      rules: [{ class: "pending", path: "^package\\.json$", token: "qloops", reason: "fixture" }],
    }));
    const files = [{ path: "package.json", source: '"url": "git+https://github.com/0design/qloops.git"' }];
    const pendingRules = loadRules(file);
    assert.equal(summarize(classifyFiles(files, pendingRules)).passed, true);
    assert.equal(summarize(classifyFiles(files, pendingRules), { release: true }).passed, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the repository identity is Q-Core, not the retired qloops repository", () => {
  const files = [{ path: "package.json", source: '"url": "git+https://github.com/0design/qloops.git"' }];
  assert.equal(summarize(classifyFiles(files, rules), { release: true }).passed, false);
});

test("a token rule does not excuse a different retired token on the same line", () => {
  const files = [{ path: "src/run.mjs", source: 'if (step.kind === "loop") runQloopsAlias();' }];
  assert.equal(summarize(classifyFiles(files, rules)).passed, false);
});

test("untracked, non-ignored files are inventoried before commit", () => {
  const probe = join(root, "untracked-naming-probe.tmp.mjs");
  writeFileSync(probe, "export const legacy = 'qloops';\n");
  try {
    assert.equal(trackedFiles(root).some((file) => file.path === "untracked-naming-probe.tmp.mjs"), true);
    assert.equal(checkNamingInventory(root, allowlist).passed, false);
  } finally {
    rmSync(probe, { force: true });
  }
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

test("a bare qloops identifier in the manifest negative test file is not excused", () => {
  const files = [{ path: "test/manifest.test.mjs", source: "const qloops = false;" }];
  assert.equal(summarize(classifyFiles(files, rules)).passed, false);
});
