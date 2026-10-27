import { writeFileSync, writeSync, fstatSync, statSync, openSync, readSync, closeSync, mkdirSync, renameSync, unlinkSync, rmSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { CoreError } from './contracts.mjs';
import { assertNoDecodedSecrets, MAX_SECRET_RECORD_BYTES } from './secret-decoding.mjs';

// Credentials stay in memory. All persistent bytes, including temporary files,
// pass this boundary; provider response filtering is an independent first layer.
const scopes = new AsyncLocalStorage();
const knownSecrets = new Set();
const patterns = new Map();
const tails = new Map();
const streamTails = new WeakMap();
const streamFileTails = new Map();
const streamFileWrites = new Map();
// Continuity is bounded: inspect the most recent 1,048,576 bytes on disk and
// retain 1,048,576 UTF-16 code units for cached append/stream history. Arbitrarily
// expanded encodings split across earlier calls are outside this finite guard.
const TAIL_BYTES = 1_048_576;
const MARKER = '[REDACTED]';
const unsafe = () => new CoreError('PERSISTENCE_SECRET_UNSAFE', 'Persistence refused: bytes could not be safely checked or redacted');
const quarantined = reason => new CoreError('PERSISTENCE_DESTINATION_QUARANTINED', `Persistence destination quarantined after a write failure: ${reason}`);
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
    } catch (error) {
      if (error?.code === 'SECRET_DECODE_BUDGET') {
        throw new CoreError('PERSISTENCE_SECRET_DECODE_LIMIT', `Persistence refused: ${error.message}`);
      }
      throw unsafe();
    }
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
    const stat = typeof target === 'number' ? fstatSync(target, { bigint: true }) : statSync(target, { bigint: true });
    // Linux can recycle an inode immediately after unlink. An inode alone is
    // therefore not a durable identity for a cached log/FIFO continuation.
    const generation = `${stat.mode & 0o170000n}:${stat.birthtimeNs}`;
    // Pipe/FIFO timestamps and apparent sizes can change on each write, even
    // between the stdout/stderr aliases of one destination.
    const version = stat.isFile() ? `${generation}:${stat.ctimeNs}:${stat.mtimeNs}:${stat.size}` : generation;
    return { key: `${stat.dev}:${stat.ino}`, generation, version, stat };
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

function previousTail(target, identity) {
  if (!identity?.stat.isFile()) return '';
  const previous = tails.get(identity.key);
  if (previous?.unsafe && previous.generation === identity.generation) throw unsafe();
  if (!identity.stat.size) return '';
  if (previous?.version === identity.version) return previous.text;
  // Inspect existing append targets too, using positional reads so the caller's
  // file offset does not move. Unreadable existing targets fail closed.
  const fd = typeof target === 'number' ? target : openSync(target, 'r');
  try {
    const size = Number(identity.stat.size);
    if (!Number.isSafeInteger(size)) throw unsafe();
    const length = Math.min(size, TAIL_BYTES);
    const bytes = Buffer.alloc(length);
    const count = readSync(fd, bytes, 0, length, size - length);
    return bytes.subarray(0, count).toString('utf8');
  } catch { throw unsafe(); }
  finally { if (typeof target !== 'number') closeSync(fd); }
}

function checkedContinuation(previous, output) {
  const text = typeof output === 'string' ? output : Buffer.from(output).toString('utf8');
  if (previous) redact(Buffer.from(previous + text), true);
  return (previous + text).slice(-TAIL_BYTES);
}

function remember(target, text, previous) {
  const identity = fileIdentity(target);
  if (identity?.stat.isFile()) {
    previous ??= { generation: identity.generation, version: identity.version, text };
    if (streamFileTails.has(identity.key)) streamFileTails.set(identity.key, previous);
    tails.delete(identity.key);
    tails.set(identity.key, previous);
    if (tails.size > 64) tails.delete(tails.keys().next().value);
  }
}

