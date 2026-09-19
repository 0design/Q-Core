import { subprocess, scopedEnvironment } from "../subprocess.mjs";
import { CoreError, insist } from "../contracts.mjs";
import { isAbsolute } from "node:path";
export const CLAUDE_VERSION = "2.1.156";
export const CLAUDE_VERSIONS = Object.freeze([CLAUDE_VERSION]);
const metric = (x) =>
  typeof x === "number" && Number.isFinite(x) && x >= 0 ? x : null;
const failureCode = (text, fallback = "CLI_FAILED") =>
  /auth|login|credential|401/i.test(text)
    ? "AUTH_REQUIRED"
    : /permission|denied/i.test(text)
      ? "PERMISSION_DENIED"
      : fallback;
export function claudeArgs(model) {
  return [
    "-p",
    "--output-format",
    "json",
    "--model",
    model,
    "--tools",
    "",
    "--permission-mode",
    "default",
    "--setting-sources",
    "",
    "--settings",
    JSON.stringify({ disableAllHooks: true }),
    "--strict-mcp-config",
    "--mcp-config",
    '{"mcpServers":{}}',
    "--disable-slash-commands",
    "--no-session-persistence",
    "--no-chrome",
    "--system-prompt",
    "You are a bounded text inference provider. Follow only the supplied messages. Return the requested JSON. No tools, external context or side effects.",
  ];
}
export async function claude(
  { executable, model, messages, cwd, runId, signal, timeoutMs = 90000 },
  { launch = subprocess } = {},
) {
  if (process.env.CLAUDECODE || Number(process.env.QLOOPS_DEPTH || 0) > 0)
    throw new CoreError(
      "UNSUPPORTED_NESTING",
      "Nesting guard active; use a caller-owned broker outside the active CLI session",
    );
  insist(
    typeof executable === "string" && isAbsolute(executable) &&
      typeof model === "string" && model.trim() && model.length < 200,
    "Explicit Claude model required",
  );
  insist(typeof cwd === "string" && isAbsolute(cwd), "Absolute Claude cwd required");
  insist(
    Number.isInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 300000,
    "Claude timeoutMs must be 1..300000",
  );
  insist(
    Array.isArray(messages) && messages.length > 0 && messages.length <= 100 &&
      messages.every((m) => m && ["system", "developer", "user", "assistant"].includes(m.role) && typeof m.content === "string"),
    "Claude requires bounded text messages",
  );
  insist(Buffer.byteLength(JSON.stringify({ messages })) <= 128000, "Input exceeds 128000 bytes");
  const env = scopedEnvironment({ QLOOPS_DEPTH: "1", QLOOPS_RUN_ID: runId });
  const deadline = Date.now() + timeoutMs;
  const remaining = () => {
    const ms = deadline - Date.now();
    if (ms <= 0) throw new CoreError("TIMEOUT", "Claude deadline exceeded");
    return ms;
  };
  const probe = await launch(executable, ["--version"], {
    cwd,
    env,
    signal,
    timeoutMs: Math.min(remaining(), 10000),
  });
  const version = probe.stdout.trim() === `${CLAUDE_VERSION} (Claude Code)`
    ? CLAUDE_VERSION
    : null;
  if (probe.code !== 0 || !version)
    throw new CoreError(
      "UNSUPPORTED_CLI",
      `Claude CLI version has not been reviewed (supported: ${CLAUDE_VERSIONS.join(", ")})`,
    );
  const response = await launch(executable, claudeArgs(model), {
    cwd,
    env,
    signal,
    timeoutMs: remaining(),
    input: JSON.stringify({ messages }),
  });
  let json;
  try {
    json = JSON.parse(response.stdout);
  } catch {
    const code = failureCode(
      `${response.stdout ?? ""} ${response.stderr ?? ""}`,
      response.code ? "CLI_FAILED" : "INVALID_RESPONSE",
    );
    throw new CoreError(
      code,
      "Claude did not return a valid JSON result",
    );
  }
  if (response.code !== 0 || json.is_error || json.subtype !== "success") {
    const code = failureCode(JSON.stringify(json) + " " + (response.stderr ?? ""));
    throw new CoreError(
      code,
      "Claude invocation failed; no fallback was attempted",
    );
  }
  if (json.permission_denials?.length)
    throw new CoreError(
      "PERMISSION_DENIED",
      "Claude requested an unavailable tool",
    );
  if (typeof json.result !== "string" || !json.result.trim())
    throw new CoreError("INVALID_RESPONSE", "Claude result is empty");
  return {
    content: json.result,
    requestId: json.session_id ?? null,
    provider: {
      kind: "claude",
      version,
      requestedModel: model,
      model: Object.keys(json.modelUsage ?? {})[0] ?? null,
      payerScope: "local-cli",
      permissionMode: "default",
      tools: [],
    },
    usage: {
      tokensIn: metric(json.usage?.input_tokens),
      tokensOut: metric(json.usage?.output_tokens),
      costUsd: metric(json.total_cost_usd),
      costKind: "cli-estimate",
    },
  };
}
