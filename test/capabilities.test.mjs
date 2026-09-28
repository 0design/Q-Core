import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { coreCapabilities } from "../src/capabilities.mjs";

const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const contractMetadata = JSON.parse(readFileSync(new URL("../contracts/v1/version.json", import.meta.url), "utf8"));

test("coreCapabilities exposes static contract and provider metadata", () => {
  const capabilities = coreCapabilities();

  assert.deepEqual(capabilities, {
    schema: "qf.capabilities/v1",
    packageVersion: packageJson.version,
    manifestProtocol: "q-core.workflow/v1",
    agentProtocol: "qf.agent/v1",
    contentProtocol: "qf.content-request/v1",
    contractRevision: contractMetadata.revision,
    providerKinds: ["claude", "codex", "openrouter", "caller"],
    reviewedCliVersions: {
      claude: ["2.1.156"],
      codex: ["0.153.4", "0.154.0-alpha.6.2"],
    },
    secretStore: {
      platforms: ["darwin"],
      modes: ["env", "keychain"],
    },
  });
  assert.equal(Object.isFrozen(capabilities), true);
  assert.equal("hostedInstructions" in capabilities, false);
  assert.equal("secret" in capabilities, false);
});

test("installed consumer can import capabilities without provider startup", () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "q-core-capabilities-"));
  const archiveDir = join(tempRoot, "archive");
  const appDir = join(tempRoot, "consumer");
  mkdirSync(archiveDir);
  mkdirSync(appDir);
  const packed = JSON.parse(execFileSync(
    "npm",
    ["pack", "--ignore-scripts", "--no-audit", "--no-fund", "--pack-destination", archiveDir, "--json"],
    { cwd: new URL("..", import.meta.url), encoding: "utf8" },
  ));
  const archive = join(archiveDir, packed[0].filename);
  writeFileSync(join(appDir, "package.json"), JSON.stringify({
    name: "capabilities-consumer",
    private: true,
    type: "module",
  }));
  execFileSync("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", archive], {
    cwd: appDir,
    stdio: "pipe",
  });
  const output = execFileSync(process.execPath, [
    "--input-type=module",
    "-e",
    "import { coreCapabilities } from 'q-core'; console.log(JSON.stringify(coreCapabilities()))",
  ], { cwd: appDir, encoding: "utf8" });
  const installed = JSON.parse(output);
  assert.equal(installed.packageVersion, packageJson.version);
  assert.equal(installed.contractRevision, contractMetadata.revision);
  assert.equal(installed.schema, "qf.capabilities/v1");
  assert.deepEqual(installed.providerKinds, ["claude", "codex", "openrouter", "caller"]);
  assert.deepEqual(installed.secretStore.modes, ["env", "keychain"]);
});
