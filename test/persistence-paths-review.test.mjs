import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import { closeSync, fstatSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { applyFiles, atomicJson, lockWorkspace, snapshot } from '../src/workspace.mjs';
import { digest, exportMaterialBundle } from '../src/material-graph.mjs';
import {
  guardedMkdirSync, guardedMkdtemp, guardedOpenSync, guardedRenameSync,
  guardedRm, guardedRmSync, guardedUnlinkSync, guardedWriteFileSync,
  registerPersistenceSecret,
} from '../src/persistence.mjs';
import { RunStore } from '../src/state.mjs';
import { deliverOnce } from '../src/delivery-receipts.mjs';
import { createLocalHost } from '../src/host.mjs';
import { runApiRequest } from '../src/steps.mjs';
import { installPinned } from '../src/registry-release.mjs';
import { checkForUpdate } from '../src/update-check.mjs';
import { hash } from '../src/contracts.mjs';

// Synthetic names only. The pre-existing input fixtures are created by the test;
// assertions cover every new output name created by the production functions.
const KEY = ['path', 'credential', 'review', 'B47'].join('-');
registerPersistenceSecret(KEY);
const NAMED_KEY = KEY.replaceAll('-', '_');
registerPersistenceSecret(NAMED_KEY);
const encodings = {
  raw: KEY,
  'HTML decimal entities': [...KEY].map(char => `&#${char.codePointAt(0)};`).join(''),
  'HTML hexadecimal entities': [...KEY].map(char => `&#x${char.codePointAt(0).toString(16)};`).join(''),
  'HTML named entities': NAMED_KEY.replaceAll('_', '&lowbar;'),
  'JSON byte array': JSON.stringify([...Buffer.from(KEY)]),
  'JS hexadecimal escapes': [...Buffer.from(KEY)].map(byte => `\\x${byte.toString(16).padStart(2, '0')}`).join(''),
  'JS Unicode escapes': [...KEY].map(char => `\\u${char.codePointAt(0).toString(16).padStart(4, '0')}`).join(''),
  'JS Unicode codepoint escapes': [...KEY].map(char => `\\u{${char.codePointAt(0).toString(16)}}`).join(''),
  hex: Buffer.from(KEY).toString('hex'),
  'prefixed base64': Buffer.from(`x${KEY}`).toString('base64'),
  'double percent': [...Buffer.from(KEY)].map(byte => `%25${byte.toString(16).padStart(2, '0')}`).join(''),
};
const unsafe = error => error.code === 'PERSISTENCE_SECRET_UNSAFE';
const yaml = value => Object.entries(value).map(([key, entry]) => `${key}: ${JSON.stringify(entry)}`).join('\n') + '\n';
const workflow = (id, extra = {}) => ({ manifest: 'q-core.workflow/v1', id, version: '1.0.0', steps: [{ id: 'clean', kind: 'deduplicate', config: { source: '[]' } }], ...extra });
const descriptor = { id: 'path-component', name: 'Path component', kind: 'step', input: {}, output: {}, needsEnv: [] };
function directory(t) {
  const root = mkdtempSync(join(tmpdir(), 'q-core-path-review-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

for (const [encoding, value] of Object.entries(encodings)) {
  test(`workspace rejects ${encoding} credential names before creating parents or descriptor-backed temp files`, t => {
    const root = directory(t), paths = ['safe.txt', `new/${value}/answer.txt`];
    const before = snapshot(root, paths);
    assert.throws(() => applyFiles(root, paths, paths.map(path => ({ path, content: 'safe bytes' })), before), unsafe);
    assert.deepEqual(readdirSync(root), [], 'all proposal paths are checked before the first write');
  });

  test(`export rejects ${encoding} credential destination names before creating ancestors`, t => {
    const root = directory(t), source = join(root, 'component.json');
    writeFileSync(source, JSON.stringify(descriptor));
    assert.throws(() => exportMaterialBundle(source, join(root, 'new', value, 'export')), unsafe);
    assert.deepEqual(readdirSync(root), ['component.json'], 'no output parent or temporary export survives');
  });
}

test('workspace checks a generated temporary pathname before mkdir or descriptor open', t => {
  const root = directory(t), paths = ['new/answer.txt'], before = snapshot(root, paths);
  t.mock.method(crypto, 'randomUUID', () => KEY);
  syncBuiltinESMExports();
  try {
    assert.throws(() => applyFiles(root, paths, [{ path: paths[0], content: 'safe bytes' }], before), unsafe);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
  assert.deepEqual(readdirSync(root), []);
});

test('workspace root names are checked before creating the lock directory', t => {
  const root = directory(t), workspace = join(root, KEY);
  mkdirSync(workspace);
  assert.throws(() => lockWorkspace(workspace), unsafe);
  assert.deepEqual(readdirSync(workspace), []);
});

test('atomic JSON checks destination names before any temporary file is created', t => {
  const root = directory(t);
  assert.throws(() => atomicJson(join(root, `${KEY}.json`), { safe: true }), unsafe);
  assert.deepEqual(readdirSync(root), []);
});

test('export checks descriptor entry names before creating even a safe output ancestor', t => {
  const root = directory(t), source = join(root, `${KEY}.json`);
  writeFileSync(source, JSON.stringify(descriptor));
  assert.throws(() => exportMaterialBundle(source, join(root, 'new', 'export')), unsafe);
  assert.equal(existsSync(join(root, 'new')), false);
  assert.deepEqual(readdirSync(root), [`${KEY}.json`]);
});

test('export checks the complete randomized temporary name before creating any output ancestor', t => {
  const root = directory(t), source = join(root, 'component.json');
  writeFileSync(source, JSON.stringify(descriptor));
  t.mock.method(crypto, 'randomUUID', () => KEY);
  syncBuiltinESMExports();
  try {
    assert.throws(() => exportMaterialBundle(source, join(root, 'new', 'export')), unsafe);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
  assert.deepEqual(readdirSync(root), ['component.json']);
});

test('export preflights nested dependency names before any export directory is created', t => {
  const root = directory(t), sourceRoot = join(root, 'source'), childPath = `${KEY}/child.yaml`;
  mkdirSync(join(sourceRoot, KEY), { recursive: true });
  const child = yaml(workflow('child'));
  writeFileSync(join(sourceRoot, childPath), child);
  writeFileSync(join(sourceRoot, 'parent.yaml'), yaml(workflow('parent', {
    dependencies: { child: { kind: 'workflow', id: 'child', version: '1.0.0', path: childPath, sha256: digest(child) } },
  })));
  assert.throws(() => exportMaterialBundle(join(sourceRoot, 'parent.yaml'), join(root, 'new', 'export')), unsafe);
  assert.deepEqual(readdirSync(root), ['source']);
});

for (const [label, write] of Object.entries({
  state: store => store.save({ runId: 'safe-run', steps: [] }),
  sink: store => store.writeSink('safe-run', 'safe bytes'),
  specification: store => store.recordSpecification({ id: 'safe' }, { summary: 'safe bytes' }),
})) {
  test(`${label} rejects credential-bearing parent names before creating state directories`, t => {
    const root = directory(t), store = new RunStore(join(root, 'new', KEY, 'workflow.yaml'));
    assert.throws(() => write(store), unsafe);
    assert.deepEqual(readdirSync(root), []);
  });
}

test('state preflights caller-provided output file names before creating state directories', t => {
  const root = directory(t), store = new RunStore(join(root, 'workflow.yaml'));
  assert.throws(() => store.save({ runId: KEY, steps: [] }), unsafe);
  assert.throws(() => store.writeSink(KEY, 'safe bytes'), unsafe);
  assert.deepEqual(readdirSync(root), []);
});

test('file delivery validates the destination before opening its descriptor', async t => {
  const root = directory(t), path = join(root, `${KEY}.jsonl`);
  await assert.rejects(runApiRequest({ kind: 'api-request', config: { url: pathToFileURL(path).href, body: '{"safe":true}' } },
    { runId: 'safe-run', templateId: 'safe-workflow', priorOutputs: {}, inputs: {} }), unsafe);
  assert.deepEqual(readdirSync(root), []);
});

test('idempotent file delivery preflights its destination before creating receipt state', async t => {
  const root = directory(t), path = join(root, `${KEY}.jsonl`), store = new RunStore(join(root, 'workflow.yaml'));
  await assert.rejects(runApiRequest({ kind: 'api-request', config: { url: pathToFileURL(path).href, body: '{"safe":true}', receiptKey: 'a'.repeat(64) } },
    { runId: 'safe-run', templateId: 'safe-workflow', priorOutputs: {}, inputs: {}, runStore: store }), unsafe);
  assert.deepEqual(readdirSync(root), []);
});

test('idempotent delivery preflights receipt parents before mkdir or outbound send', async t => {
  const root = directory(t);
  let sent = false;
  await assert.rejects(deliverOnce({ store: { dir: join(root, 'new', KEY) }, destination: { method: 'LOCAL' }, key: 'a'.repeat(64), payloadHash: 'b'.repeat(64) },
    async () => { sent = true; return { output: { dispatched: true } }; }), unsafe);
  assert.equal(sent, false);
  assert.deepEqual(readdirSync(root), []);
});

test('local host preflights its state destinations before recursive mkdir', t => {
  const root = directory(t), sourceRoot = join(root, KEY);
  mkdirSync(sourceRoot);
  const file = join(sourceRoot, 'workflow.yaml'), body = yaml(workflow('host-path', { enabled: true, triggers: [{ kind: 'manual' }] }));
  writeFileSync(file, body);
  assert.throws(() => createLocalHost({ manifest: file, manifestSha256: hash(body) }), unsafe);
  assert.deepEqual(readdirSync(sourceRoot), ['workflow.yaml']);
});

test('registry install preflights every nested destination before writing the first material', async t => {
  const root = directory(t), releaseRoot = join(root, 'release'), targetRoot = join(root, 'installed');
  const credential = KEY.toLowerCase();
  registerPersistenceSecret(credential);
  mkdirSync(join(releaseRoot, 'workflows', credential), { recursive: true }); mkdirSync(targetRoot);
  const childPath = `${credential}/child.yaml`, child = yaml(workflow('child'));
  const parent = yaml(workflow('parent', { dependencies: { child: { kind: 'workflow', id: 'child', version: '1.0.0', path: childPath, sha256: digest(child) } } }));
  writeFileSync(join(releaseRoot, 'workflows', childPath), child);
  writeFileSync(join(releaseRoot, 'workflows', 'parent.yaml'), parent);
  const catalog = JSON.stringify({ releaseVersion: 'fixture.1',
    core: { package: 'q-core', version: JSON.parse(readFileSync(new URL('../package.json', import.meta.url))).version, manifest: 'q-core.workflow/v1' },
    workflows: [{ id: 'parent', version: '1.0.0', file: 'workflows/parent.yaml', sha256: hash(parent), dependencies: [] }],
  });
  writeFileSync(join(releaseRoot, 'catalog.json'), catalog);
  await assert.rejects(installPinned({ base: releaseRoot, catalogSha256: hash(catalog), id: 'parent', version: '1.0.0', destination: join(targetRoot, 'parent.yaml') }), unsafe);
  assert.deepEqual(readdirSync(targetRoot), []);
});

test('update cache validates its path before mkdir while retaining silent-cache behavior', async t => {
  const root = directory(t), names = ['XDG_CACHE_HOME', 'QF_UPDATE_URL', 'QF_NO_UPDATE_CHECK'];
  const previous = Object.fromEntries(names.map(name => [name, process.env[name]]));
  t.after(() => { for (const name of names) if (previous[name] === undefined) delete process.env[name]; else process.env[name] = previous[name]; });
  process.env.XDG_CACHE_HOME = join(root, 'new', KEY);
  process.env.QF_UPDATE_URL = 'https://offline-fixture.invalid/update';
  delete process.env.QF_NO_UPDATE_CHECK;
  t.mock.method(globalThis, 'fetch', async () => ({ ok: true, json: async () => ({ version: '99.0.0' }) }));
  assert.equal((await checkForUpdate('1.0.0')).version, '99.0.0');
  assert.deepEqual(readdirSync(root), []);
});


for (const [encoding, value] of Object.entries(encodings)) {
  test(`guarded pathname mutations reject ${encoding} names before filesystem side effects`, async t => {
    const root = directory(t), secretPath = join(root, value), safe = join(root, 'safe');
    assert.throws(() => guardedMkdirSync(secretPath, { recursive: true }), unsafe);
    assert.throws(() => guardedOpenSync(secretPath, 'w'), unsafe);
    await assert.rejects(guardedMkdtemp(secretPath), unsafe);
    assert.deepEqual(readdirSync(root), []);
    writeFileSync(safe, 'retained');
    assert.throws(() => guardedRenameSync(safe, secretPath), unsafe);
    assert.throws(() => guardedRenameSync(secretPath, safe), unsafe);
    assert.equal(readFileSync(safe, 'utf8'), 'retained', 'both rename paths are checked before moving anything');
    writeFileSync(secretPath, 'input fixture');
    assert.throws(() => guardedOpenSync(secretPath, 'w'), unsafe);
    assert.equal(readFileSync(secretPath, 'utf8'), 'input fixture', 'refused open cannot truncate an existing file');
    assert.throws(() => guardedUnlinkSync(secretPath), unsafe);
    assert.throws(() => guardedRmSync(secretPath, { force: true }), unsafe);
    // Async removal checks synchronously, before scheduling its fs operation.
    assert.throws(() => guardedRm(secretPath, { force: true }), unsafe);
    assert.equal(readFileSync(secretPath, 'utf8'), 'input fixture');
  });
}

test('guarded temporary-directory creation checks the complete generated name before mkdir', async t => {
  const root = directory(t);
  t.mock.method(crypto, 'randomUUID', () => KEY);
  syncBuiltinESMExports();
  try {
    await assert.rejects(guardedMkdtemp(join(root, 'safe-prefix-')), unsafe);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
  assert.deepEqual(readdirSync(root), []);
});

test('guarded pathname wrappers preserve ordinary filesystem operations', async t => {
  const root = directory(t), parent = join(root, 'nested'), source = join(parent, 'source.txt'), destination = join(parent, 'destination.txt');
  guardedMkdirSync(parent, { recursive: true, mode: 0o700 });
  const fd = guardedOpenSync(source, 'wx', 0o600);
  try {
    guardedWriteFileSync(fd, 'checked bytes');
    assert.equal(fstatSync(fd).mode & 0o777, 0o600);
  } finally { closeSync(fd); }
  guardedRenameSync(source, destination);
  assert.equal(existsSync(source), false);
  assert.equal(readFileSync(destination, 'utf8'), 'checked bytes');
  guardedUnlinkSync(destination);
  guardedRmSync(parent, { recursive: true });
  const temporary = await guardedMkdtemp(join(root, 'temporary-'));
  assert.equal(existsSync(temporary), true);
  await guardedRm(temporary, { recursive: true });
  assert.deepEqual(readdirSync(root), []);
});
