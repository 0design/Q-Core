/**
 * Human-only approval for the `q-core agent` (SDD) and `q-core content` JSON
 * protocols (Core 38).
 *
 * The JSON request can no longer carry a decision: a request with `approval` is
 * refused (HUMAN_APPROVAL_REQUIRED). When a run reaches its approval point the
 * response carries `nextAction: ask_human_to_approve` with the exact command a
 * person runs in their own terminal:
 *
 *   q-core agent approve <workspace> <runId> --approval-hash <hash> [--reject]
 *   q-core content approve <workspace> <runId> --approval-hash <hash> [--reject]
 *
 * That command asks exactly like `q-core approve` (confirmHumanDecision: no agent
 * session, a real terminal, a one-time code on /dev/tty) and records
 * `humanDecision: {hash, decision, channel: "tty-code", confirmedAt}` in the
 * persisted run state. The agent then resends the same JSON request without
 * `approval`; Core proceeds only when that record is bound to the current
 * approval hash.
 */
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { basename, isAbsolute, join } from "node:path";
import { CoreError, insist } from "./contracts.mjs";
import { atomicJson, lockWorkspace } from "./workspace.mjs";
import { agentSessionMarker, confirmHumanDecision, HumanConfirmationError } from "./human-confirmation.mjs";

export const HUMAN_APPROVAL_REQUIRED = "HUMAN_APPROVAL_REQUIRED";
const KINDS = ["agent", "content"];
const HASH = /^[a-f0-9]{64}$/;
const RUN_ID = /^[a-f0-9-]{36}$/;

const shellWord = (s) => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(s) ? s : `'${String(s).replace(/'/g, "'\\''")}'`);
function qcoreBin() {
  const bin = process.argv[1];
  return bin && isAbsolute(bin) && /^q-core(\.mjs)?$/.test(basename(bin)) ? bin : "q-core";
}

/** The exact command a person runs in their own terminal for this decision. */
export function humanApproveCommand(kind, workspace, runId, approvalHash) {
  return [qcoreBin(), kind, "approve", workspace, runId, "--approval-hash", approvalHash].map(shellWord).join(" ");
}

const INSTRUCTION =
  "Only a person can decide this. Show the user the exact subject, then ask them to run this command in their own terminal " +
  "(it asks for a one-time code there; add --reject to refuse). Do not run it yourself, from a script, or through a pseudo-terminal, " +
  "and never send approval in the JSON request. When the user says it is done, send the same request again without approval.";

/** nextAction for a run waiting on a person. `subject` fields are shown to the user. */
export function askHumanToApprove(kind, { workspace, runId, approvalHash, ...subject }) {
  return {
    type: "ask_human_to_approve",
    humanOnly: true,
    subject: kind === "agent" ? "specification" : "publication",
    runId,
    hash: approvalHash,
    approvalHash,
    ...subject,
    command: humanApproveCommand(kind, realpathSync(workspace), runId, approvalHash),
    instruction: INSTRUCTION,
  };
}

/** The refusal of a JSON request that carries `approval`. */
export function approvalFieldRefused(nextAction) {
  const e = new CoreError(
    HUMAN_APPROVAL_REQUIRED,
    "The JSON request cannot approve or reject; only a person decides, in their own terminal. Nothing changed; the run keeps waiting.",
  );
  e.nextAction = nextAction ?? {
    type: "ask_human_to_approve",
    humanOnly: true,
    instruction: "Send the same request again without approval. When the run waits for a decision, its response names the exact command a person runs in their own terminal.",
  };
  return e;
}

/** The recorded human decision for exactly this approval hash, or null. */
export function humanDecisionFor(record, approvalHash) {
  const d = record?.humanDecision;
  return d && HASH.test(approvalHash ?? "") && d.hash === approvalHash && ["approve", "reject"].includes(d.decision) ? d.decision : null;
}

