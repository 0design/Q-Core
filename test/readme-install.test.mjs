import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync, existsSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

// The README install block is executable documentation: it must refuse to call npm install
// unless the archive matches the expected SHA-256, on shasum, sha256sum and Node.js-only hosts.
const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
const block = /<!-- verify-install:start -->\n```sh\n([\s\S]*?)```\n<!-- verify-install:end -->/.exec(readme)?.[1];

function which(name) {
  try { return execFileSync("/bin/sh", ["-c", `command -v ${name}`], { encoding: "utf8" }).trim(); } catch { return null; }
}

function run(t, { archiveBytes, expected, tools }) {
  const dir = mkdtempSync(join(tmpdir(), "q-core-readme-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  // npm is a recorder: the test only asserts whether the block reached it.
  writeFileSync(join(bin, "npm"), `#!/bin/sh\necho "$@" > "${join(dir, "npm-called")}"\n`);
  chmodSync(join(bin, "npm"), 0o755);
  for (const tool of ["cut", "node", ...tools]) {
    const path = which(tool);
    if (!path) return null;
    symlinkSync(path, join(bin, tool));
  }
  writeFileSync(join(dir, "q-core-VERSION.tgz"), archiveBytes);
  const script = block.replace("ARTIFACT_SHA256_FROM_CATALOG", expected);
  const result = spawnSync("/bin/sh", ["-c", script], { cwd: dir, env: { PATH: bin }, encoding: "utf8" });
  return { code: result.status, stderr: result.stderr, npmCalled: existsSync(join(dir, "npm-called")) };
}

test("README install block verifies SHA-256 before npm install on every hashing path", (t) => {
  assert.ok(block, "README must keep the verify-install block");
  assert.ok(block.indexOf("npm install") > block.indexOf('[ "$ACTUAL" = "$EXPECTED" ]'), "hash check precedes npm install");
  const good = Buffer.from("synthetic q-core archive");
  const sha = createHash("sha256").update(good).digest("hex");
  const tampered = Buffer.from("synthetic q-core archivE");
  let paths = 0;
  for (const tools of [["shasum"], ["sha256sum"], []]) {
    const ok = run(t, { archiveBytes: good, expected: sha, tools });
    if (ok === null) continue; // this host lacks that hashing tool
    paths += 1;
    assert.equal(ok.code, 0, `${tools.join() || "node"}: ${ok.stderr}`);
    assert.equal(ok.npmCalled, true);
    for (const [bytes, expected] of [[tampered, sha], [good, "0".repeat(64)], [good, ""], [good, sha.toUpperCase()], [good, sha.slice(0, 63)]]) {
      const bad = run(t, { archiveBytes: bytes, expected, tools });
      assert.notEqual(bad.code, 0, `${tools.join() || "node"} accepted a bad archive/hash`);
      assert.equal(bad.npmCalled, false, `${tools.join() || "node"} reached npm install`);
    }
  }
  assert.ok(paths >= 2, "at least one system tool and the Node.js fallback were exercised");
});
