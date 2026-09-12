import { createHash, sign, verify, randomUUID } from 'node:crypto';
import { readFileSync, realpathSync, lstatSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { dirname, join, relative, isAbsolute } from 'node:path';

export function canonical(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && Object.getPrototypeOf(value) === Object.prototype) {
    return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
  }
  throw new Error('Only finite JSON data is permitted');
}

export function digest(value) {
  return createHash('sha256').update(Buffer.isBuffer(value) ? value : canonical(value)).digest('hex');
}

const object = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const sha = x => typeof x === 'string' && /^[a-f0-9]{40}$/.test(x);
const hash = x => typeof x === 'string' && /^[a-f0-9]{64}$/.test(x);
const same = (a, b) => canonical(a) === canonical(b);

export function contextSlice(contract, ds) {
  if (contract.schema !== 'qgate.task/v1' || ds.schema !== 'qgate.ds/v1') throw new Error('Unsupported contract');
  if (contract.detectorMode !== 'observe') throw new Error('This pilot has no authorized detector promotion');
  if (contract.instance !== ds.instance.id || ds.instance.coreVersion !== ds.version) throw new Error('Incompatible instance');
  // Mandatory requirements are always included. No model relevance filter can remove them.
  return structuredClone({ contract, ds, sourceDigests: { contract: digest(contract), ds: digest(ds) } });
}

export function bindCandidate({ baseSha, headSha, contract, ds, verifierDigest, files }) {
  contextSlice(contract, ds);
  if (!sha(baseSha) || !sha(headSha) || !hash(verifierDigest)) throw new Error('Invalid revision');
  if (!Array.isArray(files) || files.length !== contract.allowedFiles.length) throw new Error('Incomplete candidate manifest');
  const seen = new Set();
  for (const f of files) {
    if (!object(f) || !contract.allowedFiles.includes(f.path) || !hash(f.sha256) || seen.has(f.path)) throw new Error('Invalid manifest');
    seen.add(f.path);
  }
  return {
    schema: 'qgate.binding/v1', baseSha, headSha,
    contractDigest: digest(contract), dsDigest: digest(ds), verifierDigest,
    files: [...files].sort((a, b) => a.path.localeCompare(b.path)),
  };
}

export function scopeVerdict(changedFiles, contract) {
  if (!Array.isArray(changedFiles) || changedFiles.length === 0) return { state: 'failure', reason: 'No candidate change' };
  const outside = changedFiles.filter(p => !contract.allowedFiles.includes(p));
  return outside.length
    ? { state: 'failure', reason: 'Changed frozen or out-of-scope files', paths: outside }
    : { state: 'success', reason: 'Only approved candidate files changed' };
}

// This is an observer, not an acceptance decision. Confirmed violations are rejected
// by independent review during this observation phase. A detector finding alone is
// never converted to an acceptance receipt.
export function observe(screen, contract, ds) {
  const findings = [];
  const add = (rule, path, message) => findings.push({ rule, path, message });
  if (!object(screen)) {
    add('DS-SHAPE', '$', 'Screen must be an object');
    return { mode: 'observe', findings };
  }
  for (const k of Object.keys(screen)) if (!['instance', 'nodes'].includes(k)) add('DS-RAW', k, 'Unknown screen capability');
  if (screen.instance !== contract.instance) add('DS-INSTANCE', 'instance', 'Wrong project instance');
  if (!Array.isArray(screen.nodes) || screen.nodes.length > 32) {
    add('DS-SHAPE', 'nodes', 'Expected at most 32 component nodes');
    return { mode: 'observe', findings };
  }
  const ids = new Set();
  for (let i = 0; i < screen.nodes.length; i++) {
    const n = screen.nodes[i], path = 'nodes[' + i + ']';
    if (!object(n)) { add('DS-SHAPE', path, 'Node must be an object'); continue; }
    for (const k of Object.keys(n)) {
      if (['waiver', 'allow', 'ds-allow'].includes(k)) add('DS-WAIVER', path + '.' + k, 'No worker-created exemptions');
      else if (!['id', 'component', 'role', 'variant', 'presentation', 'content', 'extension'].includes(k)) {
        add('DS-RAW', path + '.' + k, 'No raw styling, HTML replacement or token override');
      }
    }
    if (typeof n.id !== 'string' || ids.has(n.id)) add('DS-ID', path, 'Missing or duplicate node ID');
    ids.add(n.id);
    const c = Object.hasOwn(ds.components, n.component ?? '') ? ds.components[n.component] : null;
    if (!c) { add('DS-COMPONENT', path, 'Component is not in the Core registry'); continue; }
    if (n.role !== c.role) add('DS-ROLE', path, 'Role does not map to this component');
    if (!c.variants.includes(n.variant)) add('DS-VARIANT', path, 'Variant is not registered');
    if (!c.presentations.includes(n.presentation)) add('DS-PRESENTATION', path, 'Presentation is incompatible');
    if (typeof n.content !== 'string' || n.content.length > 2000) add('DS-CONTENT', path, 'Content must be bounded text');
    if (n.extension !== undefined) {
      const e = Object.hasOwn(ds.instance.extensions, n.extension) ? ds.instance.extensions[n.extension] : null;
      if (!e || e.scope !== screen.instance || !e.components.includes(n.component) || !e.presentations.includes(n.presentation)) {
        add('DS-EXTENSION', path, 'Extension is unregistered or incompatible');
      }
    }
  }
  for (const [id, required] of Object.entries(contract.requiredNodes)) {
    const n = screen.nodes.find(x => object(x) && x.id === id);
    if (!n) { add('TASK-NODE', id, 'Required task node is missing'); continue; }
    for (const [key, value] of Object.entries(required)) if (n[key] !== value) add('TASK-MAPPING', id + '.' + key, 'Task mapping differs from its contract');
  }
  const save = screen.nodes.find(x => object(x) && x.id === 'save');
  if (save?.content !== contract.requiredSaveLabel) add('TASK-COPY', 'save.content', 'Task action label differs from its contract');
  return { mode: 'observe', findings };
}

