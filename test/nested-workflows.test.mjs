import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync, symlinkSync, readdirSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { loadManifestGraph, exportMaterialBundle, digest, MAX_CALL_DEPTH } from '../src/material-graph.mjs';
import { validateManifest } from '../src/manifest.mjs';
import { loadWorkflow } from '../src/workflow-policy.mjs';
import { createRun, driveRun, resumeRun, waitingGate, RunStore, resolveKnobs, cancelWaitingRun, resumeCancelledRun } from '../src/run.mjs';
import { resolveBinding } from '../src/material-io.mjs';
import { AGENT_SESSION_ENV } from '../src/human-confirmation.mjs';
import { validateComponentDescriptor } from '../src/component-descriptor.mjs';
import { installPinned } from '../src/registry-release.mjs';
import { buildRegistry } from '../scripts/build-registry.mjs';

const yaml = doc => Object.entries(doc).map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join('\n') + '\n';
const document = (id, extra = {}) => ({ manifest: 'q-core.workflow/v1', id, version: '1.0.0', ...extra });
const source = [{ url: 'https://example.test/article', text: 'A verified local fixture' }, { url: 'https://example.test/article', text: 'A verified local fixture' }];
const leaf = (extra = {}) => document('clean', { manifest: 'q-core.component/v1', inputs: { sources: { type: 'array', items: { type: 'object' } } }, outputs: { sources: { type: 'array', value: '{{steps.clean.output.sources}}' }, removed: { type: 'integer', value: '{{steps.clean.output.removed}}' } }, steps: [{ id: 'clean', kind: 'deduplicate', config: { source: '{{inputs.sources}}' } }], ...extra });
function directory(t) { const dir = mkdtempSync(join(tmpdir(), 'q-core-nested-')); t.after(() => rmSync(dir, { recursive: true, force: true })); return dir; }
function write(dir, path, doc) { const file = join(dir, path); mkdirSync(dirname(file), { recursive: true }); const bytes = yaml(doc); writeFileSync(file, bytes); return { kind: doc.manifest === 'q-core.component/v1' ? 'component' : 'workflow', id: doc.id, version: doc.version, path, sha256: digest(bytes) }; }
function parent(ref, extra = {}) { return document('parent', { dependencies: { cleaner: ref }, outputs: { removed: { type: 'integer', value: '{{steps.call.output.removed}}' } }, steps: [{ id: 'call', kind: 'workflow-call', config: { ref: 'cleaner', inputs: JSON.stringify({ sources: source }) } }], ...extra }); }

test('parent → executable component → typed output; exact bytes survive clean export and relocated CLI run', async t => {
  const dir = directory(t), ref = write(dir, 'deps/clean.yaml', leaf());
  write(dir, 'parent.yaml', parent(ref));
  const file = join(dir, 'parent.yaml');
  const manifest = loadWorkflow(file);
  const done = await driveRun(createRun(manifest));
  assert.equal(done.status, 'success', done.summary);
  assert.deepEqual(done.output, { removed: 1 });
  assert.equal(done.steps.find(row => row.stepId === 'call').childStatus, 'success');
  assert.equal(done.steps.find(row => row.stepId === 'call').output.sources.length, 1);
  const bundleDir = join(dir, 'portable'), bundle = exportMaterialBundle(file, bundleDir);
  assert.equal(bundle.files.length, 2);
  for (const asset of bundle.files) assert.equal(digest(readFileSync(join(bundleDir, asset.path))), asset.sha256);
  // Source is removed: the exported bundle must contain its complete closure.
  rmSync(join(dir, 'deps'), { recursive: true }); rmSync(file);
  const bin = resolve('bin/q-core.mjs');
  const result = spawnSync(process.execPath, [bin, 'run', join(bundleDir, bundle.entry), '--json'], { cwd: bundleDir, env: { ...process.env, QF_NO_UPDATE_CHECK: '1' }, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).output, { removed: 1 });
});

