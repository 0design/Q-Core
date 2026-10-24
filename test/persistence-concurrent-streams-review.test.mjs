import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import test from 'node:test';
import { guardedStreamWrite, registerPersistenceSecret } from '../src/persistence.mjs';

let inode = 910000n;

// Model physical flushes and write callbacks separately: independent Writable
// queues may flush B,A while completing A,B. No scheduler or real disk timing.
function destination(t, { sameFd = false, length = true } = {}) {
  const first = 99001, second = sameFd ? first : 99002, ino = inode++;
  let bytes = Buffer.alloc(0), version = 1n;
  const originalStat = fs.fstatSync, originalRead = fs.readSync;
  const owns = fd => fd === first || fd === second;
  t.mock.method(fs, 'fstatSync', (fd, ...args) => owns(fd) ? {
    dev: 123456n, ino, mode: 0o100600n, birthtimeNs: 1n,
    ctimeNs: version, mtimeNs: version, size: BigInt(bytes.length),
    isFile: () => true, isFIFO: () => false, isSocket: () => false,
  } : originalStat(fd, ...args));
  t.mock.method(fs, 'readSync', (fd, buffer, offset, size, position) => owns(fd)
    ? bytes.copy(buffer, offset, position, position + size)
    : originalRead(fd, buffer, offset, size, position));
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const stream = fd => {
    const queued = [], callbacks = [];
    const output = {
      fd,
      write(value, callback) { queued.push({ value: Buffer.from(value), callback }); return false; },
      flush(count = queued.length) {
        for (const entry of queued.splice(0, count)) {
          bytes = Buffer.concat([bytes, entry.value]);
          version++;
          callbacks.push(entry.callback);
        }
      },
      complete(error) { for (const callback of callbacks.splice(0)) callback(error); },
    };
    if (length) Object.defineProperty(output, 'writableLength', { get: () => queued.reduce((sum, entry) => sum + entry.value.length, 0) });
    return output;
  };
  return { a: stream(first), b: stream(second), text: () => bytes.toString('utf8') };
}

function refused(stream, value) {
  try { guardedStreamWrite(stream, value); }
  catch (error) { return error; }
}

for (const sameFd of [false, true]) {
  for (const length of [true, false]) {
    test(`independent streams fail closed for B,A flush / A,B completion (same fd: ${sameFd}, writableLength: ${length})`, t => {
      const { a, b, text } = destination(t, { sameFd, length });
      const credential = ['isolated', 'concurrent-stream', String(sameFd), String(length), 'D118'].join('-');
      const prefix = credential.slice(0, 10), suffix = credential.slice(10), safe = 'ordinary separator\n';
      registerPersistenceSecret(credential);
      assert.equal(guardedStreamWrite(a, prefix), false);
      const overlap = refused(b, safe);
      // Run the exact review ordering even on the vulnerable implementation.
      b.flush();
      a.flush();
      a.complete();
      b.complete();
      const completion = refused(a, suffix);
      a.flush();
      a.complete();
      // On 87d0ebc this is safe + prefix + suffix: the credential is on disk.
      assert.equal(text().includes(credential), false, 'the reordered writes persisted a split credential');
      assert.equal(overlap?.code, 'PERSISTENCE_SECRET_UNSAFE');
      assert.equal(completion?.code, 'PERSISTENCE_SECRET_UNSAFE');
      assert.equal(text(), prefix);
      // A confirmed flush releases ownership; ordinary independent writes work.
      assert.equal(guardedStreamWrite(b, safe), false);
      b.flush();
      b.complete();
      assert.equal(text(), prefix + safe);
    });
  }
}

test('a drained stream retains ownership until all queued callbacks complete', t => {
  const { a, b, text } = destination(t);
  guardedStreamWrite(a, 'first ordinary chunk\n');
  a.flush();
  guardedStreamWrite(a, 'second ordinary chunk\n');
  a.complete();
  assert.throws(() => guardedStreamWrite(b, 'third ordinary chunk\n'), { code: 'PERSISTENCE_SECRET_UNSAFE' });
  a.flush();
  assert.equal(a.writableLength, 0);
  assert.throws(() => guardedStreamWrite(b, 'third ordinary chunk\n'), { code: 'PERSISTENCE_SECRET_UNSAFE' });
  a.complete();
  guardedStreamWrite(b, 'third ordinary chunk\n');
  b.flush();
  b.complete();
  assert.equal(text(), 'first ordinary chunk\nsecond ordinary chunk\nthird ordinary chunk\n');
});

test('an older queued write failure blocks until callbacks settle and then rechecks regular output', t => {
  const { a, b, text } = destination(t);
  guardedStreamWrite(a, 'first partial chunk\n');
  a.flush();
  guardedStreamWrite(a, 'second ordinary chunk\n');
  a.complete(new Error('partial flush failure'));
  assert.throws(() => guardedStreamWrite(b, 'third ordinary chunk\n'), { code: 'PERSISTENCE_SECRET_UNSAFE' });
  assert.throws(() => guardedStreamWrite(a, 'third ordinary chunk\n'), { code: 'PERSISTENCE_SECRET_UNSAFE' });
  a.flush();
  a.complete();
  guardedStreamWrite(b, 'third ordinary chunk\n');
  b.flush();
  b.complete();
  assert.equal(text(), 'first partial chunk\nsecond ordinary chunk\nthird ordinary chunk\n');
});

test('a partial flush without writableLength preserves the queued secret prefix', t => {
  const { a, text } = destination(t, { length: false });
  const credential = ['isolated', 'partial-stream', 'D119'].join('-');
  const prefix = credential.slice(0, 10), suffix = credential.slice(10);
  registerPersistenceSecret(credential);
  guardedStreamWrite(a, 'ordinary first chunk\n');
  guardedStreamWrite(a, prefix);
  a.flush(1);
  a.complete();
  assert.throws(() => guardedStreamWrite(a, suffix), { code: 'PERSISTENCE_SECRET_UNSAFE' });
  a.flush();
  a.complete();
  assert.equal(text(), 'ordinary first chunk\n' + prefix);
});
