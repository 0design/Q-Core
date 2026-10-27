import test from 'node:test';
import assert from 'node:assert/strict';
import { closeSync, existsSync, linkSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { approverDirectory, bundledTouchIdDirectory, touchIdKeyDirectory, withApproverEnrollmentWrites } from '../src/approver-write-boundary.mjs';
import { assertPersistencePath, guardedMkdirSync, guardedOpenSync, guardedRenameSync, guardedRm, guardedRmSync, guardedStreamWrite, guardedUnlinkSync, guardedWriteFileSync, guardedWriteSync } from '../src/persistence.mjs';
import { applyFiles, atomicJson, snapshot } from '../src/workspace.mjs';
import { runApiRequest } from '../src/steps.mjs';

const refused = { code: 'APPROVER_WRITE_REFUSED' };
function fixture(t) {
  const root = mkdtempSync(join(os.tmpdir(), 'q-core-trust-writes-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const account = os.userInfo();
  t.mock.method(os, 'userInfo', () => ({ ...account, homedir: root }));
  const registration = join(approverDirectory(), 'touchid.json');
  const key = join(touchIdKeyDirectory(), 'enclave-key');
  for (const directory of [approverDirectory(), touchIdKeyDirectory()]) mkdirSync(directory, { recursive: true });
  writeFileSync(registration, '{"registered":"original"}\n');
  writeFileSync(key, 'original wrapped key\n');
  return { root, registration, key };
}

test('Q-Core file writers refuse registration, native key, and bundled helper targets', t => {
  const f = fixture(t);
  const source = join(bundledTouchIdDirectory(), 'main.swift');
  const sourceBefore = readFileSync(source, 'utf8');
  for (const target of [f.registration, f.key, source, join(bundledTouchIdDirectory(), 'touchid-approve')]) {
    assert.throws(() => guardedWriteFileSync(target, 'replacement'), refused);
    assert.throws(() => guardedOpenSync(target, 'w'), refused);
    assert.throws(() => guardedUnlinkSync(target), refused);
  }
  assert.equal(readFileSync(f.registration, 'utf8'), '{"registered":"original"}\n');
  assert.equal(readFileSync(f.key, 'utf8'), 'original wrapped key\n');
  assert.equal(readFileSync(source, 'utf8'), sourceBefore);
  assert.throws(() => guardedMkdirSync(join(approverDirectory(), 'new')), refused);
  assert.doesNotThrow(() => guardedMkdirSync(join(f.root, '.q-core'), { recursive: true }));
});

test('rename and removal cannot replace a protected tree or one of its ancestors', async t => {
  const f = fixture(t), source = join(f.root, 'safe.txt');
  writeFileSync(source, 'ordinary file');
  for (const target of [approverDirectory(), join(f.root, '.q-core'), touchIdKeyDirectory()]) {
    assert.throws(() => guardedRmSync(target, { recursive: true }), refused);
    assert.throws(() => guardedRm(target, { recursive: true }), refused);
    assert.throws(() => guardedRenameSync(target, join(f.root, 'moved')), refused);
    assert.throws(() => guardedRenameSync(source, target), refused);
  }
  assert.equal(readFileSync(source, 'utf8'), 'ordinary file');
  assert.ok(existsSync(f.registration));
  assert.ok(existsSync(f.key));
});

test('symlink destinations, dangling links, and hard links cannot redirect trust writes', t => {
  const f = fixture(t);
  const directoryAlias = join(f.root, 'directory-alias');
  symlinkSync(approverDirectory(), directoryAlias);
  const danglingAlias = join(f.root, 'dangling-alias');
  symlinkSync(join(approverDirectory(), 'not-created.json'), danglingAlias);
  const hardAlias = join(f.root, 'hard-alias');
  linkSync(f.registration, hardAlias);
  const nested = join(approverDirectory(), 'nested');
  mkdirSync(nested);
  const parentAlias = join(f.root, 'parent-alias');
  symlinkSync(nested, parentAlias);
  // This raw pathname is interpreted by the OS after following parent-alias;
  // path.join/resolve would instead erase the symlink segment prematurely.
  const rawParentAlias = `${parentAlias}/../touchid.json`;
  for (const target of [join(directoryAlias, 'touchid.json'), danglingAlias, hardAlias, rawParentAlias]) {
    assert.throws(() => guardedWriteFileSync(target, 'replacement'), refused);
  }
  assert.equal(existsSync(join(approverDirectory(), 'not-created.json')), false);
  assert.equal(readFileSync(f.registration, 'utf8'), '{"registered":"original"}\n');
});

test('descriptor and redirected stream output cannot overwrite an approver', t => {
  const f = fixture(t), fd = openSync(f.registration, 'r+');
  try {
    assert.throws(() => guardedWriteFileSync(fd, 'replacement'), refused);
    assert.throws(() => guardedWriteSync(fd, 'replacement'), refused);
    let wrote = false;
    assert.throws(() => guardedStreamWrite({ fd, write() { wrote = true; } }, 'replacement'), refused);
    assert.equal(wrote, false);
  } finally { closeSync(fd); }
  let wrote = false;
  assert.throws(() => guardedStreamWrite({ path: f.registration, write() { wrote = true; } }, 'replacement'), refused);
  assert.equal(wrote, false);
  assert.equal(readFileSync(f.registration, 'utf8'), '{"registered":"original"}\n');
});

test('workspace proposals and workflow file deliveries cannot write inside trust locations', async t => {
  const f = fixture(t);
  const workspace = approverDirectory(), before = snapshot(workspace, ['touchid.json']);
  assert.throws(() => applyFiles(workspace, ['touchid.json'], [{ path: 'touchid.json', content: 'replacement' }], before), refused);
  assert.throws(() => atomicJson(f.registration, { public_key: 'replacement' }), refused);
  const delivery = join(touchIdKeyDirectory(), 'delivery.jsonl');
  await assert.rejects(runApiRequest({ kind: 'api-request', config: { url: pathToFileURL(delivery).href, body: '{"public_key":"replacement"}' } },
    { runId: 'synthetic-run', templateId: 'synthetic-workflow', priorOutputs: {}, inputs: {} }), refused);
  assert.equal(existsSync(delivery), false);
  assert.deepEqual(readdirSync(workspace), ['touchid.json']);
  assert.equal(readFileSync(f.registration, 'utf8'), '{"registered":"original"}\n');
});

test('HOME and helper environment overrides do not move protected trust locations', t => {
  const f = fixture(t), previous = process.env.HOME;
  process.env.HOME = join(f.root, 'spoofed-home');
  t.after(() => previous === undefined ? delete process.env.HOME : process.env.HOME = previous);
  assert.equal(approverDirectory(), join(f.root, '.q-core', 'approvers'));
  assert.equal(touchIdKeyDirectory(), join(f.root, 'Library', 'Application Support', 'q-core-touchid-approve'));
  assert.throws(() => assertPersistencePath(f.registration), refused);
});

test('only the synchronous enrollment capability permits trust writes and always restores the guard', t => {
  const f = fixture(t);
  withApproverEnrollmentWrites(() => guardedWriteFileSync(f.registration, 'human-confirmed registration\n'));
  assert.equal(readFileSync(f.registration, 'utf8'), 'human-confirmed registration\n');
  assert.throws(() => guardedWriteFileSync(f.registration, 'replacement'), refused);
  assert.throws(() => withApproverEnrollmentWrites(() => { throw Error('synthetic failure'); }), /synthetic failure/);
  assert.throws(() => guardedWriteFileSync(f.registration, 'replacement'), refused);
  assert.throws(() => withApproverEnrollmentWrites(() => Promise.resolve()), /synchronous/);
  assert.throws(() => guardedWriteFileSync(f.registration, 'replacement'), refused);
  const ordinary = join(f.root, 'ordinary.txt');
  guardedWriteFileSync(ordinary, 'ordinary output');
  assert.equal(readFileSync(ordinary, 'utf8'), 'ordinary output');
});
