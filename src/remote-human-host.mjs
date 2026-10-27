/** Candidate native enrollment, receipt consumption and leased continuation.
 * No provider transport, signing, service installation or platform adapter.
 */
import { readFileSync, lstatSync, existsSync, realpathSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { hash, insist } from './contracts.mjs';
import { agentSessionMarker, confirmHumanDecision } from './human-confirmation.mjs';
import { acquireWorkflowLease, workflowRecoveryClaims, WORKFLOW_RECOVERY_PREFIX } from './workflow-lease.mjs';
import { RunStore } from './state.mjs';
import { createRun, waitingGate, resolveKnobs, driveRun } from './run.mjs';
import { assertInferenceReply, assertInferenceOutput, validateCallerInput } from './caller-inference.mjs';
import { loadWorkflow } from './workflow-policy.mjs';
import { guardedDurableReplaceSync, guardedMkdirSync, guardedSyncDirectorySync,
  guardedRenameSync, guardedUnlinkSync,
  persistenceEnvironment, withPersistenceSecrets } from './persistence.mjs';
import { remoteApprovalKeyId, createRemoteApprovalRequest, assertRemoteApprovalRequest, verifyRemoteApprovalReceipt } from './remote-human-receipt.mjs';

const HEX = /^[a-f0-9]{64}$/;
function personOnly() {
  insist(!agentSessionMarker(), 'A person must enroll or consume remote human decisions outside an agent session', 'HUMAN_CONFIRMATION_REQUIRED');
}
function plainFile(file, maxBytes = 8_388_608) {
  const stat = lstatSync(file);
  insist(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.size <= maxBytes,
    'Unsafe remote human state file', 'REMOTE_APPROVAL_INVALID');
  return readFileSync(file, 'utf8');
}
function context(file, { readOnly = false } = {}) {
  // The manifest itself must not be a symlink. Parent is canonicalized once.
  insist(typeof file === 'string' && !/[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/.test(file), 'Unsafe manifest pathname');
  plainFile(file, 1_048_576);
  const manifestFile = realpathSync(file), root = dirname(manifestFile);
  const store = new RunStore(manifestFile);
  directory(store.dir, !readOnly);
  return { manifestFile, root, store, readOnly, policyFile: join(store.dir, 'remote-human-provider.json') };
}
function directory(path, create = true) {
  if (existsSync(path)) {
    const stat = lstatSync(path);
    insist(stat.isDirectory() && !stat.isSymbolicLink(), 'Unsafe remote human directory', 'REMOTE_APPROVAL_INVALID');
  } else {
    insist(create, 'Remote human state directory is missing', 'REMOTE_APPROVAL_INVALID');
    guardedMkdirSync(path, { mode: 0o700 });
    guardedSyncDirectorySync(dirname(path));
  }
}
function save(file, value) {
  guardedDurableReplaceSync(file, JSON.stringify(value) + '\n', { receipt: value });
}
function policyValue(value, manifestHash) {
  insist(value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).sort().join(',') === 'chatId,endpoint,manifestHash,publicKey,reviewerId', 'Invalid remote provider policy');
  insist(typeof value.manifestHash === 'string' && HEX.test(value.manifestHash) && value.manifestHash === manifestHash,
    'Policy must pin the current manifest bytes');
  insist(typeof value.reviewerId === 'string' && /^[1-9][0-9]{0,19}$/.test(value.reviewerId) &&
    typeof value.chatId === 'string' && /^-?[1-9][0-9]{0,19}$/.test(value.chatId), 'Literal Telegram user and chat IDs required');
  insist(typeof value.endpoint === 'string' && value.endpoint.length <= 2048 && !/[\x00-\x20\x7f]/.test(value.endpoint), 'Invalid provider endpoint');
  let url; try { url = new URL(value.endpoint); } catch { insist(false, 'Invalid provider endpoint'); }
  insist(url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash && url.href === value.endpoint,
    'Provider endpoint must be canonical HTTPS without credentials, query or fragment');
  return { ...value, issuerKeyId: remoteApprovalKeyId(value.publicKey) };
}
function enrollment(ctx) {
  const stored = JSON.parse(plainFile(ctx.policyFile, 16_384));
  insist(stored.protocol === 'qf.remote-human-enrollment/v1' &&
    typeof stored.enrollmentId === 'string' && /^[a-f0-9-]{36}$/.test(stored.enrollmentId) &&
    stored.confirmation?.channel === 'tty-code', 'Provider has no terminal enrollment');
  const { publicKey, endpoint, reviewerId, chatId, manifestHash } = stored;
  const value = policyValue({ publicKey, endpoint, reviewerId, chatId, manifestHash }, hash(plainFile(ctx.manifestFile)));
  insist(value.issuerKeyId === stored.issuerKeyId, 'Enrolled key fingerprint changed');
  return stored;
}

/** Called by the person's terminal. io only supplies terminal fixtures in tests;
 * the independent process marker guard is never injectable. No key generation.
 */
export function enrollRemoteHumanProvider(file, policy, io = {}) {
  personOnly();
  const ctx = context(file), value = policyValue(policy, hash(plainFile(ctx.manifestFile)));
  const confirmation = confirmHumanDecision({ decision: 'approve', lines: [
    'Enroll remote human approval provider for this exact workflow:',
    `Manifest: ${ctx.manifestFile}`, `Manifest SHA256: ${value.manifestHash}`,
    `Provider: ${value.endpoint}`, `Ed25519 fingerprint: ${value.issuerKeyId}`,
    `Telegram user: ${value.reviewerId}; chat: ${value.chatId}`,
    'The provider must authenticate the human callback before signing; it may not sign model output.'
  ] }, io);
  personOnly();
  const lock = acquireWorkflowLease(ctx.manifestFile);
  try {
    // Refuse a manifest edit made while the person was reading the terminal.
    policyValue(policy, hash(plainFile(ctx.manifestFile)));
    const record = { protocol: 'qf.remote-human-enrollment/v1', enrollmentId: randomUUID(),
      ...value, confirmation, enrolledAt: new Date().toISOString() };
    save(ctx.policyFile, record);
    return { enrollmentId: record.enrollmentId, issuerKeyId: value.issuerKeyId, manifestHash: value.manifestHash };
  } finally { lock.release(); }
}

const plan = run => run.steps.map(({ seq, stepId, kind, name, config, then, else: otherwise, cases, default: fallback, depth, laneOf, invocationId }) =>
  ({ seq, stepId, kind, name, config, then, else: otherwise, cases, default: fallback, depth, laneOf, invocationId }));
function currentRun(ctx, runId, provider) {
  directory(ctx.store.runsDir, !ctx.readOnly);
  const run = JSON.parse(plainFile(ctx.store.runFile(runId)));
  const manifest = loadWorkflow(ctx.manifestFile), expected = createRun(manifest, { inputs: run.inputs });
  insist(manifest.enabled && !Object.keys(manifest.dependencies ?? {}).length &&
    manifest.steps.every(step => !['workflow-call','fan-out','if','switch','loop','each'].includes(step.kind)) &&
    Object.keys(run.invocations ?? {}).join(',') === 'root', 'Remote human v1 requires a flat, enabled workflow');
  insist(run.runId === runId && typeof run.manifestFile === 'string' && realpathSync(run.manifestFile) === ctx.manifestFile && run.workflowId === manifest.id &&
    run.hostEvent?.manifestSha256 === provider.manifestHash && hash(plan(run)) === hash(plan(expected)) &&
    hash(run.executionKnobs) === hash(resolveKnobs(manifest.settings)), 'Run does not match the enrolled host manifest', 'REMOTE_APPROVAL_INVALID');
  insist(run.steps.filter(step => step.kind === 'approval-gate' && (step.config.reviewer ?? 'human') === 'human').length === 1,
    'Remote human v1 requires exactly one human gate');
  return run;
}
function binding(run, provider) {
  insist(run.status === 'waiting_human' && !run.pendingClarification, 'Run is not waiting at a human gate', 'REMOTE_APPROVAL_INVALID');
  const gate = waitingGate(run, run.steps.find(step => step.status === 'waiting_human')?.output?.approvalHash);
  insist(gate.kind === 'approval-gate' && (gate.config.reviewer ?? 'human') === 'human' && gate.config.bind === 'sha256',
    'Remote approval requires an exact sha256 human gate');
  return { runId: run.runId, gateId: `gate:${hash({ seq: gate.seq, stepId: gate.stepId, rowId: gate.rowId })}`, approvalHash: gate.output.approvalHash,
    manifestHash: provider.manifestHash, reviewerId: provider.reviewerId, issuerKeyId: provider.issuerKeyId };
}
const runHash = run => { const { remoteHuman, ...rest } = run; return hash(rest); };
function requestedState(run, provider) {
  const state = run.remoteHuman;
  insist(state && typeof state === 'object' && !Array.isArray(state) &&
    Object.keys(state).sort().join(',') === 'enrollmentHash,phase,protocol,request,runBindingHash' &&
    state.protocol === 'qf.remote-human-state/v1' && state.phase === 'requested' &&
    state.enrollmentHash === hash(provider) && state.runBindingHash === runHash(run),
    'Remote challenge is consumed, missing or changed', 'REMOTE_APPROVAL_INVALID');
  return state;
}

/** Save before notification. This function itself never notifies anyone. */
export function requestRemoteHumanDecision(file, runId, { nowMs = Date.now(), ttlMs = 900_000 } = {}) {
  insist(Number.isSafeInteger(nowMs) && nowMs >= 0, 'Invalid remote request clock');
  const ctx = context(file), lock = acquireWorkflowLease(ctx.manifestFile);
  try {
    const provider = enrollment(ctx), run = currentRun(ctx, runId, provider), current = binding(run, provider);
    if (Object.hasOwn(run, 'remoteHuman')) {
      const state = requestedState(run, provider);
      assertRemoteApprovalRequest({ request: state.request, current, nowMs, allowExpired: true });
      if (nowMs < state.request.expiresAt) return structuredClone(state.request);
    }
    const request = createRemoteApprovalRequest(current, { nowMs, ttlMs });
    run.remoteHuman = { protocol: 'qf.remote-human-state/v1', phase: 'requested', enrollmentHash: hash(provider),
      runBindingHash: runHash(run), request };
    withPersistenceSecrets({ env: persistenceEnvironment(run), receipt: run }, () => save(ctx.store.runFile(runId), run));
    return structuredClone(request);
  } finally { lock.release(); }
}

/** Native one-file transaction: terminal challenge + gate decision are committed
 * together before any effect. No driveRun, network, signing or publish here.
 * The separate resume API leases/revalidates continuation; this consumer is not
 * an E2E host and never drives a workflow itself.
 */
export function consumeRemoteHumanDecision(file, runId, receiptJson, { nowMs = Date.now() } = {}) {
  personOnly();
  const ctx = context(file), lock = acquireWorkflowLease(ctx.manifestFile);
  try {
    const provider = enrollment(ctx), run = currentRun(ctx, runId, provider), state = requestedState(run, provider);
    const current = binding(run, provider);
    const evidence = verifyRemoteApprovalReceipt({ receiptJson, request: state.request, current,
      trustedPublicKey: provider.publicKey, consumedReceiptIds: [], nowMs });
    const gate = waitingGate(run, evidence.approvalHash), confirmedAt = new Date(nowMs).toISOString();
    gate.decision = evidence.decision;
    gate.confirmation = { channel: 'telegram-ed25519', confirmedAt, receiptHash: evidence.receiptHash,
      enrollmentId: provider.enrollmentId, reviewerId: provider.reviewerId };
    gate.finishedAt = confirmedAt;
    if (evidence.decision === 'approve') {
      gate.approvedSubjectHash = evidence.approvalHash; gate.status = 'success';
      run.status = 'running'; run.finishedAt = null; run.summary = 'Remote human decision committed; execution has not resumed.';
    } else {
      gate.status = 'failed'; gate.errorText = 'Rejected at the gate by a human.';
      run.status = 'failed'; run.finishedAt = confirmedAt; run.summary = `Step "${gate.name}": rejected at the gate.`;
    }
    run.remoteHuman = { ...state, phase: 'consumed', consumedAt: nowMs, receiptJson,
      evidence: { ...evidence, authorizationApplied: true }, effectExecuted: false,
      checkpointHash: runHash(run) };
    withPersistenceSecrets({ env: persistenceEnvironment(run), receipt: run }, () => save(ctx.store.runFile(runId), run));
    return { runId, decision: evidence.decision, authorizationApplied: true, effectExecuted: false, status: run.status };
  } finally { lock.release(); }
}

function consumedState(run, provider, nowMs) {
  const state = run.remoteHuman;
  const fields = ['protocol','phase','enrollmentHash','runBindingHash','request','consumedAt',
    'receiptJson','evidence','effectExecuted','checkpointHash', ...(state?.execution ? ['execution'] : [])];
  insist(state && typeof state === 'object' && !Array.isArray(state) &&
    Object.keys(state).sort().join(',') === fields.sort().join(',') &&
    state.protocol === 'qf.remote-human-state/v1' && state.phase === 'consumed' &&
    state.enrollmentHash === hash(provider) && state.checkpointHash === runHash(run) &&
    typeof state.runBindingHash === 'string' && HEX.test(state.runBindingHash) &&
    Number.isSafeInteger(state.consumedAt) && state.consumedAt >= 0 && state.consumedAt <= nowMs,
    'Consumed decision or native execution checkpoint changed', 'REMOTE_APPROVAL_INVALID');
  // Reconstruct only an inspection copy so the existing exact gate-subject
  // validator checks the approved original output as well as the shown subject.
  const inspection = structuredClone(run);
  const gate = inspection.steps.find(step => step.kind === 'approval-gate' && (step.config.reviewer ?? 'human') === 'human');
  const originalGate = run.steps.find(step => step.seq === gate.seq);
  gate.status = 'waiting_human'; inspection.status = 'waiting_human';
  const current = binding(inspection, provider);
  const evidence = verifyRemoteApprovalReceipt({ receiptJson: state.receiptJson, request: state.request, current,
    trustedPublicKey: provider.publicKey, consumedReceiptIds: [], nowMs: state.consumedAt });
  insist(hash(state.evidence) === hash({ ...evidence, authorizationApplied: true }) &&
    originalGate.decision === evidence.decision && originalGate.status === (evidence.decision === 'approve' ? 'success' : 'failed') &&
    (evidence.decision !== 'approve' || originalGate.approvedSubjectHash === evidence.approvalHash) &&
    hash(originalGate.confirmation) === hash({ channel: 'telegram-ed25519', confirmedAt: new Date(state.consumedAt).toISOString(),
      receiptHash: evidence.receiptHash, enrollmentId: provider.enrollmentId, reviewerId: provider.reviewerId }),
    'Native gate no longer matches its signed decision', 'REMOTE_APPROVAL_INVALID');
  if (Object.hasOwn(state, 'execution')) {
    const execution = state.execution;
    insist(execution && typeof execution === 'object' && !Array.isArray(execution) &&
      Object.keys(execution).sort().join(',') === 'id,phase,status' &&
      typeof execution.id === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(execution.id) &&
      execution.status === run.status && execution.phase === executionPhase(run.status) && state.effectExecuted === null,
      'Invalid native execution checkpoint', 'REMOTE_APPROVAL_INVALID');
  } else insist(state.effectExecuted === false, 'Invalid unstarted native execution', 'REMOTE_APPROVAL_INVALID');
  return state;
}

function executionPhase(status) {
  return ['success','failed','cancelled'].includes(status) ? 'completed' : status === 'needs_human' ? 'held'
    : status === 'running' ? 'running' : 'paused';
}

const RECOVERY_RUN_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const STOP_SUMMARY = 'Interrupted native run stopped by a human; external effect outcome remains unknown.';
const STOP_STATUSES = ['running', 'needs_human', 'waiting_human', 'waiting_inference'];
const exactKeys = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).sort().join(',') === [...keys].sort().join(',');

