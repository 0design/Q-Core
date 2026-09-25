// Claude CLI-agent provider failure matrix on the pinned Core29 adapter.
// Rows use generated fake executables only (never the real Claude CLI), except the
// nesting-guard row, which proves the adapter refuses to launch anything while an
// active Claude Code session is detected.
// Usage: QCORE_PKG=<pkg dir> CLAUDE_BIN=<real claude path> node 01-claude-matrix.mjs
import { mkdtempSync, writeFileSync, chmodSync, mkdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readFileSync } from "node:fs";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "out");
mkdirSync(OUT, { recursive: true });
const pkg = process.env.QCORE_PKG;
const version = JSON.parse(readFileSync(join(pkg, "package.json"), "utf8")).version;
const { claude, CoreError } = await import(pathToFileURL(join(pkg, "src/index.mjs")).href);
const realBin = process.env.CLAUDE_BIN ? realpathSync(process.env.CLAUDE_BIN) : null;

const dir = realpathSync(mkdtempSync(join(tmpdir(), "qf-claude-gate-")));
const fake = (name, body) => {
  const p = join(dir, name);
  writeFileSync(p, `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "${name === "old-version" ? "2.0.0" : "2.1.156"} (Claude Code)"; exit 0; fi\ncat >/dev/null\n${body}\n`);
  chmodSync(p, 0o755);
  return p;
};
const ok = (extra = "") =>
  `echo '{"type":"result","subtype":"success","is_error":false,"result":"{\\"ok\\":true}","session_id":"stub-session","total_cost_usd":0.0001,"usage":{"input_tokens":12,"output_tokens":4},"modelUsage":{"claude-stub-model":{}}${extra}}'`;
const bins = {
  success: fake("success", ok()),
  oldVersion: fake("old-version", ok()),
  auth: fake("auth", `echo '{"type":"result","subtype":"success","is_error":true,"result":"Invalid API key · Please run /login"}'; exit 1`),
  invalid: fake("invalid", `echo 'this is not json'`),
  denied: fake("denied", ok(`,"permission_denials":[{"tool_name":"Bash"}]`)),
  empty: fake("empty", `echo '{"type":"result","subtype":"success","is_error":false,"result":"   "}'`),
  noUsage: fake("no-usage", `echo '{"type":"result","subtype":"success","is_error":false,"result":"ok"}'`),
  hang: fake("hang", `sleep 61.4199 & sleep 61.4199; wait`),
};
if (Object.values(bins).some((b) => b === realBin)) throw new Error("Matrix must never target the real Claude CLI");

const base = { model: "claude-stub-model", messages: [{ role: "user", content: "Return {\"ok\":true}" }], cwd: dir, runId: "claude-gate-matrix", timeoutMs: 20000 };
const survivors = () => {
  try { return execFileSync("/usr/bin/pgrep", ["-f", "sleep 61.4199"], { encoding: "utf8" }).trim().split("\n").filter(Boolean).length; }
  catch { return 0; }
};
async function attempt(fn) {
  const t0 = Date.now();
  try {
    const r = await fn();
    return { outcome: "success", ms: Date.now() - t0, result: { model: r.provider.model, usage: r.usage, permissionMode: r.provider.permissionMode, tools: r.provider.tools } };
  } catch (e) {
    return { outcome: "error", ms: Date.now() - t0, code: e.code ?? e.name, message: e.message };
  }
}
const rows = [];
const row = async (id, kind, check, fn) => {
  const r = await fn();
  rows.push({ id, kind, pass: typeof check === "function" ? check(r) : r.code === check, ...r });
};

// Nesting guard: evaluated with the real session marker, before any launch.
{
  const saved = process.env.CLAUDECODE;
  process.env.CLAUDECODE = "1";
  await row("nesting-guard-in-active-claude-session", "real-guard", "UNSUPPORTED_NESTING", () =>
    attempt(() => claude({ ...base, executable: realBin ?? "/usr/local/bin/claude" })));
  if (saved === undefined) delete process.env.CLAUDECODE; else process.env.CLAUDECODE = saved;
}
if (process.env.CLAUDECODE) throw new Error("Run the fake-executable rows in a process without CLAUDECODE (no real CLI is launched)");

