import { createPublicKey, randomBytes, verify } from 'node:crypto';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import childProcess from 'node:child_process';
import os from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { approverDirectory } from './approver-write-boundary.mjs';
import { insist } from './contracts.mjs';
import { guardedMkdirSync, guardedWriteFileSync, guardedUnlinkSync, guardedStreamWrite, guardedStreamEnd } from './persistence.mjs';

/** @typedef {{id: string, verify(decision: {payload: object, signature: string}): boolean}} ApprovalAnchor
 * New transports register a verifier at trusted server startup, never through
 * tool arguments or elicitation. A future phone callback must verify its own
 * server-side signature and the same challenge before returning true.
 */
export const APPROVAL_TTL_MS = 120_000;
const FIELDS = ['run_id', 'gate_id', 'content_hash', 'decision', 'nonce', 'issued_at'];
const HEX = /^[a-f0-9]{64}$/;

/** Canonical UTF-8 JSON: these six string fields in this exact order, no newline. */
export function canonicalApprovalPayload(payload) {
  insist(payload && typeof payload === 'object' && !Array.isArray(payload) &&
    Object.keys(payload).sort().join(',') === [...FIELDS].sort().join(',') &&
    FIELDS.every(key => typeof payload[key] === 'string' && payload[key].length > 0) &&
    HEX.test(payload.content_hash) && HEX.test(payload.nonce) &&
    ['approve', 'reject'].includes(payload.decision) &&
    Number.isFinite(Date.parse(payload.issued_at)) && new Date(payload.issued_at).toISOString() === payload.issued_at,
  'Invalid canonical approval payload.', 'INVALID_ANCHOR_DECISION');
  return JSON.stringify(Object.fromEntries(FIELDS.map(key => [key, payload[key]])));
}

export { approverDirectory };
export const touchIdHelper = () => fileURLToPath(new URL('../tools/touchid-approve/touchid-approve', import.meta.url));
export const touchIdEnvironment = () => ({ HOME: os.userInfo().homedir, PATH: '/usr/bin:/bin' });

/** Separate signing domain: an enrollment proof can never approve a run. */
export function canonicalRegistrationPayload(publicKey, nonce) {
  publicP256Key(publicKey);
  insist(HEX.test(nonce), 'Invalid registration nonce.', 'INVALID_APPROVAL_ANCHOR');
  return JSON.stringify({ purpose: 'q-core.touchid-registration/v1', public_key: publicKey, nonce });
}

/** A registry belongs to its server. Constructing another registry cannot alter
 * the production allowlist or enroll a key through an MCP request. */
