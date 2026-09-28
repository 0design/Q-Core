import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { assertEvidencePins, buildRegistry } from "../scripts/build-registry.mjs";

const registry = resolve("registry");

test("every Registry evidence pin matches the shipped evidence bytes", () => {
  assert.doesNotThrow(() => buildRegistry(registry));
});

test("a stale evidence sha256 in the catalog source fails the build", () => {
  const dir = mkdtempSync(join(tmpdir(), "q-core-evidence-pin-"));
  try {
    cpSync(registry, dir, { recursive: true, filter: (path) => !path.includes("/vendor") });
    const file = join(dir, "catalog.source.json");
    const source = readFileSync(file, "utf8");
    const current = JSON.parse(source).components.find((entry) => entry.id === "determined").acceptance.evidence[0].sha256;
    writeFileSync(file, source.replace(current, "1073d7d01885f6271a0149f65e8c8605a9efda69719027017bd3cdc5fa6c9c23"));
    assert.throws(() => buildRegistry(dir), /Evidence pin mismatch/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a stale evidence sha256 inside a component file fails the check", () => {
  const record = { acceptance: { evidence: [{ file: "demos/x.txt", sha256: "0".repeat(64) }] } };
  assert.throws(() => assertEvidencePins(record, () => Buffer.from("changed"), "components/x file"), /Evidence pin mismatch/);
  assert.doesNotThrow(() => assertEvidencePins({ acceptance: { evidence: ["free text evidence"] } }, () => Buffer.alloc(0), "x"));
});