test('typed root inputs/defaults, nested input bindings and repeated child IDs are isolated', async t => {
  const dir = directory(t), ref = write(dir, 'clean.yaml', leaf());
  const base = parent(ref, { inputs: { sources: { type: 'array' }, count: { type: 'integer', default: 2 } }, outputs: { first: { type: 'integer', value: '{{steps.first.output.removed}}' }, second: { type: 'integer', value: '{{steps.second.output.removed}}' }, count: { type: 'integer', value: '{{inputs.count}}' } }, steps: [
    { id: 'first', kind: 'workflow-call', config: { ref: 'cleaner', inputs: '{"sources":"{{inputs.sources}}"}' } },
    { id: 'second', kind: 'workflow-call', config: { ref: 'cleaner', inputs: '{"sources":"{{steps.first.output.sources}}"}' } },
  ] });
  write(dir, 'parent.yaml', base);
  const manifest = loadWorkflow(join(dir, 'parent.yaml'));
  assert.throws(() => createRun(manifest), /required input/);
  assert.throws(() => createRun(manifest, { inputs: { sources: source, count: '2' } }), /expected integer/);
  const done = await driveRun(createRun(manifest, { inputs: { sources: source } }));
  assert.equal(done.status, 'success', done.summary);
  assert.deepEqual(done.output, { first: 1, second: 0, count: 2 });
  assert.equal(new Set(done.steps.filter(row => row.stepId === 'clean').map(row => row.invocationId)).size, 2);
});

test('child waiting_human persists and resumes its snapshot; agent and stale approvals still refuse', async t => {
  const dir = directory(t);
  const child = leaf({ steps: [...leaf().steps, { id: 'approve', kind: 'approval-gate', config: { reviewer: 'human', bind: 'sha256' } }] });
  const ref = write(dir, 'clean.yaml', child); write(dir, 'parent.yaml', parent(ref));
  const file = join(dir, 'parent.yaml'), store = new RunStore(file);
  const waiting = await driveRun(createRun(loadWorkflow(file)), { store });
  assert.equal(waiting.status, 'waiting_human');
  assert.equal(waiting.steps[0].childStatus, 'waiting_human');
  const snapshot = store.load(waiting.runId), gate = snapshot.steps.find(row => row.status === 'waiting_human');
  assert.throws(() => waitingGate(snapshot, '0'.repeat(64)), /Approval does not match/);
  await assert.rejects(resumeRun(snapshot, { decision: 'approve', approvalHash: gate.output.approvalHash }), /human confirmation/);
  const priorMarker = process.env.AI_AGENT; process.env.AI_AGENT = 'synthetic-test-agent';
  await assert.rejects(resumeRun(snapshot, { decision: 'approve', approvalHash: gate.output.approvalHash, confirmation: { channel: 'synthetic-test' } }), /agent session/);
  if (priorMarker === undefined) delete process.env.AI_AGENT; else process.env.AI_AGENT = priorMarker;
  // Explicit synthetic embedding-host fixture, following existing Core35 tests.
  // It performs only local deterministic deduplication, never real publication.
  const markers = Object.fromEntries(AGENT_SESSION_ENV.map(key => [key, process.env[key]]));
  try {
    for (const key of AGENT_SESSION_ENV) delete process.env[key];
    writeFileSync(join(dir, 'clean.yaml'), 'changed after pause');
    const result = await resumeRun(snapshot, { decision: 'approve', approvalHash: gate.output.approvalHash, confirmation: { channel: 'synthetic-test-human' }, store });
    assert.equal(result.status, 'success', result.summary);
    assert.deepEqual(result.output, { removed: 1 });
  } finally { for (const [key, value] of Object.entries(markers)) if (value === undefined) delete process.env[key]; else process.env[key] = value; }
});

