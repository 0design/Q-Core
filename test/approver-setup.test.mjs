import assert from 'node:assert/strict';
import test from 'node:test';
import childProcess from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import { join, resolve } from 'node:path';
import { addTouchIdApprover } from '../src/approver-setup.mjs';

// No native enrollment or authentication is invoked by these setup tests.
test('setup builds the bundled helper and stores only its public key', t => {
  if (process.platform !== 'darwin') return t.skip('Touch ID enrollment requires macOS.');
  const dir = mkdtempSync(join(os.tmpdir(), 'q-core-enrollment-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  t.mock.method(os, 'homedir', () => dir);
  const { publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const publicPem = publicKey.export({ type: 'spki', format: 'pem' });
  const helper = join(dir, '.q-core', 'approvers', 'touchid-approve');
  const calls = [];
  t.mock.method(childProcess, 'execFileSync', (command, args) => {
    calls.push({ command, args });
    if (command === '/usr/bin/swiftc') {
      assert.equal(args[0], resolve('tools/touchid-approve/main.swift'));
      assert.deepEqual(args.slice(1), ['-o', helper]);
      return '';
    }
    assert.equal(command, helper);
    assert.deepEqual(args, ['setup']);
    return JSON.stringify({ public_key: publicPem });
  });
  assert.deepEqual(addTouchIdApprover(), { id: 'touchid', registered: true, existing: false });
  assert.deepEqual(JSON.parse(readFileSync(join(dir, '.q-core', 'approvers', 'touchid.json'), 'utf8')),
    { id: 'touchid', public_key: publicPem });
  assert.equal(calls.length, 2);
  assert.deepEqual(addTouchIdApprover(), { id: 'touchid', registered: true, existing: true });
  assert.equal(calls.length, 2, 'existing registration is never silently replaced');
});

test('approver CLI refuses supplied keys and unsupported transports before enrollment', () => {
  for (const args of [
    ['approver', 'add', 'touchid', '--public-key', 'forged'],
    ['approver', 'add', 'telegram'],
    ['approver', 'add', 'software'],
  ]) {
    const result = childProcess.spawnSync(process.execPath, [resolve('bin/q-core.mjs'), ...args], { encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /Usage: q-core approver add touchid/);
  }
});
