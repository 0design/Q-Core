import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import test from 'node:test';
import { guardedWriteFileSync, registerPersistenceSecret } from '../src/persistence.mjs';
import { assertNoDecodedSecrets, MAX_SECRET_RECORD_BYTES } from '../src/secret-decoding.mjs';

// Generated here, rather than copied from a third-party feed. Each item has
// unique hashes and base64 tokens: deduplicating a repeated short paragraph
// must not make the large-document regression pass accidentally.
function syntheticFeed(size) {
  const items = ['<?xml version="1.0"?><rss><channel>'];
  let length = items[0].length;
  for (let index = 0; length < size; index++) {
    const hash = createHash('sha256').update(`ordinary-feed-item-${index}`).digest('hex');
    const token = Buffer.from(`ordinary-content-${index}-${hash}`).toString('base64');
    const item = `<item id="${index}"><title>Item &amp; &#38; &#x26; ${index}</title>`
      + `<link>https:\\/\\/example.invalid\\/articles\\/${index}?q=%3Ctitle%3E&amp;nested=%252F&amp;page=${index}</link>`
      + `<description><![CDATA[<p class="summary" data-label="quoted \\"text\\"">`
      + `Ordinary article ${index}; escaped path \\/images\\/cover; &#x2f; &#47; &quot; &copy; &amp;copy; `
      + String.raw`safe JS \x48\u0069\u{21}; `
      + `safe bytes [72,101,108,108,111]; token ${token}; checksum ${hash}.`
      + '</p>]]></description></item>\n';
    items.push(item);
    length += item.length;
  }
  return items.join('').slice(0, size);
}