function recoverStreamDestination(fd, identity, writes) {
  if (!identity.stat.isFile()) throw quarantined('partial output from a non-regular file cannot be reread');
  try {
    const size = Number(identity.stat.size), boundary = Number(writes.boundary);
    if (!Number.isSafeInteger(size) || !Number.isSafeInteger(boundary) || size < boundary) throw unsafe();
    // The queued tail describes intended bytes, not necessarily the bytes a
    // failed write emitted. Recheck every byte since this owner acquired the
    // destination, with overlap before that last verified boundary.
    const start = Math.max(0, boundary - TAIL_BYTES);
    const length = size - start;
    // Reuse the existing whole-record ceiling, including overlap. Splitting
    // this scan could miss a representation spanning artificial chunks.
    if (length > MAX_SECRET_RECORD_BYTES) throw unsafe();
    const bytes = Buffer.alloc(length);
    let count = 0;
    while (count < length) {
      const read = readSync(fd, bytes, count, length - count, start + count);
      if (!Number.isSafeInteger(read) || read <= 0 || read > length - count) throw unsafe();
      count += read;
    }
    // A byte-window cut may begin inside an otherwise valid UTF-8 character.
    // Only that leading fragment may be skipped; redact uses fatal decoding
    // for all remaining bytes, including an incomplete failed-write suffix.
    let offset = 0;
    if (start) while (offset < 3 && (bytes[offset] & 0xc0) === 0x80) offset++;
    const { text } = redact(bytes.subarray(offset), true);
    const after = fileIdentity(fd);
    if (!after || after.key !== identity.key || after.generation !== identity.generation || after.version !== identity.version) throw unsafe();
    const next = { generation: identity.generation, version: after.version, text: text.slice(-TAIL_BYTES), pending: false };
    streamFileTails.set(identity.key, next);
    remember(fd, next.text, next);
    streamFileWrites.delete(identity.key);
  } catch {
    // Keep the failed owner so a later readable fd can retry reconstruction;
    // unreadable, changing, oversized or unsafe contents never release it.
    throw quarantined('regular-file output could not be completely reread and verified within the 8 MiB record limit (including overlap); retry with a readable, stable file');
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

/** Exact human previews must refuse rather than display redacted content under its original hash. */
export function assertUnredactedOutput(data) {
  if (prepare(data).output !== data) throw new CoreError('PERSISTENCE_SECRET_UNSAFE', 'Exact delivery preview contains credentials and cannot be shown in a form.');
}

/** stdout/stderr may be redirected to a production log, so guard those bytes too. */
/** Close a writable after its bytes have passed guardedStreamWrite. */
export function guardedStreamEnd(stream) { stream.end(); }

export function guardedStreamWrite(stream, data) {
  const { output } = prepare(data);
  const identity = typeof stream.fd === 'number' ? fileIdentity(stream.fd) : null;
  // stdout and stderr can share one log inode after `2>&1`; use the physical
  // destination rather than the JavaScript stream identity in that case.
  const sharedDestination = identity && (identity.stat.isFile() || identity.stat.isFIFO() || identity.stat.isSocket());
  if (sharedDestination && !streamFileTails.has(identity.key) && streamFileTails.size >= 64) throw unsafe();
  let active = identity ? streamFileWrites.get(identity.key) : null;
  // Independent Writable queues can flush in a different order from .write
  // calls. Keep one owner until every callback confirms its writes, even when
  // writableLength is already zero or unavailable. Cache refreshes cannot
  // release this lock, and a recycled inode starts a new generation.
  if (active && active.generation === identity.generation) {
    if (active.unsafe && active.pending === 0) {
      recoverStreamDestination(stream.fd, identity, active);
      active = null;
    } else if (active.unsafe || (sharedDestination && active.stream !== stream)) throw unsafe();
  }
  const cached = sharedDestination ? streamFileTails.get(identity.key) : null;
  if (cached?.unsafe && cached.generation === identity.generation) throw unsafe();
  const previous = sharedDestination
    ? (cached?.version === identity.version || (cached?.pending && cached.generation === identity.generation)
      ? cached.text : previousTail(stream.fd, identity))
    : streamTails.get(stream);
  const tail = checkedContinuation(previous ?? '', output);
  if (!identity) {
    const accepted = stream.write(output);
    streamTails.set(stream, tail);
    return accepted;
  }
  const writes = active?.generation === identity.generation ? active : { generation: identity.generation, stream, pending: 0, boundary: identity.stat.size };
  writes.pending++;
  streamFileWrites.set(identity.key, writes);
  const next = { generation: identity.generation, version: identity.version, text: tail, pending: true };
  if (sharedDestination) streamFileTails.set(identity.key, next);
  const fail = () => {
    writes.unsafe = true;
    if (!sharedDestination) return;
    if (streamFileWrites.get(identity.key) !== writes) return;
    const current = streamFileTails.get(identity.key);
    if (current?.generation !== identity.generation) return;
    current.unsafe = true;
    current.pending = false;
    if (identity.stat.isFile()) tails.set(identity.key, current);
  };
  const refresh = error => {
    // Writable streams may flush after .write returns. Only the latest queued
    // continuation can refresh its snapshot; an older callback must not erase
    // a newer tail. Synchronous wrappers are covered by the immediate refresh.
    if (!sharedDestination || streamFileTails.get(identity.key) !== next || next.unsafe) return;
    try {
      if (error) throw error;
      const written = fileIdentity(stream.fd);
      if (!written || written.key !== identity.key || written.generation !== identity.generation) throw unsafe();
      next.version = written.version;
      next.pending = writes.pending > 0;
      remember(stream.fd, tail, next);
    } catch {
      // A failed flush may still have emitted a credential prefix. Keep this
      // owner until all callbacks settle and physical bytes can be rechecked.
      fail();
    }
  };
  let completed = false;
  const complete = error => {
    if (completed) return;
    completed = true;
    // An older queued callback can fail after a newer tail replaced it.
    if (error) fail();
    writes.pending--;
    refresh(error);
    if (writes.pending === 0 && !writes.unsafe && streamFileWrites.get(identity.key) === writes) streamFileWrites.delete(identity.key);
  };
  let accepted;
  try { accepted = stream.write(output, complete); }
  catch (error) { fail(); complete(error); throw error; }
  refresh();
  if (!sharedDestination) streamTails.set(stream, tail);
  return accepted;
}

/** Capture configured references before even the first run snapshot is saved. */
export function persistenceEnvironment(config, env = process.env) {
  const names = new Set(["ANTHROPIC_WORKSPACE_ID", ...Object.keys(env).filter(name => credentialName.test(name))]);
  const visit = value => {
    if (typeof value === 'string') {
      for (const match of value.matchAll(/\{\{\s*env\.([A-Za-z_][A-Za-z0-9_]*)/g)) names.add(match[1]);
    } else if (value && typeof value === 'object') {
      for (const [key, child] of Object.entries(value)) {
        if (/(?:keyRef|tokenRef|secretRef|authRef|workspaceRef)$/i.test(key) && typeof child === 'string') names.add(child);
        // Legacy literal workspace config must be protected before the first
        // run snapshot, as well as when the provider resolves it.
        if (key === 'workspaceId' && typeof child === 'string') registerPersistenceSecret(child);
        visit(child);
      }
    }
  };
  visit(config);
  return Object.fromEntries([...names].filter(name => typeof env[name] === 'string').map(name => [name, env[name]]));
}
