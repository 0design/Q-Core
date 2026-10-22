import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { loadManifestGraph, digest, MAX_CALL_DEPTH } from '../src/material-graph.mjs';
import { loadWorkflow } from '../src/workflow-policy.mjs';
import { ManifestError } from '../src/manifest.mjs';
import { YamlError } from '../src/yaml.mjs';
import { loadComponentDescriptor } from '../src/component-descriptor.mjs';
const yaml = doc => Object.entries(doc).map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join('\n') + '\n';
const manifest = (id, extra = {}) => ({ manifest: 'q-core.workflow/v1', id, version: '1.0.0', steps: [{ id: 'clean', kind: 'deduplicate', config: { source: '[]' } }], ...extra });
function directory(t) { const dir = mkdtempSync(join(tmpdir(), 'q-core-diagnostic-')); t.after(() => rmSync(dir, { recursive: true, force: true })); return dir; }
function put(dir, path, body) { mkdirSync(dirname(join(dir, path)), { recursive: true }); writeFileSync(join(dir, path), typeof body === 'object' && !Buffer.isBuffer(body) ? yaml(body) : body); }
function child(dir, path, body, id = 'child') { const bytes = typeof body === 'object' && !Buffer.isBuffer(body) ? yaml(body) : body; put(dir, path, bytes); return { kind: 'workflow', id, version: '1.0.0', path, sha256: digest(bytes) }; }
const parent = ref => manifest('parent', { dependencies: { child: ref }, steps: [{ id: 'call', kind: 'workflow-call', config: { ref: 'child' } }] });
function thrown(fn) { try { fn(); assert.fail('Expected a diagnostic'); } catch (error) { assert.notEqual(error.code, 'ERR_ASSERTION'); return error; } }

test('invalid nested YAML and manifest fields preserve their own source, class and coordinates', t => {
  const dir = directory(t);
  const cases = [
    ['manifest', manifest('child', { steps: [{ id: 'bad', kind: 'unknown-kind' }] }), ManifestError, 'steps[0].kind', null],
    ['yaml', 'manifest: q-core.workflow/v1\nid: child\nversion: "1.0.0"\nsteps:\n\t- id: bad\n', YamlError, null, 5],
  ];
  for (const [name, source, klass, path, line] of cases) {
    const ref = child(dir, `deps/${name}.yaml`, source); put(dir, 'parent.yaml', parent(ref));
    const error = thrown(() => loadWorkflow(join(dir, 'parent.yaml')));
    assert(error instanceof klass); assert.equal(error.name, klass.name);
    assert.equal(error.materialPath, `deps/${name}.yaml`); assert.equal(error.path ?? null, path); assert.equal(error.line ?? null, line);
    assert(!error.message.includes(dir)); assert.notEqual(error.materialPath, 'parent.yaml');
  }
});

test('invalid UTF-8 preserves its code and actual child provenance', t => {
  const dir = directory(t), ref = child(dir, 'broken.yaml', Buffer.from([0xc3, 0x28]));
  put(dir, 'parent.yaml', parent(ref));
  const error = thrown(() => loadManifestGraph(join(dir, 'parent.yaml')));
  assert.equal(error.code, 'ERR_ENCODING_INVALID_ENCODED_DATA'); assert.equal(error.materialPath, 'broken.yaml');
});

test('missing/hash/identity/symlink failures point to the referencing material and pin field', t => {
  const dir = directory(t), ref = child(dir, 'child.yaml', manifest('child'));
  for (const [patch, field, message] of [[{ path: 'missing.yaml' }, 'path', /cannot resolve/], [{ sha256: '0'.repeat(64) }, 'sha256', /checksum/], [{ id: 'wrong' }, 'id', /identity/], [{ version: '2.0.0' }, 'version', /identity/], [{ kind: 'component' }, 'kind', /identity/]]) {
    put(dir, 'parent.yaml', parent({ ...ref, ...patch }));
    const error = thrown(() => loadManifestGraph(join(dir, 'parent.yaml')));
    assert.equal(error.materialPath, 'parent.yaml'); assert.equal(error.path, `dependencies.child.${field}`); assert.match(error.message, message); assert(!error.message.includes(dir));
  }
  symlinkSync(tmpdir(), join(dir, 'outside')); put(dir, 'parent.yaml', parent({ ...ref, path: 'outside/private.yaml' }));
  const error = thrown(() => loadManifestGraph(join(dir, 'parent.yaml')));
  assert.equal(error.materialPath, 'parent.yaml'); assert.equal(error.path, 'dependencies.child.path'); assert(!error.message.includes(tmpdir()));
  const middle = child(dir, 'nested/middle.yaml', manifest('middle', { dependencies: { child: { ...ref, path: 'missing.yaml' } } }), 'middle');
  put(dir, 'parent.yaml', parent(middle));
  const nested = thrown(() => loadManifestGraph(join(dir, 'parent.yaml')));
  assert.equal(nested.materialPath, 'nested/middle.yaml'); assert.equal(nested.path, 'dependencies.child.path');
  put(dir, 'cycle.yaml', manifest('cycle', { dependencies: { self: { kind: 'workflow', id: 'cycle', version: '1.0.0', path: 'cycle.yaml', sha256: '0'.repeat(64) } } }));
  const cycle = thrown(() => loadManifestGraph(join(dir, 'cycle.yaml')));
  assert.equal(cycle.materialPath, 'cycle.yaml'); assert.equal(cycle.path, 'dependencies.self.path'); assert.match(cycle.message, /cycle/); assert(!cycle.message.includes(dir));
});

