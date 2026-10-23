import { writeFileSync, writeSync, fstatSync, statSync, openSync, readSync, closeSync, mkdirSync, renameSync, unlinkSync, rmSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { CoreError } from './contracts.mjs';
import { assertNoDecodedSecrets } from './secret-decoding.mjs';

// Credentials stay in memory. All persistent bytes, including temporary files,
// pass this boundary; provider response filtering is an independent first layer.
const scopes = new AsyncLocalStorage();
const knownSecrets = new Set();
const patterns = new Map();
const tails = new Map();
const streamTails = new WeakMap();
const streamFileTails = new Map();
// Continuity is bounded: inspect the most recent 1,048,576 bytes on disk and
// retain 1,048,576 UTF-16 code units for cached append/stream history. Arbitrarily
// expanded encodings split across earlier calls are outside this finite guard.
const TAIL_BYTES = 1_048_576;
const MARKER = '[REDACTED]';
const unsafe = () => new CoreError('PERSISTENCE_SECRET_UNSAFE', 'Persistence refused: bytes could not be safely checked or redacted');
const credentialName = /(?:key|token|secret|password|credential|authorization|cookie)/i;

export function registerPersistenceSecret(value) {
  if (value === undefined || value === null || value === '') return value;
  if (typeof value !== 'string' || Buffer.byteLength(value) > 8192) throw unsafe();
  for (const secret of [value, value.trim()]) {
    if (!secret) continue;
    if (!knownSecrets.has(secret) && knownSecrets.size >= 4096) throw unsafe();
    knownSecrets.add(secret);
  }
  return value;
}

/** Explicit env values and resolver results are credentials regardless of name. */
export function withPersistenceSecrets({ env = {}, secrets = [], receipt } = {}, callback) {
  for (const value of [...Object.values(env), ...secrets]) registerPersistenceSecret(value);
  const receipts = new Set(scopes.getStore()?.receipts ?? []);
  if (receipt) receipts.add(receipt);
  return scopes.run({ receipts }, callback);
}

const literal = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const hex = value => [...value].map(c => /[a-f]/i.test(c) ? `[${c.toLowerCase()}${c.toUpperCase()}]` : c).join('');
function jsonChar(char) {
  const code = char.charCodeAt(0).toString(16).padStart(4, '0');
  const escaped = JSON.stringify(char).slice(1, -1);
  const short = escaped === char ? (char === '/' ? `|\\\\{1,64}/` : '')
    : char === '\\' ? '|\\\\{1,64}' : `|\\\\{1,64}${literal(escaped.slice(1))}`;
  return `(?:${literal(char)}|\\\\{1,64}u${hex(code)}${short})`;
}
function encodedPattern(value) {
  // Each code unit can independently be literal, JSON escaped or percent
  // encoded. This catches mixed Unicode/URL escapes and escaped backslashes in
  // JSON containing another serialized JSON string, without decoding output.
  return [...value].map(char => {
    const json = char.split('').map(jsonChar).join('');
    const percent = [...Buffer.from(char)].map(byte => `${jsonChar('%')}${hex(byte.toString(16).padStart(2, '0'))}`).join('');
    return `(?:${json}|${percent}${char === ' ' ? `|${jsonChar('+')}` : ''})`;
  }).join('');
}
function secretPatterns() {
  for (const [name, value] of Object.entries(process.env)) if (credentialName.test(name)) registerPersistenceSecret(value);
  for (const secret of knownSecrets) {
    if (patterns.has(secret)) continue;
    const base64 = Buffer.from(secret).toString('base64');
    const variants = new Set([secret, base64, base64.replace(/=+$/, ''), base64.replace(/\+/g, '-').replace(/\//g, '_'), base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')]);
    patterns.set(secret, [...variants].filter(Boolean).map(value => new RegExp(encodedPattern(value), 'g')));
  }
  return [...patterns.values()].flat();
}

function redact(bytes, failOnRedaction) {
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw unsafe(); }
  if (text.includes('\0')) throw unsafe();
  const checks = secretPatterns();
  if (checks.length && /\\{65}/.test(text)) throw unsafe();
  let redactedSecrets = 0;
  for (const pattern of checks) {
    pattern.lastIndex = 0;
    text = text.replace(pattern, () => { redactedSecrets++; return MARKER; });
  }
  if (redactedSecrets && failOnRedaction) throw unsafe();
  // A replacement must never itself contain another credential. Fail closed
  // rather than emit a partial replacement or leak an unhandled short value.
  for (const pattern of checks) {
    pattern.lastIndex = 0;
    if (pattern.test(text)) throw unsafe();
  }
  if (checks.length) {
    try {
      const secrets = [...knownSecrets];
      const minSecretBytes = Math.min(12, ...secrets.map(secret => Buffer.byteLength(secret)));
      assertNoDecodedSecrets(text, decoded => secrets.some(secret => decoded.includes(secret)), { minSecretBytes });
    } catch { throw unsafe(); }
  }
  if (redactedSecrets) {
    try {
      const original = JSON.parse(bytes.toString('utf8'));
      const sanitized = JSON.parse(text);
      const sameShape = (a, b) => {
        if (!a || typeof a !== 'object') return typeof a === typeof b;
        if (!b || typeof b !== 'object' || Array.isArray(a) !== Array.isArray(b)) return false;
        const before = Object.values(a), after = Object.values(b);
        return before.length === after.length && before.every((value, i) => sameShape(value, after[i]));
      };
      if (!sameShape(original, sanitized)) throw unsafe();
    } catch (error) {
      if (error?.code === 'PERSISTENCE_SECRET_UNSAFE') throw error;
      // If the original was JSON, redaction must leave valid JSON. Plain text
      // and JSONL remain plain bytes, with no serialization/format changes.
      try { JSON.parse(bytes.toString('utf8')); } catch { return { text, redactedSecrets }; }
      throw unsafe();
    }
  }
  return { text, redactedSecrets };
}

function prepare(data, options = {}) {
  const settings = typeof options === 'string' ? { encoding: options } : (options ?? {});
  const { receipt, failOnRedaction = false, ...fsOptions } = settings;
  if (fsOptions.encoding && !/^utf-?8$/i.test(fsOptions.encoding)) throw unsafe();
  let bytes;
  try { bytes = typeof data === 'string' ? Buffer.from(data, fsOptions.encoding ?? 'utf8') : Buffer.from(data.buffer ?? data, data.byteOffset ?? 0, data.byteLength); }
  catch { throw unsafe(); }
  const result = redact(bytes, failOnRedaction);
  let output = result.redactedSecrets ? Buffer.from(result.text) : data;
  if (result.redactedSecrets) {
    const owners = new Set([receipt, ...(scopes.getStore()?.receipts ?? [])].filter(Boolean));
    for (const owner of owners) owner.redactedSecrets = (Number.isSafeInteger(owner.redactedSecrets) ? owner.redactedSecrets : 0) + result.redactedSecrets;
    if (receipt) {
      let value;
      try { value = JSON.parse(result.text); } catch { throw unsafe(); }
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw unsafe();
      value.redactedSecrets = receipt.redactedSecrets;
      const final = redact(Buffer.from(JSON.stringify(value, null, 2) + '\n'), false);
      if (final.redactedSecrets) throw unsafe();
      output = Buffer.from(final.text);
    }
  }
  return { output, fsOptions, redactedSecrets: result.redactedSecrets };
}

function fileIdentity(target) {
  try {
    const stat = typeof target === 'number' ? fstatSync(target) : statSync(target);
    return { key: `${stat.dev}:${stat.ino}`, stat };
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

function previousTail(target, identity) {
  if (!identity?.stat.isFile() || !identity.stat.size) return '';
  const previous = tails.get(identity.key);
  if (previous?.size === identity.stat.size) return previous.text;
  // Inspect existing append targets too, using positional reads so the caller's
  // file offset does not move. Unreadable existing targets fail closed.
  const fd = typeof target === 'number' ? target : openSync(target, 'r');
  try {
    const length = Math.min(identity.stat.size, TAIL_BYTES);
    const bytes = Buffer.alloc(length);
    const count = readSync(fd, bytes, 0, length, identity.stat.size - length);
    return bytes.subarray(0, count).toString('utf8');
  } catch { throw unsafe(); }
  finally { if (typeof target !== 'number') closeSync(fd); }
}

function checkedContinuation(previous, output) {
  const text = typeof output === 'string' ? output : Buffer.from(output).toString('utf8');
  if (previous) redact(Buffer.from(previous + text), true);
  return (previous + text).slice(-TAIL_BYTES);
}

function remember(target, text) {
  const identity = fileIdentity(target);
  if (identity?.stat.isFile()) {
    if (streamFileTails.has(identity.key)) streamFileTails.set(identity.key, text);
    tails.delete(identity.key);
    tails.set(identity.key, { size: identity.stat.size, text });
    if (tails.size > 64) tails.delete(tails.keys().next().value);
  }
}

export function assertPersistencePath(file) {
  if (typeof file !== 'number') redact(Buffer.from(file instanceof URL ? file.href : file), true);
}

// Path mutations are capabilities too: validate every pathname before the first
// side effect, including both names for moves. A caller's earlier check cannot
// substitute for this boundary, because a new callsite could omit it.
export function guardedMkdirSync(path, options) {
  assertPersistencePath(path);
  return mkdirSync(path, options);
}

export function guardedOpenSync(path, flags, mode) {
  assertPersistencePath(path);
  return openSync(path, flags, mode);
}

export function guardedRenameSync(source, destination) {
  assertPersistencePath(source);
  assertPersistencePath(destination);
  return renameSync(source, destination);
}

export function guardedUnlinkSync(path) {
  assertPersistencePath(path);
  return unlinkSync(path);
}

export function guardedRmSync(path, options) {
  assertPersistencePath(path);
  return rmSync(path, options);
}

export function guardedRm(path, options) {
  assertPersistencePath(path);
  return rm(path, options);
}

export async function guardedMkdtemp(prefix) {
  assertPersistencePath(prefix);
  if (typeof prefix !== 'string') throw unsafe();
  // Choose and check the complete random name before mkdir. Native mkdtemp
  // chooses its suffix inside the mutation, too late to guard the full path.
  for (let attempt = 0; attempt < 10; attempt++) {
    const path = prefix + randomUUID();
    assertPersistencePath(path);
    try { await mkdir(path, { mode: 0o700 }); return path; }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
  throw unsafe();
}

/** The sole file writer. Check before open/create/truncate, including temp files. */
export function guardedWriteFileSync(file, data, options) {
  assertPersistencePath(file);
  const { output, fsOptions, redactedSecrets } = prepare(data, options);
  const append = typeof file === 'number' || /^a/.test(fsOptions.flag ?? 'w');
  const tail = checkedContinuation(append ? previousTail(file, fileIdentity(file)) : '', output);
  writeFileSync(file, output, fsOptions);
  remember(file, tail);
  return { redactedSecrets };
}

/** The sole fd writer (append logs and already-open, symlink-safe file sinks). */
export function guardedWriteSync(fd, data, ...args) {
  if (typeof data === 'string') {
    const [position = null, encoding = 'utf8'] = args;
    const { output } = prepare(data, { encoding });
    const tail = checkedContinuation(previousTail(fd, fileIdentity(fd)), output);
    const written = typeof output === 'string' ? writeSync(fd, output, position, encoding) : writeSync(fd, output, 0, output.length, position);
    remember(fd, tail);
    return written;
  }
  const [offset = 0, length = data.byteLength - offset, position = null] = args;
  const slice = Buffer.from(data.buffer, data.byteOffset, data.byteLength).subarray(offset, offset + length);
  const { output } = prepare(slice);
  const tail = checkedContinuation(previousTail(fd, fileIdentity(fd)), output);
  const written = writeSync(fd, output, 0, output.length, position);
  remember(fd, tail);
  return written;
}

/** stdout/stderr may be redirected to a production log, so guard those bytes too. */
export function guardedStreamWrite(stream, data) {
  const { output } = prepare(data);
  const identity = typeof stream.fd === 'number' ? fileIdentity(stream.fd) : null;
  // stdout and stderr can share one log inode after `2>&1`; use the physical
  // destination rather than the JavaScript stream identity in that case.
  const sharedDestination = identity && (identity.stat.isFile() || identity.stat.isFIFO() || identity.stat.isSocket());
  if (sharedDestination && !streamFileTails.has(identity.key) && streamFileTails.size >= 64) throw unsafe();
  const previous = sharedDestination
    ? (streamFileTails.get(identity.key) ?? previousTail(stream.fd, identity))
    : streamTails.get(stream);
  const tail = checkedContinuation(previous ?? '', output);
  const accepted = stream.write(output);
  if (sharedDestination) { streamFileTails.set(identity.key, tail); remember(stream.fd, tail); }
  else streamTails.set(stream, tail);
  return accepted;
}

/** Capture configured references before even the first run snapshot is saved. */
export function persistenceEnvironment(config, env = process.env) {
  const names = new Set(Object.keys(env).filter(name => credentialName.test(name)));
  const visit = value => {
    if (typeof value === 'string') {
      for (const match of value.matchAll(/\{\{\s*env\.([A-Za-z_][A-Za-z0-9_]*)/g)) names.add(match[1]);
    } else if (value && typeof value === 'object') {
      for (const [key, child] of Object.entries(value)) {
        if (/(?:keyRef|tokenRef|secretRef|authRef)$/i.test(key) && typeof child === 'string') names.add(child);
        visit(child);
      }
    }
  };
  visit(config);
  return Object.fromEntries([...names].filter(name => typeof env[name] === 'string').map(name => [name, env[name]]));
}
