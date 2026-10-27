/** Shared lease for the shipped manifest workflow writers. Library code that
 * deliberately edits unsigned state as the same OS user is outside this lock.
 * An interrupted lease is held for explicit reconciliation, never time-evicted.
 */
import { lstatSync, realpathSync } from 'node:fs';
import { dirname } from 'node:path';
import { insist } from './contracts.mjs';
import { lockWorkspace } from './workspace.mjs';

export function acquireWorkflowLease(file) {
  const stat = lstatSync(file);
  insist(stat.isFile() && !stat.isSymbolicLink(), 'Workflow lease requires a plain manifest file', 'SCOPE_DENIED');
  return lockWorkspace(dirname(realpathSync(file)), 'workflow.lock');
}

export async function withWorkflowLease(file, operation) {
  const lease = acquireWorkflowLease(file);
  try { return await operation(); }
  finally { lease.release(); }
}
