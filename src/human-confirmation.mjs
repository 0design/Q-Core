/**
 * Human confirmation for a human gate (`q-core approve`).
 *
 * A decision at a `reviewer: human` gate must be typed by a person, not by the
 * agent that is driving the run. Agents run commands without a terminal, so Q-Core
 * asks on the controlling terminal (/dev/tty), not on stdin/stdout:
 *
 *   1. refuse inside a known agent session (CLAUDECODE, AI_AGENT, CODEX_SANDBOX, ...);
 *   2. refuse unless stdin and stdout are terminals;
 *   3. open /dev/tty (no controlling terminal -> refuse);
 *   4. write a fresh one-time code to /dev/tty only (never to stdout/stderr) and
 *      read it back from /dev/tty; anything else refuses.
 *
 * Threat model and limits (SPEC-MANIFEST "Human gate"):
 * - Stops an agent that runs `q-core approve` itself, directly or from its own
 *   script (no terminal, agent environment), and a blind `yes |` or piped answer
 *   (the code is random per call and is read only from the terminal).
 * - It is not an identity service. A process of the same OS user that deliberately
 *   removes the agent markers AND drives a pseudo-terminal can still answer; the
 *   instructions forbid that and it leaves a trace. Run state on disk is not signed.
 * - POSIX terminals only (macOS, Linux). There is no Windows console path yet.
 */
import { openSync, closeSync, readSync, writeSync } from "node:fs";
import { randomInt } from "node:crypto";

/** Environment variables that mark a process started by a coding agent. */
export const AGENT_SESSION_ENV = Object.freeze([
  "CLAUDECODE",
  "CLAUDE_CODE_ENTRYPOINT",
  "AI_AGENT",
  "CODEX_SANDBOX",
  "CODEX_SANDBOX_NETWORK_DISABLED",
  "CODEX_THREAD_ID",
  "CURSOR_AGENT",
  "GEMINI_CLI",
  "OPENCODE",
]);

export class HumanConfirmationError extends Error {
  constructor(reason, message) {
    super(message);
    this.code = "HUMAN_CONFIRMATION_REQUIRED";
    this.reason = reason;
  }
}

/** The first agent-session marker present in env, or null. */
export function agentSessionMarker(env = process.env) {
  return AGENT_SESSION_ENV.find((name) => env[name] != null && env[name] !== "") ?? null;
}

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export function oneTimeCode(length = 6, pick = randomInt) {
  let code = "";
  for (let i = 0; i < length; i++) code += ALPHABET[pick(ALPHABET.length)];
  return code;
}
const normalize = (s) => String(s ?? "").toUpperCase().replace(/[\s-]/g, "");

/** Default terminal: the controlling terminal of this process. */
function openControllingTerminal() {
  if (process.platform === "win32")
    throw new HumanConfirmationError("no-terminal", "Human approval needs a POSIX terminal (macOS or Linux); Windows consoles are not supported yet.");
  let rfd, wfd;
  try {
    rfd = openSync("/dev/tty", "r");
    wfd = openSync("/dev/tty", "w");
  } catch {
    if (rfd !== undefined) closeSync(rfd);
    throw new HumanConfirmationError("no-terminal", "This process has no controlling terminal.");
  }
  return {
    write: (text) => writeSync(wfd, text),
    readLine: () => {
      const buf = Buffer.alloc(256);
      let line = "";
      for (;;) {
        const n = readSync(rfd, buf, 0, buf.length, null);
        if (n <= 0) return line;
        line += buf.subarray(0, n).toString("utf8");
        const nl = line.indexOf("\n");
        if (nl >= 0) return line.slice(0, nl);
        if (line.length > 1024) return line;
      }
    },
    close: () => { closeSync(rfd); closeSync(wfd); },
  };
}

/**
 * Ask a person at the controlling terminal to confirm one decision.
 * Resolves to a confirmation record; throws HumanConfirmationError otherwise.
 * `io` exists for tests: { env, stdinIsTTY, stdoutIsTTY, openTerminal, code }.
 */
export function confirmHumanDecision({ decision, lines = [] }, io = {}) {
  const env = io.env ?? process.env;
  const marker = agentSessionMarker(env);
  if (marker)
    throw new HumanConfirmationError("agent-session", `This shell belongs to an agent session (${marker} is set).`);
  const stdinIsTTY = io.stdinIsTTY ?? Boolean(process.stdin.isTTY);
  const stdoutIsTTY = io.stdoutIsTTY ?? Boolean(process.stdout.isTTY);
  if (!stdinIsTTY || !stdoutIsTTY)
    throw new HumanConfirmationError("not-a-terminal", "stdin and stdout must be a terminal, not a pipe or a file.");
  const terminal = (io.openTerminal ?? openControllingTerminal)();
  try {
    const code = io.code ?? oneTimeCode();
    const verb = decision === "reject" ? "REJECT" : "APPROVE";
    terminal.write(`\n  Q-Core · human decision\n${lines.map((l) => `  ${l}\n`).join("")}\n`);
    terminal.write(`  To ${verb} this exact subject, type the code ${code} and press Enter.\n  Anything else cancels and the run keeps waiting.\n  code: `);
    const answer = terminal.readLine();
    if (normalize(answer) !== code) {
      terminal.write("  Not confirmed. Nothing changed.\n");
      throw new HumanConfirmationError("code-mismatch", "The one-time code was not confirmed at the terminal.");
    }
    terminal.write(`  Confirmed: ${decision}.\n\n`);
    return { decision, channel: "tty-code", confirmedAt: new Date().toISOString() };
  } finally {
    terminal.close();
  }
}
