import { guardedWriteFileSync } from './persistence.mjs';
import {
  lstatSync,
  existsSync,
  realpathSync,
  readFileSync,
  mkdirSync,
  renameSync,
  openSync,
  fstatSync,
  closeSync,
  unlinkSync,
  constants,
} from "node:fs";
import { resolve, dirname, join, relative } from "node:path";
import { randomUUID } from "node:crypto";
import { hash, CoreError, insist } from "./contracts.mjs";
function workspaceRoot(workspace) {
  const path = resolve(workspace), stat = lstatSync(path, { bigint: true });
  insist(
    stat.isDirectory() && !stat.isSymbolicLink(),
    "Workspace root cannot be a symlink; resolve it at plan time",
    "SCOPE_DENIED",
  );
  const root = realpathSync(path);
  insist(sameFile(stat, lstatSync(path, { bigint: true })), "Workspace root changed", "WORKSPACE_CHANGED");
  return root;
}
const sameFile = (a, b) => a.dev === b.dev && a.ino === b.ino;
const inside = (root, path) => path === root || path.startsWith(root + "/");

function checkDirectories(root, directories) {
  const parent = directories.at(-1).path;
  insist(realpathSync(root) === root && realpathSync(parent) === parent && inside(root, parent),
    "Workspace parent escaped scope", "SCOPE_DENIED");
  for (const { path, stat } of directories) {
    const current = lstatSync(path, { bigint: true });
    insist(current.isDirectory() && !current.isSymbolicLink(), "Symlinks are not allowed", "SCOPE_DENIED");
    insist(sameFile(stat, current), "Workspace directory changed", "WORKSPACE_CHANGED");
  }
}

function prepareParent(root, parent, rootStat) {
  const directories = [{ path: root, stat: rootStat }];
  let part = root;
  for (const segment of relative(root, parent).split("/").filter(Boolean)) {
    checkDirectories(root, directories);
    part = join(part, segment);
    let stat;
    try {
      stat = lstatSync(part, { bigint: true });
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      mkdirSync(part);
      stat = lstatSync(part, { bigint: true });
    }
    insist(stat.isDirectory() && !stat.isSymbolicLink(), "Symlinks are not allowed", "SCOPE_DENIED");
    directories.push({ path: part, stat });
  }
  checkDirectories(root, directories);
  return directories;
}

function removeOwnedTemp(tmp, stat) {
  try {
    // A pathname may have been replaced. Never delete a different file or link.
    const current = lstatSync(tmp, { bigint: true });
    if (current.isFile() && sameFile(stat, current)) unlinkSync(tmp);
  } catch (error) {
    if (error.code !== "ENOENT" && error.code !== "ENOTDIR") throw error;
  }
}