export class ApprovalAnchorRegistry {
  #anchors = new Map();
  register(anchor) {
    insist(anchor && typeof anchor.id === 'string' && anchor.id && typeof anchor.verify === 'function',
      'An ApprovalAnchor must provide id and verify(decision).');
    insist(!this.#anchors.has(anchor.id), 'Approval anchor is already registered.');
    this.#anchors.set(anchor.id, anchor);
    return this;
  }
  get(id) {
    const anchor = this.#anchors.get(id);
    insist(anchor, 'Approval anchor is not registered.', 'APPROVAL_ANCHOR_REQUIRED');
    return anchor;
  }
}

function publicP256Key(publicKey) {
  insist(typeof publicKey === 'string' && publicKey.startsWith('-----BEGIN PUBLIC KEY-----'),
    'Only a public P-256 key may be registered.', 'INVALID_APPROVAL_ANCHOR');
  const key = createPublicKey(publicKey);
  insist(key.asymmetricKeyType === 'ec' && key.asymmetricKeyDetails?.namedCurve === 'prime256v1',
    'A P-256 approval public key is required.', 'INVALID_APPROVAL_ANCHOR');
  return key;
}

/** Signature-only verifier, also usable by a trusted server-side callback. */
export class P256ApprovalAnchor {
  constructor(id, publicKey) {
    insist(typeof id === 'string' && id.length > 0, 'An anchor id is required.');
    this.id = id;
    this.publicKey = publicP256Key(publicKey);
  }
  verify(decision) {
    try {
      if (typeof decision?.signature !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(decision.signature)) return false;
      const signature = Buffer.from(decision.signature, 'base64');
      if (signature.toString('base64') !== decision.signature) return false;
      return verify('sha256', Buffer.from(canonicalApprovalPayload(decision.payload)), this.publicKey, signature);
    } catch { return false; }
  }
}

export class TouchIdAnchor extends P256ApprovalAnchor {
  constructor(publicKey) { super('touchid', publicKey); }
  async confirm(payload) {
    const input = canonicalApprovalPayload(payload);
    const response = await new Promise((resolve, reject) => {
      const child = childProcess.execFile(touchIdHelper(), ['approve'], {
        encoding: 'utf8', timeout: APPROVAL_TTL_MS, maxBuffer: 65_536, env: touchIdEnvironment(),
      }, (error, stdout) => error ? reject(error) : resolve(stdout));
      child.stdin.on('error', reject);
      try { guardedStreamWrite(child.stdin, input); guardedStreamEnd(child.stdin); }
      catch (error) { child.kill?.(); reject(error); }
    });
    const result = JSON.parse(response);
    return { channel: 'approval-anchor', anchor_id: this.id, decision: payload.decision, payload, signature: result.signature };
  }
}

/** This registry is server-owned. No client-supplied key/verifier/path is read. */
function registeredTouchIdAnchor() {
  const dir = approverDirectory(), file = join(dir, 'touchid.json');
  insist(existsSync(file), 'Set up Touch ID first: q-core approver add touchid', 'APPROVAL_ANCHOR_REQUIRED');
  for (const path of [join(os.userInfo().homedir, '.q-core'), dir]) {
    insist(lstatSync(path).isDirectory() && !lstatSync(path).isSymbolicLink(), 'Unsafe approver directory.', 'INVALID_APPROVAL_ANCHOR');
  }
  insist(lstatSync(file).isFile() && !lstatSync(file).isSymbolicLink(), 'Unsafe approver registration.', 'INVALID_APPROVAL_ANCHOR');
  const registered = JSON.parse(readFileSync(file, 'utf8'));
  insist(registered.id === 'touchid' && Object.keys(registered).sort().join(',') === 'id,public_key',
    'Invalid approver registration.', 'INVALID_APPROVAL_ANCHOR');
  return new TouchIdAnchor(registered.public_key);
}

// Add future audited transports here, with their server-side verifier. This
// factory allowlist is private: form answers and tool clients cannot register.
const registeredProviders = new Map([['touchid', registeredTouchIdAnchor]]);
export function loadApprovalAnchor(id = 'touchid') {
  const factory = registeredProviders.get(id);
  insist(factory, 'Approval anchor is not registered.', 'APPROVAL_ANCHOR_REQUIRED');
  return new ApprovalAnchorRegistry().register(factory()).get(id);
}

function noncePath(store, nonce) {
  insist(HEX.test(nonce ?? ''), 'Invalid approval nonce.', 'STALE_APPROVAL');
  const dir = join(store.dir, 'approval-nonces');
  if (existsSync(dir)) insist(lstatSync(dir).isDirectory() && !lstatSync(dir).isSymbolicLink(), 'Unsafe approval nonce directory.');
  return join(dir, `${nonce}.json`);
}

export function issueApprovalChallenge(store, snapshot, decision) {
  const payload = { run_id: snapshot.runId, gate_id: snapshot.gateId, content_hash: snapshot.deliveryHash,
    decision, nonce: randomBytes(32).toString('hex'), issued_at: new Date().toISOString() };
  canonicalApprovalPayload(payload);
  const file = noncePath(store, payload.nonce);
  guardedMkdirSync(join(store.dir, 'approval-nonces'), { recursive: true, mode: 0o700 });
  const record = { payload, runHash: snapshot.runHash, environmentHash: snapshot.environmentHash };
  guardedWriteFileSync(file, JSON.stringify(record), { flag: 'wx', mode: 0o600, receipt: record, failOnRedaction: true });
  return payload;
}

/** Called synchronously under the run lock, immediately before saving a decision. */
export function consumeAnchorDecision(confirmation, store, snapshot, decision) {
  insist(store && confirmation?.channel === 'approval-anchor', 'A registered approval anchor is required.', 'HUMAN_CONFIRMATION_REQUIRED');
  const payload = confirmation.payload;
  canonicalApprovalPayload(payload);
  const anchor = loadApprovalAnchor(confirmation.anchor_id);
  insist(anchor.verify(confirmation), 'The registered approval anchor signature is invalid.', 'INVALID_ANCHOR_SIGNATURE');
  const file = noncePath(store, payload.nonce);
  insist(existsSync(file) && lstatSync(file).isFile() && !lstatSync(file).isSymbolicLink(),
    'Approval nonce is unknown or already used.', 'STALE_APPROVAL');
  const record = JSON.parse(readFileSync(file, 'utf8'));
  const age = Date.now() - Date.parse(payload.issued_at);
  insist(age >= 0 && age < APPROVAL_TTL_MS, 'Approval nonce has expired or is not yet valid.', 'STALE_APPROVAL');
  insist(canonicalApprovalPayload(record.payload) === canonicalApprovalPayload(payload) &&
    payload.decision === decision && payload.run_id === snapshot.runId && payload.gate_id === snapshot.gateId &&
    payload.content_hash === snapshot.deliveryHash && record.runHash === snapshot.runHash && record.environmentHash === snapshot.environmentHash,
  'Approval does not match this pending run and exact delivery.', 'STALE_APPROVAL');
  guardedUnlinkSync(file);
  return { anchorId: anchor.id, runId: payload.run_id, gateId: payload.gate_id, deliveryHash: payload.content_hash,
    confirmedAt: payload.issued_at };
}
