import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { guardedDurableReplaceSync, registerPersistenceSecret } from '../src/persistence.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(join(tmpdir(), 'qf-durable-fixture-')), file = join(root, 'state.json');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(file, 'before');
  return { root, file };
}
test('durable authority replacement writes exact bytes privately and leaves no temp', t => {
  const { root, file } = fixture(t);
  guardedDurableReplaceSync(file, 'after');
  assert.equal(fs.readFileSync(file, 'utf8'), 'after');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(root), ['state.json']);
});
test('authority secret filtering refuses rather than redacts a signed decision', t => {
  const { root, file } = fixture(t);
  const secret = 'disposable-authority-secret-ABC123456789'; registerPersistenceSecret(secret);
  assert.throws(() => guardedDurableReplaceSync(file, secret));
  assert.equal(fs.readFileSync(file, 'utf8'), 'before');
  assert.deepEqual(fs.readdirSync(root), ['state.json']);
});
test('symlink target, hardlink target and symlink parent are refused', t => {
  const { root, file } = fixture(t), other = join(root, 'other.json'), alias = join(root, 'alias');
  fs.writeFileSync(other, 'outside'); fs.unlinkSync(file); fs.symlinkSync(other, file);
  assert.throws(() => guardedDurableReplaceSync(file, 'unsafe'));
  assert.equal(fs.readFileSync(other, 'utf8'), 'outside');
  fs.unlinkSync(file); fs.linkSync(other, file);
  assert.throws(() => guardedDurableReplaceSync(file, 'unsafe'));
  fs.symlinkSync(root, alias);
  assert.throws(() => guardedDurableReplaceSync(join(alias, 'new.json'), 'unsafe'));
});
for (const stage of ['file', 'directory']) test(`flush failure at ${stage} has the documented commit boundary`, t => {
  const { root, file } = fixture(t), original = fs.fsyncSync; let calls = 0;
  fs.fsyncSync = fd => { calls++; if (calls === (stage === 'file' ? 1 : 2)) throw Object.assign(Error('fixture flush failure'), { code: 'EIO' }); return original(fd); };
  syncBuiltinESMExports();
  try { assert.throws(() => guardedDurableReplaceSync(file, 'after'), /fixture flush failure/); }
  finally { fs.fsyncSync = original; syncBuiltinESMExports(); }
  assert.equal(fs.readFileSync(file, 'utf8'), stage === 'file' ? 'before' : 'after');
  assert.deepEqual(fs.readdirSync(root), ['state.json']);
});
