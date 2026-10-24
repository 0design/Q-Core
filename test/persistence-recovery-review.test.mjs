import assert from 'node:assert/strict';
import fs from 'node:fs';
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync, writeSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { guardedStreamWrite, registerPersistenceSecret } from '../src/persistence.mjs';
import { MAX_SECRET_RECORD_BYTES } from '../src/secret-decoding.mjs';

let nextIdentity = 920000n;

// Keep the physical bytes independent from submitted buffers and completion
// callbacks. A failed write can persist any prefix, including incomplete UTF-8.
function destination(t, { type = 'file' } = {}) {
  const first = 99101, second = 99102, ino = nextIdentity++;
  let bytes = Buffer.alloc(0), version = 1n, readable = true, reads = 0;
  let maxRead = Infinity, stopReadingAt = Infinity, changeDuringRead = false, reportedSize;
  const originalStat = fs.fstatSync, originalRead = fs.readSync;
  const owns = fd => fd === first || fd === second;
  t.mock.method(fs, 'fstatSync', (fd, ...args) => owns(fd) ? {
    dev: 123456n, ino,
    mode: ({ file: 0o100600n, fifo: 0o010600n, socket: 0o140600n, character: 0o020600n })[type],
    birthtimeNs: 1n, ctimeNs: version, mtimeNs: version, size: BigInt(reportedSize ?? bytes.length),
    isFile: () => type === 'file', isFIFO: () => type === 'fifo', isSocket: () => type === 'socket',
  } : originalStat(fd, ...args));
  t.mock.method(fs, 'readSync', (fd, buffer, offset, length, position) => {
    if (!owns(fd)) return originalRead(fd, buffer, offset, length, position);
    reads++;
    if (!readable) throw Object.assign(new Error('simulated unreadable regular file'), { code: 'EACCES' });
    if (position >= stopReadingAt) return 0;
    const count = bytes.copy(buffer, offset, position, position + Math.min(length, maxRead, stopReadingAt - position));
    if (changeDuringRead) { version++; changeDuringRead = false; }
    return count;
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const stream = fd => {
    const queued = [], callbacks = [];
    return {
      fd,
      get writableLength() { return queued.reduce((sum, entry) => sum + entry.value.length, 0); },
      write(value, callback) { queued.push({ value: Buffer.from(value), callback }); return false; },
      flush(count) {
        const entry = queued.shift();
        assert.ok(entry, 'a submitted write must exist');
        bytes = Buffer.concat([bytes, entry.value.subarray(0, count ?? entry.value.length)]);
        version++;
        callbacks.push(entry.callback);
      },
      complete(error) {
        const callback = callbacks.shift();
        assert.equal(typeof callback, 'function', 'a flushed write must have a completion callback');
        callback(error);
      },
    };
  };
  return {
    a: stream(first), b: stream(second), reopen: () => stream(second),
    text: () => bytes.toString('utf8'), bytes: () => Buffer.from(bytes),
    readable(value) { readable = value; }, reads: () => reads,
    maxRead(value) { maxRead = value; }, stopReadingAt(value) { stopReadingAt = value; },
    changeDuringRead() { changeDuringRead = true; },
    truncate(length) { bytes = bytes.subarray(0, length); version++; },
    reportedSize(value) { reportedSize = value; },
  };
}

const failed = () => new Error('simulated partial write failure');
const quarantined = { code: 'PERSISTENCE_DESTINATION_QUARANTINED', message: /quarantin|recover|reconstruct/i };

test('a reopened regular file recovers physical benign bytes after the failed write settles', t => {
  const sink = destination(t);
  guardedStreamWrite(sink.a, 'verified before failure\n');
  sink.a.flush();
  sink.a.complete();
  guardedStreamWrite(sink.a, 'partially persisted output that was not fully written\n');
  sink.a.flush(9);
  assert.throws(() => guardedStreamWrite(sink.b, 'still pending\n'), { code: 'PERSISTENCE_SECRET_UNSAFE' });
  sink.a.complete(failed());
  const reopened = sink.reopen(), beforeRecovery = sink.reads();
  assert.equal(guardedStreamWrite(reopened, 'recovered\n'), false);
  assert.ok(sink.reads() > beforeRecovery, 'recovery must inspect physical output rather than trust submitted text');
  reopened.flush();
  reopened.complete();
  assert.equal(sink.text(), 'verified before failure\npartiallyrecovered\n');
});

test('a zero-byte failed flush recovers without retaining a prefix that never reached disk', t => {
  const sink = destination(t);
  const credential = ['isolated', 'recovery-zero-byte', 'D121'].join('-');
  registerPersistenceSecret(credential);
  guardedStreamWrite(sink.a, credential.slice(0, 10));
  sink.a.flush(0);
  sink.a.complete(failed());
  guardedStreamWrite(sink.b, credential.slice(10));
  sink.b.flush();
  sink.b.complete();
  assert.equal(sink.text(), credential.slice(10));
  assert.equal(sink.text().includes(credential), false);
});

test('partial failed output is combined with the verified boundary before checking a split credential', t => {
  const sink = destination(t);
  const credential = ['isolated', 'recovery-physical-prefix', 'D120'].join('-');
  registerPersistenceSecret(credential);
  const verified = credential.slice(0, 8), partial = credential.slice(8, 19), suffix = credential.slice(19);
  guardedStreamWrite(sink.a, verified);
  sink.a.flush();
  sink.a.complete();
  guardedStreamWrite(sink.a, partial + '\nordinary divider that never reaches disk\n');
  sink.a.flush(Buffer.byteLength(partial));
  sink.a.complete(failed());
  assert.throws(() => guardedStreamWrite(sink.reopen(), suffix), { code: 'PERSISTENCE_SECRET_UNSAFE' });
  assert.equal(sink.text(), verified + partial);
  assert.equal(sink.text().includes(credential), false);
  // A rejected credential continuation does not poison a reconstructable file.
  const reopened = sink.reopen();
  guardedStreamWrite(reopened, '\nordinary recovery\n');
  reopened.flush();
  reopened.complete();
  assert.equal(sink.text(), verified + partial + '\nordinary recovery\n');
});

test('unreadable regular recovery stays closed and can retry once the file is readable', t => {
  const sink = destination(t);
  guardedStreamWrite(sink.a, 'ordinary failed output\n');
  sink.a.flush();
  sink.a.complete(failed());
  sink.readable(false);
  assert.throws(() => guardedStreamWrite(sink.b, 'refused while unreadable\n'), quarantined);
  assert.equal(sink.text(), 'ordinary failed output\n');
  sink.readable(true);
  guardedStreamWrite(sink.b, 'successful readable retry\n');
  sink.b.flush();
  sink.b.complete();
  assert.equal(sink.text(), 'ordinary failed output\nsuccessful readable retry\n');
});

test('a failed partial UTF-8 code point cannot be reconstructed with replacement characters', t => {
  const sink = destination(t);
  guardedStreamWrite(sink.a, 'é harmless submitted output\n');
  sink.a.flush(1);
  sink.a.complete(failed());
  assert.throws(() => guardedStreamWrite(sink.reopen(), 'ordinary successor\n'), quarantined);
  assert.deepEqual(sink.bytes(), Buffer.from([0xc3]));
});

test('recovery completes positional short reads before releasing the failed owner', t => {
  const sink = destination(t);
  guardedStreamWrite(sink.a, 'physically complete benign output\n');
  sink.a.flush();
  sink.a.complete(failed());
  sink.maxRead(2);
  const beforeRecovery = sink.reads();
  guardedStreamWrite(sink.b, 'recovered after short reads\n');
  assert.ok(sink.reads() > beforeRecovery + 1, 'one short read does not establish complete recovery');
  sink.b.flush();
  sink.b.complete();
  assert.equal(sink.text(), 'physically complete benign output\nrecovered after short reads\n');
});

test('an early EOF during recovery stays quarantined until the entire snapshot can be reread', t => {
  const sink = destination(t);
  guardedStreamWrite(sink.a, 'ordinary physical output\n');
  sink.a.flush();
  sink.a.complete(failed());
  sink.stopReadingAt(5);
  assert.throws(() => guardedStreamWrite(sink.b, 'refused incomplete snapshot\n'), quarantined);
  sink.stopReadingAt(Infinity);
  guardedStreamWrite(sink.b, 'complete recovery\n');
  sink.b.flush();
  sink.b.complete();
  assert.equal(sink.text(), 'ordinary physical output\ncomplete recovery\n');
});

test('a file changing during reconstruction stays quarantined until a stable retry', t => {
  const sink = destination(t);
  guardedStreamWrite(sink.a, 'ordinary physical output\n');
  sink.a.flush();
  sink.a.complete(failed());
  sink.changeDuringRead();
  assert.throws(() => guardedStreamWrite(sink.b, 'refused changing snapshot\n'), quarantined);
  guardedStreamWrite(sink.b, 'stable recovery\n');
  sink.b.flush();
  sink.b.complete();
  assert.equal(sink.text(), 'ordinary physical output\nstable recovery\n');
});

test('shrinking below the last verified boundary cannot release a failed owner', t => {
  const sink = destination(t);
  guardedStreamWrite(sink.a, 'verified baseline\n');
  sink.a.flush();
  sink.a.complete();
  guardedStreamWrite(sink.a, 'failed suffix\n');
  sink.a.flush();
  sink.a.complete(failed());
  sink.truncate(1);
  assert.throws(() => guardedStreamWrite(sink.b, 'refused after shrink\n'), quarantined);
  assert.equal(sink.text(), 'v');
});

test('recovery beyond the existing record limit stays quarantined without changing that limit', t => {
  const sink = destination(t);
  guardedStreamWrite(sink.a, 'ordinary physical output\n');
  sink.a.flush();
  sink.a.complete(failed());
  sink.reportedSize(MAX_SECRET_RECORD_BYTES + 1);
  const beforeRecovery = sink.reads();
  assert.throws(() => guardedStreamWrite(sink.b, 'refused oversized reconstruction\n'), quarantined);
  assert.equal(sink.reads(), beforeRecovery, 'an over-limit recovery must fail before reading an incomplete bounded tail');
  assert.equal(sink.text(), 'ordinary physical output\n');
});

for (const type of ['fifo', 'socket', 'character']) {
  test(`a failed ${type} destination remains quarantined after callbacks settle`, t => {
    const sink = destination(t, { type });
    guardedStreamWrite(sink.a, 'first queued output\n');
    guardedStreamWrite(sink.a, 'second queued output\n');
    sink.a.flush(5);
    sink.a.complete(failed());
    assert.throws(() => guardedStreamWrite(sink.b, 'refused before settle\n'), { code: 'PERSISTENCE_SECRET_UNSAFE' });
    sink.a.flush();
    sink.a.complete();
    assert.throws(() => guardedStreamWrite(sink.reopen(), 'refused after settle\n'), quarantined);
    assert.equal(sink.text(), 'firstsecond queued output\n');
  });
}

test('ordinary terminal aliases can write independently before callbacks complete', t => {
  const sink = destination(t, { type: 'character' });
  assert.equal(guardedStreamWrite(sink.a, 'ordinary stdout\n'), false);
  assert.equal(guardedStreamWrite(sink.b, 'ordinary stderr\n'), false);
  sink.b.flush();
  sink.a.flush();
  sink.a.complete();
  sink.b.complete();
  assert.equal(sink.text(), 'ordinary stderr\nordinary stdout\n');
});

test('actual regular-file descriptors recover a partial write after close and reopen', t => {
  const root = mkdtempSync(join(tmpdir(), 'q-core-recovery-review-'));
  const path = join(root, 'recovered.log');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  let fd = openSync(path, 'a+'), callback;
  try {
    guardedStreamWrite({
      fd,
      write(value, complete) { writeSync(fd, Buffer.from(value).subarray(0, 7)); callback = complete; return false; },
    }, 'partial physical output\n');
    callback(failed());
  } finally { closeSync(fd); }
  fd = openSync(path, 'a');
  try {
    assert.throws(() => guardedStreamWrite({
      fd,
      write() { assert.fail('an unreadable reopened file must not receive a write'); },
    }, 'refused write-only recovery\n'), quarantined);
    assert.equal(readFileSync(path, 'utf8'), 'partial');
  } finally { closeSync(fd); }
  fd = openSync(path, 'a+');
  try {
    guardedStreamWrite({ fd, write(value, complete) { writeSync(fd, value); complete(); return true; } }, ' recovered\n');
    assert.equal(readFileSync(path, 'utf8'), 'partial recovered\n');
  } finally { closeSync(fd); }
});
