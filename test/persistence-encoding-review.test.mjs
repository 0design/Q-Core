import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, readSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { guardedStreamWrite, guardedWriteFileSync, registerPersistenceSecret } from '../src/persistence.mjs';
import { assertNoDecodedSecrets } from '../src/secret-decoding.mjs';
import { assertNoSecretShapes } from '../scripts/check-no-secrets-in-artifacts.mjs';

const key = ['sk', 'ant', 'round3', 'synthetic', 'q7_'.repeat(16)].join('-');
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
  'HTML decimal numeric entities': value => [...value].map(char => `&#${char.codePointAt(0)};`).join(''),
  'HTML hexadecimal numeric entities': value => [...value].map(char => `&#x${char.codePointAt(0).toString(16)};`).join(''),
  'HTML numeric entities without semicolons': value => [...value].map(char => `&#${char.codePointAt(0)}`).join(''),
  'HTML named entities': value => value.replaceAll('_', '&lowbar;'),
  'nested HTML named entities': value => value.replaceAll('_', '&amp;lowbar;'),
  'JSON byte array': value => JSON.stringify([...Buffer.from(value)]),
  'JSON byte array in a string': value => JSON.stringify({ bytes: JSON.stringify([...Buffer.from(value)]) }),
  'JavaScript hex escapes': value => [...Buffer.from(value)].map(byte => `\\x${byte.toString(16).padStart(2, '0')}`).join(''),
  'JavaScript Unicode escapes': value => [...value].map(char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`).join(''),
  'JavaScript code-point escapes': value => [...value].map(char => `\\u{${char.codePointAt(0).toString(16)}}`).join(''),
  'mixed HTML, byte-array and JS escapes': value => [...value].map((char, i) => i % 3 === 0
    ? `&#${char.codePointAt(0)};`
    : i % 3 === 1 ? `[${Buffer.from(char).join(',')}]` : `\\x${char.charCodeAt(0).toString(16).padStart(2, '0')}`).join(''),
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
      assert.throws(() => guardedWriteFileSync(file, JSON.stringify({ error: payload }), { failOnRedaction: true }), { code: 'PERSISTENCE_SECRET_UNSAFE' });
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

for (const [label, encode] of [['raw', value => value], ...Object.entries(encodings)]) {
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

for (const [label, encode] of Object.entries(encodings).filter(([label]) => /HTML|JSON byte|JavaScript|mixed/.test(label))) {
  test(`${label}: redirected stdout/stderr does not emit the review payload`, () => {
    const script = `
      import { guardedStreamWrite, registerPersistenceSecret } from ${JSON.stringify(new URL('../src/persistence.mjs', import.meta.url).href)};
      registerPersistenceSecret(${JSON.stringify(key)});
      try { guardedStreamWrite(process.stdout, ${JSON.stringify(encode(key))}); }
      catch (error) { if (error.code === 'PERSISTENCE_SECRET_UNSAFE') process.exit(0); throw error; }
      process.exit(${label === 'JavaScript Unicode escapes' ? 0 : 1});
    `;
    const output = execFileSync('/bin/bash', ['-o', 'pipefail', '-c', '"$1" --input-type=module -e "$2" 2>&1 | cat', 'q-core-encoded-pipe-test', process.execPath, script], { encoding: 'utf8' });
    assert.equal(output, label === 'JavaScript Unicode escapes' ? '[REDACTED]' : '');
  });
}

test('new decoding forms are subject to the shared nesting budget', () => {
  const html = '&' + 'amp;'.repeat(8) + 'lowbar;';
  assert.throws(() => assertNoDecodedSecrets(html, () => false), { code: 'SECRET_DECODE_BUDGET' });
  let javascript = String.raw`\x41`;
  for (let level = 0; level < 8; level++) javascript = javascript.replaceAll('\\', String.raw`\x5c`);
  assert.throws(() => assertNoDecodedSecrets(javascript, () => false), { code: 'SECRET_DECODE_BUDGET' });
  let bytes = 'ordinary';
  for (let level = 0; level < 8; level++) bytes = JSON.stringify([...Buffer.from(bytes)]);
  assert.throws(() => assertNoDecodedSecrets(bytes, () => false), { code: 'SECRET_DECODE_BUDGET' });
});

test('HTML5 names, numeric replacement rules and JavaScript Unicode scalar forms are decoded for checking', () => {
  for (const [encoded, expected] of [
    ['&CounterClockwiseContourIntegral;', '∳'], ['&fjlig;', 'fj'], ['&NotEqualTilde;', '≂̸'],
    ['&ampX', '&X'], ['&copy', '©'], ['&#x1f680;', '🚀'], ['&#128;', '€'], ['&#0;', '�'],
    ['&#xD800;', '�'], ['&#x110000;', '�'], [String.raw`\u{1f680}`, '🚀'],
    [String.raw`\uD83D\uDE80`, '🚀'], [String.raw`\u{000000000073}`, 's'],
    ['[1.15e2,107,45]', 'sk-'],
  ]) {
    assert.throws(() => assertNoDecodedSecrets(encoded, text => text === expected), { code: 'SECRET_DECODE_MATCH' });
  }
});

for (const credential of ['ABC&amp;DEF', 'ABC%41DEF', 'ABC[65,66]DEF']) {
  test(`selective nested decoding preserves literal syntax in a registered credential (${credential.includes('&') ? 'HTML' : credential.includes('%') ? 'percent' : 'JSON array'})`, t => {
    const root = directory(t), file = join(root, 'literal-syntax.txt');
    registerPersistenceSecret(credential);
    let encoded = credential.replace('A', String.raw`\x41`);
    for (let depth = 0; depth < 3; depth++) {
      assert.throws(() => assertNoDecodedSecrets(encoded, text => text.includes(credential)), { code: 'SECRET_DECODE_MATCH' });
      assert.throws(() => guardedWriteFileSync(file, encoded), { code: 'PERSISTENCE_SECRET_UNSAFE' });
      assert.equal(existsSync(file), false);
      encoded = encoded.replaceAll('\\', String.raw`\x5c`);
    }
  });
}

test('malformed or unsupported escape forms and non-byte arrays remain ordinary data', t => {
  const root = directory(t), file = join(root, 'ordinary-encodings.txt');
  const value = [
    '&unknown; &hyphen &COPYcat; &#x; &#;', String.raw`\xG0 \u{110000} \u{xyz} \u123`,
    '[256,1] [-1,1] [1.5,2] ["115",107] [115,,107] [01,107]',
    'Valid text: &amp; &copy; &#x1f680; [72,101,108,108,111] ' + String.raw`\x48\u0069\u{21}`,
  ].join('\n');
  guardedWriteFileSync(file, value);
  assert.equal(readFileSync(file, 'utf8'), value);
  assert.doesNotThrow(() => assertNoSecretShapes(Buffer.from(value)));
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
