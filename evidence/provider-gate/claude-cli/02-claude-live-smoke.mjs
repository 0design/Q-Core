// ONE bounded live Claude smoke through Q-Core's CLI-agent provider.
// Must be launched from an ordinary terminal (or a non-Claude agent such as Codex),
// NOT from inside an active Claude Code session: Core29's nesting guard refuses
// that by design and this script does not bypass it.
// Usage: QCORE_PKG=<pkg dir> CLAUDE_BIN=<absolute claude path> node 02-claude-live-smoke.mjs
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "out");
mkdirSync(OUT, { recursive: true });
const target = join(OUT, "02-claude-live-smoke.json");
const sentinel = join(OUT, "02-claude-live-smoke.started");
if (existsSync(target) || existsSync(sentinel)) throw new Error("One-shot guard: live smoke already attempted");
if (process.env.CLAUDECODE) throw new Error("Active Claude Code session detected; run from an ordinary terminal (nesting guard is not bypassed)");

const pkg = process.env.QCORE_PKG;
const version = JSON.parse(readFileSync(join(pkg, "package.json"), "utf8")).version;
const { claude } = await import(pathToFileURL(join(pkg, "src/index.mjs")).href);
const executable = realpathSync(process.env.CLAUDE_BIN);
const cwd = realpathSync(mkdtempSync(join(tmpdir(), "qf-claude-gate-live-"))); // empty, no project context

const MODEL = "claude-haiku-4-5";
const messages = [{ role: "user", content: 'Return exactly this JSON and nothing else: {"ok":true}' }];
const startedAt = new Date().toISOString();
writeFileSync(sentinel, startedAt + "\n");
let result, error;
try {
  result = await claude({ executable, model: MODEL, messages, cwd, runId: "claude-gate-live-smoke", timeoutMs: 120000 });
} catch (e) {
  error = { code: e.code ?? e.name, message: e.message };
}
const evidence = {
  gate: "claude-cli-provider",
  coreVersion: version,
  startedAt,
  finishedAt: new Date().toISOString(),
  requestedModel: MODEL,
  outcome: error ? "error" : "success",
  error: error ?? null,
  response: result
    ? {
        provider: result.provider,
        usage: result.usage,
        output: result.content,
        outputSha256: createHash("sha256").update(result.content).digest("hex"),
      }
    : null,
};
let text = JSON.stringify(evidence, null, 2).replaceAll(cwd, "<tmp>");
if (process.env.HOME) text = text.replaceAll(process.env.HOME, "~");
if (/sk-(or|ant)-[A-Za-z0-9_-]{8,}/.test(text)) throw new Error("Refusing to write evidence: key-shaped value present");
writeFileSync(target, text + "\n");
process.stdout.write(text + "\n");
process.exitCode = error ? 1 : 0;
