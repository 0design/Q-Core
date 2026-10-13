import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, symlinkSync, mkdirSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { digest, exportMaterialBundle, loadManifestGraph } from '../src/material-graph.mjs';
import { validateManifest } from '../src/manifest.mjs';

const cli = resolve('bin/q-core.mjs');
const yaml = doc => Object.entries(doc).map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join('\n') + '\n';
const simple = { manifest: 'q-core.workflow/v1', id: 'simple', version: '1.0.0', steps: [{ id: 'clean', kind: 'deduplicate', config: { source: '[]' } }] };
const leaf = { manifest: 'q-core.component/v1', id: 'leaf', version: '1.0.0', inputs: {}, outputs: { removed: { type: 'integer', value: '{{steps.clean.output.removed}}' } }, steps: [{ id: 'clean', kind: 'deduplicate', config: { source: '[]' } }] };
function directory(t) { const dir = mkdtempSync(join(tmpdir(), 'q-core-49-review-')); t.after(() => rmSync(dir, { recursive: true, force: true })); return dir; }
const write = (dir, name, doc) => { const bytes = yaml(doc); writeFileSync(join(dir, name), bytes); return digest(bytes); };
const parentOf = (path, sha256) => ({ manifest: 'q-core.workflow/v1', id: 'parent', version: '1.0.0', dependencies: { leaf: { kind: 'component', id: 'leaf', version: '1.0.0', path, sha256 } }, steps: [{ id: 'call', kind: 'workflow-call', config: { ref: 'leaf', inputs: '{}' } }] });
const validate = (cwd, args) => spawnSync(process.execPath, [cli, 'validate', ...args], { cwd, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: cwd } });

test('validate --json keeps the Core.47 shape; --graph adds the verified material graph', t => {
  const dir = directory(t);
  write(dir, 'simple.yaml', simple);
  const plain = validate(dir, ['simple.yaml', '--json']);
  assert.equal(plain.status, 0, plain.stderr);
  const out = JSON.parse(plain.stdout);
  assert.deepEqual(Object.keys(out), ['id', 'name', 'version', 'description', 'owner', 'enabled', 'triggers', 'settings', 'steps', 'file']);
  assert.equal(out.file, 'simple.yaml');
  const graph = JSON.parse(validate(dir, ['simple.yaml', '--json', '--graph']).stdout);
  assert.equal(graph.file, 'simple.yaml');
  assert.equal(graph.materialKey, 'simple.yaml');
  assert.ok(graph.materialGraph['simple.yaml'].source.startsWith('manifest:'));
});

test('unknown top-level and step keys are dropped, as before nested materials', () => {
  const manifest = validateManifest({ ...simple, extra: 'x', steps: [{ ...simple.steps[0], note: 'y' }] });
  assert.equal(Object.hasOwn(manifest, 'extra'), false);
  assert.equal(Object.hasOwn(manifest.steps[0], 'note'), false);
});

test('a symlinked entry file loads and validates; a symlinked dependency is refused with a reason', t => {
  const dir = directory(t);
  mkdirSync(join(dir, 'real'));
  const sha = write(join(dir, 'real'), 'leaf.yaml', leaf);
  write(join(dir, 'real'), 'parent.yaml', parentOf('./leaf.yaml', sha));
  symlinkSync(join(dir, 'real/parent.yaml'), join(dir, 'entry.yaml'));
  const graph = loadManifestGraph(join(dir, 'entry.yaml'));
  assert.deepEqual(Object.keys(graph.materialGraph).sort(), ['leaf.yaml', 'parent.yaml']);
  assert.equal(validate(dir, ['entry.yaml']).status, 0);

  symlinkSync(join(dir, 'real/leaf.yaml'), join(dir, 'real/linked.yaml'));
  write(join(dir, 'real'), 'linked-parent.yaml', parentOf('./linked.yaml', sha));
  assert.throws(() => loadManifestGraph(join(dir, 'real/linked-parent.yaml')), /linked\.yaml: a dependency may not be a symlink/);
  assert.throws(() => loadManifestGraph(join(dir, 'missing.yaml')), /cannot resolve the material file: file not found/);
});

test('export refuses Bundle.json and names that differ only in case before writing, and leaves no partial folder', t => {
  const dir = directory(t);
  const sha = write(dir, 'Bundle.json', leaf);
  write(dir, 'parent.yaml', parentOf('./Bundle.json', sha));
  assert.throws(() => exportMaterialBundle(join(dir, 'parent.yaml'), join(dir, 'out')), /bundle\.json is reserved/);
  assert.equal(existsSync(join(dir, 'out')), false);
  assert.deepEqual(readdirSync(dir).filter(name => name.includes('export-')), []);

  write(dir, 'leaf.yaml', leaf);
  const ok = exportMaterialBundle(join(dir, 'leaf.yaml'), join(dir, 'leaf-out'));
  assert.equal(ok.entry, 'leaf.yaml');
  assert.deepEqual(readdirSync(join(dir, 'leaf-out')).sort(), ['bundle.json', 'leaf.yaml']);
  assert.equal(readFileSync(join(dir, 'leaf-out/leaf.yaml'), 'utf8'), yaml(leaf));
  assert.throws(() => exportMaterialBundle(join(dir, 'leaf.yaml'), join(dir, 'leaf-out')), /already exists/);
});
