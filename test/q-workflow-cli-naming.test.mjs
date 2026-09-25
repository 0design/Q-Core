import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const cli = resolve("bin/q-core.mjs");
const invoke = (args, cwd = resolve("."), env = {}) => spawnSync(process.execPath, [cli, ...args], {
  cwd,
  encoding: "utf8",
  env: { ...process.env, QF_NO_UPDATE_CHECK: "1", ...env },
});

const retiredRenderedTerm = /\b(?:before blaming|this|no human gate)\s+(?:the\s+)?loop\b/i;

test("public q-core CLI calls the reachable product surface a workflow and retains generic kind loop", () => {
  const help = invoke(["--help"]);
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /before blaming the workflow/);
  assert.doesNotMatch(help.stdout, retiredRenderedTerm);

  const doctor = invoke(["doctor", "--offline"]);
  assert.equal(doctor.status, 0, doctor.stderr);

  const dir = mkdtempSync(join(tmpdir(), "q-core-cli-generic-loop-"));
  try {
    const generic = join(dir, "loop.yaml");
    writeFileSync(generic, `manifest: q-core.workflow/v1
id: generic-control
name: Generic control flow
version: 1.0.0
enabled: true
settings:
  budgetUsd: null
steps:
  - id: repeat
    kind: loop
    config:
      maxIterations: 1
    then:
      - id: hold
        kind: approval-gate
        config:
          reviewer: human
`);
    const validateGeneric = invoke(["validate", generic], dir);
    assert.equal(validateGeneric.status, 0, validateGeneric.stderr);
    assert.match(validateGeneric.stdout, /loop\s+repeat/);
    assert.match(validateGeneric.stdout, /this workflow only runs when you run it/);
    assert.match(validateGeneric.stdout, /no human gate — this workflow runs to the end on its own/);
    assert.doesNotMatch(validateGeneric.stdout, retiredRenderedTerm);

    const human = join(dir, "human-gate.yaml");
    writeFileSync(human, `manifest: q-core.workflow/v1
id: human-gate
name: Human gate
version: 1.0.0
enabled: true
settings:
  budgetUsd: null
steps:
  - id: gate
    kind: approval-gate
    config:
      reviewer: human
`);
    const validateHuman = invoke(["validate", human], dir);
    assert.equal(validateHuman.status, 0, validateHuman.stderr);
    assert.match(validateHuman.stdout, /this workflow stops for a human/);
    assert.doesNotMatch(validateHuman.stdout, retiredRenderedTerm);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("catalog and missing-init wording call the product unit a workflow", () => {
  const registryEnv = { QFACTORY_REGISTRY: resolve("registry") };
  const catalog = invoke(["catalog", "--section", "components"], resolve("."), registryEnv);
  assert.equal(catalog.status, 0, catalog.stderr);
  assert.match(catalog.stdout, /used by \d+ workflow\(s\)|used by none yet/);
  assert.doesNotMatch(catalog.stdout, /used by \d+ loop\(s\)/);

  const missing = invoke(["init", "missing-workflow", "--offline"], resolve("."), registryEnv);
  assert.equal(missing.status, 64);
  assert.match(`${missing.stdout}${missing.stderr}`, /no workflow "missing-workflow"/);
  assert.doesNotMatch(`${missing.stdout}${missing.stderr}`, /no loop "missing-workflow"/);
});