export function signReceipt(body, privateKey) {
  return { body, signature: sign(null, Buffer.from(canonical(body)), privateKey).toString('base64') };
}

export function checkReceipt(envelope, kind, binding, publicKey, nowMs, maxAgeSeconds) {
  if (envelope === null || envelope === undefined) return { state: 'pending', reason: 'Missing ' + kind + ' receipt' };
  try {
    if (!object(envelope) || !object(envelope.body) || typeof envelope.signature !== 'string') throw new Error('Malformed receipt');
    const b = envelope.body;
    if (b.schema !== 'qgate.receipt/v1' || b.kind !== kind || !same(b.binding, binding)) throw new Error('Wrong purpose or stale revision');
    if (!verify(null, Buffer.from(canonical(b)), publicKey, Buffer.from(envelope.signature, 'base64'))) throw new Error('Invalid signature');
    const issued = Date.parse(b.issuedAt), expires = Date.parse(b.expiresAt);
    if (!Number.isFinite(maxAgeSeconds) || maxAgeSeconds <= 0 || !Number.isFinite(nowMs) || !Number.isFinite(issued) || !Number.isFinite(expires)
      || issued > nowMs + 60_000 || expires <= nowMs || expires <= issued
      || nowMs - issued > maxAgeSeconds * 1000 || expires - issued > maxAgeSeconds * 1000) throw new Error('Expired or invalid receipt time');
    if (typeof b.receiptId !== 'string' || !b.receiptId || !hash(b.evidenceDigest)) throw new Error('Missing evidence provenance');
    if (kind === 'review') {
      if (!['approved', 'rejected'].includes(b.decision) || b.independent !== true) throw new Error('Invalid independent review');
      return b.decision === 'approved'
        ? { state: 'success', reason: 'Independent review approved this exact candidate' }
        : { state: 'failure', reason: 'Independent review rejected this candidate' };
    }
    if (kind === 'linear-sync' && b.confirmed === true) return { state: 'success', reason: 'Linear write and readback attested for this candidate' };
    throw new Error('Unconfirmed synchronization');
  } catch (e) {
    return { state: 'failure', reason: e.message };
  }
}

export function acceptance({ binding, changedFiles, contract, review, sync, reviewPublicKey, syncPublicKey, nowMs = Date.now() }) {
  if (!binding || binding.contractDigest !== digest(contract)) throw new Error('Contract and candidate binding differ');
  const checks = {
    contract: scopeVerdict(changedFiles, contract),
    review: checkReceipt(review, 'review', binding, reviewPublicKey, nowMs, contract.receiptMaxAgeSeconds),
    linearSync: checkReceipt(sync, 'linear-sync', binding, syncPublicKey, nowMs, contract.receiptMaxAgeSeconds),
  };
  const states = Object.values(checks).map(c => c.state);
  return {
    schema: 'qgate.acceptance/v1', binding, detectorMode: 'observe', checks,
    state: states.includes('failure') ? 'rejected' : states.includes('pending') ? 'pending' : 'eligible',
  };
}

export function applyProposal(root, proposal, contract) {
  if (!object(proposal) || !same(Object.keys(proposal).sort(), ['content', 'expectedSha256', 'path'].sort())) throw new Error('Malformed proposal');
  if (!contract.allowedFiles.includes(proposal.path) || isAbsolute(proposal.path) || proposal.path.split('/').includes('..')) throw new Error('Out-of-scope proposal');
  if (typeof proposal.content !== 'string' || Buffer.byteLength(proposal.content) > 65_536 || !hash(proposal.expectedSha256)) throw new Error('Invalid proposal content');
  JSON.parse(proposal.content); // Data only; the worker supplies no executable command.
  const base = realpathSync(root), file = join(base, proposal.path), parent = realpathSync(dirname(file));
  const rel = relative(base, parent);
  if (rel.startsWith('..') || isAbsolute(rel) || lstatSync(file).isSymbolicLink()) throw new Error('Symlink escape');
  if (digest(readFileSync(file)) !== proposal.expectedSha256) throw new Error('Candidate changed since slicing');
  const temp = join(parent, '.qgate-' + randomUUID());
  let created = false;
  try {
    writeFileSync(temp, proposal.content, { flag: 'wx', mode: 0o600 });
    created = true;
    renameSync(temp, file);
  } finally {
    try { if (created) unlinkSync(temp); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
  return { path: proposal.path, sha256: digest(Buffer.from(proposal.content)) };
}
