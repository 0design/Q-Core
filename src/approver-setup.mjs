import childProcess from 'node:child_process';
import { existsSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { insist } from './contracts.mjs';
import { approverDirectory, touchIdHelper, P256ApprovalAnchor, loadApprovalAnchor } from './approval-anchor.mjs';
import { guardedMkdirSync, guardedWriteFileSync, guardedUnlinkSync } from './persistence.mjs';

/** Enroll only the public key returned by the bundled Secure Enclave helper. */
export function addTouchIdApprover() {
  insist(process.platform === 'darwin', 'Touch ID approval requires macOS.', 'TOUCH_ID_UNAVAILABLE');
  const dir = approverDirectory(), registration = join(dir, 'touchid.json');
  if (existsSync(registration)) {
    loadApprovalAnchor();
    return { id: 'touchid', registered: true, existing: true };
  }
  // Refuse symlinks before asking the compiler to write an executable.
  const parent = join(dir, '..');
  for (const path of [parent, dir, touchIdHelper()]) if (existsSync(path)) {
    insist(!lstatSync(path).isSymbolicLink(), 'Unsafe Touch ID setup destination.');
  }
  guardedMkdirSync(dir, { recursive: true, mode: 0o700 });
  const lock = join(dir, 'setup.lock');
  guardedWriteFileSync(lock, '', { flag: 'wx', mode: 0o600 });
  try {
    const source = fileURLToPath(new URL('../tools/touchid-approve/main.swift', import.meta.url));
    childProcess.execFileSync('/usr/bin/swiftc', [source, '-o', touchIdHelper()], {
      encoding: 'utf8', timeout: 120_000, maxBuffer: 1_048_576,
    });
    const result = JSON.parse(childProcess.execFileSync(touchIdHelper(), ['setup'], {
      encoding: 'utf8', timeout: 120_000, maxBuffer: 65_536,
    }));
    new P256ApprovalAnchor('touchid', result.public_key);
    const record = { id: 'touchid', public_key: result.public_key };
    guardedWriteFileSync(registration, JSON.stringify(record) + '\n', {
      flag: 'wx', mode: 0o600, receipt: record, failOnRedaction: true,
    });
    return { id: 'touchid', registered: true, existing: false };
  } finally { guardedUnlinkSync(lock); }
}
