/**
 * The driver — `driveRun` without a database.
 *
 * Step for step it follows `lib/processes/orchestrator.ts`, and the order of the
 * checks is the part that matters most:
 *
 *   0. a kind the engine does not execute → the step fails BY NAME
 *   1. BUDGET, before the paid step — a ceiling verified afterwards is not a
 *      ceiling, it is a report of an overrun
 *   2. sensitivity — see the refusal below; this build does not implement it
 *   3. execute, record output + tokens + cost
 *
 * A run that stops at a human gate is not finished and not failed: it is
 * `waiting_human`, held on disk, and `q-core approve` continues it from exactly
 * there. The workflow re-reads its own step list on every iteration, which is why a
 * run parked yesterday resumes today with nothing kept in memory.
 *
 * HUMAN-GATE IS OPTIONAL. Nothing here assumes a run must meet a person; a workflow
 * that ends in `api-request` is a complete workflow.
 */
import { flattenWorkflowSteps, isExpandingFanOut, isControlFlow, SEQ_STRIDE } from "./flatten.mjs";
import { runFetch, runLlmCall, runApiRequest, runApprovalGate, stepLabel } from "./steps.mjs";
import { registryCliStep } from "./registry-cli-step.mjs";
import { runParseWeb, runDeduplicate, runVerifySources } from "./registry-data-steps.mjs";
import { runWorkspaceRead, runSpecification, runWorkspaceApply, runVerifyArtifact, runDetermined, assertFreshWorkspaceArtifact } from "./registry-workspace-steps.mjs";
import { snapshot, contextFiles } from './workspace.mjs';
import { assertInferenceReply, invalidateInference } from "./caller-inference.mjs";
import { resolveTemplate } from "./template.mjs";
import { num, str } from "./config.mjs";
import { resolveTemplateValue } from "./template.mjs";
import { usdForTokens } from "./cost.mjs";
import { RunStore, newRunId } from "./state.mjs";
import { hash, insist } from "./contracts.mjs";

/** Default ceiling per run, USD. Not infinity: a run without one spends whatever
 *  it manages to before somebody notices. Raise it explicitly in `settings`. */
export const DEFAULT_RUN_BUDGET_USD = 1;
export const DEFAULT_MAX_TOKENS = 1200;
export const MAX_EXPANDED_RUN_ROWS = 10_000;

const ENGINE_KINDS = new Set(["fetch", "llm-call", "api-request", "approval-gate", "parse-web", "deduplicate", "verify-sources", "workspace-read", "specification", "workspace-apply", "verify-artifact", "determined"]);

/** The three knobs, resolved once per run, with where each value came from. */
export function resolveKnobs(settings = {}) {
  const model = settings.model ?? process.env.OPENROUTER_MODEL ?? null;
  const budgetUsd =
    "budgetUsd" in settings ? settings.budgetUsd : DEFAULT_RUN_BUDGET_USD;
  return {
    model,
    budgetUsd,
    sensitivity: settings.sensitivity ?? null,
    limits: settings.limits ?? null,
    exit: settings.exit ?? { kind: "always_done" },
    provenance: {
      model: settings.model ? "workflow settings" : process.env.OPENROUTER_MODEL ? "OPENROUTER_MODEL" : "not configured",
      budget: "budgetUsd" in settings ? "workflow settings" : "default",
    },
  };
}

/** Per-step model override (knob 2 is strongest at the step). */
function stepModel(step, knobs) {
  return str(step.config, "model") ?? knobs.model;
}
function stepMaxTokens(step) {
  return num(step.config, "maxTokens") ?? DEFAULT_MAX_TOKENS;
}

