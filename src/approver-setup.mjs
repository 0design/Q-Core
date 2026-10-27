import childProcess from 'node:child_process';
import { randomBytes, verify } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readSync } from 'node:fs';
import tty from 'node:tty';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hash, insist } from './contracts.mjs';
import { approverDirectory, touchIdHelper, touchIdEnvironment, P256ApprovalAnchor, loadApprovalAnchor,
  canonicalApprovalPayload, canonicalRegistrationPayload } from './approval-anchor.mjs';
import { guardedMkdirSync, guardedWriteFileSync, guardedUnlinkSync, guardedStreamWrite } from './persistence.mjs';
import { withApproverEnrollmentWrites, touchIdKeyDirectory } from './approver-write-boundary.mjs';

function confirmRegistration(operation) {
  insist(tty.isatty(process.stdin.fd) && tty.isatty(process.stdout.fd),
    'Approver changes require an interactive TTY.', 'HUMAN_CONFIRMATION_REQUIRED');
  const expected = `${operation} touchid`;
  guardedStreamWrite(process.stderr, `Type "${expected}" to ${operation} the Touch ID approver: `);
  const byte = Buffer.alloc(1);
  let answer = '';
  while (answer.length <= 64 && readSync(process.stdin.fd, byte, 0, 1, null) === 1) {
    if (byte[0] === 10) break;
    answer += byte.toString('utf8');
  }
  insist(answer.replace(/\r$/, '') === expected,
    'Approver change was not confirmed at the terminal.', 'HUMAN_CONFIRMATION_REQUIRED');
}

function safePath(path) {
  if (existsSync(path)) insist(!lstatSync(path).isSymbolicLink(), 'Unsafe Touch ID setup destination.');
}

function withSetupLock(callback) {
  const dir = approverDirectory();
  for (const path of [dirname(dir), dir, dirname(touchIdHelper()), touchIdHelper()]) safePath(path);
  guardedMkdirSync(dir, { recursive: true, mode: 0o700 });
  const lock = join(dir, 'setup.lock');
  guardedWriteFileSync(lock, '', { flag: 'wx', mode: 0o600 });
  try { return callback(join(dir, 'touchid.json')); }
  finally { guardedUnlinkSync(lock); }
}

function helper(command, input) {
  return JSON.parse(childProcess.execFileSync(touchIdHelper(), [command], {
    input, encoding: 'utf8', timeout: 120_000, maxBuffer: 65_536, env: touchIdEnvironment(),
  }));
}

/** Only the exact interactive CLI command calls enrollment. No supplied key/path. */
export function addTouchIdApprover() {
  confirmRegistration('add');
  insist(process.platform === 'darwin', 'Touch ID approval requires macOS.', 'TOUCH_ID_UNAVAILABLE');
  return withApproverEnrollmentWrites(() => withSetupLock(registration => {
    const previous = existsSync(registration) ? readFileSync(registration, 'utf8') : null;
    const oldAnchor = previous === null ? null : loadApprovalAnchor();
    const source = fileURLToPath(new URL('../tools/touchid-approve/main.swift', import.meta.url));
    childProcess.execFileSync('/usr/bin/swiftc', [source, '-o', touchIdHelper()], {
      encoding: 'utf8', timeout: 120_000, maxBuffer: 1_048_576, env: touchIdEnvironment(),
    });
    const nonce = randomBytes(32).toString('hex');
    const result = helper('setup', JSON.stringify({ nonce }));
    const anchor = new P256ApprovalAnchor('touchid', result.public_key);
    insist(typeof result.signature === 'string' &&
      verify('sha256', Buffer.from(canonicalRegistrationPayload(result.public_key, nonce)),
        anchor.publicKey, Buffer.from(result.signature, 'base64')),
    'The new Touch ID key must sign this registration.', 'INVALID_ANCHOR_SIGNATURE');
    const record = { id: 'touchid', public_key: result.public_key };
    if (oldAnchor && JSON.parse(previous).public_key !== record.public_key) {
      const payload = { run_id: 'q-core-approver-registration', gate_id: 'replace-touchid',
        content_hash: hash(record), decision: 'approve', nonce: randomBytes(32).toString('hex'), issued_at: new Date().toISOString() };
      const signed = helper('approve', canonicalApprovalPayload(payload));
      insist(oldAnchor.verify({ payload, signature: signed.signature }),
        'Replacement requires the currently registered Touch ID key signature; use q-core approver remove touchid in an interactive TTY for recovery.',
        'INVALID_ANCHOR_SIGNATURE');
    }
    // Recheck the registration before any write, including after native prompts.
    insist((existsSync(registration) ? readFileSync(registration, 'utf8') : null) === previous,
      'Approver registration changed during setup.', 'INVALID_APPROVAL_ANCHOR');
    if (previous !== null && JSON.parse(previous).public_key === record.public_key)
      return { id: 'touchid', registered: true, existing: true };
    guardedWriteFileSync(registration, JSON.stringify(record) + '\n', {
      flag: previous === null ? 'wx' : 'w', mode: 0o600, receipt: record, failOnRedaction: true,
    });
    return { id: 'touchid', registered: true, existing: false };
  }));
}

/** Explicit terminal recovery; never available through MCP/config/tool arguments. */
export function removeTouchIdApprover() {
  confirmRegistration('remove');
  return withApproverEnrollmentWrites(() => withSetupLock(registration => {
    const keyDir = touchIdKeyDirectory(), blob = join(keyDir, 'enclave-key');
    for (const path of [registration, keyDir, blob]) safePath(path);
    if (existsSync(blob)) guardedUnlinkSync(blob);
    if (existsSync(registration)) guardedUnlinkSync(registration);
    return { id: 'touchid', registered: false };
  }));
}