function recoveryFile(path, max = 8_388_608) {
  const info = lstatSync(path);
  insist(info.isFile() && !info.isSymbolicLink() && info.nlink === 1 && !(info.mode & 0o022) &&
    (typeof process.getuid !== 'function' || info.uid === process.getuid()), 'Unsafe recovery file', 'REMOTE_RECOVERY_INVALID');
  return plainFile(path, max);
}
function deadLease(path) {
  const raw = recoveryFile(path, 1024), value = JSON.parse(raw), info = lstatSync(path);
  insist(exactKeys(value, ['pid']) && Number.isSafeInteger(value.pid) && value.pid > 0 &&
    (info.mode & 0o777) === 0o600, 'Unknown workflow lease; manual investigation required', 'REMOTE_RECOVERY_INVALID');
  let absent = false;
  try { process.kill(value.pid, 0); }
  catch (error) { absent = error.code === 'ESRCH'; }
  insist(absent, 'Workflow lease owner is still present or cannot be verified', 'WORKSPACE_LOCKED');
  return { raw, pid: value.pid, dev: info.dev, ino: info.ino };
}
function recoveryState(run, provider, nowMs) {
  insist(!Object.hasOwn(run, 'humanRecovery') && STOP_STATUSES.includes(run.status) &&
    typeof run.summary === 'string' && (run.finishedAt === null || typeof run.finishedAt === 'string'),
    'Run needs a separate recovery procedure', 'REMOTE_RECOVERY_INVALID');
  if (run.remoteHuman?.phase === 'requested') {
    const state = requestedState(run, provider);
    assertRemoteApprovalRequest({ request: state.request, current: binding(run, provider), nowMs, allowExpired: true });
    return state;
  }
  return consumedState(run, provider, nowMs);
}
function recoverySnapshot(ctx, runId) {
  insist(typeof runId === 'string' && RECOVERY_RUN_ID.test(runId), 'Invalid recovery run ID', 'REMOTE_RECOVERY_INVALID');
  const manifestRaw = recoveryFile(ctx.manifestFile, 1_048_576), policyRaw = recoveryFile(ctx.policyFile, 16384);
  const runRaw = recoveryFile(ctx.store.runFile(runId));
  const provider = enrollment(ctx), run = currentRun(ctx, runId, provider);
  recoveryState(run, provider, Date.now());
  const leaseFile = join(ctx.store.dir, 'workflow.lock'), lease = deadLease(leaseFile);
  const host = join(ctx.store.dir, 'host', hash(ctx.manifestFile));
  directory(join(ctx.store.dir, 'host'), false); directory(host, false);
  insist(!existsSync(join(host, 'lock')), 'Interrupted dispatch still holds its own lock', 'REMOTE_RECOVERY_INVALID');
  const activeFile = join(host, 'active.json'), activeRaw = recoveryFile(activeFile, 16384), active = JSON.parse(activeRaw);
  const eventFile = join(host, `${hash({ kind: run.trigger, eventId: run.hostEvent?.id })}.json`);
  const eventRaw = recoveryFile(eventFile, 16384), event = JSON.parse(eventRaw);
  insist(exactKeys(active, ['runId']) && active.runId === runId &&
    exactKeys(event, ['phase','runId','kind','eventId','inputsHash','status']) && event.phase === 'completed' &&
    event.status === 'waiting_human' && event.runId === runId && event.kind === run.trigger && event.eventId === run.hostEvent.id &&
    event.inputsHash === hash(run.inputs), 'Dispatch is incomplete or does not match this run', 'REMOTE_RECOVERY_INVALID');
  insist(hash(run) === hash(JSON.parse(runRaw)) && hash(provider) === hash(JSON.parse(policyRaw)) &&
    recoveryFile(ctx.manifestFile, 1_048_576) === manifestRaw && recoveryFile(ctx.policyFile, 16384) === policyRaw &&
    recoveryFile(ctx.store.runFile(runId)) === runRaw, 'Recovery inputs changed during inspection', 'REMOTE_RECOVERY_INVALID');
  const files = { manifest: hash(manifestRaw),
    enrollment: hash(policyRaw), run: hash(runRaw),
    active: hash(activeRaw), event: hash(eventRaw), lease: hash(lease.raw), leaseDev: lease.dev, leaseIno: lease.ino };
  return { provider, run, lease, leaseFile, files, snapshotHash: hash(files) };
}
function stoppedRun(original, confirmation, snapshotHash) {
  const run = structuredClone(original);
  run.humanRecovery = { protocol: 'qf.remote-human-stop/v1', snapshotHash, beforeRunHash: hash(original),
    prior: { status: original.status, summary: original.summary, finishedAt: original.finishedAt },
    confirmation, effectOutcome: 'unknown' };
  run.status = 'cancelled'; run.summary = STOP_SUMMARY; run.finishedAt = confirmation.confirmedAt;
  if (run.remoteHuman.phase === 'consumed') {
    if (run.remoteHuman.execution) {
      run.remoteHuman.execution.status = 'cancelled'; run.remoteHuman.execution.phase = 'completed';
    }
    run.remoteHuman.checkpointHash = runHash(run);
  }
  return run;
}

