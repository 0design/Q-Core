// Release guard: inspect the exact npm file list, example output, and (when
// supplied) the decompressed packed archive. No lifecycle scripts or network.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";

const rootDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const secretShape = /(?:\bsk-(?:(?:ant-|or-)[A-Za-z0-9_-]{16,}|(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,})|\bgsk_[A-Za-z0-9]{20,}|\bAIza[A-Za-z0-9_-]{30,}|\bgh[pousr]_[A-Za-z0-9]{20,}|\bgithub_pat_[A-Za-z0-9_]{22,}|\b(?:AKIA|ASIA)[A-Z0-9]{16}\b|\b[0-9]{8,10}:[A-Za-z0-9_-]{30,})/;

// These transformations are detection only. Never include matched bytes in an
// error, stdout, or a generated file, including a synthetic test credential.
export function assertNoSecretShapes(bytes) {
  const pending = [{ text: Buffer.from(bytes).toString("utf8"), depth: 0 }];
  const seen = new Set();
  while (pending.length) {
    const { text, depth } = pending.pop();
    if (seen.has(text)) continue;
    seen.add(text);
    if (secretShape.test(text)) throw new Error("Secret-shaped string detected in release artifact; release refused");
    if (depth >= 4) continue;
    const enqueue = decoded => { if (decoded !== text) pending.push({ text: decoded, depth: depth + 1 }); };
    enqueue(text.replace(/\\+u([\da-f]{4})/gi, (_match, hex) => String.fromCharCode(Number.parseInt(hex, 16))).replace(/\\\//g, "/").replace(/\\\\/g, "\\"));
    enqueue(text.replace(/(?:%[\da-f]{2})+/gi, value => {
      try { return decodeURIComponent(value); } catch { return value; }
    }));
    for (const match of text.matchAll(/[A-Za-z0-9+/_-]{24,}={0,2}/g)) {
      const decoded = Buffer.from(match[0], "base64").toString("utf8");
      if (decoded !== match[0]) pending.push({ text: decoded, depth: depth + 1 });
    }
  }
}

function descendants(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const file = join(directory, entry.name);
    if (entry.isDirectory()) return descendants(file);
    if (!entry.isFile()) throw new Error("Unsupported file type in release examples; release refused");
    return [file];
  });
}

export function checkArtifacts({ root = rootDirectory, archive } = {}) {
  root = resolve(root);
  const cache = mkdtempSync(join(tmpdir(), "q-core-artifact-scan-cache-"));
  let packed;
  try {
    packed = JSON.parse(execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts", "--offline", "--cache", cache], {
      cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, npm_config_update_notifier: "false" },
    }));
  } catch { throw new Error("Cannot establish npm artifact file list; release refused"); }
  finally { rmSync(cache, { recursive: true, force: true }); }
  if (packed.length !== 1 || !packed[0]?.files?.length) throw new Error("Cannot establish npm artifact file list; release refused");
  const files = new Set(packed[0].files.map(({ path }) => resolve(root, path)));
  const examples = join(root, "examples");
  // Include all example outputs, even if a future package allowlist omits one.
  let exampleFiles;
  try { exampleFiles = descendants(examples); }
  catch (error) { if (error.code !== "ENOENT") throw error; exampleFiles = []; }
  for (const file of exampleFiles) files.add(file);
  for (const file of files) {
    const path = relative(root, file);
    if (path.startsWith("..") || resolve(file) === root) throw new Error("Invalid npm artifact path; release refused");
    assertNoSecretShapes(Buffer.from(path));
    assertNoSecretShapes(readFileSync(file));
  }
  if (archive) {
    // Scan uncompressed bytes, not gzip bytes; tar headers and every payload are
    // inspected without extracting paths or trusting an external tar executable.
    assertNoSecretShapes(gunzipSync(readFileSync(resolve(root, archive))));
  }
  return { files: files.size, packageFiles: packed[0].files.length, exampleFiles: exampleFiles.length, archives: archive ? 1 : 0, secretShapes: 0 };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2);
    if (args.length && (args.length !== 2 || args[0] !== "--archive")) throw new Error("Usage: check-no-secrets-in-artifacts.mjs [--archive FILE.tgz]");
    console.log(JSON.stringify(checkArtifacts({ archive: args[1] })));
  } catch (error) {
    // Child-process/read errors can contain source bytes or user-controlled
    // names. Only the guard's fixed, non-secret diagnostic reaches release logs.
    console.error(secretShape.test(String(error.message)) || !/^(Secret-shaped|Cannot establish|Invalid npm|Unsupported file type|Usage:)/.test(error.message)
      ? "Cannot safely scan release artifacts; release refused"
      : error.message);
    process.exitCode = 1;
  }
}