function summarise(status, rows, dryRun = false) {
  const ok = rows.filter((r) => r.status === "success").length;
  if (status === "success" && dryRun) {
    const planned = rows.filter((r) => r.status === "planned").length;
    return `Planned ${planned}/${rows.length} steps — dry run, nothing was executed.`;
  }
  if (status === "success") return `Completed ${ok}/${rows.length} steps.`;
  const failed = rows.find((r) => r.status === "failed");
  if (failed) return `Step "${failed.name}": ${failed.errorText ?? "failed with no explanation"}`;
  const waiting = rows.find((r) => r.status === "waiting_human");
  return waiting ? `Waiting on a human at step "${waiting.name}".` : `Completed ${ok}/${rows.length}.`;
}

/** Build the initial run record from a manifest. */
export function createRun(manifest, { trigger = "manual" } = {}) {
  const flat = flattenWorkflowSteps(manifest.steps);
  return {
    runId: newRunId(),
    workflowId: manifest.id,
    workflowName: manifest.name,
    manifestFile: manifest.file ?? null,
    trigger,
    status: "running",
    summary: "",
    startedAt: new Date().toISOString(),
    finishedAt: null,
    costUsd: 0,
    tokensIn: 0,
    tokensOut: 0,
    steps: flat.map(({ step, seq, depth, laneOf }) => ({
      seq,
      stepId: step.id,
      kind: step.kind,
      name: stepLabel(step),
      depth,
      laneOf,
      /* The step config is a SNAPSHOT. A run parked at a gate for a week must
         replay with the prompt it was created with, or its history starts lying. */
      config: step.config,
      then: step.then ?? null,
      else: step.else ?? null,
      cases: step.cases ?? null,
      default: step.default ?? null,
      status: "pending",
      decision: null,
      gateReason: null,
      output: null,
      errorText: null,
      tokensIn: 0,
      tokensOut: 0,
      costUsd: 0,
      item: undefined,
      itemIndex: null,
      startedAt: null,
      finishedAt: null,
    })),
  };
}

/**
 * Drive a run to its next stopping point: success, failure, or a human gate.
 *
 * @param {object} run    the run record (mutated and persisted as it advances)
 * @param {object} opts   { store, apiKey, dryRun, onStep }
 */
