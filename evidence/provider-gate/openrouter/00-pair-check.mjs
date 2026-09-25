// Step 0 — machine-checkable pair identity (no network, no credential).
// Usage: QCORE_PKG=<pkg dir> QCORE_TARBALL=<Core29 .tgz> QCORE_LOCK=<package-lock.json of the install> node 00-pair-check.mjs
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { HERE, sha256, writeEvidence } from "./common.mjs";

const repo = join(HERE, "../../..");
const treeHash = (root) => {
  const files = [];
  const walk = (d) => { for (const n of readdirSync(d).sort()) { const p = join(d, n); statSync(p).isDirectory() ? walk(p) : files.push(p); } };
  walk(root);
  const h = createHash("sha256");
  for (const f of files) h.update(`${relative(root, f)}\0${sha256(readFileSync(f))}\n`);
  return { files: files.length, sha256: h.digest("hex") };
};
const tarball = process.env.QCORE_TARBALL;
const tgz = readFileSync(tarball);
const lock = JSON.parse(readFileSync(process.env.QCORE_LOCK, "utf8"));
const locked = lock.packages?.["node_modules/q-core"]?.integrity ?? null;
const integrity = "sha512-" + createHash("sha512").update(tgz).digest("base64");
const pin = readFileSync(join(repo, "registry/SHA256SUMS"), "utf8").split("\n").find((l) => l.endsWith(`vendor/${basename(tarball)}`))?.split("  ")[0] ?? null;
const repoSrc = treeHash(join(repo, "src"));
const pkgSrc = treeHash(join(process.env.QCORE_PKG, "src"));
const doc = {
  checkedAt: new Date().toISOString(),
  tarball: { name: basename(tarball), sha256: sha256(tgz), registryPin: pin, lockIntegrityMatches: locked === integrity },
  srcTree: { repository: repoSrc, installedPackage: pkgSrc, identical: repoSrc.sha256 === pkgSrc.sha256 },
  status: "Unreleased candidate pair; release gates outside this evidence remain open.",
};
doc.pass = doc.tarball.sha256 === pin && doc.tarball.lockIntegrityMatches && doc.srcTree.identical;
process.stdout.write(writeEvidence("00-pair-check.json", doc));