test('binding diagnostics locate the actual calling control-flow field', t => {
  const dir = directory(t), ref = child(dir, 'child.yaml', manifest('child', { inputs: { items: { type: 'array' } } }));
  const doc = parent(ref); doc.steps = [{ id: 'choose', kind: 'if', config: { condition: 'true' }, then: [{ id: 'bad', kind: 'workflow-call', config: { ref: 'child', inputs: '{"items":1}' } }] }];
  put(dir, 'parent.yaml', doc);
  const error = thrown(() => loadManifestGraph(join(dir, 'parent.yaml')));
  assert.equal(error.materialPath, 'parent.yaml'); assert.equal(error.path, 'steps[0].then[0].config.inputs'); assert.match(error.message, /expected array/);
});

test('child outbound human-policy skips optional workspace approval and preserves child-relative diagnostics', t => {
  const dir = directory(t);
  let ref = child(dir, 'child.yaml', manifest('child', { steps: [{ id: 'send', kind: 'api-request', config: { url: 'https://example.test/never-called' } }] }));
  put(dir, 'parent.yaml', parent(ref));
  const gate = thrown(() => loadWorkflow(join(dir, 'parent.yaml')));
  assert.equal(gate.materialPath, 'child.yaml'); assert.equal(gate.path, 'steps[0]'); assert.match(gate.message, /GATE_REQUIRED/);
  const guarded = parent(ref); guarded.steps.unshift({ id: 'approve', kind: 'approval-gate', config: { reviewer: 'human', bind: 'sha256' } });
  put(dir, 'parent.yaml', guarded); assert.doesNotThrow(() => loadWorkflow(join(dir, 'parent.yaml'))); // Validation only; no approval or send.
  ref = child(dir, 'child.yaml', manifest('child', { steps: [{ id: 'apply', kind: 'workspace-apply', config: { source: '{"files":[{"path":"value.txt","content":"bounded"}]}' } }, { id: 'send', kind: 'api-request', config: { url: 'https://example.test/never-called' } }] }));
  put(dir, 'parent.yaml', parent(ref));
  const outbound = thrown(() => loadWorkflow(join(dir, 'parent.yaml')));
  assert.equal(outbound.materialPath, 'child.yaml'); assert.equal(outbound.path, 'steps[1]'); assert.match(outbound.message, /GATE_REQUIRED: step "send"/);
  ref = child(dir, 'child.yaml', manifest('child', { steps: [{ id: 'read', kind: 'workspace-read' }] })); put(dir, 'parent.yaml', parent(ref));
  const unused = thrown(() => loadWorkflow(join(dir, 'parent.yaml')));
  assert.equal(unused.materialPath, 'child.yaml'); assert.equal(unused.path, 'steps[0]'); assert.match(unused.message, /UNUSED_WORKSPACE_READ/);
});

test('root and descriptor failures are local; unresolved roots and cached graph depth remain explicitly unlocated', t => {
  const dir = directory(t); put(dir, 'root.yaml', manifest('bad', { steps: [{ id: 'bad', kind: 'unknown-kind' }] }));
  assert.equal(thrown(() => loadManifestGraph(join(dir, 'root.yaml'))).materialPath, 'root.yaml');
  put(dir, 'component.json', JSON.stringify({ id: 'component', name: '', kind: 'step' }));
  const descriptor = thrown(() => loadComponentDescriptor(join(dir, 'component.json')));
  assert.equal(descriptor.materialPath, 'component.json'); assert.equal(descriptor.path, 'name');
  assert.equal(thrown(() => loadManifestGraph(join(dir, 'missing-dir/root.yaml'))).materialPath, null);
  let ref = child(dir, 'shared-end.yaml', manifest('shared-end'), 'shared-end');
  for (let i = 3; i >= 0; i--) ref = child(dir, `shared-${i}.yaml`, manifest(`shared-${i}`, { dependencies: { child: ref } }), `shared-${i}`);
  const shallow = ref;
  for (let i = MAX_CALL_DEPTH - 3; i >= 0; i--) ref = child(dir, `chain-${i}.yaml`, manifest(`chain-${i}`, { dependencies: { child: ref } }), `chain-${i}`);
  put(dir, 'root.yaml', manifest('root', { dependencies: { shallow, deep: ref } }));
  const depth = thrown(() => loadManifestGraph(join(dir, 'root.yaml')));
  assert.equal(depth.materialPath, null); assert.equal(depth.path, null); assert.match(depth.message, /depth/);
});
