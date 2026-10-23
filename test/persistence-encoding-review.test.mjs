import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, readSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { guardedStreamWrite, guardedWriteFileSync, registerPersistenceSecret } from '../src/persistence.mjs';
import { assertNoDecodedSecrets } from '../src/secret-decoding.mjs';
import { assertNoSecretShapes } from '../scripts/check-no-secrets-in-artifacts.mjs';

const key = ['sk', 'ant', 'round3', 'synthetic', 'q7'.repeat(16)].join('-');
const percent = value => [...Buffer.from(value)].map(byte => `%${byte.toString(16).padStart(2, '0')}`).join('');
const encodings = {
  hex: value => Buffer.from(value).toString('hex'),
  'hex offset prefix': value => 'a' + Buffer.from('x' + value).toString('hex'),
  'base64 encoded prefix': value => Buffer.from('x' + value).toString('base64'),
  'base64 offset prefix': value => 'prefix' + Buffer.from('xx' + value).toString('base64'),
  'base64url offset prefix': value => 'abc' + Buffer.from('x' + value).toString('base64url'),
  'base64 MIME whitespace': value => Buffer.from('x' + value).toString('base64').match(/.{1,20}/g).join('\r\n'),
  'double percent': value => percent(percent(value)),
  'nested base64 hex percent': value => Buffer.from(percent(Buffer.from(value).toString('hex'))).toString('base64'),
};
const directory = t => {
  const root = mkdtempSync(join(tmpdir(), 'q-core-encoding-review-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
};

for (const [label, encode] of Object.entries(encodings)) {
  test(`${label}: guard refuses before create/truncate and scanner rejects the same payload`, t => {
    const root = directory(t), existing = join(root, 'existing.txt'), missing = join(root, 'missing.txt');
    const payload = encode(key);
    registerPersistenceSecret(key);
    writeFileSync(existing, 'keep');
    for (const file of [existing, missing]) {
      assert.throws(() => guardedWriteFileSync(file, JSON.stringify({ error: payload })), { code: 'PERSISTENCE_SECRET_UNSAFE' });
    }
    assert.equal(readFileSync(existing, 'utf8'), 'keep');
    assert.equal(existsSync(missing), false);
    assert.throws(() => assertNoSecretShapes(Buffer.from(payload)), /Secret-shaped string/);
  });
}

test('bounded decoding fails closed on depth and total byte budgets', t => {
  const root = directory(t), file = join(root, 'refused.txt');
  let excessive = '%41';
  for (let level = 0; level < 8; level++) excessive = excessive.replaceAll('%', '%25');
  assert.throws(() => assertNoDecodedSecrets(excessive, () => false), { code: 'SECRET_DECODE_BUDGET' });
  assert.throws(() => assertNoDecodedSecrets('!'.repeat(64 * 1024 * 1024 + 1), () => false), { code: 'SECRET_DECODE_BUDGET' });
  assert.throws(() => guardedWriteFileSync(file, excessive), { code: 'PERSISTENCE_SECRET_UNSAFE' });
  assert.equal(existsSync(file), false);
  assert.throws(() => assertNoSecretShapes(Buffer.from(excessive)), /Cannot safely scan/);
});

for (const [label, encode] of [['raw', value => value], ['prefixed base64', encodings['base64 encoded prefix']]]) {
  test(`shared FIFO stream wrappers refuse a split ${label} credential`, t => {
    const root = directory(t), path = join(root, 'collector');
    execFileSync('mkfifo', [path]);
    const fd = openSync(path, 'r+');
    try {
      const wrap = () => ({ fd, write(bytes) { writeSync(fd, bytes); return true; } });
      const stdout = wrap(), stderr = wrap();
      const value = encode(key), midpoint = Math.floor(value.length / 2);
      registerPersistenceSecret(key);
      guardedStreamWrite(stdout, value.slice(0, midpoint));
      assert.throws(() => guardedStreamWrite(stderr, value.slice(midpoint)), { code: 'PERSISTENCE_SECRET_UNSAFE' });
      const received = Buffer.alloc(midpoint);
      assert.equal(readSync(fd, received), midpoint);
      assert.equal(received.toString(), value.slice(0, midpoint));
    } finally { closeSync(fd); }
  });
}

test('real combined stdout/stderr pipeline shares secret continuity', () => {
  const script = `
    import { guardedStreamWrite, registerPersistenceSecret } from ${JSON.stringify(new URL('../src/persistence.mjs', import.meta.url).href)};
    const key = ${JSON.stringify(key)};
    registerPersistenceSecret(key);
    const split = Math.floor(key.length / 2);
    guardedStreamWrite(process.stdout, key.slice(0, split));
    try { guardedStreamWrite(process.stderr, key.slice(split)); }
    catch (error) { if (error.code === 'PERSISTENCE_SECRET_UNSAFE') process.exit(0); throw error; }
    process.exit(1);
  `;
  const output = execFileSync('/bin/sh', ['-c', '"$1" --input-type=module -e "$2" 2>&1 | cat', 'q-core-pipe-test', process.execPath, script], { encoding: 'utf8' });
  assert.equal(output, key.slice(0, Math.floor(key.length / 2)));
});

test('decoding keeps ordinary Unicode, JSON and hashes unchanged', t => {
  const root = directory(t), file = join(root, 'ordinary.json');
  const value = JSON.stringify({ text: 'Звичайний результат', sha256: 'a5'.repeat(32), percent: '100%', path: 'C:\\work\\normal' });
  guardedWriteFileSync(file, value);
  assert.equal(readFileSync(file, 'utf8'), value);
  assert.doesNotThrow(() => assertNoSecretShapes(Buffer.from(value)));
});

test('short registered credentials also receive hex decoding protection', t => {
  const root = directory(t), file = join(root, 'short.txt');
  const credential = ['tiny', '9'].join('');
  registerPersistenceSecret(credential);
  assert.throws(() => guardedWriteFileSync(file, Buffer.from(credential).toString('hex')), { code: 'PERSISTENCE_SECRET_UNSAFE' });
  assert.equal(existsSync(file), false);
});
