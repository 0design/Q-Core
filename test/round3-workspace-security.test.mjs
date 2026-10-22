import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync,
  renameSync, rmSync, realpathSync, symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadWorkflow } from '../src/workflow-policy.mjs';
import { createRun, driveRun } from '../src/run.mjs';
import { validateWorkspacePolicy } from '../src/registry-workspace-steps.mjs';
import { applyFiles, snapshot } from '../src/workspace.mjs';

const yaml = doc => Object.entries(doc).map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join('\n') + '\n';

function fixture(t) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'q-core-round3-security-')));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const root = join(base, 'workspace'), outside = join(base, 'outside');
  mkdirSync(root); mkdirSync(outside); mkdirSync(join(root, 'allowed'));
  writeFileSync(join(root, 'allowed', 'value.txt'), 'original');
  writeFileSync(join(outside, 'sentinel.txt'), 'outside-original');
  writeFileSync(join(root, 'verify.mjs'), 'process.exit(0);');
  const policy = validateWorkspacePolicy({
    workspace: root, allowedPaths: ['allowed/value.txt'], intent: 'Update the bounded artifact',
    maxRepairAttempts: 0,
    verifier: { command: process.execPath, args: ['verify.mjs'], timeoutMs: 3000 },
  });
  const workflow = join(root, 'workflow.yaml');
  writeFileSync(workflow, yaml({
    manifest: 'q-core.workflow/v1', id: 'round3-workspace-race', version: '1.0.0',
    settings: { budgetUsd: null },
    inputs: { proposal: { type: 'object', default: { files: [{ path: 'allowed/value.txt', content: 'changed' }] } } },
    steps: [{ id: 'apply', kind: 'workspace-apply', config: { source: '{{inputs.proposal}}' } }],
  }));
  // Create/validate the run before installing the hook: its only subsequent UUID
  // belongs to the workspace temp file, not run IDs or persisted state.
  const run = createRun(loadWorkflow(workflow));
  run.workspacePolicy = policy;
  return { root, outside, run, policy };
}

