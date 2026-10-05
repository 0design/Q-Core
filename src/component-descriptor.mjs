/** Registry block descriptors describe an operation; they are not executable manifests. */
import { readFileSync } from 'node:fs';
import { ManifestError } from './manifest.mjs';
import { object, safeName, MATERIAL_TYPES } from './material-io.mjs';

const PORT_TYPES = new Set([...MATERIAL_TYPES, 'reference', 'step-id', 'json-string', 'external-json']);
function strings(value, path, { required = false, pattern } = {}) {
  if (value === undefined && !required) return;
  if (!Array.isArray(value) || value.some(entry => typeof entry !== 'string' || !entry.trim() || (pattern && !pattern.test(entry)))) throw new ManifestError('must be a list of valid nonempty strings', path);
}

export function validateComponentDescriptor(doc) {
  if (!object(doc)) throw new ManifestError('component descriptor must be an object');
  if (Object.hasOwn(doc, 'manifest') || Object.hasOwn(doc, 'steps')) throw new ManifestError('executable components use q-core.component/v1 YAML; a Registry descriptor does not execute');
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(doc.id ?? '')) throw new ManifestError('lowercase component id is required', 'id');
  if (typeof doc.name !== 'string' || !doc.name.trim()) throw new ManifestError('nonempty name is required', 'name');
  if (doc.version !== undefined && (typeof doc.version !== 'string' || !doc.version.trim())) throw new ManifestError('version must be a nonempty string', 'version');
  const plannedAdapter = doc.kind === undefined && doc.contentType === 'component' && doc.implementation?.status === 'planned' && Array.isArray(doc.operations);
  if (!['step', 'trigger', 'composite'].includes(doc.kind) && !plannedAdapter) throw new ManifestError('kind must be step, trigger or composite (or an explicitly planned adapter)', 'kind');
  if (doc.contentType !== undefined && doc.contentType !== 'component') throw new ManifestError('must be component', 'contentType');
  for (const direction of ['input', 'output']) {
    const ports = doc[direction];
    if (ports === undefined && plannedAdapter) continue;
    if (!object(ports)) throw new ManifestError('must be a port mapping', direction);
    for (const [name, port] of Object.entries(ports)) {
      if (!safeName(name) || !object(port) || typeof port.type !== 'string' || !port.type.split('|').every(type => PORT_TYPES.has(type.trim()))) throw new ManifestError('invalid descriptor port/type', `${direction}.${name}`);
      if (port.required !== undefined && typeof port.required !== 'boolean') throw new ManifestError('must be boolean', `${direction}.${name}.required`);
    }
  }
  strings(doc.needsEnv, 'needsEnv', { required: !plannedAdapter, pattern: /^[A-Z_][A-Z0-9_]*$/ });
  strings(doc.usedBy, 'usedBy');
  if (doc.kind === 'composite') {
    strings(doc.builtFrom, 'builtFrom', { required: true, pattern: /^[a-z0-9]+(?:-[a-z0-9]+)*$/ });
    if (!doc.builtFrom.length) throw new ManifestError('composite needs at least one source component', 'builtFrom');
  }
  if (plannedAdapter) strings(doc.operations, 'operations', { required: true });
  for (const key of ['implementation', 'acceptance']) if (doc[key] !== undefined && !object(doc[key])) throw new ManifestError('must be an object', key);
  return structuredClone(doc);
}

export function loadComponentDescriptor(file) {
  let bytes;
  try { bytes = readFileSync(file); }
  catch (error) { throw Object.assign(new ManifestError('cannot read component descriptor'), { code: error.code, materialPath: null }); }
  try {
    if (bytes.length > 1_048_576) throw new ManifestError('component descriptor exceeds 1 MiB');
    return validateComponentDescriptor(JSON.parse(bytes.toString('utf8')));
  } catch (error) { throw Object.assign(error, { materialPath: String(file).split(/[\\/]/).at(-1) }); }
}