test('missing files, digest/identity mismatch, path traversal/symlink and literal binding types fail before run', t => {
  const dir = directory(t), ref = write(dir, 'clean.yaml', leaf());
  const file = join(dir, 'parent.yaml');
  for (const [changed, message] of [[{ ...ref, path: 'missing.yaml' }, /cannot resolve/], [{ ...ref, sha256: '0'.repeat(64) }, /checksum/], [{ ...ref, version: '2.0.0' }, /identity/], [{ ...ref, path: '../outside.yaml' }, /traversal/]]) {
    write(dir, 'parent.yaml', parent(changed)); assert.throws(() => loadWorkflow(file), message);
  }
  symlinkSync(tmpdir(), join(dir, 'outside')); write(dir, 'parent.yaml', parent({ ...ref, path: 'outside/not-a-material.yaml' })); assert.throws(() => loadWorkflow(file), /cannot resolve/);
  write(dir, 'parent.yaml', parent(ref, { steps: [{ id: 'bad', kind: 'workflow-call', config: { ref: 'cleaner', inputs: '{"sources":3}' } }] }));
  assert.throws(() => loadWorkflow(file), /expected array/);
});

test('cycle and depth bounds are explicit, and raw unresolved manifests cannot run', t => {
  const dir = directory(t), self = document('cycle', { dependencies: { self: { kind: 'workflow', id: 'cycle', version: '1.0.0', path: 'cycle.yaml', sha256: '0'.repeat(64) } }, steps: [{ id: 'call', kind: 'workflow-call', config: { ref: 'self' } }] });
  write(dir, 'cycle.yaml', self); assert.throws(() => loadWorkflow(join(dir, 'cycle.yaml')), /cycle/);
  let ref = write(dir, `n${MAX_CALL_DEPTH + 1}.yaml`, leaf());
  for (let index = MAX_CALL_DEPTH; index >= 0; index--) ref = write(dir, `n${index}.yaml`, parent(ref, { id: `node${index}` }));
  assert.throws(() => loadWorkflow(join(dir, 'n0.yaml')), /depth exceeds/);
  assert.throws(() => createRun(validateManifest(self)), /complete pinned dependency graph/);
});

test('child side effects cannot hide from human policy; output type failures propagate to call and run', async t => {
  const dir = directory(t);
  const unsafe = document('unsafe', { steps: [{ id: 'send', kind: 'api-request', config: { url: 'https://example.test/hook' } }] });
  let ref = write(dir, 'child.yaml', unsafe); write(dir, 'parent.yaml', parent(ref, { steps: [{ id: 'call', kind: 'workflow-call', config: { ref: 'cleaner' } }] }));
  assert.throws(() => loadWorkflow(join(dir, 'parent.yaml')), /GATE_REQUIRED/);
  ref = write(dir, 'child.yaml', leaf({ outputs: { removed: { type: 'string', value: '{{steps.clean.output.removed}}' } } })); write(dir, 'parent.yaml', parent(ref));
  const failed = await driveRun(createRun(loadWorkflow(join(dir, 'parent.yaml'))));
  assert.equal(failed.status, 'failed'); assert.match(failed.summary, /expected string/);
  assert.equal(failed.steps[0].status, 'failed');
});

test('template data is never reinterpreted and whole input refs preserve objects/null/booleans', () => {
  const context = { priorOutputs: {}, inputs: { value: '{{env.SECRET}}', bool: false, nullable: null, obj: { value: 4 } } };
  assert.deepEqual(resolveBinding({ value: '{{inputs.value}}', bool: '{{inputs.bool}}', nullable: '{{inputs.nullable}}', obj: '{{inputs.obj}}' }, context), { value: '{{env.SECRET}}', bool: false, nullable: null, obj: { value: 4 } });
  assert.throws(() => resolveBinding('{{inputs.obj.constructor}}', context), /Unresolved/);
});