await row("missing-binary", "fake-exec", "MISSING_EXECUTABLE", () => attempt(() => claude({ ...base, executable: join(dir, "absent-claude") })));
await row("relative-executable-rejected", "precheck", "INVALID_REQUEST", () => attempt(() => claude({ ...base, executable: "claude" })));
await row("missing-model-rejected", "precheck", "INVALID_REQUEST", () => attempt(() => claude({ ...base, model: "", executable: bins.success })));
await row("unreviewed-cli-version", "fake-exec", "UNSUPPORTED_CLI", () => attempt(() => claude({ ...base, executable: bins.oldVersion })));
await row("auth-failure-no-fallback", "fake-exec", (r) => r.code === "AUTH_REQUIRED" && /no fallback/.test(r.message), () => attempt(() => claude({ ...base, executable: bins.auth })));
await row("invalid-output", "fake-exec", "INVALID_RESPONSE", () => attempt(() => claude({ ...base, executable: bins.invalid })));
await row("permission-denied", "fake-exec", "PERMISSION_DENIED", () => attempt(() => claude({ ...base, executable: bins.denied })));
await row("empty-result", "fake-exec", "INVALID_RESPONSE", () => attempt(() => claude({ ...base, executable: bins.empty })));
await row("success-shape", "fake-exec", (r) => r.outcome === "success" && r.result.usage.costKind === "cli-estimate" && r.result.tools.length === 0 && r.result.permissionMode === "default", () =>
  attempt(() => claude({ ...base, executable: bins.success })));
await row("missing-usage-is-null", "fake-exec", (r) => r.outcome === "success" && r.result.usage.tokensIn === null && r.result.usage.costUsd === null && r.result.model === null, () =>
  attempt(() => claude({ ...base, executable: bins.noUsage })));
await row("timeout-kills-process-tree", "fake-exec", (r) => r.code === "TIMEOUT" && r.survivors === 0, async () => {
  const r = await attempt(() => claude({ ...base, executable: bins.hang, timeoutMs: 1500 }));
  await new Promise((x) => setTimeout(x, 800));
  return { ...r, survivors: survivors() };
});
await row("cancel-kills-process-tree", "fake-exec", (r) => r.code === "CANCELLED" && r.survivors === 0, async () => {
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 400);
  const r = await attempt(() => claude({ ...base, executable: bins.hang, signal: ac.signal }));
  await new Promise((x) => setTimeout(x, 800));
  return { ...r, survivors: survivors() };
});
await row("timeout-over-300000-rejected", "precheck", "INVALID_REQUEST", () => attempt(() => claude({ ...base, executable: bins.success, timeoutMs: 300001 })));
await row("input-over-128000-bytes-rejected", "precheck", "INVALID_REQUEST", () =>
  attempt(() => claude({ ...base, executable: bins.success, messages: [{ role: "user", content: "x".repeat(128001) }] })));

const summary = { total: rows.length, pass: rows.filter((r) => r.pass).length };
const text = JSON.stringify({ checkedAt: new Date().toISOString(), coreVersion: version, realCliLaunched: false, summary, rows }, null, 2)
  .replaceAll(dir, "<tmp>");
if (process.env.HOME && text.includes(process.env.HOME)) throw new Error("home path in evidence");
writeFileSync(join(OUT, "01-claude-matrix.json"), text + "\n");
for (const r of rows) console.log(`${r.pass ? "PASS" : "FAIL"}  ${r.id.padEnd(40)} ${r.kind.padEnd(11)} ${r.code ?? r.outcome}`);
console.log(JSON.stringify(summary));
process.exitCode = summary.pass === summary.total ? 0 : 1;
