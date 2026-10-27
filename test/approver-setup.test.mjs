import assert from 'node:assert/strict';
import test from 'node:test';
import childProcess from 'node:child_process';
import { generateKeyPairSync, sign } from 'node:crypto';
import fs, { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import tty from 'node:tty';
import { join, resolve } from 'node:path';
import { addTouchIdApprover, removeTouchIdApprover } from '../src/approver-setup.mjs';
import { canonicalApprovalPayload, canonicalRegistrationPayload, loadApprovalAnchor, touchIdHelper } from '../src/approval-anchor.mjs';

const keyPair = () => {
  const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  return { ...pair, publicPem: pair.publicKey.export({ type: 'spki', format: 'pem' }) };
};
const signature = (bytes, key) => sign('sha256', Buffer.from(bytes), key.privateKey).toString('base64');

// Test-only terminal and software signatures; never enroll or authenticate natively.
function fixture(t) {
  const dir = mkdtempSync(join(os.tmpdir(), 'q-core-enrollment-'));
  const account = os.userInfo(), key = keyPair();
  const f = { dir, key, calls: [], answer: 'add touchid\n', registration: join(dir, '.q-core', 'approvers', 'touchid.json') };
  t.mock.method(os, 'userInfo', () => ({ ...account, homedir: dir }));
  t.mock.method(tty, 'isatty', () => true);
  const originalRead = fs.readSync;
  t.mock.method(fs, 'readSync', (fd, buffer, ...args) => {
    if (fd !== process.stdin.fd) return originalRead(fd, buffer, ...args);
    if (!f.answer) return 0;
    buffer[0] = f.answer.charCodeAt(0);
    f.answer = f.answer.slice(1);
    return 1;
  });
  syncBuiltinESMExports();
  t.mock.method(process.stderr, 'write', () => true);
  f.setup = nonce => ({ public_key: key.publicPem, signature: signature(canonicalRegistrationPayload(key.publicPem, nonce), key) });
  f.approve = payload => ({ signature: signature(canonicalApprovalPayload(payload), key) });
  t.mock.method(childProcess, 'execFileSync', (command, args, options) => {
    f.calls.push({ command, args, options });
    assert.deepEqual(options.env, { HOME: dir, PATH: '/usr/bin:/bin' }, 'caller env cannot redirect compilation or key storage');
    if (command === '/usr/bin/swiftc') {
      assert.deepEqual(args, [resolve('tools/touchid-approve/main.swift'), '-o', touchIdHelper()]);
      return '';
    }
    assert.equal(command, resolve('tools/touchid-approve/touchid-approve'));
    const payload = JSON.parse(options.input);
    if (args[0] === 'setup') {
      assert.deepEqual(Object.keys(payload), ['nonce']);
      assert.match(payload.nonce, /^[a-f0-9]{64}$/);
      return JSON.stringify(f.setup(payload.nonce));
    }
    assert.deepEqual(args, ['approve']);
    return JSON.stringify(f.approve(payload));
  });
  f.register = publicPem => {
    mkdirSync(join(dir, '.q-core', 'approvers'), { recursive: true });
    writeFileSync(f.registration, JSON.stringify({ id: 'touchid', public_key: publicPem }) + '\n');
  };
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); rmSync(dir, { recursive: true, force: true }); });
  return f;
}

function macOnly(t) {
  if (process.platform === 'darwin') return false;
  t.skip('Touch ID enrollment requires macOS.');
  return true;
}

test('interactive setup verifies a fresh new-key signature and stores only the public key', t => {
  if (macOnly(t)) return;
  const f = fixture(t);
  assert.deepEqual(addTouchIdApprover(), { id: 'touchid', registered: true, existing: false });
  assert.deepEqual(JSON.parse(readFileSync(f.registration, 'utf8')), { id: 'touchid', public_key: f.key.publicPem });
  const firstNonce = JSON.parse(f.calls[1].options.input).nonce;
  f.answer = 'add touchid\n';
  assert.deepEqual(addTouchIdApprover(), { id: 'touchid', registered: true, existing: true });
  assert.notEqual(JSON.parse(f.calls[3].options.input).nonce, firstNonce, 'existing enrollment also needs a fresh presence proof');
});

for (const kind of ['missing signature', 'wrong key', 'replayed nonce', 'changed public key']) {
  test(`setup refuses ${kind} before storing a registration`, t => {
    if (macOnly(t)) return;
    const f = fixture(t), other = keyPair();
    f.setup = nonce => {
      const bytes = canonicalRegistrationPayload(f.key.publicPem, kind === 'replayed nonce' ? '0'.repeat(64) : nonce);
      return { public_key: kind === 'changed public key' ? other.publicPem : f.key.publicPem,
        ...(kind === 'missing signature' ? {} : { signature: signature(bytes, kind === 'wrong key' ? other : f.key) }) };
    };
    assert.throws(() => addTouchIdApprover(), /must sign this registration/);
    assert.equal(existsSync(f.registration), false);
  });
}