export async function driveRun(run, opts = {}) {
  const { store, apiKey = null, dryRun = false, onStep = () => {} } = opts;
  let inferenceReply = opts.inferenceReply;
  assertInferenceReply(run, inferenceReply);
  if (run.status === 'success' && run.workspacePolicy) {
    const artifact = run.steps.findLast(s => s.kind === 'workspace-apply' && s.status === 'success')?.output;
    if (artifact) try { assertFreshWorkspaceArtifact(artifact, run.workspacePolicy); }
    catch { run.status = 'needs_human'; run.summary = 'Completed artifact or verifier changed; existing evidence is stale'; store?.save(run); }
  }
  if (['waiting_human', 'failed', 'cancelled', 'needs_human', 'success'].includes(run.status)) return run;
  const knobs = opts.knobs ?? resolveKnobs(opts.settings ?? {});

  /* SENSITIVITY IS NOT IMPLEMENTED HERE — and it is refused, not ignored.
     The profile exists to stop irreversible or outbound steps and hand them to a
     person. Running the workflow anyway "because the local runner is simpler" would
     perform exactly the actions the knob was set to prevent, silently. */
  if (knobs.sensitivity) {
    throw new Error(
      "This manifest sets settings.sensitivity, which the local runner does not implement. " +
        "It is refused rather than ignored: the profile exists to hold back irreversible steps, " +
        "and ignoring it would carry them out. Run this workflow in the product, or remove the profile.",
    );
  }

  const persist = () => {
    if (store) store.save(run);
  };

  for (;;) {
    if (opts.signal?.aborted) {
      run.status = "cancelled";
      run.summary = "Run cancelled.";
      run.finishedAt = new Date().toISOString();
      persist();
      return run;
    }
    const next = run.steps.find((s) => s.status === "pending");

    if (!next) {
      const anyFailed = run.steps.some((s) => s.status === "failed");
      const anyWaiting = run.steps.some((s) => s.status === "waiting_human");
      run.status = anyFailed ? "failed" : anyWaiting ? "waiting_human" : "success";
      run.summary = summarise(run.status, run.steps, dryRun);
      run.finishedAt = new Date().toISOString();
      persist();
      return run;
    }

    /* Input of a step = outputs of prior SUCCESSFUL steps, in execution order. */
    const priorOutputs = {};
    const priorStepNames = {};
    for (const s of run.steps) {
      if (s.seq >= next.seq) break;
      priorStepNames[s.stepId] = s.name ?? s.kind;
      if (s.status === "success" && s.output != null) priorOutputs[s.stepId] = s.output;
    }

    const step = {
      id: next.stepId,
      kind: next.kind,
      config: next.config,
      then: next.then ?? undefined,
      else: next.else ?? undefined,
      cases: next.cases ?? undefined,
      default: next.default ?? undefined,
    };

    /* ── 0. fan-out — rows, not output ─────────────────────────────────── */
    if (next.kind === "fan-out") {
      expandFanOut(run, next, step, priorOutputs, priorStepNames, dryRun, next.item, next.itemIndex);
      persist();
      onStep(next);
      if (next.status === "failed") {
        run.status = "failed";
        run.summary = next.errorText;
        run.finishedAt = new Date().toISOString();
        persist();
        return run;
      }
      continue;
    }
    if (isControlFlow(step)) {
      expandControl(run, next, step, priorOutputs, priorStepNames, dryRun);
      persist();
      onStep(next);
      if (next.status === "failed") {
        run.status = "failed";
        run.summary = next.errorText;
        run.finishedAt = new Date().toISOString();
        persist();
        return run;
      }
      continue;
    }
    if (!ENGINE_KINDS.has(next.kind)) {
      next.status = "failed";
      next.errorText = `Step kind "${next.kind}" is not executed by the runner.`;
      next.startedAt = next.finishedAt = new Date().toISOString();
      persist();
      onStep(next);
      continue;
    }

    /* ── 1. BUDGET (knob 3), BEFORE the paid step ───────────────────────── */
    const spent = run.steps.reduce((acc, s) => acc + Number(s.costUsd ?? 0), 0);
    const cliStep = next.kind === "llm-call" && next.config.provider === "cli";
    const paidKind = (next.kind === "llm-call" && !cliStep) || next.kind === "approval-gate";
    if (paidKind && knobs.budgetUsd !== null && spent >= knobs.budgetUsd) {
      next.status = "failed";
      next.gateReason = "budget";
      next.errorText = `Run budget exhausted: spent $${spent.toFixed(4)} of the $${knobs.budgetUsd.toFixed(4)} ceiling (the workflow's "budgetUsd" knob).`;
      next.startedAt = next.finishedAt = new Date().toISOString();
      run.status = "failed";
      run.summary = `Stopped by budget: $${spent.toFixed(4)} ≥ $${knobs.budgetUsd.toFixed(4)}.`;
      run.finishedAt = new Date().toISOString();
      persist();
      onStep(next);
      return run;
    }

    /* ── 2. EXECUTE ─────────────────────────────────────────────────────── */
    const ctx = {
      runId: run.runId,
      templateId: run.workflowId,
      stepId: next.stepId,
      priorOutputs,
      priorStepNames,
      item: next.item,
      itemIndex: next.itemIndex,
      apiKey,
      /* What the run has spent BEFORE this step — the number {{run.costUsd}}
         resolves to. On the last api-request it is the run's whole cost. */
      spentUsd: spent,
      /* Only present when there is somewhere to write. Without a store there is
         no `.qf/` and no fallback — the request goes out or it does not. */
      fileSink: store ? (body) => store.writeSink(run.runId, body) : null,
      signal: opts.signal,
      runStore: store,
      workspacePolicy: run.workspacePolicy,
      repairSnapshot: run.repairSnapshot,
      repairAttempt: run.repairAttempt,
    };

    next.status = "running";
    next.startedAt = new Date().toISOString();
    persist();

    /* A dry run performs no side effects at all — no fetch, no model call, no
       outgoing request. It proves the manifest resolves and the order is what
       the author expected, and it says "planned", never "success". */
    if (dryRun) {
      next.status = "planned";
      next.finishedAt = new Date().toISOString();
      next.output = plannedOutput(step, ctx, knobs);
      persist();
      onStep(next);
      continue;
    }

    try {
      if (next.kind === "llm-call" && next.config.provider && !["cli", "openrouter"].includes(next.config.provider)) throw new Error("Unknown inference provider; no fallback is allowed");
      let result;
      if (cliStep) {
        if (knobs.budgetUsd !== null) throw new Error('CLI usage cost is unknown; explicitly set budgetUsd to null and use bounded inference jobs.');
        const explicitInput = step.config.input ? resolveTemplateValue(step.config.input, { priorOutputs, priorStepNames, item: next.item, index: next.itemIndex }) : undefined;
        if (step.config.input && explicitInput === undefined) throw new Error('CLI input reference did not resolve');
        const response = registryCliStep(run, {
          stepId: `${next.seq}:${next.stepId}`,
          instructions: resolveTemplate(str(step.config, 'instructions') ?? '', { priorOutputs, priorStepNames, item: next.item, index: next.itemIndex }),
          input: run.repairContext ? { input: step.config.input ? explicitInput : priorOutputs, repair: run.repairContext } : step.config.input ? explicitInput : next.item === undefined ? priorOutputs : { item: next.item, index: next.itemIndex, steps: priorOutputs },
          provider: opts.callerProvider, reply: inferenceReply, save: persist,
          maxInferenceJobs: opts.maxInferenceJobs, inferenceTtlMs: opts.inferenceTtlMs,
        });
        inferenceReply = undefined;
        const { text } = JSON.parse(response.content);
        const format = str(step.config, 'format') ?? 'text';
        if (!['text', 'json'].includes(format)) throw new Error('Unsupported CLI output format');
        const output = format === 'json' ? JSON.parse(text) : { text };
        if (format === 'json' && (!output || typeof output !== 'object')) throw new Error('CLI JSON output must be an object or array');
        result = { output, unknownUsage: true, provider: response.provider };
      } else result = await dispatch(step, ctx, knobs);
      if (['verify-artifact', 'determined'].includes(next.kind) && result.output.outcome === 'fail') {
        run.repairHistory ??= [];
        run.repairHistory.push(result.output);
        const policy = run.workspacePolicy, attempts = run.repairAttempt ?? 0;
        if (attempts >= (policy.maxRepairAttempts ?? 0)) {
          next.status = 'failed'; next.output = result.output; next.errorText = 'Independent verifier failed; repair limit reached';
          next.finishedAt = new Date().toISOString(); run.status = 'needs_human'; run.summary = next.errorText; run.finishedAt = next.finishedAt; persist(); return run;
        }
        const from = run.steps.find(s => s.stepId === next.config.repairFrom && s.seq < next.seq && s.kind === 'llm-call' && s.config.provider === 'cli');
        insist(from && run.steps.filter(s => s.seq >= from.seq && s.seq <= next.seq).every(s => ['llm-call','workspace-apply','verify-artifact','determined'].includes(s.kind)), 'Repair may only repeat the declared local proposal/apply/verify segment');
        run.repairAttempt = attempts + 1;
        run.repairSnapshot = snapshot(policy.workspace, policy.allowedPaths);
        run.repairContext = { attempt: run.repairAttempt, evidence: result.output, files: contextFiles(policy.workspace, policy.allowedPaths) };
        for (const row of run.steps.filter(s => s.seq >= from.seq && s.seq <= next.seq)) { row.status = 'pending'; row.output = null; row.errorText = null; row.startedAt = null; row.finishedAt = null; }
        persist(); continue;
      }
      const costUsd = result.costUsd ?? usdForTokens(result.tokensIn ?? 0, result.tokensOut ?? 0);
      next.status = result.waitingHuman ? "waiting_human" : "success";
      next.gateReason = result.waitingHuman ? "gate" : null;
      next.output = result.output;
      next.tokensIn = result.tokensIn ?? 0;
      next.tokensOut = result.tokensOut ?? 0;
      next.costUsd = result.unknownUsage ? null : Number(costUsd.toFixed(4));
      if (result.provider) next.provider = result.provider;
      if (result.unknownUsage) { next.tokensIn = null; next.tokensOut = null; }
      next.finishedAt = result.waitingHuman ? null : new Date().toISOString();

      run.tokensIn = run.tokensIn === null || next.tokensIn === null ? null : run.tokensIn + next.tokensIn;
      run.tokensOut = run.tokensOut === null || next.tokensOut === null ? null : run.tokensOut + next.tokensOut;
      run.costUsd = run.costUsd === null || next.costUsd === null ? null : Number((run.costUsd + next.costUsd).toFixed(4));
      persist();
      onStep(next);

      if (result.waitingHuman) {
        run.status = "waiting_human";
        run.summary = `Waiting on a human at step "${next.name ?? next.kind}".`;
        persist();
        return run;
      }
    } catch (e) {
      if (e?.code === 'INFERENCE_REQUIRED') {
        next.status = 'pending';
        run.status = 'waiting_inference';
        run.summary = 'Waiting for a reply from the selected CLI caller.';
        run.finishedAt = null;
        persist();
        return run;
      }
      if (opts.signal?.aborted) {
        next.status = "failed";
        next.errorText = "Run cancelled.";
        next.finishedAt = new Date().toISOString();
        run.status = "cancelled";
        run.summary = "Run cancelled.";
        run.finishedAt = new Date().toISOString();
        persist();
        onStep(next);
        return run;
      }
      next.status = "failed";
      next.errorText = e instanceof Error ? e.message : String(e);
      next.finishedAt = new Date().toISOString();
      run.status = "failed";
      run.summary = next.errorText;
      run.finishedAt = new Date().toISOString();
      persist();
      onStep(next);
      return run;
    }
  }
}

