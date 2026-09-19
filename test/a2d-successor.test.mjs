import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { determined } from "../src/determined.mjs";
import { hash } from "../src/contracts.mjs";

const root = resolve(".");
const pkg = JSON.parse(readFileSync(resolve(root, "package.json")));
const guide = readFileSync(resolve(root, "docs/a2d-migration.md"), "utf8");
const contract = readFileSync(resolve(root, "contracts/v1/determined.md"), "utf8");

test("public package ships the explicit A2D successor guide", () => {
  const packed = JSON.parse(execFileSync("npm", ["pack", root, "--dry-run", "--ignore-scripts", "--json"], {
    encoding: "utf8",
  }))[0];
  assert.ok(packed.files.some(({ path }) => path === "docs/a2d-migration.md"));
  assert.match(contract, /A2D migration guide/);
  for (const term of ["a2done", "binary `a2d`", "MCP server\/tool ID `a2d`", "`.a2d` saved state"]) {
    assert.match(guide, new RegExp(term));
  }
});

test("historical A2D command, binary and package subpath fail closed", () => {
  assert.equal(pkg.bin.a2d, undefined);
  assert.equal(pkg.exports["./a2d"], undefined);
  const implementation = ["bin", "src"].flatMap((directory) =>
    readdirSync(resolve(root, directory), { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".mjs"))
      .map((entry) => readFileSync(resolve(entry.path, entry.name), "utf8")),
  ).join("\n");
  assert.doesNotMatch(implementation, /\.a2d/);
  assert.doesNotMatch(implementation, /["']a2d["']/);
  const cli = spawnSync(process.execPath, [resolve(root, "bin/qloops.mjs"), "a2d"], {
    encoding: "utf8",
    env: { ...process.env, QF_NO_UPDATE_CHECK: "1" },
  });
  assert.equal(cli.status, 64);
  assert.match(cli.stderr, /unknown command "a2d"/);
  assert.doesNotMatch(guide, /rename \.a2d|import \.a2d/i);
});

test("fresh determined evidence succeeds while old evidence cannot transfer", async () => {
  const criterion = { id: "current-result", verifier: { type: "test", command: "current-result" } };
  const artifact = { revision: 1, sha256: hash("current") };
  const accepted = await determined({ criteria: [criterion] }, {
    execute: async () => {},
    getArtifact: async () => artifact,
    verify: async ({ artifact: current }) => ({
      outcome: "pass",
      artifactHash: current.sha256,
      revision: current.revision,
    }),
  });
  assert.equal(accepted.status, "success");

  const stale = await determined({ criteria: [criterion] }, {
    execute: async () => {},
    getArtifact: async () => artifact,
    verify: async () => ({
      outcome: "pass",
      artifactHash: hash("historical-a2d-result"),
      revision: 0,
    }),
  });
  assert.equal(stale.status, "needs_human");
  assert.match(stale.reason, /stale|human/i);
});
