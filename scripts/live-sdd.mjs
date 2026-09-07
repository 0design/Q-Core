import { mkdirSync, mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { runAgent } from "../src/agent.mjs";
const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i < 0 ? fallback : process.argv[i + 1];
};
const kind = arg("--provider", "claude");
if (!["claude", "codex"].includes(kind))
  throw Error("Unsupported live CLI provider");
const approve = process.argv.includes("--approve-synthetic");
mkdirSync(".qf", { recursive: true });
const workspace = mkdtempSync(resolve(".qf/live-sdd-"));
writeFileSync(join(workspace, "value.mjs"), "export const add=()=>0;\n");
writeFileSync(
  join(workspace, "verify.mjs"),
  "import assert from 'node:assert/strict';import {add} from './value.mjs';assert.equal(add(2,3),5);assert.equal(add(-2,1),-1);console.log('2 checks passed');\n",
);
const request = {
  protocolVersion: "qf.agent/v1",
  requestId: "controlled-live-sdd",
  loop: { id: "sdd-pipeline", version: "1.0.0" },
  intent:
    "Implement arithmetic add(a,b) in value.mjs. The independent verifier checks positive and negative inputs. Only value.mjs is writable.",
  workspace,
  allowedPaths: ["value.mjs"],
  allowedTools: [process.execPath],
  provider: {
    kind,
    model: arg("--model", kind === "codex" ? "gpt-5.4-mini" : "sonnet"),
    executable: arg(
      "--executable",
      kind === "codex"
        ? "/Applications/ChatGPT.app/Contents/Resources/codex"
        : "/usr/local/bin/claude",
    ),
    payerScope: "local-cli",
  },
  deadlineMs: 90000,
  maxRepairAttempts: 1,
  verifier: { command: process.execPath, args: ["verify.mjs"] },
};
let result = await runAgent(request);
console.error(JSON.stringify({ workspace, spec: result.nextAction ?? null }));
if (approve && result.nextAction?.type === "approve_spec") {
  // Explicit opt-in approves only the generated specification in this newly
  // created synthetic workspace. It does not approve any external publication.
  request.resumeRunId = result.runId;
  request.approval = { hash: result.nextAction.hash, decision: "approve" };
  result = await runAgent(request);
  if (result.status === "success") {
    const cached = await runAgent(request);
    if (cached.status !== "success") throw Error("Completed resume failed");
  }
}
writeFileSync(
  join(workspace, "request.json"),
  JSON.stringify(request, null, 2) + "\n",
);
writeFileSync(
  join(workspace, "result.json"),
  JSON.stringify(result, null, 2) + "\n",
);
console.log(JSON.stringify(result));
process.exitCode =
  result.status === "success" ? 0 : result.status === "needs_human" ? 2 : 1;