/** Read-only plan for one known, dead PID lease and a completed host dispatch.
 * Missing/malformed leases, incomplete starts and prior interrupted repair
 * claims stay held. No timeout eviction or process termination is performed.
 */
export function inspectRemoteHumanRecovery(file, runId) {
  personOnly();
  const ctx = context(file, { readOnly: true });
  insist(workflowRecoveryClaims(ctx.root).length === 0, 'An earlier repair needs investigation', 'WORKSPACE_LOCKED');
  const value = recoverySnapshot(ctx, runId);
  return { protocol: 'qf.remote-human-recovery-plan/v1', runId, status: value.run.status,
    manifestHash: value.provider.manifestHash, snapshotHash: value.snapshotHash,
    leasePid: value.lease.pid, action: 'stop', effectOutcome: 'unknown' };
}

/** Validate the complete permitted stop delta without acquiring a writer lease.
 * The old native receipt/gate and every other run field are retained. This
 * observation can coexist with a later owned run using the same workflow.
 */
export function inspectStoppedRemoteHumanRun(file, runId) {
  personOnly();
  insist(typeof runId === 'string' && RECOVERY_RUN_ID.test(runId), 'Invalid recovery run ID', 'REMOTE_RECOVERY_INVALID');
  const ctx = context(file, { readOnly: true }), provider = enrollment(ctx), run = currentRun(ctx, runId, provider);
  const record = run.humanRecovery;
  insist(exactKeys(record, ['protocol','snapshotHash','beforeRunHash','prior','confirmation','effectOutcome']) &&
    record.protocol === 'qf.remote-human-stop/v1' && HEX.test(record.snapshotHash) && HEX.test(record.beforeRunHash) &&
    exactKeys(record.prior, ['status','summary','finishedAt']) &&
    exactKeys(record.confirmation, ['decision','channel','confirmedAt']) &&
    record.confirmation.decision === 'reject' && record.confirmation.channel === 'tty-code' &&
    typeof record.confirmation.confirmedAt === 'string' && Number.isFinite(Date.parse(record.confirmation.confirmedAt)) &&
    new Date(record.confirmation.confirmedAt).toISOString() === record.confirmation.confirmedAt &&
    record.effectOutcome === 'unknown' && run.status === 'cancelled', 'Invalid human stop record', 'REMOTE_RECOVERY_INVALID');
  const before = structuredClone(run); delete before.humanRecovery;
  Object.assign(before, record.prior);
  if (before.remoteHuman?.phase === 'consumed') {
    if (before.remoteHuman.execution) {
      before.remoteHuman.execution.status = before.status;
      before.remoteHuman.execution.phase = executionPhase(before.status);
    }
    before.remoteHuman.checkpointHash = runHash(before);
  }
  insist(hash(before) === record.beforeRunHash, 'Stopped checkpoint changed outside its permitted delta', 'REMOTE_RECOVERY_INVALID');
  recoveryState(before, provider, Date.now());
  insist(hash(run) === hash(stoppedRun(before, record.confirmation, record.snapshotHash)),
    'Stopped checkpoint changed', 'REMOTE_RECOVERY_INVALID');
  return { protocol: 'qf.remote-human-stopped/v1', runId, status: 'cancelled', manifestHash: provider.manifestHash,
    requestId: before.remoteHuman.request.requestId, approvalHash: before.remoteHuman.request.approvalHash,
    snapshotHash: record.snapshotHash, effectOutcome: 'unknown', readOnly: true };
}

