import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { buildCatalog } from "../src/catalog.mjs";
import { loadRegistry } from "../src/registry.mjs";
import { buildRegistry } from "../scripts/build-registry.mjs";

const registry = resolve("registry");
const cli = resolve("bin/q-core.mjs");

test("planned Registry entries remain discoverable without becoming raw runtime contracts", () => {
  const loaded = loadRegistry(registry);
  assert.deepEqual(loaded.planned.map((entry) => entry.id), ["agentation", "annotation-review"]);
  assert.equal(loaded.components.some((entry) => entry.id === "agentation"), false);
  assert.equal(loaded.demos.some((entry) => entry.id === "annotation-review"), false);

  const catalog = buildCatalog(join(registry, "workflows"), { registryDir: registry, examplesDir: resolve("examples") });
  const agentation = catalog.components.find((entry) => entry.id === "agentation");
  const annotation = catalog.demos.find((entry) => entry.id === "annotation-review");
  for (const entry of [agentation, annotation]) {
    assert.equal(entry.status, "planned");
    assert.equal(entry.launch, "forbidden");
    assert.equal(typeof entry.reason, "string");
  }
  assert.equal(Object.hasOwn(agentation, "kind"), false);
  assert.equal(Object.hasOwn(annotation, "proof"), false);
});

test("planned declaration is explicit: missing it exposes malformed raw data, while unrelated malformed raw data still fails", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "q-core-planned-registry-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  cpSync(registry, dir, { recursive: true });

  const plannedFile = join(dir, "planned.json");
  const planned = JSON.parse(readFileSync(plannedFile, "utf8"));
  planned.entries = planned.entries.filter((entry) => entry.id !== "agentation");
  writeFileSync(plannedFile, JSON.stringify(planned));
  assert.throws(() => loadRegistry(dir), /agentation\.json: kind must be a non-empty string/);

  planned.entries.push(JSON.parse(readFileSync(join(registry, "planned.json"), "utf8")).entries.find((entry) => entry.id === "agentation"));
  writeFileSync(plannedFile, JSON.stringify(planned));
  writeFileSync(join(dir, "components", "unplanned.json"), JSON.stringify({ id: "unplanned", contentType: "component" }));
  assert.throws(() => loadRegistry(dir), /unplanned\.json: (?:name|kind) must be a non-empty string/);
});

test("catalog source must agree with explicit planned metadata", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "q-core-planned-source-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  cpSync(registry, dir, { recursive: true });
  const sourceFile = join(dir, "catalog.source.json");
  const source = JSON.parse(readFileSync(sourceFile, "utf8"));
  source.components.find((entry) => entry.id === "agentation").launch = "allowed";
  writeFileSync(sourceFile, JSON.stringify(source));
  assert.throws(() => buildRegistry(dir), /disagrees with planned\.json at launch/);
});

test("missing or malformed planned classification fails closed instead of accepting raw contracts", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "q-core-planned-missing-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  cpSync(registry, dir, { recursive: true });
  rmSync(join(dir, "planned.json"));
  assert.throws(() => loadRegistry(dir), /agentation\.json: kind must be a non-empty string/);
  writeFileSync(join(dir, "planned.json"), "{ invalid");
  assert.throws(() => loadRegistry(dir), /planned\.json: not valid JSON/);
});

test("CLI renders planned entries and explicitly refuses to initialize or run them", () => {
  const invoke = (args) => spawnSync(process.execPath, [cli, ...args], {
    encoding: "utf8",
    env: { ...process.env, QFACTORY_REGISTRY: registry, QF_NO_UPDATE_CHECK: "1" },
  });
  const components = invoke(["catalog", "--section", "components"]);
  assert.equal(components.status, 0, components.stderr);
  assert.match(components.stdout, /agentation.*planned.*launch forbidden/i);
  assert.match(components.stdout, /No verified raw component contract exists yet/);

  const demos = invoke(["catalog", "--section", "demos"]);
  assert.equal(demos.status, 0, demos.stderr);
  assert.match(demos.stdout, /annotation-review.*planned.*launch forbidden/i);
  assert.match(demos.stdout, /No verified raw demo contract or proof exists yet/);

  for (const id of ["agentation", "annotation-review"]) {
    const blocked = invoke(["init", id, "--offline"]);
    assert.equal(blocked.status, 64);
    assert.match(`${blocked.stdout}${blocked.stderr}`, new RegExp(`${id} is planned in this registry and cannot be initialized or run`));
  }
});
