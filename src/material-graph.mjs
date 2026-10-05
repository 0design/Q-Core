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
function calls(steps, path = 'steps') {
  return steps.flatMap((step, index) => {
    const at = `${path}[${index}]`;
    return [ ...(step.kind === 'workflow-call' ? [{ step, path: at }] : []),
      ...['then', 'else', 'default'].flatMap(branch => step[branch] ? calls(step[branch], `${at}.${branch}`) : []),
      ...Object.entries(step.cases ?? {}).flatMap(([name, branch]) => calls(branch, `${at}.cases.${name}`)) ];
  });
}
const located = (error, materialPath) => Object.assign(error, { materialPath: materialPath ?? null });
const referenceError = (message, reference, field = 'path') => located(new ManifestError(message, reference ? `${reference.path}.${field}` : undefined), reference?.materialPath);

export function loadManifestGraph(file) {
  let root;
  try { root = realpathSync(dirname(resolve(file))); }
  catch { throw referenceError('cannot resolve material directory'); }
  const portable = target => within(root, resolve(target)) ? relative(root, resolve(target)).split(sep).join('/') : null;
  const materialGraph = {};
  const paths = new Map();
  const identities = new Map();
  function visit(target, ancestors, expected, depth, reference) {
    if (depth === 0) target = join(root, basename(target));
    if (depth > MAX_CALL_DEPTH) throw referenceError(`dependency depth exceeds ${MAX_CALL_DEPTH}`, reference);
    let actual, bytes;
    try {
      let check = root;
      for (const segment of relative(root, resolve(target)).split(sep)) { check = join(check, segment); if (lstatSync(check).isSymbolicLink()) throw new Error('symlink dependency is not portable'); }
      actual = realpathSync(target);
      if (!within(root, actual)) throw new Error('dependency escapes the root directory (including symlinks)');
      if (!statSync(actual).isFile() || statSync(actual).size > MAX_MANIFEST_BYTES) throw new Error('dependency must be a bounded regular file');
      bytes = readFileSync(actual);
      if (bytes.length > MAX_MANIFEST_BYTES) throw new Error('dependency must be a bounded regular file');
    } catch (error) {
      // Node filesystem errors include absolute host paths. Keep the portable reference and a bounded reason.
      const reason = error.code === 'ENOENT' ? 'file not found' : error.code ? `filesystem error (${error.code})` : error.message;
      throw referenceError(`cannot resolve dependency ${portable(target) ?? '<outside root>'}: ${reason}`, reference);
    }
    if (ancestors.includes(actual)) throw referenceError(`dependency cycle: ${[...ancestors, actual].map(portable).join(' -> ')}`, reference);
    const sha256 = digest(bytes);
    if (expected && expected.sha256 !== sha256) throw referenceError(`dependency checksum mismatch: ${expected.id}@${expected.version}`, reference, 'sha256');
    const key = portable(actual);
    let source, manifest;
    try { source = new TextDecoder('utf-8', { fatal: true }).decode(bytes); manifest = validateManifest(parseYaml(source)); }
    catch (error) { throw located(error, key); } // Preserve the original class, name, code, semantic path and YAML line.
    if (expected && (expected.id !== manifest.id || expected.version !== manifest.version || manifest.manifest !== `q-core.${expected.kind}/v1`)) {
      const field = expected.id !== manifest.id ? 'id' : expected.version !== manifest.version ? 'version' : 'kind';
      throw referenceError(`dependency identity/version/kind mismatch: ${expected.id}@${expected.version}`, reference, field);
    }
    const identity = `${manifest.manifest}:${manifest.id}@${manifest.version}`;
    if (identities.has(identity) && identities.get(identity) !== sha256) throw referenceError(`conflicting exact bytes for ${identity}`, reference, 'sha256');
    identities.set(identity, sha256);
    if (paths.has(actual)) return paths.get(actual);
    if (Object.keys(materialGraph).length >= MAX_MATERIALS) throw referenceError(`dependency count exceeds ${MAX_MATERIALS}`, reference);
    paths.set(actual, key);
    const { file: ignored, ...snapshot } = manifest;
    const node = materialGraph[key] = { manifest: snapshot, sha256, source, resolved: {} };
    for (const [alias, ref] of Object.entries(manifest.dependencies)) node.resolved[alias] = visit(resolve(dirname(actual), ref.path), [...ancestors, actual], ref, depth + 1, { materialPath: key, path: `dependencies.${alias}` });
    // Literal arguments can be refused before a paid or outbound step. Dynamic
    // arguments receive the identical check at the invocation boundary.
    for (const { step: call, path } of calls(manifest.steps)) {
      const invalidCall = message => located(new ManifestError(`call ${call.id}: ${message}`, `${path}.config.inputs`), key);
      const child = materialGraph[node.resolved[call.config.ref]].manifest;
      const values = JSON.parse(call.config.inputs ?? '{}');
      for (const name of Object.keys(values)) if (!Object.hasOwn(child.inputs, name)) throw invalidCall(`undeclared child input ${name}`);
      for (const [name, port] of Object.entries(child.inputs)) if (!Object.hasOwn(values, name) && port.required !== false && !Object.hasOwn(port, 'default')) throw invalidCall(`missing required child input ${name}`);
      for (const [name, value] of Object.entries(values)) {
        const inputRef = typeof value === 'string' && value.match(/^\{\{\s*inputs\.([a-zA-Z_][a-zA-Z0-9_-]*)\s*\}\}$/);
        if (inputRef) {
          const input = manifest.inputs[inputRef[1]];
          if (!input) throw invalidCall(`unknown parent input ${inputRef[1]}`);
          if (input.type !== child.inputs[name].type && !(input.type === 'integer' && child.inputs[name].type === 'number')) throw invalidCall(`input ${name} expects ${child.inputs[name].type}, parent input is ${input.type}`);
        } else if (!JSON.stringify(value).includes('{{')) try { assertType(value, child.inputs[name], `inputs.${name}`); } catch (error) { throw invalidCall(error.message); }
      }
      if (!JSON.stringify(values).includes('{{')) try { bindInputs(child.inputs, values); } catch (error) { throw invalidCall(error.message); }
    }
    return key;
  }
  const materialKey = visit(resolve(file), [], null, 0);
  // Cached shared dependencies must still respect the longest path, not only
  // the first shallow path through which they were loaded.
  const heights = new Map();
  const height = (key, chain = []) => {
    if (chain.includes(key)) throw referenceError('dependency cycle in resolved graph');
    if (heights.has(key)) return heights.get(key);
    const result = Math.max(0, ...Object.values(materialGraph[key].resolved).map(child => 1 + height(child, [...chain, key])));
    heights.set(key, result); return result;
  };
  if (height(materialKey) > MAX_CALL_DEPTH) throw referenceError(`dependency depth exceeds ${MAX_CALL_DEPTH}`);
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