async function dispatch(step, ctx, knobs) {
  switch (step.kind) {
    case "workspace-read": return runWorkspaceRead(step, ctx);
    case "specification": return runSpecification(step, ctx);
    case "workspace-apply": return runWorkspaceApply(step, ctx);
    case "verify-artifact": return runVerifyArtifact(step, ctx);
    case "determined": return runDetermined(step, ctx);
    case "parse-web": return runParseWeb(step, ctx);
    case "deduplicate": return runDeduplicate(step, ctx);
    case "verify-sources": return runVerifySources(step, ctx);
    case "fetch":
      return runFetch(step, ctx);
    case "llm-call":
      return runLlmCall(step, ctx, stepModel(step, knobs), stepMaxTokens(step));
    case "api-request":
      return runApiRequest(step, ctx);
    case "approval-gate":
      return runApprovalGate(step, ctx, stepModel(step, knobs), stepMaxTokens(step));
    default:
      throw new Error(`Step kind "${step.kind}" is not executed by the runner.`);
  }
}

/** What `--dry-run` records instead of a real result. */
function plannedOutput(step, ctx, knobs) {
  const label = stepLabel(step);
  if (step.kind === "llm-call") {
    return { planned: true, step: label, model: stepModel(step, knobs), maxTokens: stepMaxTokens(step) };
  }
  if (step.kind === "fetch" || step.kind === "api-request") {
    const raw = str(step.config, "url") ?? "";
    return { planned: true, step: label, url: raw, method: str(step.config, "method") ?? (step.kind === "fetch" ? "GET" : "POST") };
  }
  if (step.kind === "approval-gate") {
    return { planned: true, step: label, reviewer: str(step.config, "reviewer") ?? "human" };
  }
  return { planned: true, step: label };
}

