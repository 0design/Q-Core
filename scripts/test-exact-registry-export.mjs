import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sha256 = (body) => createHash("sha256").update(body).digest("hex");
const integrity = (body) => `sha512-${createHash("sha512").update(body).digest("base64")}`;
const run = (command, args, cwd) => execFileSync(command, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const temp = mkdtempSync(join(tmpdir(), "q-core-registry-export-"));

try {
  const packed = JSON.parse(run("npm", ["pack", "--ignore-scripts", "--json", root], temp));
  assert.equal(packed.length, 1, "npm pack must produce exactly one Core archive");
  const archive = join(temp, packed[0].filename);
  const body = readFileSync(archive);
  const catalog = JSON.parse(readFileSync(join(root, "registry", "catalog.source.json"), "utf8"));
  assert.equal(sha256(body), catalog.core.artifactSha256, "fresh Core tar SHA256 must equal the Registry pin");
  assert.equal(integrity(body), catalog.core.integrity, "fresh Core tar integrity must equal the Registry pin");
  const exported = join(temp, "registry");
  run(process.execPath, ["scripts/build-registry.mjs", "--export", exported, "--core-artifact", archive], root);
  run(process.execPath, ["scripts/test-registry-export.mjs", exported], root);
  console.log(JSON.stringify({ exactCoreTarPin: true, versionedRegistryExport: true, cleanInstall: true }));
} finally {
  rmSync(temp, { recursive: true, force: true });
}
