import { readFileSync, existsSync, lstatSync, realpathSync } from 'node:fs';
import { resolve, isAbsolute } from 'node:path';
import { hash, insist } from './contracts.mjs';
import { snapshot, contextFiles, applyFiles, scopedPath, lockWorkspace } from './workspace.mjs';
import { subprocess, scopedEnvironment } from './subprocess.mjs';
import { specification } from './specification.mjs';
import { determined } from './determined.mjs';
import { resolveTemplateValue } from './template.mjs';
const value = (step, key, ctx) => resolveTemplateValue(step.config[key], { priorOutputs: ctx.priorOutputs, priorStepNames: ctx.priorStepNames });

export function validateWorkspacePolicy(policy) {
  insist(policy && Object.keys(policy).every(k => ['workspace','allowedPaths','intent','verifier','maxRepairAttempts','specification'].includes(k)), 'Invalid workspace policy fields');
  insist(typeof policy.workspace === 'string' && isAbsolute(policy.workspace), 'Absolute workspace required');
  insist(Array.isArray(policy.allowedPaths) && policy.allowedPaths.length > 0 && policy.allowedPaths.length <= 30 && policy.allowedPaths.every(p => typeof p === 'string') && new Set(policy.allowedPaths).size === policy.allowedPaths.length, 'Unique bounded allowed paths required');
  insist(typeof policy.intent === 'string' && policy.intent.trim() && policy.intent.length <= 8000, 'Bounded intent required');
  insist(Number.isInteger(policy.maxRepairAttempts ?? 0) && (policy.maxRepairAttempts ?? 0) >= 0 && (policy.maxRepairAttempts ?? 0) <= 5, 'Repair bound must be 0..5');
  const verifier = policy.verifier;
  insist(verifier && Object.keys(verifier).every(k => ['command','args','timeoutMs'].includes(k)) && isAbsolute(verifier.command) && Array.isArray(verifier.args) && verifier.args.length > 0 && verifier.args.every(a => typeof a === 'string'), 'Pinned verifier executable and file arguments required');
  insist(Number.isInteger(verifier.timeoutMs) && verifier.timeoutMs > 0 && verifier.timeoutMs <= 300000, 'Bounded verifier timeout required');
  const normalized = { ...structuredClone(policy), workspace: realpathSync(policy.workspace) };
  snapshot(normalized.workspace, normalized.allowedPaths);
  verifierIdentity(normalized);
  if (policy.specification) specification(policy.specification);
  return normalized;
}
function verifierIdentity(policy) {
  const sources = {};
  insist(existsSync(policy.verifier.command) && lstatSync(policy.verifier.command).isFile(), 'Verifier executable missing');
  sources[policy.verifier.command] = hash(readFileSync(policy.verifier.command));
  let fileCount = 0;
  for (const arg of policy.verifier.args) {
    const candidate = resolve(policy.workspace, arg);
    if (arg.startsWith('-') || !existsSync(candidate)) continue;
    const path = scopedPath(policy.workspace, arg);
    insist(lstatSync(path).isFile() && lstatSync(path).size <= 128000, 'Verifier input must be a bounded regular file');
    insist(!policy.allowedPaths.some(p => resolve(policy.workspace, p) === path), 'Verifier inputs cannot be writable artifacts');
    sources[path] = hash(readFileSync(path)); fileCount++;
  }
  insist(fileCount > 0, 'Verifier must have an independent immutable source file');
  return sources;
}
export function runWorkspaceRead(step, ctx) {
  const policy = validateWorkspacePolicy(ctx.workspacePolicy);
  return { output: { policy, policyHash: hash(policy), before: snapshot(policy.workspace, policy.allowedPaths), files: contextFiles(policy.workspace, policy.allowedPaths), verifierSources: verifierIdentity(policy) } };
}
export function runSpecification(step, ctx) {
  const source = value(step, 'source', ctx), workspace = value(step, 'workspace', ctx);
  insist(workspace?.policyHash === hash(workspace?.policy), 'Workspace policy identity changed');
  const spec = specification(workspace.policy.specification ?? source, 'INVALID_RESPONSE');
  insist(ctx.runStore, 'Versioned specification requires persistent storage');
  const record = ctx.runStore.recordSpecification({ loop: ctx.templateId, workspace: workspace.policy.workspace }, { spec, policyHash: workspace.policyHash });
  return { output: { ...record, spec, plan: spec.plan, workspace } };
}
export function runWorkspaceApply(step, ctx) {
  const proposal = value(step, 'source', ctx), approved = value(step, 'approval', ctx);
  const spec = approved?.subject;
  insist(spec?.workspace && approved?.approvalHash === hash(spec), 'Exact approved specification required');
  const original = spec.workspace, policy = validateWorkspacePolicy(ctx.workspacePolicy);
  insist(hash(policy) === original.policyHash, 'Execution policy changed after approval');
  insist(hash(verifierIdentity(policy)) === hash(original.verifierSources), 'Verifier source changed after planning');
  const before = ctx.repairSnapshot ?? original.before;
  const lock = lockWorkspace(policy.workspace);
  try {
    const after = applyFiles(policy.workspace, policy.allowedPaths, proposal?.files, before);
    return { output: { workspace: policy.workspace, paths: policy.allowedPaths, artifactHash: hash(after), revision: (ctx.repairAttempt ?? 0) + 1, after, policyHash: original.policyHash, verifierSources: original.verifierSources, specHash: spec.hash } };
  } finally { lock.release(); }
}
export async function runVerifyArtifact(step, ctx) {
  const artifact = value(step, 'source', ctx), policy = validateWorkspacePolicy(ctx.workspacePolicy);
  assertFreshWorkspaceArtifact(artifact, policy);
  const result = await subprocess(policy.verifier.command, policy.verifier.args, { cwd: policy.workspace, timeoutMs: policy.verifier.timeoutMs, signal: ctx.signal, env: scopedEnvironment(), maxBytes: 16000 });
  insist(hash(snapshot(policy.workspace, policy.allowedPaths)) === artifact.artifactHash && hash(verifierIdentity(policy)) === hash(artifact.verifierSources), 'Artifact or verifier changed during verification');
  return { output: { artifactHash: artifact.artifactHash, revision: artifact.revision, outcome: result.code === 0 ? 'pass' : 'fail', exitCode: result.code, stdout: result.stdout, stderr: result.stderr, verifierSources: artifact.verifierSources, specHash: artifact.specHash } };
}
export function assertFreshWorkspaceArtifact(artifact, policy) {
  insist(artifact?.policyHash === hash(policy), 'Artifact policy mismatch');
  insist(hash(verifierIdentity(policy)) === hash(artifact.verifierSources), 'Plan-time verifier changed');
  insist(hash(snapshot(policy.workspace, policy.allowedPaths)) === artifact.artifactHash, 'Artifact is stale before verification');
}

