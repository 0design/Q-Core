/**
 * Core37 policy for workflows a user or an agent creates (E2E run 9, 27.09.2026).
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
 * Core37 (gate required): a workflow created outside the reviewed Registry may not write
 * files or send data anywhere before a person has approved the run. A human
 * approval-gate must come EARLIER on the same path as every side-effect step. A gate
 * inside an if/switch branch guards only that branch. Agent gates do not count.
 * Reviewed Registry workflows (installed with a matching lock, or built into the
 * Registry release) keep their published shape and are not re-judged here.
 */
export function assertHumanGateBeforeSideEffects(steps) {
  const walk = (list, gated, path) => {
    let covered = gated;
    list.forEach((step, i) => {
      const at = `${path}[${i}]`;
      const effect = sideEffectOf(step);
      if (effect && !covered) {
        throw new ManifestError(
          `GATE_REQUIRED: step "${step.id}" (${step.kind}) ${effect}, and no human approval-gate comes before it. ` +
            "A workflow you create may not write files or send data before a person approves the run: add an " +
            "approval-gate step with reviewer: human (bind: sha256) before it, or install the reviewed Registry " +
            "workflow unchanged with q-core install. Do not move the work into your own script instead",
          at,
        );
      }
      for (const key of ["then", "else", "default"]) if (step[key]) walk(step[key], covered, `${at}.${key}`);
      for (const [name, branch] of Object.entries(step.cases ?? {})) walk(branch, covered, `${at}.cases.${name}`);
      if (isHumanGate(step)) covered = true;
    });
  };
  walk(steps, false, "steps");
}

/**
 * A workspace-read whose output no later step uses reads the project and does nothing
 * with it: the manifest would look like a workflow while the work happens outside
 * Q-Core (E2E run 9, 27.09). Refused in every workflow.
 */
export function assertWorkspaceReadIsUsed(steps) {
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
    const used = after.some(({ step: other }) => (other.kind === "llm-call" && other.config?.input == null) || Object.values(other.config ?? {}).some((v) => ref.test(String(v))));
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

/** The Core37 policy for a validated manifest. `reviewed: true` only for bytes of a reviewed Registry workflow. */
export function assertWorkflowPolicy(manifest, { reviewed = false } = {}) {
  assertWorkspaceReadIsUsed(manifest.steps);
  if (!reviewed) assertHumanGateBeforeSideEffects(manifest.steps);
  return manifest;
}

/**
 * loadManifest + the Core37 policy. A file is reviewed when its `<file>.lock.json` (q-core install,
 * q-core init) names the SHA-256 of these exact bytes, or when the caller says so.
 */
export function loadWorkflow(file, { reviewed } = {}) {
  const manifest = loadManifest(file);
  let isReviewed = reviewed;
  if (isReviewed == null) {
    let bytes = null;
    try { bytes = readFileSync(file); } catch { bytes = null; }
    isReviewed = bytes != null && isReviewedInstall(file, bytes, manifest);
  }
  return assertWorkflowPolicy(manifest, { reviewed: isReviewed });
}