test('child spend rolls into parent exactly once and ancestor budgets stop later model calls', async t => {
  const dir = directory(t); let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; return new Response(JSON.stringify({ id: 'fixture', model: 'test/model', choices: [{ message: { content: 'fixture' }, finish_reason: 'stop' }], usage: { prompt_tokens: 4, completion_tokens: 2, cost: 0.2 } }), { status: 200, headers: { 'content-type': 'application/json' } }); });
  const child = document('paid', { settings: { model: 'test/model', budgetUsd: 1 }, outputs: { text: { type: 'string', value: '{{steps.model.output.text}}' } }, steps: [{ id: 'model', kind: 'llm-call', config: { instructions: 'Fixture request', retries: 0 } }] });
  const ref = write(dir, 'paid.yaml', child);
  write(dir, 'parent.yaml', parent(ref, { settings: { budgetUsd: 0.1 }, outputs: {}, steps: [{ id: 'first', kind: 'workflow-call', config: { ref: 'cleaner' } }, { id: 'second', kind: 'workflow-call', config: { ref: 'cleaner' } }] }));
  const manifest = loadWorkflow(join(dir, 'parent.yaml'));
  const result = await driveRun(createRun(manifest), { apiKey: 'synthetic-fixture', knobs: resolveKnobs(manifest.settings) });
  assert.equal(result.status, 'failed'); assert.match(result.summary, /budget/i); assert.equal(calls, 1);
  assert.equal(result.costUsd, 0.2); assert.equal(result.steps[0].childUsage.costUsd, 0.2); assert.equal(result.steps[0].costUsd, 0);
});

test('a reusable child workflow calls a component inside control flow without leaking caller outputs', async t => {
  const dir = directory(t), leafRef = write(dir, 'clean.yaml', leaf());
  const mid = parent(leafRef, { id: 'middle', inputs: { sources: { type: 'array' } }, steps: [{ id: 'choose', kind: 'if', config: { condition: 'true' }, then: [{ id: 'call', kind: 'workflow-call', config: { ref: 'cleaner', inputs: '{"sources":"{{inputs.sources}}"}' } }] }] });
  const ref = write(dir, 'middle.yaml', mid); write(dir, 'parent.yaml', parent(ref));
  const done = await driveRun(createRun(loadWorkflow(join(dir, 'parent.yaml'))));
  assert.equal(done.status, 'success', done.summary); assert.deepEqual(done.output, { removed: 1 });
  assert.equal(Object.keys(done.invocations).length, 3);
  assert.ok(done.steps.filter(row => row.kind === 'workflow-call').every(row => row.childStatus === 'success'));
});

test('nested caller inference pauses, cancels and resumes the same pinned invocation', async t => {
  const dir = directory(t);
  const child = document('caller', { settings: { budgetUsd: null }, outputs: { text: { type: 'string', value: '{{steps.model.output.text}}' } }, steps: [{ id: 'model', kind: 'llm-call', config: { provider: 'cli', instructions: 'Return a deterministic fixture' } }] });
  const ref = write(dir, 'caller.yaml', child); write(dir, 'parent.yaml', parent(ref, { settings: { budgetUsd: null }, outputs: { text: { type: 'string', value: '{{steps.call.output.text}}' } }, steps: [{ id: 'call', kind: 'workflow-call', config: { ref: 'cleaner' } }] }));
  const manifest = loadWorkflow(join(dir, 'parent.yaml'));
  const opts = { knobs: resolveKnobs(manifest.settings), callerProvider: { kind: 'caller', agent: 'codex', model: 'test-model', payerScope: 'local-cli' } };
  const run = await driveRun(createRun(manifest), opts);
  assert.equal(run.status, 'waiting_inference'); assert.equal(run.steps[0].childStatus, 'waiting_inference');
  const old = { jobId: run.pendingInference.jobId, hash: run.pendingInference.hash, output: { text: 'stale' } };
  cancelWaitingRun(run); assert.equal(run.steps[0].childStatus, 'cancelled');
  await resumeCancelledRun(run, opts); assert.equal(run.status, 'waiting_inference');
  await assert.rejects(driveRun(run, { ...opts, inferenceReply: old }), /stale|match|pending|unknown/i);
  const reply = { jobId: run.pendingInference.jobId, hash: run.pendingInference.hash, output: { text: 'fixture' } };
  const done = await driveRun(run, { ...opts, inferenceReply: reply });
  assert.equal(done.status, 'success', done.summary); assert.deepEqual(done.output, { text: 'fixture' });
  assert.equal(done.costUsd, null); assert.equal(done.steps[0].childUsage.costUsd, null);
});

