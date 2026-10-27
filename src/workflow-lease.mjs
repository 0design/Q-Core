/** Shared lease for the shipped manifest workflow writers. Library code that
 * deliberately edits unsigned state as the same OS user is outside this lock.
 * An interrupted lease is held for explicit reconciliation, never time-evicted.
 */
import { lstatSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { insist } from './contracts.mjs';
import { lockWorkspace } from './workspace.mjs';

export function acquireWorkflowLease(file) {
  const stat = lstatSync(file);
  insist(stat.isFile() && !stat.isSymbolicLink(), 'Workflow lease requires a plain manifest file', 'SCOPE_DENIED');
  const root = dirname(realpathSync(file)), claim = join(root, '.qf', 'remote-human-recovery.lock');
  const noRepair = () => {
    let present = true;
    try { lstatSync(claim); } catch (error) { if (error.code === 'ENOENT') present = false; else throw error; }
    insist(!present, 'An interrupted human recovery still holds this workflow', 'WORKSPACE_LOCKED');
  };
  noRepair();
  const lease = lockWorkspace(root, 'workflow.lock');
  try { noRepair(); return lease; }
  catch (error) { lease.release(); throw error; }
}

export async function withWorkflowLease(file, operation) {
  const lease = acquireWorkflowLease(file);
  try { return await operation(); }
  finally { lease.release(); }
}
