/** Candidate native enrollment and single-file gate consumer. No transport,
 * signing, workflow driving or publishing. Existing terminal approvals unchanged.
 */
import { readFileSync, lstatSync, existsSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { hash, insist } from './contracts.mjs';
import { agentSessionMarker, confirmHumanDecision } from './human-confirmation.mjs';
import { lockWorkspace } from './workspace.mjs';
import { RunStore } from './state.mjs';
import { createRun, waitingGate, resolveKnobs } from './run.mjs';
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
  const lock = lockWorkspace(ctx.root);
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

/** Save before notification. This function itself never notifies anyone. */
export function requestRemoteHumanDecision(file, runId, { nowMs = Date.now(), ttlMs = 900_000 } = {}) {
  insist(Number.isSafeInteger(nowMs) && nowMs >= 0, 'Invalid remote request clock');
  const ctx = context(file), lock = lockWorkspace(ctx.root);
  try {
    const provider = enrollment(ctx), run = currentRun(ctx, runId, provider), current = binding(run, provider);
    if (run.remoteHuman) {
      insist(run.remoteHuman.protocol === 'qf.remote-human-state/v1' && run.remoteHuman.phase === 'requested' && run.remoteHuman.enrollmentHash === hash(provider) &&
        run.remoteHuman.runBindingHash === runHash(run), 'Remote challenge is consumed or its subject changed', 'REMOTE_APPROVAL_INVALID');
      assertRemoteApprovalRequest({ request: run.remoteHuman.request, current, nowMs, allowExpired: true });
      if (nowMs < run.remoteHuman.request.expiresAt) return structuredClone(run.remoteHuman.request);
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
 * A future host must lease/reconcile execution separately; this is not an E2E host.
 */
export function consumeRemoteHumanDecision(file, runId, receiptJson, { nowMs = Date.now() } = {}) {
  personOnly();
  const ctx = context(file), lock = lockWorkspace(ctx.root);
  try {
    const provider = enrollment(ctx), run = currentRun(ctx, runId, provider), state = run.remoteHuman;
    insist(state?.protocol === 'qf.remote-human-state/v1' && state.phase === 'requested' &&
      state.enrollmentHash === hash(provider) && state.runBindingHash === runHash(run),
      'Remote challenge is consumed, missing or changed', 'REMOTE_APPROVAL_INVALID');
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
    run.remoteHuman = { ...state, phase: 'consumed', consumedAt: nowMs,
      evidence: { ...evidence, authorizationApplied: true }, effectExecuted: false };
    withPersistenceSecrets({ env: persistenceEnvironment(run), receipt: run }, () => save(ctx.store.runFile(runId), run));
    return { runId, decision: evidence.decision, authorizationApplied: true, effectExecuted: false, status: run.status };
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
