/**
 * Policy for workflows a user or an agent creates.
 *
 * Kept OUT of manifest.mjs on purpose: the hosted MCP serves several exact Cores with one bundled
 * validator and requires manifest.mjs, yaml.mjs and the request schema to be byte-identical across
 * them. The format is unchanged; this module adds a policy on top of it, applied by `q-core validate`,
 * `run`, `approve` and the host when they load a manifest (loadWorkflow). Library calls (loadManifest,
 * createRun/driveRun) do not apply it; a hosted validator must call assertWorkflowPolicy itself.
 *
 * - GATE_REQUIRED: a step that writes files (workspace-apply) or sends data (every api-request except an
 *   exact method: GET to a literal http(s) URL) needs a human approval-gate earlier on the same path.
 *   Reviewed Registry workflows (built into the Registry, installed or initialised unchanged) are exempt.
 * - UNUSED_WORKSPACE_READ: a workspace-read whose output no later step uses is refused in every workflow.
 */
import { readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { loadManifest, ManifestError } from "./manifest.mjs";
import { loadManifestGraph } from './material-graph.mjs';
import { CONTROL_KINDS } from './flatten.mjs';

/**
 * Steps that change something outside the run: local files or another system. An api-request is a
 * read only when it is exactly `method: GET` (the engine's spelling; any other value, a template or
 * no method means POST) to a literal http(s) URL: a file: URL or a templated one can append to a
 * local file (the file sink), so it counts as a write whatever the method.
 */
export function sideEffectOf(step) {
  if (step.kind === "workspace-apply") return "writes project files";
  if (step.kind === "api-request") {
    const url = String(step.config?.url ?? "");
    const method = step.config?.method;
    const readOnly = method === "GET" && /^https?:\/\//i.test(url) && !url.includes("{{");
    if (!readOnly) return `sends ${method === "GET" ? "a request that may write a file to" : `${method ?? "POST"} to`} ${url}`.trim();
  }
  return null;
}

const isHumanGate = (step) => step.kind === "approval-gate" && (step.config?.reviewer ?? "human") === "human";

/**
 * Gate required: a workflow created outside the reviewed Registry may not write
 * files or send data anywhere before a person has approved the run. A human
 * approval-gate must come EARLIER on the same path as every side-effect step. A gate
 * inside an if/switch branch guards only that branch. Agent gates do not count.
 * Reviewed Registry workflows (installed with a matching lock, or built into the
 * Registry release) keep their published shape and are not re-judged here.
 */
/** True when every successful run of this material passes a human gate on its top-level
 *  list (directly or through a top-level child call). A gate inside if/switch/each does not count. */
function alwaysHumanGated(graph, key, seen = new Set()) {
  if (seen.has(key)) return false;
  seen.add(key);
  return graph[key].manifest.steps.some((step) => isHumanGate(step) ||
    (step.kind === 'workflow-call' && graph[key].resolved?.[step.config.ref] && alwaysHumanGated(graph, graph[key].resolved[step.config.ref], seen)));
}

export function assertHumanGateBeforeSideEffects(steps, { graph, key } = {}) {
  const walk = (list, gated, path, materialKey) => {
    let covered = gated;
    list.forEach((step, i) => {
      const at = `${path}[${i}]`;
      const effect = sideEffectOf(step);
      if (effect && !covered) {
        throw Object.assign(new ManifestError(
          `GATE_REQUIRED: step "${step.id}" (${step.kind}) ${effect}, and no human approval-gate comes before it. ` +
            "A workflow you create may not write files or send data before a person approves the run: add an " +
            "approval-gate step with reviewer: human (bind: sha256) before it, or install the reviewed Registry " +
            "workflow unchanged with q-core install. Do not move the work into your own script instead",
          at,
        ), { materialPath: materialKey ?? null });
      }
      if (step.kind === 'workflow-call') {
        const childKey = graph?.[materialKey]?.resolved[step.config.ref];
        if (!childKey) throw Object.assign(new ManifestError('UNRESOLVED_DEPENDENCY: load and verify the complete graph before applying execution policy', at), { materialPath: materialKey ?? null });
        walk(graph[childKey].manifest.steps, covered, 'steps', childKey);
        // A child that always stops at a human gate has had a person approve before it returns.
        if (alwaysHumanGated(graph, childKey)) covered = true;
      }
      for (const key of ["then", "else", "default"]) if (step[key]) walk(step[key], covered, `${at}.${key}`, materialKey);
      for (const [name, branch] of Object.entries(step.cases ?? {})) walk(branch, covered, `${at}.cases.${name}`, materialKey);
      if (isHumanGate(step)) covered = true;
    });
  };
  walk(steps, false, "steps", key);
}

/* A human gate shows and binds one subject: the output of the last successful step
   before it in the same material. When a side effect after the gate also uses the
   output of an earlier step, the person approves less than what is sent. This is a
   warning, not a refusal: the shape can be intended, and existing workflows keep
   running unchanged. Control-flow steps directly before a gate are not judged,
   because their subject depends on the branch taken at run time. */
const STEP_REF_RE = /\{\{\s*steps\.([^{}]+?)\.output(?:\.[^}\s]+)?\s*\}\}/g;
const UNJUDGED_SUBJECT_KINDS = new Set([...CONTROL_KINDS, "fan-out"]);
const stepNames = (step) => [step.id, step.config?.name].filter((v) => typeof v === "string" && v);
const referencedSteps = (value) => new Set([...JSON.stringify(value ?? null).matchAll(STEP_REF_RE)].map((m) => m[1]));
/* Config fields that stay local: they decide how a step runs (or its delivery dedup key),
   not what it sends, so a reference in them is not part of what the person approves. */
