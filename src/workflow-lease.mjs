/** Shared lease for the shipped manifest workflow writers. Library code that
 * deliberately edits unsigned state as the same OS user is outside this lock.
 * An interrupted lease is held for explicit reconciliation, never time-evicted.
 */
import { lstatSync, realpathSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { insist } from './contracts.mjs';
import { lockWorkspace } from './workspace.mjs';

export const WORKFLOW_RECOVERY_PREFIX = 'remote-human-recovery-claim-';
export function workflowRecoveryClaims(root) {
  const dir = join(root, '.qf');
  try {
    const info = lstatSync(dir);
    insist(info.isDirectory() && !info.isSymbolicLink(), 'Unsafe workflow state directory', 'SCOPE_DENIED');
    return readdirSync(dir).filter(name => name === 'remote-human-recovery.lock' || name.startsWith(WORKFLOW_RECOVERY_PREFIX)).sort();
  } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}

export function acquireWorkflowLease(file) {
  const stat = lstatSync(file);
  insist(stat.isFile() && !stat.isSymbolicLink(), 'Workflow lease requires a plain manifest file', 'SCOPE_DENIED');
  const root = dirname(realpathSync(file));
  const noRepair = () => insist(workflowRecoveryClaims(root).length === 0,
    'An interrupted human recovery still holds this workflow', 'WORKSPACE_LOCKED');
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
