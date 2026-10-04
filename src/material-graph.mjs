/** Resolve exact local material bytes before execution; export the same closure. */
import { readFileSync, realpathSync, statSync, lstatSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname, relative, join, sep, basename } from 'node:path';
import { createHash } from 'node:crypto';
import { validateManifest, ManifestError } from './manifest.mjs';
import { parseYaml } from './yaml.mjs';
import { bindInputs, assertType } from './material-io.mjs';
import { loadComponentDescriptor } from './component-descriptor.mjs';

export const MAX_CALL_DEPTH = 16;
export const MAX_MATERIALS = 128;
export const MAX_MANIFEST_BYTES = 1_048_576;
export const digest = bytes => createHash('sha256').update(bytes).digest('hex');

function within(root, file) { const rel = relative(root, file); return !rel.startsWith(`..${sep}`) && rel !== '..' && !rel.startsWith(sep); }
function calls(steps) {
  return steps.flatMap(step => [ ...(step.kind === 'workflow-call' ? [step] : []), ...[step.then, step.else, step.default, ...Object.values(step.cases ?? {})].filter(Boolean).flatMap(calls) ]);
}

export function loadManifestGraph(file) {
  const root = realpathSync(dirname(resolve(file)));
  const materialGraph = {};
  const paths = new Map();
  const identities = new Map();
  function visit(target, ancestors, expected, depth) {
    if (depth === 0) target = join(root, basename(target));
    if (depth > MAX_CALL_DEPTH) throw new ManifestError(`dependency depth exceeds ${MAX_CALL_DEPTH}`);
    let actual, bytes;
    try {
      let check = root;
      for (const segment of relative(root, resolve(target)).split(sep)) { check = join(check, segment); if (lstatSync(check).isSymbolicLink()) throw new Error('symlink dependency is not portable'); }
      actual = realpathSync(target);
      if (!within(root, actual)) throw new Error('dependency escapes the root directory (including symlinks)');
      if (!statSync(actual).isFile() || statSync(actual).size > MAX_MANIFEST_BYTES) throw new Error('dependency must be a bounded regular file');
      bytes = readFileSync(actual);
      if (bytes.length > MAX_MANIFEST_BYTES) throw new Error('dependency must be a bounded regular file');
    } catch (error) { throw new ManifestError(`cannot resolve dependency ${target}: ${error.message}`); }
    if (ancestors.includes(actual)) throw new ManifestError(`dependency cycle: ${[...ancestors, actual].map(name => relative(root, name)).join(' -> ')}`);
    const sha256 = digest(bytes);
    if (expected && expected.sha256 !== sha256) throw new ManifestError(`dependency checksum mismatch: ${expected.id}@${expected.version}`);
    const source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    const manifest = validateManifest(parseYaml(source));
    if (expected && (expected.id !== manifest.id || expected.version !== manifest.version || manifest.manifest !== `q-core.${expected.kind}/v1`)) throw new ManifestError(`dependency identity/version/kind mismatch: ${expected.id}@${expected.version}`);
    const identity = `${manifest.manifest}:${manifest.id}@${manifest.version}`;
    if (identities.has(identity) && identities.get(identity) !== sha256) throw new ManifestError(`conflicting exact bytes for ${identity}`);
    identities.set(identity, sha256);
    if (paths.has(actual)) return paths.get(actual);
    if (Object.keys(materialGraph).length >= MAX_MATERIALS) throw new ManifestError(`dependency count exceeds ${MAX_MATERIALS}`);
    const key = relative(root, actual).split(sep).join('/');
    paths.set(actual, key);
    const { file: ignored, ...snapshot } = manifest;
    const node = materialGraph[key] = { manifest: snapshot, sha256, source, resolved: {} };
    for (const [alias, ref] of Object.entries(manifest.dependencies)) node.resolved[alias] = visit(resolve(dirname(actual), ref.path), [...ancestors, actual], ref, depth + 1);
    // Literal arguments can be refused before a paid or outbound step. Dynamic
    // arguments receive the identical check at the invocation boundary.
    for (const call of calls(manifest.steps)) {
      const child = materialGraph[node.resolved[call.config.ref]].manifest;
      const values = JSON.parse(call.config.inputs ?? '{}');
      for (const name of Object.keys(values)) if (!Object.hasOwn(child.inputs, name)) throw new ManifestError(`call ${call.id}: undeclared child input ${name}`);
      for (const [name, port] of Object.entries(child.inputs)) if (!Object.hasOwn(values, name) && port.required !== false && !Object.hasOwn(port, 'default')) throw new ManifestError(`call ${call.id}: missing required child input ${name}`);
      for (const [name, value] of Object.entries(values)) {
        const inputRef = typeof value === 'string' && value.match(/^\{\{\s*inputs\.([a-zA-Z_][a-zA-Z0-9_-]*)\s*\}\}$/);
        if (inputRef) {
          const input = manifest.inputs[inputRef[1]];
          if (!input) throw new ManifestError(`call ${call.id}: unknown parent input ${inputRef[1]}`);
          if (input.type !== child.inputs[name].type && !(input.type === 'integer' && child.inputs[name].type === 'number')) throw new ManifestError(`call ${call.id}: input ${name} expects ${child.inputs[name].type}, parent input is ${input.type}`);
        } else if (!JSON.stringify(value).includes('{{')) try { assertType(value, child.inputs[name], `inputs.${name}`); } catch (error) { throw new ManifestError(`call ${call.id}: ${error.message}`); }
      }
      if (!JSON.stringify(values).includes('{{')) try { bindInputs(child.inputs, values); } catch (error) { throw new ManifestError(`call ${call.id}: ${error.message}`); }
    }
    return key;
  }
  const materialKey = visit(resolve(file), [], null, 0);
  // Cached shared dependencies must still respect the longest path, not only
  // the first shallow path through which they were loaded.
  const heights = new Map();
  const height = (key, chain = []) => {
    if (chain.includes(key)) throw new ManifestError('dependency cycle in resolved graph');
    if (heights.has(key)) return heights.get(key);
    const result = Math.max(0, ...Object.values(materialGraph[key].resolved).map(child => 1 + height(child, [...chain, key])));
    heights.set(key, result); return result;
  };
  if (height(materialKey) > MAX_CALL_DEPTH) throw new ManifestError(`dependency depth exceeds ${MAX_CALL_DEPTH}`);
  return { ...materialGraph[materialKey].manifest, file: resolve(file), materialKey, materialGraph };
}