const key = ['sk', 'ant', 'large-record-synthetic', 'q7_'.repeat(12)].join('-');
const percent = value => [...Buffer.from(value)].map(byte => `%${byte.toString(16).padStart(2, '0')}`).join('');
const encodings = {
  raw: value => value,
  hex: value => Buffer.from(value).toString('hex'),
  'hex with adjacent offset prefix': value => 'a' + Buffer.from('x' + value).toString('hex'),
  base64: value => Buffer.from(value).toString('base64'),
  'base64 with encoded prefix': value => Buffer.from('x' + value).toString('base64'),
  'base64 with adjacent offset prefix': value => 'prefix' + Buffer.from('xx' + value).toString('base64'),
  'base64url with adjacent offset prefix': value => 'abc' + Buffer.from('x' + value).toString('base64url'),
  'MIME-wrapped base64': value => Buffer.from('x' + value).toString('base64').match(/.{1,20}/g).join('\r\n'),
  percent,
  'double percent': value => percent(percent(value)),
  'nested base64, percent and hex': value => Buffer.from(percent(Buffer.from(value).toString('hex'))).toString('base64'),
  'HTML decimal entities': value => [...value].map(char => `&#${char.codePointAt(0)};`).join(''),
  'HTML hexadecimal entities': value => [...value].map(char => `&#x${char.codePointAt(0).toString(16)};`).join(''),
  'HTML numeric entities without semicolons': value => [...value].map(char => `&#${char.codePointAt(0)}`).join(''),
  'HTML named entities': value => value.replaceAll('_', '&lowbar;'),
  'nested HTML named entities': value => value.replaceAll('_', '&amp;lowbar;'),
  'JSON byte array': value => JSON.stringify([...Buffer.from(value)]),
  'JSON byte array in a string': value => JSON.stringify({ bytes: JSON.stringify([...Buffer.from(value)]) }),
  'JavaScript hex escapes': value => [...Buffer.from(value)].map(byte => `\\x${byte.toString(16).padStart(2, '0')}`).join(''),
  'JavaScript Unicode escapes': value => [...value].map(char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`).join(''),
  'JavaScript code-point escapes': value => [...value].map(char => `\\u{${char.codePointAt(0).toString(16)}}`).join(''),
  'mixed HTML, byte-array and hex escapes': value => [...value].map((char, index) => index % 3 === 0
    ? `&#${char.codePointAt(0)};`
    : index % 3 === 1 ? `[${Buffer.from(char).join(',')}]` : `\\x${char.charCodeAt(0).toString(16).padStart(2, '0')}`).join(''),
};
const sizes = [400 * 1024, 2 * 1024 * 1024];
const feeds = new Map(sizes.map(size => [size, syntheticFeed(size)]));
const envelope = text => JSON.stringify({ source: 'synthetic-rss-fixture', text }).replaceAll('/', '\\/');
const directory = t => {
  const root = mkdtempSync(join(tmpdir(), 'q-core-large-records-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
};

for (const [size, feed] of feeds) {
  test(`${size / 1024} KiB synthetic HTML/XML in JSON passes decoding and persistence unchanged`, t => {
    const file = join(directory(t), 'safe.json');
    const body = envelope(feed);
    assert.equal(Buffer.byteLength(feed), size);
    assert.ok(body.includes('\\"') && body.includes('\\/') && body.includes('&amp;') && body.includes('%3C'));
    registerPersistenceSecret(key);
    assert.doesNotThrow(() => assertNoDecodedSecrets(body, decoded => decoded.includes(key)));
    guardedWriteFileSync(file, body, { failOnRedaction: true });
    assert.equal(readFileSync(file, 'utf8'), body);
  });
}

for (const [label, encode] of Object.entries(encodings)) {
  test(`large JSON rejects ${label} credential before create or truncate`, t => {
    const root = directory(t);
    registerPersistenceSecret(key);
    for (const [size, feed] of feeds) {
      // The credential is late in the document, so a prefix-only scan cannot
      // satisfy this test. Keep the rest identical to the safe large fixture.
      const midpoint = Math.floor(feed.length * 0.9);
      const body = envelope(`${feed.slice(0, midpoint)}<credential>${encode(key)}</credential>${feed.slice(midpoint)}`);
      assert.throws(() => assertNoDecodedSecrets(body, decoded => decoded.includes(key)), { code: 'SECRET_DECODE_MATCH' });
      const existing = join(root, `existing-${size}.json`), missing = join(root, `missing-${size}.json`);
      writeFileSync(existing, 'preserve existing bytes');
      for (const file of [existing, missing]) {
        assert.throws(() => guardedWriteFileSync(file, body, { failOnRedaction: true }), { code: 'PERSISTENCE_SECRET_UNSAFE' });
      }
      assert.equal(readFileSync(existing, 'utf8'), 'preserve existing bytes');
      assert.equal(existsSync(missing), false);
    }
  });
}

test('pathological nesting still fails closed and exposes a distinct persistence limit', t => {
  const root = directory(t), existing = join(root, 'existing.json'), missing = join(root, 'missing.json');
  registerPersistenceSecret(key);
  let nested = '%41';
  for (let level = 0; level < 13; level++) nested = nested.replaceAll('%', '%25');
  const body = envelope(`${feeds.get(sizes[0])}<pathological>${nested}</pathological>`);
  assert.throws(() => assertNoDecodedSecrets(body, () => false), { code: 'SECRET_DECODE_BUDGET' });
  writeFileSync(existing, 'preserve existing bytes');
  for (const file of [existing, missing]) {
    assert.throws(() => guardedWriteFileSync(file, body, { failOnRedaction: true }), error => {
      assert.equal(error.code, 'PERSISTENCE_SECRET_DECODE_LIMIT');
      assert.match(error.message, /(?:decod|nest|limit|patholog)/i);
      return true;
    });
  }
  assert.equal(readFileSync(existing, 'utf8'), 'preserve existing bytes');
  assert.equal(existsSync(missing), false);
});

test('record size has a hard 8 MiB cap before candidate matching', t => {
  const root = directory(t), existing = join(root, 'existing.txt'), missing = join(root, 'missing.txt');
  assert.ok(MAX_SECRET_RECORD_BYTES >= 2 * 1024 * 1024);
  const atLimit = '!'.repeat(MAX_SECRET_RECORD_BYTES);
  assert.doesNotThrow(() => assertNoDecodedSecrets(atLimit, () => false));
  let matched = false;
  const oversized = atLimit + '!';
  const isSizeLimit = error => error.code === 'SECRET_DECODE_BUDGET' && /8 MiB size limit/.test(error.message);
  for (const input of [oversized, Buffer.from(oversized)]) {
    assert.throws(() => assertNoDecodedSecrets(input, () => { matched = true; return false; }), isSizeLimit);
  }
  assert.equal(matched, false);
  registerPersistenceSecret(key);
  writeFileSync(existing, 'preserve existing bytes');
  for (const file of [existing, missing]) {
    assert.throws(() => guardedWriteFileSync(file, oversized), { code: 'PERSISTENCE_SECRET_DECODE_LIMIT' });
  }
  assert.equal(readFileSync(existing, 'utf8'), 'preserve existing bytes');
  assert.equal(existsSync(missing), false);
});

test('combinatorial decoding expansion exhausts proportional work and fails before writing', t => {
  // Each individual syntax is shallow, but their full-record combinations
  // would exceed 128 times the input. Stable padding makes that cost visible.
  const unit = '&amp;amp;copy; %252541 ' + String.raw`\x5cx5cx41` + ' [91,54,53,93] ' + '!'.repeat(1024);
  const body = unit.repeat(32);
  assert.throws(() => assertNoDecodedSecrets(body, () => false), error =>
    error.code === 'SECRET_DECODE_BUDGET' && /expansion.*input-proportional work limit/.test(error.message));
  const file = join(directory(t), 'expansion.txt');
  registerPersistenceSecret(key);
  assert.throws(() => guardedWriteFileSync(file, body), { code: 'PERSISTENCE_SECRET_DECODE_LIMIT' });
  assert.equal(existsSync(file), false);
});

test('2 MiB synthetic record decoding completes in under two seconds', t => {
  const body = envelope(feeds.get(2 * 1024 * 1024));
  const start = performance.now();
  assertNoDecodedSecrets(body, decoded => decoded.includes(key));
  const elapsed = performance.now() - start;
  t.diagnostic(`2 MiB HTML/XML (${Buffer.byteLength(body)} JSON bytes) decoded in ${elapsed.toFixed(1)} ms`);
  assert.ok(elapsed < 2000, `2 MiB decoding took ${elapsed.toFixed(1)} ms (limit 2000 ms)`);
});