/** Human STOP only. Authority is fully prepared in a private directory before
 * atomic publication. Immutable owner names permit a later human to finish an
 * interrupted STOP; they never permit a resend or a time-based lease eviction.
 */
export function stopInterruptedRemoteHumanRun(file, runId, snapshotHash, io = {}) {
  personOnly();
  insist(typeof snapshotHash === 'string' && HEX.test(snapshotHash), 'Exact recovery snapshot required', 'REMOTE_RECOVERY_INVALID');
  const ctx = context(file, { readOnly: true });
  insist(workflowRecoveryClaims(ctx.root).length === 0, 'An earlier repair needs investigation', 'WORKSPACE_LOCKED');
  const initial = recoverySnapshot(ctx, runId);
  insist(initial.snapshotHash === snapshotHash, 'Recovery snapshot changed', 'REMOTE_RECOVERY_INVALID');
  const confirmation = confirmHumanDecision({ decision: 'reject', lines: [
    'Stop this interrupted native workflow and release its dead process lease:',
    `Manifest: ${ctx.manifestFile}`, `Run: ${runId}`, `Snapshot SHA256: ${snapshotHash}`,
    `Former lease PID: ${initial.lease.pid}`,
    'External publication may already have happened. Its outcome stays unknown until separate readback.'
  ] }, io);
  personOnly();
  insist(recoverySnapshot(ctx, runId).snapshotHash === snapshotHash, 'Recovery snapshot changed during confirmation', 'REMOTE_RECOVERY_INVALID');
  const claimId = randomUUID(), body = {
    protocol: 'qf.remote-human-recovery-claim/v1', claimId, runId, snapshotHash,
    beforeRunHash: hash(initial.run), files: initial.files,
    lease: { pid: initial.lease.pid, dev: initial.lease.dev, ino: initial.lease.ino, sha256: hash(initial.lease.raw) }, confirmation
  };
  const owner = `owner-${process.pid}-${claimId}.lock`;
  // A pre-publication crash leaves only a hidden draft. The original workflow
  // lease still holds; a published claim is never empty or missing its owner.
  const draft = join(ctx.store.dir, `.remote-human-recovery-draft-${claimId}`);
  guardedMkdirSync(draft, { mode: 0o700 });
  save(join(draft, 'claim.json'), body); save(join(draft, owner), {});
  insist(workflowRecoveryClaims(ctx.root).length === 0 && recoverySnapshot(ctx, runId).snapshotHash === snapshotHash,
    'Recovery changed before claim publication', 'REMOTE_RECOVERY_INVALID');
  // The complete, nonempty destination serializes same-snapshot publishers.
  guardedRenameSync(draft, join(ctx.store.dir, recoveryClaimName(body)));
  guardedSyncDirectorySync(ctx.store.dir);
  return finishOwnedRecovery(ctx, runId, owner, body, confirmation, snapshotHash, 'stop');
}