test('every existing Registry component descriptor validates without becoming executable', t => {
  for (const file of readdirSync('registry/components').filter(file => file.endsWith('.json'))) {
    const raw = JSON.parse(readFileSync(join('registry/components', file)));
    assert.deepEqual(validateComponentDescriptor(raw), raw, file);
  }
  const descriptor = JSON.parse(readFileSync('registry/components/llm-call.json'));
  for (const patch of [{ kind: 'workflow' }, { manifest: 'q-core.component/v1' }, { steps: [] }, { input: { bad: { type: 'made-up' } } }, { needsEnv: ['raw-secret-value'] }]) assert.throws(() => validateComponentDescriptor({ ...descriptor, ...patch }));
  const dir = directory(t); writeFileSync(join(dir, 'component.json'), JSON.stringify(descriptor));
  const bundle = exportMaterialBundle(join(dir, 'component.json'), join(dir, 'export'));
  assert.equal(bundle.executable, false); assert.equal(bundle.files[0].format, 'descriptor');
  const validation = spawnSync(process.execPath, [resolve('bin/q-core.mjs'), 'validate', join(dir, 'component.json'), '--json'], { env: { ...process.env, QF_NO_UPDATE_CHECK: '1' }, encoding: 'utf8' });
  assert.equal(validation.status, 0, validation.stderr); assert.equal(JSON.parse(validation.stdout).executable, false);
});

test('pinned Registry install materializes complete nested closure and refuses tampered child bytes', async t => {
  const dir = directory(t), registry = join(dir, 'registry'); mkdirSync(registry);
  const ref = write(registry, 'workflows/deps/clean.yaml', leaf());
  const parentDoc = parent({ ...ref, path: 'deps/clean.yaml' });
  const main = write(registry, 'workflows/parent.yaml', parentDoc);
  const pkg = JSON.parse(readFileSync('package.json'));
  const catalog = { releaseVersion: 'fixture-nested-v1', core: { package: 'q-core', version: pkg.version, manifest: 'q-core.workflow/v1' }, workflows: [{ id: 'parent', version: '1.0.0', file: main.path, sha256: main.sha256 }], components: [] };
  const bytes = JSON.stringify(catalog); writeFileSync(join(registry, 'catalog.json'), bytes);
  const destination = join(dir, 'renamed.yaml');
  await installPinned({ base: registry, catalogSha256: digest(bytes), id: 'parent', version: '1.0.0', destination });
  assert.equal(digest(readFileSync(join(dir, 'deps/clean.yaml'))), ref.sha256);
  const done = await driveRun(createRun(loadWorkflow(destination)));
  assert.equal(done.status, 'success', done.summary); assert.deepEqual(done.output, { removed: 1 });
  writeFileSync(join(registry, ref.path), 'corrupt');
  await assert.rejects(installPinned({ base: registry, catalogSha256: digest(bytes), id: 'parent', version: '1.0.0', destination: join(dir, 'new.yaml') }), /checksum/);
});

test('Registry builder includes exact transitive dependency assets, not only listed parent files', t => {
  const dir = directory(t); cpSync('registry', dir, { recursive: true });
  const sourceFile = join(dir, 'catalog.source.json'), catalog = JSON.parse(readFileSync(sourceFile));
  const ref = write(dir, 'workflows/deps/clean.yaml', leaf());
  write(dir, 'workflows/nested-fixture.yaml', parent({ ...ref, path: 'deps/clean.yaml' }, { id: 'nested-fixture' }));
  catalog.workflows.push({ id: 'nested-fixture', name: 'Nested fixture', value: 'Controlled local dependency test', version: '1.0.0', file: 'workflows/nested-fixture.yaml', author: '0design', license: 'MIT', engine: { package: catalog.core.package, version: catalog.core.version, manifest: catalog.core.manifest } });
  writeFileSync(sourceFile, JSON.stringify(catalog));
  const built = buildRegistry(dir);
  assert.equal(digest(built.assets['workflows/deps/clean.yaml']), ref.sha256);
  assert.ok(built.assets['workflows/nested-fixture.yaml']);
  writeFileSync(join(dir, ref.path), 'tampered');
  assert.throws(() => buildRegistry(dir), /checksum/);
});