export function scopedPath(workspace, path) {
  const root = workspaceRoot(workspace),
    target = resolve(root, path);
  insist(
    target.startsWith(root + "/") &&
      !relative(root, target)
        .split("/")
        .some((p) => p.startsWith(".")),
    `Path outside allowed scope: ${path} (paths must stay inside the workspace, and hidden segments such as .qfactory/ or .git/ are never in scope; put the verifier and allowed files in a visible folder)`,
    "SCOPE_DENIED",
  );
  let part = root;
  for (const p of relative(root, target).split("/")) {
    part = join(part, p);
    if (
      existsSync(part) ||
      (() => {
        try {
          return lstatSync(part).isSymbolicLink();
        } catch {
          return false;
        }
      })()
    )
      insist(
        !lstatSync(part).isSymbolicLink(),
        "Symlinks are not allowed",
        "SCOPE_DENIED",
      );
  }
  return target;
}
export function snapshot(workspace, paths) {
  return Object.fromEntries(
    paths.map((p) => {
      const file = scopedPath(workspace, p);
      if (existsSync(file))
        insist(
          lstatSync(file).isFile() && lstatSync(file).size <= 128000,
          "Scoped input must be a file <=128000 bytes",
          "SCOPE_DENIED",
        );
      return [p, existsSync(file) ? hash(readFileSync(file, "utf8")) : null];
    }),
  );
}
export function contextFiles(workspace, paths) {
  snapshot(workspace, paths);
  const files = paths.map((path) => ({
    path,
    content: existsSync(scopedPath(workspace, path))
      ? readFileSync(scopedPath(workspace, path), "utf8")
      : null,
  }));
  insist(
    JSON.stringify(files).length < 60000,
    "Workspace context exceeds limit",
  );
  return files;
}
export function applyFiles(workspace, allowedPaths, files, before) {
  insist(
    Array.isArray(files) &&
      files.length > 0 &&
      files.length <= allowedPaths.length,
    "Invalid file proposal",
    "INVALID_RESPONSE",
  );
  insist(
    new Set(files.map((f) => f.path)).size === files.length,
    "Duplicate file proposal",
    "INVALID_RESPONSE",
  );
  const root = workspaceRoot(workspace), rootStat = lstatSync(root, { bigint: true });
  for (const f of files) {
    insist(
      allowedPaths.includes(f.path) &&
        typeof f.content === "string" &&
        Buffer.byteLength(f.content) <= 128000,
      "Proposal escapes scope or size limit",
      "SCOPE_DENIED",
    );
    scopedPath(root, f.path);
  }
  insist(
    hash(snapshot(root, allowedPaths)) === hash(before),
    "Workspace changed since snapshot; reconcile first",
    "WORKSPACE_CHANGED",
  );
  for (const f of files) {
    const file = scopedPath(root, f.path);
    const directories = prepareParent(root, dirname(file), rootStat);
    const tmp = `${file}.${randomUUID()}.tmp`;
    let fd, tempStat, renamed = false;
    try {
      // Node has no portable openat/renameat API. Rechecks narrow the race;
      // isolation from hostile same-user processes requires an OS sandbox.
      checkDirectories(root, directories);
      insist(Number.isInteger(constants.O_NOFOLLOW), "Secure writes require O_NOFOLLOW", "SCOPE_DENIED");
      fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      tempStat = fstatSync(fd, { bigint: true });
      checkDirectories(root, directories);
      guardedWriteFileSync(fd, f.content);
      insist(sameFile(tempStat, lstatSync(tmp, { bigint: true })), "Workspace temporary file changed", "WORKSPACE_CHANGED");
      scopedPath(root, f.path);
      checkDirectories(root, directories);
      renameSync(tmp, file);
      renamed = true;
      insist(inside(root, realpathSync(file)), "Written file escaped workspace", "SCOPE_DENIED");
      checkDirectories(root, directories);
      insist(sameFile(tempStat, lstatSync(file, { bigint: true })), "Written file changed", "WORKSPACE_CHANGED");
    } finally {
      try {
        if (!renamed && tempStat) removeOwnedTemp(tmp, tempStat);
      } finally {
        if (fd !== undefined) closeSync(fd);
      }
    }
  }
  return snapshot(root, allowedPaths);
}
export function atomicJson(file, value) {
  const tmp = `${file}.${randomUUID()}.tmp`;
  const result = guardedWriteFileSync(tmp, JSON.stringify(value, null, 2) + "\n", {
    flag: "wx",
    mode: 0o600,
    receipt: value,
  });
  renameSync(tmp, file);
  return result;
}
export function lockWorkspace(workspace) {
  const dir = join(realpathSync(workspace), ".qf");
  if (existsSync(dir))
    insist(
      !lstatSync(dir).isSymbolicLink() && lstatSync(dir).isDirectory(),
      "Unsafe state directory",
      "SCOPE_DENIED",
    );
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const lock = join(dir, "agent.lock");
  let fd;
  try {
    fd = openSync(lock, "wx", 0o600);
  } catch {
    throw new CoreError(
      "WORKSPACE_LOCKED",
      "Workspace already locked; inspect interrupted run before removing stale lock",
    );
  }
  guardedWriteFileSync(fd, JSON.stringify({ pid: process.pid }));
  return {
    dir,
    release() {
      closeSync(fd);
      unlinkSync(lock);
    },
  };
}
