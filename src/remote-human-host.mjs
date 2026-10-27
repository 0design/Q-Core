/** Candidate native enrollment, receipt consumption and leased continuation.
 * No provider transport, signing, service installation or platform adapter.
 */
import { readFileSync, lstatSync, existsSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { hash, insist } from './contracts.mjs';
import { agentSessionMarker, confirmHumanDecision } from './human-confirmation.mjs';
import { acquireWorkflowLease } from './workflow-lease.mjs';
import { RunStore } from './state.mjs';
import { createRun, waitingGate, resolveKnobs, driveRun } from './run.mjs';
import { assertInferenceReply, assertInferenceOutput, validateCallerInput } from './caller-inference.mjs';
import { loadWorkflow } from './workflow-policy.mjs';
import { guardedDurableReplaceSync, guardedMkdirSync, guardedSyncDirectorySync,
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
function context(file) {
  // The manifest itself must not be a symlink. Parent is canonicalized once.
  insist(typeof file === 'string' && !/[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/.test(file), 'Unsafe manifest pathname');
  plainFile(file, 1_048_576);
  const manifestFile = realpathSync(file), root = dirname(manifestFile);
  const store = new RunStore(manifestFile);
  directory(store.dir);
  return { manifestFile, root, store, policyFile: join(store.dir, 'remote-human-provider.json') };
}
function directory(path) {
  if (existsSync(path)) {
    const stat = lstatSync(path);
    insist(stat.isDirectory() && !stat.isSymbolicLink(), 'Unsafe remote human directory', 'REMOTE_APPROVAL_INVALID');
  } else {
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
  directory(ctx.store.runsDir);
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
  const [operation, file, value] = argv;
  insist(argv.length === 3 && file && value, 'Usage: q-core remote-human <enroll|request> <manifest> <policy-file|runId>');
  if (operation === 'enroll') {
    personOnly();
    return enrollRemoteHumanProvider(file, JSON.parse(plainFile(value, 16_384)));
  }
  if (operation === 'request') return requestRemoteHumanDecision(file, value);
  insist(false, 'Use the native receipt consumer API from the separately enrolled human host; transport/driver CLI is not implemented');
}