/**
 * Expand a fan-out lane over the items of a prior step's array.
 *
 * The expanded rows' `seq` lands BETWEEN the fan-out node and the next top-level
 * step — that is what SEQ_STRIDE leaves room for. So the item cap is not
 * arbitrary: items × lane length has to fit in the gap.
 *
 * TRUNCATION IS NEVER SILENT. How many arrived, how many were taken and why is
 * all in the node's own output. A 500-entry feed against a cap of 50 has to say
 * so, not report success and move on.
 */
function expandFanOut(run, row, step, priorOutputs, priorStepNames, dryRun, item, index) {
  const label = row.name ?? "fan-out";
  const overExpr = str(step.config, "over") ?? "";
  const lane = step.then ?? [];
  const now = new Date().toISOString();
  const fail = (msg) => {
    row.status = "failed";
    row.errorText = msg;
    row.startedAt = row.finishedAt = now;
  };

  if (lane.length === 0) {
    fail(`"${label}": the fan-out lane is empty — there is nothing to repeat per item.`);
    return;
  }
  if (!overExpr) {
    /* Pre-0034 behaviour, kept: the inlined lane runs ONCE and the node says so
       rather than pretending it expanded. */
    row.status = dryRun ? "planned" : "success";
    row.startedAt = row.finishedAt = now;
    row.output = {
      fannedOut: false,
      reason:
        'This fan-out has no "over" source, so its lane runs ONCE. Point it at a prior step\'s array to expand per item.',
    };
    return;
  }

  const value = resolveTemplateValue(overExpr, { priorOutputs, priorStepNames, item, index });
  if (!Array.isArray(value)) {
    if (dryRun) {
      /* Nothing has run, so no array can exist yet. Say that plainly instead of
         reporting a configuration error that is not one. */
      row.status = "planned";
      row.startedAt = row.finishedAt = now;
      row.output = { planned: true, step: label, over: overExpr, note: "lane size is unknown until the source step has run" };
      return;
    }
    fail(
      `"${label}": "over" (${overExpr}) did not resolve to an array` +
        `${value === undefined ? " — no such step or path" : ` (got ${typeof value})`}.`,
    );
    return;
  }

  const roomFor = Math.floor((SEQ_STRIDE - 1) / lane.length);
  const configured = num(step.config, "maxItems");
  const cap = Math.max(0, Math.min(configured && configured > 0 ? configured : 50, roomFor));
  const taken = value.slice(0, cap);

  const rows = taken.flatMap((item, i) =>
    lane.map((laneStep, j) => ({
      stepId: laneStep.id,
      kind: laneStep.kind,
      name: stepLabel(laneStep),
      depth: row.depth + 1,
      laneOf: step.id,
      config: laneStep.config,
      then: laneStep.then ?? null,
      else: laneStep.else ?? null,
      cases: laneStep.cases ?? null,
      default: laneStep.default ?? null,
      status: "pending",
      decision: null,
      gateReason: null,
      output: null,
      errorText: null,
      tokensIn: 0,
      tokensOut: 0,
      costUsd: 0,
      item,
      itemIndex: i,
      startedAt: null,
      finishedAt: null,
    })),
  );

  if (!insertExpansionRows(run, row, rows)) return;

  row.status = "success";
  row.startedAt = row.finishedAt = now;
  row.output = {
    source: overExpr,
    fannedOut: true,
    laneSteps: lane.length,
    itemsFound: value.length,
    itemsTaken: taken.length,
    stepsCreated: rows.length,
    ...(taken.length < value.length
      ? { truncated: `${value.length - taken.length} item(s) skipped by the cap of ${cap}` }
      : {}),
  };
}