/** Destination must be new, so no existing user files can be overwritten. */
export function exportMaterialBundle(file, destination) {
  if (file.endsWith('.json')) {
    const descriptor = loadComponentDescriptor(file), source = readFileSync(file), target = resolve(destination);
    if (existsSync(target)) throw new ManifestError('export destination already exists; choose a new directory');
    const path = basename(file);
    if (path === 'bundle.json') throw new ManifestError('bundle.json is reserved for the export index');
    const bundle = { protocolVersion: 'q-core.bundle/v1', entry: path, executable: false, files: [{ path, sha256: digest(source), id: descriptor.id, version: descriptor.version ?? null, kind: 'component', format: 'descriptor' }] };
    mkdirSync(target, { recursive: true }); writeFileSync(join(target, path), source, { flag: 'wx' });
    writeFileSync(join(target, 'bundle.json'), JSON.stringify(bundle, null, 2) + '\n', { flag: 'wx' }); return bundle;
  }
  const manifest = loadManifestGraph(file);
  const target = resolve(destination);
  if (existsSync(target)) throw new ManifestError('export destination already exists; choose a new directory');
  const files = Object.entries(manifest.materialGraph).map(([path, node]) => ({ path, sha256: node.sha256, id: node.manifest.id, version: node.manifest.version, kind: node.manifest.manifest === 'q-core.component/v1' ? 'component' : 'workflow' }));
  const bundle = { protocolVersion: 'q-core.bundle/v1', entry: manifest.materialKey, files };
  if (files.some(file => file.path === 'bundle.json')) throw new ManifestError('bundle.json is reserved for the export index');
  mkdirSync(target, { recursive: true });
  for (const [path, node] of Object.entries(manifest.materialGraph)) { const output = join(target, path); mkdirSync(dirname(output), { recursive: true }); writeFileSync(output, node.source, { flag: 'wx' }); }
  writeFileSync(join(target, 'bundle.json'), JSON.stringify(bundle, null, 2) + '\n', { flag: 'wx' });
  return bundle;
}
