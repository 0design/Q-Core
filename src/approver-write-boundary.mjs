import { lstatSync, statSync, readdirSync, readlinkSync, fstatSync } from 'node:fs';
import os from 'node:os';
import { dirname, isAbsolute, join, parse, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CoreError } from './contracts.mjs';

// Trust locations belong to the OS account and installed package, never to a
// workflow, tool argument, HOME override, or user-supplied configuration.
export const approverDirectory = () => join(os.userInfo().homedir, '.q-core', 'approvers');
export const touchIdKeyDirectory = () => join(os.userInfo().homedir, 'Library', 'Application Support', 'q-core-touchid-approve');
export const bundledTouchIdDirectory = () => fileURLToPath(new URL('../tools/touchid-approve/', import.meta.url));

let enrollmentWrites = 0;

/** Only the explicit, human-confirmed synchronous enrollment/removal path uses
 * this capability. It is not exposed by any CLI, MCP, or workflow arguments. */
export function withApproverEnrollmentWrites(callback) {
  enrollmentWrites++;
  try {
    const result = callback();
    if (result && typeof result.then === 'function') throw new TypeError('Enrollment writes must be synchronous.');
    return result;
  } finally { enrollmentWrites--; }
}

const refused = () => new CoreError('APPROVER_WRITE_REFUSED', 'Q-Core cannot modify approver registration, key storage, or the bundled Touch ID helper through this interface. Use q-core approver add touchid or approver remove touchid in an interactive terminal.');
const inside = (root, target) => target === root || target.startsWith(root + sep);
const absent = error => ['ENOENT', 'ENOTDIR'].includes(error?.code);
const roots = () => [approverDirectory(), touchIdKeyDirectory(), bundledTouchIdDirectory()].map(path => resolve(path));

// Resolve existing symlinks even when their final target does not yet exist.
// realpath alone cannot resolve a dangling link used as a creation destination.
function physicalPath(path, links = 0) {
  if (links > 40) throw refused();
  // Keep .. until after each preceding symlink has been followed, matching
  // filesystem lookup rather than lexical path.resolve() normalization.
  const absolute = isAbsolute(path) ? path : `${process.cwd()}${sep}${path}`;
  const { root } = parse(absolute);
  const parts = absolute.slice(root.length).split(sep).filter(Boolean);
  let current = root;
  for (let index = 0; index < parts.length; index++) {
    if (parts[index] === '.') continue;
    if (parts[index] === '..') { current = dirname(current); continue; }
    const next = join(current, parts[index]);
    let stat;
    try { stat = lstatSync(next); }
    catch (error) {
      if (absent(error)) return join(current, ...parts.slice(index));
      throw error;
    }
    if (stat.isSymbolicLink()) {
      const linked = readlinkSync(next);
      const target = isAbsolute(linked) ? linked : `${dirname(next)}${sep}${linked}`;
      return physicalPath(`${target}${sep}${parts.slice(index + 1).join(sep)}`, links + 1);
    }
    current = next;
  }
  return current;
}

function sameFile(a, b) { return a.dev === b.dev && a.ino === b.ino; }

// A redirected stdout/stderr or an already-open descriptor does not retain a
// reliable pathname on every supported OS. Compare physical file identities in
// the small protected trees, covering hard links as well as path aliases.
function protectedIdentity(identity, protectedRoots) {
  const visited = new Set();
  function visit(path) {
    let stat;
    try { stat = statSync(path, { bigint: true }); }
    catch (error) { if (absent(error)) return false; throw error; }
    if (sameFile(identity, stat)) return true;
    if (!stat.isDirectory()) return false;
    const id = `${stat.dev}:${stat.ino}`;
    if (visited.has(id)) return false;
    visited.add(id);
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      // Do not turn an unrelated directory symlink into a broad protected tree.
      if (entry.isSymbolicLink()) {
        let linked;
        try { linked = statSync(child, { bigint: true }); }
        catch (error) { if (absent(error)) continue; throw error; }
        if (sameFile(identity, linked)) return true;
      } else if (visit(child)) return true;
    }
    return false;
  }
  return protectedRoots.some(path => visit(path));
}

/** Guard every Q-Core-owned mutation, including deletion/move of an ancestor. */
export function assertApproverWriteAllowed(target, { recursive = false } = {}) {
  if (enrollmentWrites) return;
  const protectedRoots = roots();
  let identity;
  if (typeof target === 'number') {
    identity = fstatSync(target, { bigint: true });
  } else {
    const path = target instanceof URL ? fileURLToPath(target) : Buffer.isBuffer(target) ? target.toString() : target;
    const paths = [resolve(path), physicalPath(path)];
    const physicalRoots = protectedRoots.flatMap(root => [root, physicalPath(root)]);
    if (paths.some(path => physicalRoots.some(root => inside(root, path) || recursive && inside(path, root)))) throw refused();
    try { identity = statSync(path, { bigint: true }); }
    catch (error) { if (!absent(error)) throw error; }
  }
  if (identity && (identity.isFile() || identity.isDirectory?.()) && protectedIdentity(identity, protectedRoots)) throw refused();
}