const LOCAL_CONFIG_KEYS = new Set(["name", "receiptKey", "expect", "timeoutSec", "method"]);
const sentConfig = (config) => Object.fromEntries(Object.entries(config ?? {}).filter(([k]) => !LOCAL_CONFIG_KEYS.has(k)));
const branchesOf = (step) => [step.then, step.else, step.default, ...Object.values(step.cases ?? {})].filter(Array.isArray);

function hasSideEffect(step, graph, materialKey, seen = new Set()) {
  if (sideEffectOf(step)) return true;
  if (branchesOf(step).some((list) => list.some((s) => hasSideEffect(s, graph, materialKey, seen)))) return true;
  if (step.kind === "workflow-call") {
    const childKey = graph?.[materialKey]?.resolved?.[step.config?.ref];
    if (!childKey || seen.has(childKey)) return false;
    seen.add(childKey);
    return graph[childKey].manifest.steps.some((s) => hasSideEffect(s, graph, childKey, seen));
  }
  return false;
}

/** Side-effect steps after a gate (until the next human gate on the same list), with nested branches. */
function effectsAfter(list, from, graph, materialKey) {
  const out = [];
  const collect = (step) => {
    if (step.kind === "workflow-call" || sideEffectOf(step)) {
      if (hasSideEffect(step, graph, materialKey)) out.push(step);
    }
    branchesOf(step).forEach((branch) => branch.forEach(collect));
  };
  for (let j = from; j < list.length; j++) {
    if (isHumanGate(list[j])) break;
    collect(list[j]);
  }
  return out;
}

export function approvalSubjectWarnings(steps, { graph, key = null } = {}) {
  const warnings = [];
  const walk = (list, path) => {
    list.forEach((step, i) => {
      const at = `${path}[${i}]`;
      if (step.then) walk(step.then, `${at}.then`);
      if (step.else) walk(step.else, `${at}.else`);
      if (step.default) walk(step.default, `${at}.default`);
      for (const [name, branch] of Object.entries(step.cases ?? {})) walk(branch, `${at}.cases.${name}`);
      if (!isHumanGate(step) || i === 0) return;
      const subject = list[i - 1];
      if (UNJUDGED_SUBJECT_KINDS.has(subject.kind) || subject.kind === "approval-gate") return;
      const subjectNames = new Set(stepNames(subject));
      const earlier = new Map();
      list.slice(0, i - 1).forEach((s) => stepNames(s).forEach((n) => earlier.set(n, s)));
      const uncovered = new Map();
      for (const effect of effectsAfter(list, i + 1, graph, key)) {
        for (const ref of referencedSteps(sentConfig(effect.config))) {
          if (subjectNames.has(ref) || !earlier.has(ref)) continue;
          const source = earlier.get(ref);
          if (!uncovered.has(source.id)) uncovered.set(source.id, new Set());
          uncovered.get(source.id).add(effect.id);
        }
      }
      if (!uncovered.size) return;
      const sources = [...uncovered.keys()];
      const effects = [...new Set([...uncovered.values()].flatMap((s) => [...s]))];
      warnings.push({
        code: "GATE_SUBJECT_PARTIAL",
        path: at,
        materialPath: key,
        gate: step.id,
        subject: subject.id,
        uncovered: sources,
        effects,
        message:
          `approval-gate "${step.id}" shows the person only the output of "${subject.id}", but ` +
          `${effects.map((e) => `"${e}"`).join(", ")} also uses the output of ${sources.map((s) => `"${s}"`).join(", ")}, ` +
          "which the person does not see or approve. Put the steps whose output is sent into one step or child " +
          "workflow directly before the gate, so its output is the whole subject",
      });
    });
  };
  walk(steps ?? [], "steps");
  return warnings;
}

