import { readFileSync, existsSync, lstatSync, realpathSync } from 'node:fs';
import { resolve, isAbsolute } from 'node:path';
import { hash, insist } from './contracts.mjs';
import { snapshot, contextFiles, applyFiles, scopedPath, lockWorkspace } from './workspace.mjs';
import { subprocess, scopedEnvironment } from './subprocess.mjs';
import { specification } from './specification.mjs';
import { determined } from './determined.mjs';
import { resolveTemplateValue } from './template.mjs';
const value = (step, key, ctx) => resolveTemplateValue(step.config[key], { priorOutputs: ctx.priorOutputs, priorStepNames: ctx.priorStepNames, inputs: ctx.inputs });

export function validateWorkspacePolicy(policy) {
  insist(policy, 'Workspace policy required for workspace access; pass --workspace-policy <file>');
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
  const identity = { workflow: ctx.templateId, workspace: workspace.policy.workspace };
  const record = ctx.runStore.recordSpecification(identity, { spec, policyHash: workspace.policyHash });
  return { output: { ...record, identity, spec, plan: spec.plan, workspace } };
}

function assertSpecificationRecord(record, ctx) {
  const original = record?.workspace;
  insist(original?.before && typeof original.before === 'object' && !Array.isArray(original.before), 'Planning snapshot required');
  insist(original.policy && typeof original.policy === 'object' && !Array.isArray(original.policy) &&
    typeof original.policyHash === 'string' && /^[a-f0-9]{64}$/.test(original.policyHash) &&
    original.verifierSources && typeof original.verifierSources === 'object' && !Array.isArray(original.verifierSources), 'Invalid specification workspace structure');
  const spec = specification(record.spec);
  const identity = record.identity ?? { workflow: ctx.templateId, workspace: original.policy?.workspace };
  insist(identity && Object.keys(identity).length === 2 && typeof identity.workflow === 'string' && identity.workflow.trim() &&
    identity.workspace === original.policy?.workspace && isAbsolute(identity.workspace), 'Invalid specification identity');
  insist(Number.isSafeInteger(record.revision) && record.revision > 0 && /^[a-f0-9]{64}$/.test(record.hash), 'Invalid specification revision or hash');
  insist(original.policyHash === hash(original.policy), 'Specification workspace policy identity changed');
  insist(hash(record.spec) === hash(spec) && Array.isArray(record.plan) && hash(record.plan) === hash(spec.plan), 'Specification structure or plan changed');
  // Exactly the canonical hash recorded by RunStore.recordSpecification, not a claimed digest.
  insist(record.hash === hash({ identity, value: { spec, policyHash: original.policyHash }, revision: record.revision }), 'Specification hash mismatch');
}

export function runWorkspaceApply(step, ctx) {
  const policy = validateWorkspacePolicy(ctx.workspacePolicy);
  const proposal = value(step, 'source', ctx);
  const hasApproval = Object.hasOwn(step.config, 'approval'), hasSpecification = Object.hasOwn(step.config, 'specification');
  insist(!(hasApproval && hasSpecification), 'Use either approval or specification, not both');
  const gates = ctx.workspaceApprovalGates ?? [];
  insist(!gates.length || hasApproval, 'Workspace apply governed by an approval-gate requires an explicit approval binding', 'STALE_APPROVAL');
  let spec;
  if (hasApproval) {
    const approved = value(step, 'approval', ctx);
    spec = approved?.subject;
    insist(spec?.workspace && approved?.approvalHash === hash(spec), 'Exact approved specification required');
    for (const gate of gates) {
      insist(gate.status === 'success' && gate.decision === 'approve' && gate.config?.bind === 'sha256', 'Workspace approval-gate requires approved sha256 binding', 'STALE_APPROVAL');
      const approvedHash = gate.approvedSubjectHash ?? gate.boundSubjectHash;
      insist(approvedHash && (!gate.boundSubjectHash || gate.boundSubjectHash === approvedHash) &&
        approved.approvalHash === approvedHash && gate.output?.approvalHash === approvedHash &&
        hash(gate.output?.subject) === approvedHash && hash(gate.currentSubject) === approvedHash,
      'Workspace approval does not match the current exact approved subject', 'STALE_APPROVAL');
    }
  } else if (hasSpecification) {
    spec = value(step, 'specification', ctx);
    insist(spec?.workspace && spec.hash, 'Exact specification required');
  }
  const original = spec?.workspace;
  const policyHash = hash(policy), verifierSources = verifierIdentity(policy);
  if (original) {
    assertSpecificationRecord(spec, ctx);
    insist(policyHash === original.policyHash, hasApproval ? 'Execution policy changed after approval' : 'Execution policy changed after planning');
    insist(hash(verifierSources) === hash(original.verifierSources), 'Verifier source changed after planning');
  }
  const lock = lockWorkspace(policy.workspace);
  try {
    // With no planning reference, the mandatory policy pins the current files at apply time.
    const before = ctx.repairSnapshot ?? (original ? original.before : snapshot(policy.workspace, policy.allowedPaths));
    const after = applyFiles(policy.workspace, policy.allowedPaths, proposal?.files, before);
    return { output: { workspace: policy.workspace, paths: policy.allowedPaths, artifactHash: hash(after), revision: (ctx.repairAttempt ?? 0) + 1, after, policyHash, verifierSources, specHash: spec?.hash } };
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
  insist(spec?.spec?.criteria?.length && spec.hash === artifact?.specHash, 'determined requires the specification binding');
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