test('a parent symlink swap between the scope check and write fails closed without writing outside', async t => {
  const f = fixture(t), originalUUID = crypto.randomUUID;
  let swaps = 0;
  t.mock.method(crypto, 'randomUUID', () => {
    assert.equal(swaps++, 0, 'the hook must target the workspace write only');
    renameSync(join(f.root, 'allowed'), join(f.root, 'allowed-saved'));
    symlinkSync(f.outside, join(f.root, 'allowed'), 'dir');
    return originalUUID();
  });
  syncBuiltinESMExports();
  try {
    await driveRun(f.run);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
  assert.equal(swaps, 1, 'the deterministic race hook ran');
  assert.equal(f.run.status, 'failed', f.run.summary);
  assert.equal(readFileSync(join(f.root, 'allowed-saved', 'value.txt'), 'utf8'), 'original');
  assert.deepEqual(readdirSync(f.outside), ['sentinel.txt'], 'neither final nor temporary files may escape');
  assert.equal(readFileSync(join(f.outside, 'sentinel.txt'), 'utf8'), 'outside-original');
});

async function driveWithFsHook(t, run, method, hook) {
  const original = fs[method];
  t.mock.method(fs, method, (...args) => hook(original, ...args));
  syncBuiltinESMExports();
  try {
    await driveRun(run);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
}

test('workspace temp creation is exclusive and nofollow', async t => {
  const f = fixture(t), opened = [];
  await driveWithFsHook(t, f.run, 'openSync', (original, path, flags, mode) => {
    if (typeof path === 'string' && path.startsWith(join(f.root, 'allowed', 'value.txt.'))) {
      opened.push({ flags, mode });
      for (const flag of [fs.constants.O_CREAT, fs.constants.O_EXCL, fs.constants.O_NOFOLLOW])
        assert.equal(flags & flag, flag);
      assert.equal(mode, 0o600);
    }
    return original(path, flags, mode);
  });
  assert.equal(opened.length, 1);
  assert.equal(f.run.status, 'success', f.run.summary);
  assert.equal(readFileSync(join(f.root, 'allowed', 'value.txt'), 'utf8'), 'changed');
  assert.deepEqual(readdirSync(join(f.root, 'allowed')), ['value.txt']);
});

test('a parent inode replacement before rename fails closed and removes only the owned temp', async t => {
  const f = fixture(t);
  let swaps = 0;
  await driveWithFsHook(t, f.run, 'writeFileSync', (original, file, content, ...args) => {
    const result = original(file, content, ...args);
    if (typeof file === 'number' && content === 'changed') {
      swaps++;
      const parent = join(f.root, 'allowed'), saved = join(f.root, 'allowed-saved');
      const tmp = readdirSync(parent).find(name => name.endsWith('.tmp'));
      assert.ok(tmp, 'the hook runs after temp creation and before rename');
      renameSync(parent, saved);
      mkdirSync(parent);
      original(join(parent, 'value.txt'), 'replacement-original');
      // Keep our temp reachable, so cleanup must use its inode, not remove the
      // replacement destination or the original artifact in the saved parent.
      renameSync(join(saved, tmp), join(parent, tmp));
    }
    return result;
  });
  assert.equal(swaps, 1);
  assert.equal(f.run.status, 'failed', f.run.summary);
  assert.match(f.run.summary, /directory changed/i);
  assert.deepEqual(readdirSync(join(f.root, 'allowed')), ['value.txt']);
  assert.equal(readFileSync(join(f.root, 'allowed', 'value.txt'), 'utf8'), 'replacement-original');
  assert.equal(readFileSync(join(f.root, 'allowed-saved', 'value.txt'), 'utf8'), 'original');
  assert.deepEqual(readdirSync(f.outside), ['sentinel.txt']);
});

test('a final path redirected outside after rename fails the containment check without deleting outside files', async t => {
  const f = fixture(t);
  writeFileSync(join(f.outside, 'value.txt'), 'outside-value');
  let swaps = 0;
  await driveWithFsHook(t, f.run, 'renameSync', (original, from, to) => {
    const result = original(from, to);
    if (to === join(f.root, 'allowed', 'value.txt')) {
      swaps++;
      original(join(f.root, 'allowed'), join(f.root, 'allowed-saved'));
      symlinkSync(f.outside, join(f.root, 'allowed'), 'dir');
    }
    return result;
  });
  assert.equal(swaps, 1);
  assert.equal(f.run.status, 'failed', f.run.summary);
  assert.match(f.run.summary, /escaped workspace/i);
  assert.equal(readFileSync(join(f.outside, 'value.txt'), 'utf8'), 'outside-value');
  assert.equal(readFileSync(join(f.root, 'allowed-saved', 'value.txt'), 'utf8'), 'changed');
  assert.deepEqual(readdirSync(f.outside).sort(), ['sentinel.txt', 'value.txt']);
});

test('an unresolved workspace root symlink is refused by applyFiles', t => {
  const f = fixture(t), alias = join(f.root, '..', 'alias');
  const before = snapshot(f.root, f.policy.allowedPaths);
  symlinkSync(f.root, alias, 'dir');
  assert.throws(() => applyFiles(alias, f.policy.allowedPaths,
    [{ path: 'allowed/value.txt', content: 'changed' }], before), /root cannot be a symlink/i);
  assert.equal(readFileSync(join(f.root, 'allowed', 'value.txt'), 'utf8'), 'original');
});

test('a workspace root alias resolved at plan time writes to the pinned canonical root', async t => {
  const f = fixture(t), alias = join(f.root, '..', 'alias');
  symlinkSync(f.root, alias, 'dir');
  f.run.workspacePolicy = validateWorkspacePolicy({ ...f.policy, workspace: alias });
  assert.equal(f.run.workspacePolicy.workspace, f.root);
  await driveRun(f.run);
  assert.equal(f.run.status, 'success', f.run.summary);
  assert.equal(readFileSync(join(f.root, 'allowed', 'value.txt'), 'utf8'), 'changed');
});

test('a canonical workspace root replaced by a symlink after planning fails before runtime normalization', async t => {
  const f = fixture(t), saved = join(f.root, '..', 'workspace-saved');
  renameSync(f.root, saved);
  symlinkSync(f.outside, f.root, 'dir');
  await driveRun(f.run);
  assert.equal(f.run.status, 'failed', f.run.summary);
  assert.match(f.run.summary, /root cannot be a symlink/i);
  assert.deepEqual(readdirSync(f.outside), ['sentinel.txt']);
  assert.equal(readFileSync(join(saved, 'allowed', 'value.txt'), 'utf8'), 'original');
});
