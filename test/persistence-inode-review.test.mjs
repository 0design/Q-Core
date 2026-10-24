import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { chmodSync, closeSync, createWriteStream, mkdtempSync, openSync, readFileSync, readSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { guardedStreamWrite, guardedWriteSync, registerPersistenceSecret } from '../src/persistence.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'q-core-inode-review-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

// ext4 may immediately reuse dev:ino after unlink, unlike APFS in local runs.
// Keep actual files/FIFOs and descriptors, but deterministically recycle their
// inode identity on every platform. The kernel's creation/change times differ.
function recycledInode(t) {
  const original = fs.fstatSync;
  let generation = 1n, changed = 1n;
  const dev = 123456n, ino = 9007199254740993n;
  t.mock.method(fs, 'fstatSync', (...args) => {
    const stat = original(...args);
    return Object.assign(stat, { dev, ino, birthtimeNs: generation, ctimeNs: changed });
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  return { nextGeneration() { generation++; changed++; }, changedMetadata() { changed++; } };
}

const stream = fd => ({ fd, write(bytes, callback) { writeSync(fd, bytes); callback(); return true; } });

for (const mode of ['a', 'a+']) {
  test(`a recycled Linux log inode cannot reuse an earlier stream tail (${mode})`, t => {
    const root = fixture(t), path = join(root, 'redirected.log');
    const credential = ['isolated', 'recycled-log', mode === 'a' ? 'D110' : 'D111'].join('-');
    const prefix = credential.slice(0, 10);
    registerPersistenceSecret(credential);
    const { nextGeneration } = recycledInode(t);
    let fd = openSync(path, mode);
    try { guardedStreamWrite(stream(fd), 'safe bytes'); }
    finally { closeSync(fd); }
    rmSync(path);
    nextGeneration();
    writeFileSync(path, prefix);
    fd = openSync(path, mode);
    try {
      assert.throws(() => guardedStreamWrite(stream(fd), credential.slice(10)), { code: 'PERSISTENCE_SECRET_UNSAFE' });
      assert.equal(readFileSync(path, 'utf8'), prefix);
    } finally { closeSync(fd); }
  });
}

test('a recycled Linux FIFO inode starts fresh and still shares its new stream continuation', t => {
  const root = fixture(t), path = join(root, 'collector');
  const credential = ['isolated', 'recycled-fifo', 'D112'].join('-');
  const prefix = credential.slice(0, 10), suffix = credential.slice(10);
  registerPersistenceSecret(credential);
  const { nextGeneration } = recycledInode(t);
  execFileSync('mkfifo', [path]);
  let fd = openSync(path, 'r+');
  try { guardedStreamWrite(stream(fd), prefix); }
  finally { closeSync(fd); }
  rmSync(path);
  nextGeneration();
  execFileSync('mkfifo', [path]);
  fd = openSync(path, 'r+');
  try {
    guardedStreamWrite(stream(fd), suffix);
    guardedStreamWrite(stream(fd), prefix);
    assert.throws(() => guardedStreamWrite(stream(fd), suffix), { code: 'PERSISTENCE_SECRET_UNSAFE' });
    const received = Buffer.alloc(suffix.length + prefix.length);
    assert.equal(readSync(fd, received), received.length);
    assert.equal(received.toString(), suffix + prefix);
  } finally { closeSync(fd); }
});

test('an externally replaced same-size log cannot reuse a guarded fd tail', t => {
  const root = fixture(t), path = join(root, 'replaced.log');
  const credential = ['isolated', 'replaced-log', 'D113'].join('-');
  const prefix = credential.slice(0, 10);
  registerPersistenceSecret(credential);
  const { changedMetadata } = recycledInode(t);
  const fd = openSync(path, 'a+');
  try {
    guardedWriteSync(fd, 'safe bytes');
    writeFileSync(path, prefix);
    changedMetadata();
    assert.throws(() => guardedWriteSync(fd, credential.slice(10)), { code: 'PERSISTENCE_SECRET_UNSAFE' });
    assert.equal(readFileSync(path, 'utf8'), prefix);
  } finally { closeSync(fd); }
});

test('FIFO permission and write-metadata changes preserve shared stream continuity', t => {
  const root = fixture(t), path = join(root, 'permission-collector');
  const credential = ['isolated', 'fifo-metadata', 'D116'].join('-');
  const prefix = credential.slice(0, 10), suffix = credential.slice(10);
  registerPersistenceSecret(credential);
  const { changedMetadata } = recycledInode(t);
  execFileSync('mkfifo', [path]);
  const fd = openSync(path, 'r+');
  try {
    guardedStreamWrite(stream(fd), prefix);
    chmodSync(path, 0o600);
    changedMetadata();
    assert.throws(() => guardedStreamWrite(stream(fd), suffix), { code: 'PERSISTENCE_SECRET_UNSAFE' });
    const received = Buffer.alloc(prefix.length);
    assert.equal(readSync(fd, received), prefix.length);
    assert.equal(received.toString(), prefix);
  } finally { closeSync(fd); }
});

test('an asynchronous partial FIFO flush failure cannot erase its guarded history', async t => {
  const root = fixture(t), path = join(root, 'failed-collector');
  const credential = ['isolated', 'fifo-failed-flush', 'D117'].join('-');
  const prefix = credential.slice(0, 10), suffix = credential.slice(10);
  registerPersistenceSecret(credential);
  const { nextGeneration } = recycledInode(t);
  execFileSync('mkfifo', [path]);
  let fd = openSync(path, 'r+');
  try {
    const output = { fd, write(bytes, callback) { writeSync(fd, bytes); setImmediate(() => callback(new Error('partial flush failure'))); return true; } };
    guardedStreamWrite(output, prefix);
    await new Promise(resolve => setImmediate(resolve));
    assert.throws(() => guardedStreamWrite(stream(fd), suffix), { code: 'PERSISTENCE_SECRET_UNSAFE' });
    const received = Buffer.alloc(prefix.length);
    assert.equal(readSync(fd, received), prefix.length);
    assert.equal(received.toString(), prefix);
  } finally { closeSync(fd); }
  rmSync(path);
  nextGeneration();
  execFileSync('mkfifo', [path]);
  fd = openSync(path, 'r+');
  try {
    guardedStreamWrite(stream(fd), suffix);
    const received = Buffer.alloc(suffix.length);
    assert.equal(readSync(fd, received), suffix.length);
    assert.equal(received.toString(), suffix);
  } finally { closeSync(fd); }
});

for (const mode of ['a', 'w']) {
  test(`an asynchronous write-only log keeps guarded continuity after flush (${mode})`, async t => {
    const root = fixture(t), path = join(root, 'async.log');
    const credential = ['isolated', 'async-stream', mode === 'a' ? 'D114' : 'D115'].join('-');
    const prefix = credential.slice(0, 10), suffix = credential.slice(10);
    registerPersistenceSecret(credential);
    const fd = openSync(path, mode), output = createWriteStream(path, { fd, autoClose: false });
    const flushed = () => new Promise((resolve, reject) => output.write('', error => error ? reject(error) : resolve()));
    try {
      guardedStreamWrite(output, 'safe first chunk\n');
      await flushed();
      guardedStreamWrite(output, 'safe second chunk\n');
      guardedStreamWrite(output, prefix);
      // Queued writes share one continuation even before the stream flushes.
      assert.throws(() => guardedStreamWrite(output, suffix), { code: 'PERSISTENCE_SECRET_UNSAFE' });
      await flushed();
      assert.throws(() => guardedStreamWrite(output, suffix), { code: 'PERSISTENCE_SECRET_UNSAFE' });
      assert.equal(readFileSync(path, 'utf8'), `safe first chunk\nsafe second chunk\n${prefix}`);
    } finally {
      await new Promise(resolve => output.end(resolve));
      closeSync(fd);
    }
  });
}