function controlValue(expr, priorOutputs, priorStepNames, item, index) {
  const context = { priorOutputs, priorStepNames, item, index };
  const value = resolveTemplateValue(expr, context);
  if (value !== undefined) return value;
  const resolved = resolveTemplate(expr, context);
  if (resolved !== expr) return resolved;
  // A literal selector/condition is useful for a static branch. Exact step and
  // item templates remain the only forms that may be unresolved.
  return /^\{\{/.test(expr.trim()) ? undefined : expr;
}

function branchRows(run, row, branches, items, dryRun) {
  const lane = branches.flatMap((branch) => branch);
  const count = lane.length * items.length;
  const now = new Date().toISOString();
  if (lane.length === 0) {
    row.status = dryRun ? "planned" : "success";
    row.startedAt = row.finishedAt = now;
    row.output = { selected: false, stepsCreated: 0 };
    return true;
  }
  if (count >= SEQ_STRIDE) {
    row.status = "failed";
    row.errorText = `"${row.name ?? row.kind}": bounded expansion would create ${count} steps in one control slot (maximum ${SEQ_STRIDE - 1}).`;
    row.startedAt = row.finishedAt = now;
    return false;
  }
  const rows = items.flatMap(({ item, index }) => lane.map((child, j) => ({
    stepId: child.id,
    kind: child.kind,
    name: stepLabel(child),
    depth: row.depth + 1,
    laneOf: row.stepId,
    config: child.config,
    then: child.then ?? null,
    else: child.else ?? null,
    cases: child.cases ?? null,
    default: child.default ?? null,
    status: "pending",
    decision: null,
    gateReason: null,
    output: null,
    errorText: null,
    tokensIn: 0,
    tokensOut: 0,
    costUsd: 0,
    item,
    itemIndex: index,
    startedAt: null,
    finishedAt: null,
  })));
  if (!insertExpansionRows(run, row, rows)) return false;
  row.status = dryRun ? "planned" : "success";
  row.startedAt = row.finishedAt = now;
  row.output = { selected: true, itemsTaken: items.length, stepsCreated: rows.length };
  return true;
}

/**
 * Insert generated rows immediately after their control node. Future rows are
 * shifted as a block, leaving a fresh integer slot of SEQ_STRIDE for every
 * expansion. Previously completed rows are always before `row`, so their
 * sequence and approval history remain stable. A single allocator is shared by
 * fan-out and all control nodes, including nested mixtures.
 */
function insertExpansionRows(run, row, rows) {
  if (run.steps.length + rows.length > MAX_EXPANDED_RUN_ROWS) {
    row.status = "failed";
    row.errorText = `"${row.name ?? row.kind}": expanded run row limit ${MAX_EXPANDED_RUN_ROWS} would be exceeded.`;
    row.startedAt = row.finishedAt = new Date().toISOString();
    return false;
  }
  for (const candidate of run.steps) {
    if (candidate.seq > row.seq) candidate.seq += SEQ_STRIDE;
  }
  rows.forEach((candidate, index) => { candidate.seq = row.seq + 1 + index; });
  run.steps.push(...rows);
  run.steps.sort((a, b) => a.seq - b.seq);
  return true;
}

function expandControl(run, row, step, priorOutputs, priorStepNames, dryRun) {
  const label = row.name ?? row.kind;
  const fail = (message) => {
    row.status = "failed";
    row.errorText = `"${label}": ${message}`;
    row.startedAt = row.finishedAt = new Date().toISOString();
  };
  if (step.kind === "if") {
    const expr = str(step.config, "condition") ?? str(step.config, "when");
    const value = expr && controlValue(expr, priorOutputs, priorStepNames, row.item, row.itemIndex);
    if (value === undefined) return fail(`condition "${expr}" did not resolve`);
    const truthy = typeof value === "boolean" ? value : ["true", "1", "yes", "on"].includes(String(value).toLowerCase());
    if (branchRows(run, row, [truthy ? (step.then ?? []) : (step.else ?? [])], [{ item: row.item, index: row.itemIndex ?? 0 }], dryRun)) row.output.condition = truthy;
    return;
  }
  if (step.kind === "switch") {
    const expr = str(step.config, "on") ?? str(step.config, "value");
    const value = expr && controlValue(expr, priorOutputs, priorStepNames, row.item, row.itemIndex);
    if (value === undefined) return fail(`selector "${expr}" did not resolve`);
    const key = String(value);
    const hasCase = Object.prototype.hasOwnProperty.call(step.cases ?? {}, key);
    if (!hasCase && !step.default) return fail(`no case matches "${key}" and no default branch is configured`);
    const selected = hasCase ? step.cases[key] : step.default;
    if (branchRows(run, row, [selected], [{ item: row.item, index: row.itemIndex ?? 0 }], dryRun)) {
      row.output.selector = value;
      row.output.case = hasCase ? key : "default";
    }
    return;
  }
  if (step.kind === "loop") {
    const max = num(step.config, "maxIterations") ?? 10;
    if (branchRows(run, row, Array.from({ length: max }, () => step.then ?? []), [{ item: row.item, index: row.itemIndex ?? 0 }], dryRun)) row.output.iterations = max;
    return;
  }
  const over = str(step.config, "over");
  const value = over && resolveTemplateValue(over, { priorOutputs, priorStepNames, item: row.item, index: row.itemIndex });
  if (!Array.isArray(value)) return fail(`"over" (${over}) did not resolve to an array`);
  const maxItems = num(step.config, "maxItems") ?? 50;
  const maxConcurrency = num(step.config, "maxConcurrency") ?? 1;
  const taken = value.slice(0, maxItems);
  if (branchRows(run, row, [step.then ?? []], taken.map((item, index) => ({ item, index })), dryRun)) {
    row.output.itemsFound = value.length;
    row.output.itemsTaken = taken.length;
    row.output.maxConcurrency = maxConcurrency;
    if (taken.length < value.length) row.output.truncated = `${value.length - taken.length} item(s) skipped by the cap of ${maxItems}`;
  }
}

/** Continue a run that is parked at a human gate. */
export async function resumeRun(run, { decision, approvalHash, ...opts }) {
  insist(['approve', 'reject'].includes(decision), 'Decision must be approve or reject');
  const gate = run.steps.find((s) => s.status === "waiting_human");
  if (!gate) throw new Error(`Run ${run.runId} is not waiting on anyone (status: ${run.status}).`);
  if (gate.config.bind === 'sha256') {
    const subject = run.steps.filter(s => s.seq < gate.seq && s.status === 'success' && s.output != null).at(-1)?.output ?? null;
    insist(approvalHash === gate.output.approvalHash && hash(subject) === approvalHash && hash(gate.output.subject) === approvalHash, 'Approval does not match the current exact subject', 'STALE_APPROVAL');
  }
  gate.decision = decision;
  if (decision === "reject") {
    gate.status = "failed";
    gate.errorText = "Rejected at the gate by a human.";
    gate.finishedAt = new Date().toISOString();
    run.status = "failed";
    run.summary = `Step "${gate.name}": rejected at the gate.`;
    run.finishedAt = new Date().toISOString();
    opts.store?.save(run);
    return run;
  }
  gate.status = "success";
  gate.finishedAt = new Date().toISOString();
  run.status = "running";
  run.finishedAt = null;
  return driveRun(run, opts);
}

export function cancelWaitingRun(run, { store } = {}) {
  insist(['waiting_inference', 'waiting_human'].includes(run.status), 'Only a paused run can be cancelled here; interrupt an active process directly');
  run.cancelledFrom = run.status;
  invalidateInference(run);
  run.status = 'cancelled'; run.summary = 'Paused run cancelled; explicit resume is required';
  run.finishedAt = new Date().toISOString(); store?.save(run);
  return run;
}
export async function resumeCancelledRun(run, opts = {}) {
  insist(run.status === 'cancelled' && ['waiting_inference', 'waiting_human'].includes(run.cancelledFrom), 'Interrupted effects require reconciliation; only an explicitly paused cancellation can resume');
  run.status = run.cancelledFrom; delete run.cancelledFrom; run.finishedAt = null;
  run.summary = run.status === 'waiting_human' ? 'Waiting for approval of the pinned subject' : 'Resuming caller inference';
  opts.store?.save(run);
  return run.status === 'waiting_human' ? run : driveRun(run, opts);
}

export { RunStore };