test('replacement with only the new-key signature is refused and preserves the old registration', t => {
  if (macOnly(t)) return;
  const f = fixture(t), old = keyPair();
  f.register(old.publicPem);
  const before = readFileSync(f.registration, 'utf8');
  assert.throws(() => addTouchIdApprover(), /currently registered Touch ID key signature/);
  assert.equal(readFileSync(f.registration, 'utf8'), before);
  assert.equal(f.calls.at(-1).args[0], 'approve');
});

test('replacement requires both signatures bound to the new registration', t => {
  if (macOnly(t)) return;
  const f = fixture(t), old = keyPair();
  f.register(old.publicPem);
  f.approve = payload => ({ signature: signature(canonicalApprovalPayload(payload), old) });
  assert.equal(addTouchIdApprover().registered, true);
  assert.equal(JSON.parse(readFileSync(f.registration)).public_key, f.key.publicPem);
});

test('add and remove refuse noninteractive TTY and unconfirmed terminal input before any helper invocation', t => {
  const f = fixture(t);
  t.mock.method(tty, 'isatty', () => false);
  for (const operation of [addTouchIdApprover, removeTouchIdApprover]) assert.throws(operation, /interactive TTY/);
  t.mock.method(tty, 'isatty', () => true);
  f.answer = 'yes\n';
  assert.throws(addTouchIdApprover, /not confirmed/);
  f.answer = 'add touchid\n';
  assert.throws(removeTouchIdApprover, /not confirmed/);
  assert.equal(f.calls.length, 0);
  assert.equal(existsSync(f.registration), false);
});

test('explicit interactive remove clears registration and native enrollment for recovery', t => {
  const f = fixture(t);
  f.register(f.key.publicPem);
  const native = join(f.dir, 'Library', 'Application Support', 'q-core-touchid-approve', 'enclave-key');
  mkdirSync(join(native, '..'), { recursive: true });
  writeFileSync(native, 'synthetic wrapped key');
  f.answer = 'remove touchid\n';
  assert.deepEqual(removeTouchIdApprover(), { id: 'touchid', registered: false });
  assert.equal(existsSync(native), false);
  assert.equal(existsSync(f.registration), false);
  assert.equal(f.calls.length, 0);
});

test('HOME and helper/key environment overrides cannot redirect the trusted registration or helper', t => {
  const f = fixture(t), other = keyPair();
  f.register(f.key.publicPem);
  const forged = join(f.dir, 'forged');
  mkdirSync(join(forged, '.q-core', 'approvers'), { recursive: true });
  writeFileSync(join(forged, '.q-core', 'approvers', 'touchid.json'), JSON.stringify({ id: 'touchid', public_key: other.publicPem }));
  const vars = { HOME: forged, CFFIXED_USER_HOME: forged, Q_CORE_HOME: forged,
    Q_CORE_APPROVER_KEY: other.publicPem, Q_CORE_TOUCHID_HELPER: '/tmp/forged-helper', TOUCHID_HELPER: '/tmp/forged-helper' };
  const previous = Object.fromEntries(Object.keys(vars).map(key => [key, process.env[key]]));
  Object.assign(process.env, vars);
  t.after(() => { for (const [key, value] of Object.entries(previous)) value === undefined ? delete process.env[key] : process.env[key] = value; });
  t.mock.method(os, 'homedir', () => forged);
  const payload = { run_id: 'test', gate_id: 'test', content_hash: '0'.repeat(64), decision: 'approve', nonce: '1'.repeat(64), issued_at: new Date().toISOString() };
  assert.equal(loadApprovalAnchor().verify({ payload, signature: signature(canonicalApprovalPayload(payload), other) }), false);
  assert.equal(loadApprovalAnchor().verify({ payload, signature: signature(canonicalApprovalPayload(payload), f.key) }), true);
  assert.equal(touchIdHelper(), resolve('tools/touchid-approve/touchid-approve'));
  if (process.platform === 'darwin') assert.equal(addTouchIdApprover().existing, true);
});

test('approver CLI refuses supplied keys, helper paths, swaps, unsupported commands and piped enrollment/removal', () => {
  for (const args of [
    ['approver', 'add', 'touchid', '--public-key', 'forged'],
    ['approver', 'add', 'touchid', '--helper', '/tmp/forged'],
    ['approver', 'add', 'touchid', '--replace'],
    ['approver', 'register', 'touchid'],
    ['approver', 'replace', 'touchid'],
    ['approver', 'add', 'telegram'],
    ['approver', 'add', 'software'],
    ['approver', 'remove', 'touchid', '--force'],
    ['approver', 'add', 'touchid'],
    ['approver', 'remove', 'touchid'],
  ]) {
    const result = childProcess.spawnSync(process.execPath, [resolve('bin/q-core.mjs'), ...args], {
      encoding: 'utf8', input: 'add touchid\nremove touchid\n',
      env: { ...process.env, Q_CORE_TOUCHID_HELPER: '/tmp/forged', Q_CORE_APPROVER_KEY: 'forged' },
    });
    assert.equal(result.status, 1, args.join(' '));
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /Usage: q-core approver add touchid|interactive TTY/);
  }
});