function stateFile(kind, dir, runId) {
  return kind === "agent" ? join(dir, `agent-${runId}.json`) : join(dir, "content-state.json");
}
function readState(file) {
  insist(existsSync(file) && !lstatSync(file).isSymbolicLink(), "Unknown run or unsafe run state", "INVALID_REQUEST");
  return JSON.parse(readFileSync(file, "utf8"));
}
function waitingRecord(kind, state, runId) {
  const run = kind === "agent" ? state : Object.values(state.publications ?? {}).find((p) => p.runId === runId);
  insist(run && run.runId === runId, "Unknown run", "INVALID_REQUEST");
  insist(run.phase === "approval" && HASH.test(run.approvalHash ?? ""), "This run is not waiting for an approval decision", "STALE_APPROVAL");
  return run;
}

/** Read-only view of a waiting run (for the terminal prompt). */
export function loadWaitingRun({ kind, workspace, runId, approvalHash }) {
  insist(KINDS.includes(kind), "Unknown protocol");
  insist(RUN_ID.test(runId ?? ""), "Invalid runId");
  insist(HASH.test(approvalHash ?? ""), "--approval-hash <sha256> is required");
  const dir = join(realpathSync(workspace), ".qf");
  const run = waitingRecord(kind, readState(stateFile(kind, dir, runId)), runId);
  insist(run.approvalHash === approvalHash, "Approval does not match the current exact subject", "STALE_APPROVAL");
  return run;
}

/**
 * Record a person's decision on the persisted run, bound to its current approval
 * hash. `confirmation` is the record of how the person decided; `q-core agent
 * approve` / `q-core content approve` pass the terminal record (`tty-code`). There is
 * no default and, inside an agent session, no record is accepted (like resumeRun).
 * The JSON protocols never reach this function.
 */
export function recordHumanDecision({ kind, workspace, runId, approvalHash, decision, confirmation }) {
  insist(["approve", "reject"].includes(decision), "Decision must be approve or reject");
  insist(
    confirmation && typeof confirmation.channel === "string" && confirmation.channel.trim() && (confirmation.decision ?? decision) === decision,
    "A decision is recorded only with a human confirmation record (the approve command asks at the terminal)",
    "HUMAN_CONFIRMATION_REQUIRED",
  );
  const marker = agentSessionMarker(process.env);
  insist(!marker, `A decision is not recorded from an agent session (${marker} is set); a person runs the approve command in their own terminal`, "HUMAN_CONFIRMATION_REQUIRED");
  insist(KINDS.includes(kind), "Unknown protocol");
  insist(RUN_ID.test(runId ?? ""), "Invalid runId");
  insist(HASH.test(approvalHash ?? ""), "--approval-hash <sha256> is required");
  const lock = lockWorkspace(workspace);
  try {
    const file = stateFile(kind, lock.dir, runId);
    const state = readState(file);
    const run = waitingRecord(kind, state, runId);
    insist(run.approvalHash === approvalHash, "Approval does not match the current exact subject", "STALE_APPROVAL");
    run.humanDecision = { hash: approvalHash, decision, channel: confirmation.channel, confirmedAt: confirmation.confirmedAt ?? new Date().toISOString() };
    atomicJson(file, state);
    return { kind, runId, ...run.humanDecision };
  } finally {
    lock.release();
  }
}

function subjectLines(kind, run) {
  if (kind === "agent") {
    const identity = run.specHistory?.at(-1)?.identity ?? {};
    return [
      `intent: ${identity.intent ?? ""}`,
      `files it may change: ${(identity.allowedPaths ?? []).join(", ")}`,
      `verifier: ${[identity.verifier?.command, ...(identity.verifier?.args ?? [])].join(" ")}`,
      `provider: ${identity.provider?.kind ?? ""} ${identity.provider?.model ?? ""}`,
      `specification (revision ${run.specRevision ?? 1}): ${run.spec?.summary ?? ""}`,
      ...(run.spec?.criteria ?? []).map((c) => `  criterion: ${c}`),
      ...(run.spec?.plan ?? []).map((p) => `  plan: ${p}`),
    ];
  }
  const text = String(run.text ?? "").split("\n");
  return [
    `receiver: ${run.receiver?.id ?? ""}${run.receiver?.url && run.receiver.url !== run.receiver.id ? ` (${run.receiver.url})` : ""}`,
    "exact text:",
    ...text.slice(0, 60).map((l) => `  ${l}`),
    ...(text.length > 60 ? [`  … ${text.length - 60} more line(s); see the run state file`] : []),
  ];
}