const OWNER_NAME = /^owner-([1-9][0-9]{0,9})-([a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})\.lock$/;
const SNAPSHOT_KEYS = ['manifest','enrollment','run','active','event','lease','leaseDev','leaseIno'];
const recoveryClaimName = body => `${WORKFLOW_RECOVERY_PREFIX}${body.runId}-${body.snapshotHash}`;
function privateRecoveryDirectory(path) {
  const info = lstatSync(path);
  insist(info.isDirectory() && !info.isSymbolicLink() && (info.mode & 0o777) === 0o700 &&
    (typeof process.getuid !== 'function' || info.uid === process.getuid()), 'Unsafe recovery directory', 'REMOTE_RECOVERY_INVALID');
  return info;
}
function noProcess(pid) {
  let absent = false;
  try { process.kill(pid, 0); } catch (error) { absent = error.code === 'ESRCH'; }
  insist(absent, 'Recovery owner is present or cannot be verified', 'WORKSPACE_LOCKED');
}
function stopConfirmation(value) {
  return exactKeys(value, ['decision','channel','confirmedAt']) && value.decision === 'reject' && value.channel === 'tty-code' &&
    typeof value.confirmedAt === 'string' && Number.isFinite(Date.parse(value.confirmedAt)) &&
    new Date(value.confirmedAt).toISOString() === value.confirmedAt;
}
function readRecoveryClaim(dir) {
  const info = privateRecoveryDirectory(dir), names = readdirSync(dir).sort();
  insist(names.length >= 2 && names.length <= 16 && names.includes('claim.json'), 'Incomplete recovery claim', 'REMOTE_RECOVERY_INVALID');
  const owners = names.filter(name => OWNER_NAME.test(name));
  insist(owners.length === 1 && names.every(name => name === 'claim.json' || name === 'cleanup.json' ||
    OWNER_NAME.test(name) || /^\.cleanup\.json\.[a-f0-9-]{36}\.tmp$/.test(name)),
    'Ambiguous recovery claim', 'REMOTE_RECOVERY_INVALID');
  const rows = names.map(name => {
    const file = join(dir, name), raw = recoveryFile(file, 16384), entry = lstatSync(file);
    insist((entry.mode & 0o777) === 0o600, 'Unsafe recovery claim file', 'REMOTE_RECOVERY_INVALID');
    return { name, raw, dev: entry.dev, ino: entry.ino };
  });
  const bodyRaw = rows.find(row => row.name === 'claim.json').raw, body = JSON.parse(bodyRaw);
  insist(exactKeys(body, ['protocol','claimId','runId','snapshotHash','beforeRunHash','files','lease','confirmation']) &&
    body.protocol === 'qf.remote-human-recovery-claim/v1' && RECOVERY_RUN_ID.test(body.claimId) && RECOVERY_RUN_ID.test(body.runId) &&
    HEX.test(body.snapshotHash) && HEX.test(body.beforeRunHash) && stopConfirmation(body.confirmation) &&
    exactKeys(body.files, SNAPSHOT_KEYS) && ['manifest','enrollment','run','active','event','lease'].every(key => HEX.test(body.files[key])) &&
    hash(body.files) === body.snapshotHash && exactKeys(body.lease, ['pid','dev','ino','sha256']) &&
    Number.isSafeInteger(body.lease.pid) && body.lease.pid > 0 && HEX.test(body.lease.sha256) &&
    body.lease.sha256 === body.files.lease && body.lease.dev === body.files.leaseDev && body.lease.ino === body.files.leaseIno,
    'Invalid recovery claim', 'REMOTE_RECOVERY_INVALID');
  insist(hash(JSON.parse(rows.find(row => row.name === owners[0]).raw)) === hash({}), 'Invalid recovery owner record', 'REMOTE_RECOVERY_INVALID');
  insist(readdirSync(dir).sort().join(',') === names.join(',') && rows.every(row => recoveryFile(join(dir,row.name),16384) === row.raw),
    'Recovery claim changed during inspection', 'REMOTE_RECOVERY_INVALID');
  return { dir, body, bodyHash: hash(bodyRaw), owner: owners[0], ownerPid: Number(owners[0].match(OWNER_NAME)[1]),
    directoryHash: hash({ dev: info.dev, ino: info.ino, rows }), directoryIdentity: { dev: info.dev, ino: info.ino } };
}
function recoveryRepairSnapshot(ctx, runId, ownedOwner) {
  insist(typeof runId === 'string' && RECOVERY_RUN_ID.test(runId), 'Invalid recovery run ID', 'REMOTE_RECOVERY_INVALID');
  const claims = workflowRecoveryClaims(ctx.root);
  insist(claims.length === 1 && claims[0].startsWith(WORKFLOW_RECOVERY_PREFIX), 'Unknown or legacy repair claim needs investigation', 'REMOTE_RECOVERY_INVALID');
  const claim = readRecoveryClaim(join(ctx.store.dir, claims[0]));
  insist(claim.body.runId === runId && claims[0] === recoveryClaimName(claim.body), 'Recovery belongs to a different run', 'REMOTE_RECOVERY_INVALID');
  if (ownedOwner === undefined) noProcess(claim.ownerPid);
  else insist(claim.owner === ownedOwner && claim.ownerPid === process.pid, 'Recovery ownership changed', 'WORKSPACE_LOCKED');
  const provider = enrollment(ctx), runRaw = recoveryFile(ctx.store.runFile(runId)), run = currentRun(ctx, runId, provider);
  const host = join(ctx.store.dir, 'host', hash(ctx.manifestFile));
  directory(join(ctx.store.dir, 'host'), false); directory(host, false);
  insist(!existsSync(join(host, 'lock')), 'Incomplete dispatch is not a recovery-finalize operation', 'REMOTE_RECOVERY_INVALID');
  const files = { manifest: hash(recoveryFile(ctx.manifestFile,1048576)), enrollment: hash(recoveryFile(ctx.policyFile,16384)),
    active: hash(recoveryFile(join(host,'active.json'),16384)),
    event: hash(recoveryFile(join(host,`${hash({kind:run.trigger,eventId:run.hostEvent?.id})}.json`),16384)) };
  insist(Object.entries(files).every(([key,value]) => value === claim.body.files[key]) && hash(run) === hash(JSON.parse(runRaw)),
    'Pinned recovery context changed', 'REMOTE_RECOVERY_INVALID');
  const stopped = Object.hasOwn(run, 'humanRecovery');
  if (stopped) {
    inspectStoppedRemoteHumanRun(ctx.manifestFile, runId);
    insist(run.humanRecovery.snapshotHash === claim.body.snapshotHash && run.humanRecovery.beforeRunHash === claim.body.beforeRunHash,
      'Stopped checkpoint belongs to a different recovery', 'REMOTE_RECOVERY_INVALID');
  } else {
    insist(hash(run) === claim.body.beforeRunHash && hash(runRaw) === claim.body.files.run &&
      recoverySnapshot(ctx,runId).snapshotHash === claim.body.snapshotHash, 'Original recovery checkpoint changed', 'REMOTE_RECOVERY_INVALID');
  }
  const leaseFile = join(ctx.store.dir,'workflow.lock');
  let lease = null;
  try { lstatSync(leaseFile); lease = deadLease(leaseFile); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (lease) insist(lease.pid === claim.body.lease.pid && lease.dev === claim.body.lease.dev && lease.ino === claim.body.lease.ino &&
    hash(lease.raw) === claim.body.lease.sha256, 'Original workflow lease changed', 'REMOTE_RECOVERY_INVALID');
  else insist(stopped, 'Uncommitted STOP has no verified workflow lease', 'REMOTE_RECOVERY_INVALID');
  insist(recoveryFile(ctx.store.runFile(runId)) === runRaw && hash(enrollment(ctx)) === hash(provider),
    'Recovery state changed during inspection', 'REMOTE_RECOVERY_INVALID');
  const stateHash = hash({ files, run: hash(runRaw), lease: lease ? { raw:hash(lease.raw),dev:lease.dev,ino:lease.ino } : null });
  return { ...claim, provider, run, stopped, leaseFile, lease, stateHash,
    snapshotHash: hash({ claim:claim.directoryHash, name:claims[0], state:stateHash }) };
}
function finishOwnedRecovery(ctx, runId, owner, expectedBody, confirmation, planHash, kind) {
  const current = recoveryRepairSnapshot(ctx, runId, owner);
  insist(hash(current.body) === hash(expectedBody), 'Recovery claim changed after ownership', 'REMOTE_RECOVERY_INVALID');
  save(join(current.dir,'cleanup.json'), { protocol:'qf.remote-human-recovery-cleanup/v1',kind,runId,
    initialSnapshotHash:current.body.snapshotHash, confirmation, planHash, effectOutcome:'unknown' });
  if (!current.stopped) {
    const run = stoppedRun(current.run, current.body.confirmation, current.body.snapshotHash);
    withPersistenceSecrets({env:persistenceEnvironment(run),receipt:run}, () => save(ctx.store.runFile(runId),run));
  } else {
    // The prior crash may have happened after rename but before directory flush.
    // Commit the exact already-validated bytes before releasing any lock.
    withPersistenceSecrets({env:persistenceEnvironment(current.run),receipt:current.run}, () =>
      guardedDurableReplaceSync(ctx.store.runFile(runId),recoveryFile(ctx.store.runFile(runId)),{receipt:current.run}));
  }
  const observed = inspectStoppedRemoteHumanRun(ctx.manifestFile,runId);
  const final = recoveryRepairSnapshot(ctx,runId,owner);
  if (final.lease) guardedUnlinkSync(final.leaseFile);
  guardedSyncDirectorySync(ctx.store.dir);
  const history = join(ctx.store.dir,'remote-human-recovery-history');
  if (!existsSync(history)) { guardedMkdirSync(history,{mode:0o700}); guardedSyncDirectorySync(ctx.store.dir); }
  privateRecoveryDirectory(history);
  // Whole directory retirement is atomic; no empty active claim can remain.
  // Owner filenames are immutable, unique CAS sources for competing finalizers.
  const destination = join(history,`${runId}-${current.body.claimId}`);
  insist(!existsSync(destination), 'Recovery history already exists', 'REMOTE_RECOVERY_INVALID');
  guardedRenameSync(current.dir,destination); guardedSyncDirectorySync(history); guardedSyncDirectorySync(ctx.store.dir);
  return { ...observed, readOnly:false,leaseReleased:true,executionResumed:false,recoveryFinalized:true };
}

export function inspectInterruptedRemoteHumanRecovery(file,runId) {
  personOnly();
  const current = recoveryRepairSnapshot(context(file,{readOnly:true}),runId);
  return { protocol:'qf.remote-human-recovery-finalize-plan/v1',runId,status:current.run.status,
    snapshotHash:current.snapshotHash,initialSnapshotHash:current.body.snapshotHash,
    recoveryOwnerPid:current.ownerPid,leasePresent:current.lease !== null,action:'finalize-stop',effectOutcome:'unknown' };
}
export function finalizeInterruptedRemoteHumanRecovery(file,runId,snapshotHash,io={}) {
  personOnly();
  insist(typeof snapshotHash === 'string' && HEX.test(snapshotHash),'Exact repair snapshot required','REMOTE_RECOVERY_INVALID');
  const ctx = context(file,{readOnly:true}), initial = recoveryRepairSnapshot(ctx,runId);
  insist(initial.snapshotHash === snapshotHash,'Repair snapshot changed','REMOTE_RECOVERY_INVALID');
  const confirmation = confirmHumanDecision({decision:'reject',lines:[
    'Finish this interrupted STOP. Do not retry or reconcile the external publication:',
    `Manifest: ${ctx.manifestFile}`,`Run: ${runId}`,`Repair snapshot SHA256: ${snapshotHash}`,
    `Former recovery PID: ${initial.ownerPid}`,'The external effect outcome remains unknown.'
  ]},io);
  personOnly();
  const current = recoveryRepairSnapshot(ctx,runId);
  insist(current.snapshotHash === snapshotHash,'Repair changed during confirmation','REMOTE_RECOVERY_INVALID');
  const owner = `owner-${process.pid}-${randomUUID()}.lock`;
  // The old owner filename is never recreated, including across a later claim.
  // A competing finisher cannot rename a newer owner's live record by mistake.
  guardedRenameSync(join(current.dir,current.owner),join(current.dir,owner)); guardedSyncDirectorySync(current.dir);
  const adopted = recoveryRepairSnapshot(ctx,runId,owner);
  insist(adopted.bodyHash === current.bodyHash && adopted.stateHash === current.stateHash &&
    hash(adopted.directoryIdentity) === hash(current.directoryIdentity),'Repair changed during adoption','REMOTE_RECOVERY_INVALID');
  return finishOwnedRecovery(ctx,runId,owner,current.body,confirmation,snapshotHash,'finalize');
}

export function inspectRemoteHumanRecoveryFinalization(file,runId) {
  personOnly();
  const ctx = context(file,{readOnly:true}), observed = inspectStoppedRemoteHumanRun(file,runId);
  const history = join(ctx.store.dir,'remote-human-recovery-history'); privateRecoveryDirectory(history);
  const run = currentRun(ctx,runId,enrollment(ctx));
  const names = readdirSync(history).filter(name=>name.startsWith(`${runId}-`));
  insist(names.length > 0 && names.length <= 32,'No bounded recovery history for this run','REMOTE_RECOVERY_INVALID');
  const evidence = names.sort().map(name=>{
    const claim = readRecoveryClaim(join(history,name)), cleanup = JSON.parse(recoveryFile(join(history,name,'cleanup.json'),16384));
    insist(name === `${runId}-${claim.body.claimId}` && claim.body.runId === runId && claim.body.snapshotHash === observed.snapshotHash &&
      claim.body.beforeRunHash === run.humanRecovery.beforeRunHash && exactKeys(cleanup,['protocol','kind','runId','initialSnapshotHash','confirmation','planHash','effectOutcome']) &&
      cleanup.protocol === 'qf.remote-human-recovery-cleanup/v1' && ['stop','finalize'].includes(cleanup.kind) &&
      cleanup.runId === runId && cleanup.initialSnapshotHash === observed.snapshotHash && stopConfirmation(cleanup.confirmation) &&
      HEX.test(cleanup.planHash) && cleanup.effectOutcome === 'unknown','Invalid recovery history','REMOTE_RECOVERY_INVALID');
    return claim.directoryHash;
  });
  return { ...observed,protocol:'qf.remote-human-recovery-finalized/v1',recoveryFinalized:true,historyHash:hash(evidence),readOnly:true };
}

/** Read-only observation for a separately authenticated effect adapter. A valid
 * receipt alone is insufficient: the exact native consumed checkpoint must
 * currently contain one running post-gate step under the live workflow lease.
 * This does not authorize publication, consume, resume, acquire/remove a lease
 * or resolve an uncertain effect. App bindings/preflight remain adapter duties.
 */
export function inspectRemoteHumanExecution(file, runId, { nowMs = Date.now() } = {}) {
  personOnly();
  insist(Number.isSafeInteger(nowMs) && nowMs >= 0, 'Invalid execution inspection clock');
  const ctx = context(file, { readOnly: true });
  const leaseFile = join(ctx.store.dir, 'workflow.lock');
  const leaseBytes = plainFile(leaseFile, 1024), lease = JSON.parse(leaseBytes);
  insist(lease && Object.keys(lease).join(',') === 'pid' && Number.isSafeInteger(lease.pid) && lease.pid > 0,
    'No current workflow lease', 'REMOTE_APPROVAL_INVALID');
  const leaseStat = lstatSync(leaseFile);
  insist((leaseStat.mode & 0o777) === 0o600 &&
    (typeof process.getuid !== 'function' || leaseStat.uid === process.getuid()), 'Unsafe workflow lease', 'REMOTE_APPROVAL_INVALID');
  try { process.kill(lease.pid, 0); } catch { insist(false, 'Workflow lease process is unavailable', 'REMOTE_APPROVAL_INVALID'); }
  const provider = enrollment(ctx), runBytes = plainFile(ctx.store.runFile(runId));
  const run = currentRun(ctx, runId, provider), state = consumedState(run, provider, nowMs);
  insist(state.evidence.decision === 'approve' && run.status === 'running' &&
    state.execution?.phase === 'running' && nowMs < state.request.expiresAt,
    'No active approved native execution', 'REMOTE_APPROVAL_INVALID');
  const running = run.steps.filter(step => step.status === 'running');
  const gate = run.steps.find(step => step.kind === 'approval-gate' && (step.config.reviewer ?? 'human') === 'human');
  insist(running.length === 1 && running[0].seq > gate.seq &&
    run.steps.filter(step => step.seq < running[0].seq).every(step => ['success','skipped'].includes(step.status)),
    'No exact running post-gate step', 'REMOTE_APPROVAL_INVALID');
  insist(plainFile(ctx.store.runFile(runId)) === runBytes && plainFile(leaseFile, 1024) === leaseBytes &&
    hash(enrollment(ctx)) === state.enrollmentHash, 'Execution changed during inspection', 'REMOTE_APPROVAL_INVALID');
  const step = running[0];
  return { protocol: 'qf.remote-human-execution/v1', runId, manifestHash: provider.manifestHash,
    providerEndpoint: provider.endpoint, issuerKeyId: provider.issuerKeyId, reviewerId: provider.reviewerId,
    chatId: provider.chatId, requestId: state.request.requestId, requestHash: state.request.requestHash,
    approvalHash: state.request.approvalHash, receiptHash: state.evidence.receiptHash,
    expiresAt: state.request.expiresAt, executionId: state.execution.id, checkpointHash: state.checkpointHash,
    leasePid: lease.pid, step: { seq: step.seq, stepId: step.stepId, rowId: step.rowId,
      kind: step.kind, config: structuredClone(step.config), final: step.seq === run.steps.at(-1).seq } };
}

/** Continue a durably consumed decision under the SAME lease used by the
 * shipped workflow CLI and local host. No imported confirmation or new approval.
 * beforeStep is trusted host code for source/STOP/account/report preflight; it
 * cannot be supplied by a manifest. Platform safety is still that adapter's job.
 */
export async function resumeRemoteHumanWorkflow(file, runId, { clock = Date.now, beforeStep, inferenceReply } = {}) {
  personOnly();
  insist(typeof clock === 'function' && (beforeStep === undefined || typeof beforeStep === 'function'), 'Invalid native execution options');
  const ctx = context(file), lock = acquireWorkflowLease(ctx.manifestFile);
  try {
    const nowMs = clock();
    insist(Number.isSafeInteger(nowMs) && nowMs >= 0, 'Invalid native execution clock');
    const provider = enrollment(ctx), run = currentRun(ctx, runId, provider), state = consumedState(run, provider, nowMs);
    const report = resumed => ({ runId, status: run.status, decision: state.evidence.decision,
      authorizationApplied: true, executionResumed: resumed, effectExecuted: state.effectExecuted });
    if (inferenceReply !== undefined) {
      insist(run.status === 'waiting_inference' && run.pendingInference, 'Native run is not waiting for this inference reply', 'STALE_INFERENCE');
      validateCallerInput({ provider: run.callerProvider, inferenceReply });
      assertInferenceReply(run, inferenceReply);
      assertInferenceOutput(run.pendingInference.outputKind, inferenceReply.output);
    } else if (['success','failed','cancelled','needs_human','waiting_inference','waiting_human'].includes(run.status)) return report(false);
    insist((run.status === 'running' || (run.status === 'waiting_inference' && inferenceReply !== undefined)) &&
      state.evidence.decision === 'approve', 'Native workflow is not resumable', 'REMOTE_APPROVAL_INVALID');
    insist(nowMs < state.request.expiresAt, 'Native approval expired before execution', 'REMOTE_APPROVAL_INVALID');
    run.status = 'running';
    state.execution = { id: state.execution?.id ?? randomUUID(), phase: 'running', status: run.status };
    state.effectExecuted = null; // Generic workflow status is not proof of a platform effect.
    const durable = value => {
      insist(value === run, 'Native driver attempted to persist a different run', 'REMOTE_APPROVAL_INVALID');
      state.execution.phase = executionPhase(run.status); state.execution.status = run.status;
      state.checkpointHash = runHash(run);
      withPersistenceSecrets({ env: persistenceEnvironment(run), receipt: run }, () => save(ctx.store.runFile(runId), run));
    };
    durable(run); // Recovery owns this exact checkpoint before any step.
    const store = Object.create(ctx.store); store.save = durable;
    await driveRun(run, { store, knobs: run.executionKnobs, callerProvider: run.callerProvider,
      apiKey: process.env.OPENROUTER_API_KEY ?? null, inferenceReply,
      beforeStep: async (step, current) => {
        const fresh = () => {
          const at = clock();
          insist(Number.isSafeInteger(at) && at >= nowMs && at < state.request.expiresAt &&
            hash(enrollment(ctx)) === state.enrollmentHash,
            'Native approval or enrollment expired/changed before a step', 'REMOTE_APPROVAL_INVALID');
        };
        fresh();
        // A host may revalidate its current source/STOP/account/report here.
        // A refusal leaves a durable pending step, not an uncertain send claim.
        if (beforeStep) await beforeStep(step, current);
        // The asynchronous preflight is part of the authority boundary too.
        // Recheck after it, before the driver persists a running claim/effect.
        fresh();
      } });
    durable(run); ctx.store.saveLastRun(run);
    return report(true);
  } finally { lock.release(); }
}

export function remoteHumanCli(argv) {
  const [operation, file, value, snapshotHash] = argv;
  if (operation === 'recovery-finalize') {
    insist(argv.length === 4 && file && value && snapshotHash, 'Usage: q-core remote-human recovery-finalize <manifest> <runId> <snapshotHash>');
    return finalizeInterruptedRemoteHumanRecovery(file, value, snapshotHash);
  }
  if (operation === 'recovery-stop') {
    insist(argv.length === 4 && file && value && snapshotHash, 'Usage: q-core remote-human recovery-stop <manifest> <runId> <snapshotHash>');
    return stopInterruptedRemoteHumanRun(file, value, snapshotHash);
  }
  insist(argv.length === 3 && file && value, 'Usage: q-core remote-human <enroll|request|recovery-plan|recovery-finalize-plan|recovery-finalized> <manifest> <policy-file|runId>');
  if (operation === 'recovery-finalize-plan') return inspectInterruptedRemoteHumanRecovery(file, value);
  if (operation === 'recovery-finalized') return inspectRemoteHumanRecoveryFinalization(file, value);
  if (operation === 'recovery-plan') return inspectRemoteHumanRecovery(file, value);
  if (operation === 'enroll') {
    personOnly();
    return enrollRemoteHumanProvider(file, JSON.parse(plainFile(value, 16_384)));
  }
  if (operation === 'request') return requestRemoteHumanDecision(file, value);
  insist(false, 'Use the native receipt consumer API from the separately enrolled human host; transport/driver CLI is not implemented');
}