/** The composable determined component reuses the reducer's AND/freshness
 * mechanics. The persistent Registry driver owns caller waits and repair bounds. */
export async function runDetermined(step, ctx) {
  const artifact = value(step, 'source', ctx), spec = value(step, 'specification', ctx);
  insist(spec?.spec?.criteria?.length && spec.hash === artifact?.specHash, 'determined requires the approved specification binding');
  const policy = validateWorkspacePolicy(ctx.workspacePolicy);
  let checked;
  const result = await determined({ criteria: spec.spec.criteria.map((text, i) => ({ id: `criterion-${i + 1}`, text, verifier: { type: 'command', identity: hash(artifact.verifierSources) } })), maxRepairAttempts: 0, signal: ctx.signal }, {
    execute: async () => { assertFreshWorkspaceArtifact(artifact, policy); },
    getArtifact: async () => ({ sha256: hash(snapshot(policy.workspace, policy.allowedPaths)), revision: artifact.revision }),
    verify: async () => {
      checked ??= await runVerifyArtifact(step, ctx);
      return { outcome: checked.output.outcome, artifactHash: checked.output.artifactHash, revision: checked.output.revision };
    },
  });
  insist(checked && result.history.length && result.history.at(-1).outcomes.every(e => e.outcome !== 'unknown'), 'determined has missing or stale evidence');
  return { output: { ...checked.output, outcome: result.status === 'success' ? 'pass' : 'fail', determined: result } };
}