const USAGE = (kind) => `q-core ${kind} approve <workspace> <runId> --approval-hash <sha256> [--reject] [--json]`;

/** `q-core agent|content approve ...`: a person records the decision at their terminal. Returns the exit code. */
export function humanApproveCli(kind, argv, io = {}) {
  const out = io.stdout ?? process.stdout;
  const err = io.stderr ?? process.stderr;
  const positional = [];
  const flags = new Set();
  let approvalHash;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--approval-hash") approvalHash = argv[++i];
    else if (argv[i].startsWith("--")) flags.add(argv[i].slice(2));
    else positional.push(argv[i]);
  }
  const [workspace, runId, ...extra] = positional;
  if (!workspace || !runId || extra.length || !approvalHash || [...flags].some((f) => !["reject", "json"].includes(f))) {
    err.write(`${USAGE(kind)}\n`);
    return 64;
  }
  const decision = flags.has("reject") ? "reject" : "approve";
  const json = flags.has("json");
  let run;
  try {
    run = loadWaitingRun({ kind, workspace, runId, approvalHash });
  } catch (e) {
    if (json) out.write(JSON.stringify({ runId, error: { code: e.code ?? "INVALID_REQUEST", message: e.message } }) + "\n");
    err.write(`${e.code ?? "INVALID_REQUEST"}: ${e.message}\nNothing changed.\n`);
    return 1;
  }
  const command = humanApproveCommand(kind, realpathSync(workspace), runId, approvalHash) + (decision === "reject" ? " --reject" : "");
  let confirmation;
  try {
    confirmation = (io.confirm ?? confirmHumanDecision)({
      decision,
      lines: [`${kind === "agent" ? "q-core agent (SDD)" : "q-core content"} · run ${runId}`, `approval hash ${approvalHash}`, ...subjectLines(kind, run)],
    });
  } catch (e) {
    if (!(e instanceof HumanConfirmationError)) throw e;
    if (json)
      out.write(JSON.stringify({ runId, status: "needs_human", error: { code: e.code, reason: e.reason, message: e.message }, nextAction: { ...askHumanToApprove(kind, { workspace, runId, approvalHash }), command } }) + "\n");
    err.write(
      `HUMAN_CONFIRMATION_REQUIRED: ${e.message}\n` +
        `q-core ${kind} approve takes a decision only from a person typing a one-time code at their own terminal.\n` +
        `The run is still waiting; nothing changed.\n` +
        `Agents: do not retry or work around this. Show the user the exact subject and ask them to run, in their own terminal:\n` +
        `  ${command}\n`,
    );
    return 2;
  }
  try {
    const recorded = recordHumanDecision({ kind, workspace, runId, approvalHash, decision, confirmation });
    if (json) out.write(JSON.stringify({ runId, status: "recorded", humanDecision: recorded }) + "\n");
    else out.write(`\n  RECORDED: ${decision} for run ${runId}. The caller continues by sending the same request again, without approval.\n`);
    return 0;
  } catch (e) {
    if (json) out.write(JSON.stringify({ runId, error: { code: e.code ?? "INVALID_REQUEST", message: e.message } }) + "\n");
    err.write(`${e.code ?? "INVALID_REQUEST"}: ${e.message}\nNothing changed.\n`);
    return 1;
  }
}