/** Warnings for the root and every pinned material of a loaded manifest. */
export function workflowWarnings(manifest) {
  const graph = manifest.materialGraph;
  if (!graph) return approvalSubjectWarnings(manifest.steps);
  return Object.entries(graph).flatMap(([key, node]) => approvalSubjectWarnings(node.manifest.steps, { graph, key }));
}

/**
 * A workspace-read whose output no later step uses reads the project and does nothing
 * with it: the manifest would look like a workflow while the work happens outside
 * Q-Core. Refused in every workflow.
 */
export function assertWorkspaceReadIsUsed(steps, outputs = {}) {
  const all = [];
  const collect = (list, path) => list.forEach((step, i) => {
    const at = `${path}[${i}]`;
    all.push({ step, at });
    for (const key of ["then", "else", "default"]) if (step[key]) collect(step[key], `${at}.${key}`);
    for (const [name, branch] of Object.entries(step.cases ?? {})) collect(branch, `${at}.cases.${name}`);
  });
  collect(steps, "steps");
  for (const { step, at } of all) {
    if (step.kind !== "workspace-read") continue;
    const escaped = step.id.replace(/[.*+?^$()|[\]\\{}]/g, "\\$&");
    const ref = new RegExp("\\{\\{\\s*steps\\." + escaped + "\\.output(?![\\w-])");
    // Used: a later step references it, or a later llm-call without `input` (it receives every prior output).
    const after = all.slice(all.findIndex((x) => x.step === step) + 1);
    const used = Object.values(outputs).some(port => ref.test(JSON.stringify(port.value))) || after.some(({ step: other }) => (other.kind === "llm-call" && other.config?.input == null) || Object.values(other.config ?? {}).some((v) => ref.test(String(v))));
    if (!used) {
      throw new ManifestError(
        `UNUSED_WORKSPACE_READ: no step uses the output of workspace-read "${step.id}". Q-Core would read the ` +
          "project and do nothing with it. Make the work a Q-Core step that takes {{steps." + step.id + ".output}} " +
          "(for example specification → human approval-gate → workspace-apply), not your own script",
        at,
      );
    }
  }
}

/**
 * True when `file` is a Registry workflow installed by `q-core install` and unchanged since:
 * its `<file>.lock.json` (qf.registry-lock/v1) names this workflow and the SHA-256 of these
 * exact bytes. An adapted or hand-written manifest has no matching lock.
 */
export function isReviewedInstall(file, bytes, doc) {
  const lockFile = `${file}.lock.json`;
  if (!existsSync(lockFile)) return false;
  let lock;
  try { lock = JSON.parse(readFileSync(lockFile, "utf8")); } catch { return false; }
  if (lock?.protocolVersion !== "qf.registry-lock/v1" || lock.id !== doc?.id || String(lock.version) !== (doc?.version == null ? "0" : String(doc.version))) return false;
  const sha = createHash("sha256").update(bytes).digest("hex");
  return Array.isArray(lock.resolved) && lock.resolved.some((r) => r?.key === `workflows/${lock.id}@${lock.version}` && r.sha256 === sha);
}

/** The policy for a validated manifest. `reviewed: true` only for bytes of a reviewed Registry workflow. */
export function assertWorkflowPolicy(manifest, { reviewed = false } = {}) {
  const checkReads = (doc, key) => {
    try { assertWorkspaceReadIsUsed(doc.steps, doc.outputs); }
    catch (error) { throw Object.assign(error, { materialPath: key ?? null }); }
  };
  checkReads(manifest, manifest.materialKey);
  for (const [key, node] of Object.entries(manifest.materialGraph ?? {})) checkReads(node.manifest, key);
  if (!reviewed) assertHumanGateBeforeSideEffects(manifest.steps, { graph: manifest.materialGraph, key: manifest.materialKey });
  return manifest;
}

/**
 * loadManifest + the policy. A file is reviewed when its `<file>.lock.json` (q-core install,
 * q-core init) names the SHA-256 of these exact bytes, or when the caller says so.
 */
export function loadWorkflow(file, { reviewed } = {}) {
  const manifest = loadManifestGraph(file);
  let isReviewed = reviewed;
  if (isReviewed == null) {
    let bytes = null;
    try { bytes = readFileSync(file); } catch { bytes = null; }
    isReviewed = bytes != null && isReviewedInstall(file, bytes, manifest);
  }
  return assertWorkflowPolicy(manifest, { reviewed: isReviewed });
}
