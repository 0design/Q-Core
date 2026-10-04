/** Typed boundaries shared by executable workflows and executable components. */
import { resolveTemplateReport, resolveTemplateValue } from './template.mjs';

export const MATERIAL_TYPES = ['string', 'number', 'integer', 'boolean', 'object', 'array', 'null'];
export const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
export const safeName = value => typeof value === 'string' && /^[a-zA-Z_][a-zA-Z0-9_-]*$/.test(value) && !['__proto__', 'constructor', 'prototype'].includes(value);

export function assertType(value, schema, path) {
  const valid = schema.type === 'null' ? value === null
    : schema.type === 'array' ? Array.isArray(value)
    : schema.type === 'object' ? object(value)
    : schema.type === 'integer' ? Number.isSafeInteger(value)
    : schema.type === 'number' ? typeof value === 'number' && Number.isFinite(value)
    : typeof value === schema.type;
  if (!valid) throw new Error(`${path}: expected ${schema.type}`);
  if (schema.items && Array.isArray(value)) value.forEach((item, index) => assertType(item, schema.items, `${path}[${index}]`));
}

export function validatePorts(raw = {}, { output = false, path = 'inputs' } = {}) {
  if (!object(raw)) throw new Error(`${path}: must be a mapping`);
  const ports = {};
  for (const [name, schema] of Object.entries(raw)) {
    if (!safeName(name) || !object(schema) || !MATERIAL_TYPES.includes(schema.type)) throw new Error(`${path}.${name}: needs a safe name and explicit supported type`);
    if (schema.required !== undefined && typeof schema.required !== 'boolean') throw new Error(`${path}.${name}.required: must be boolean`);
    if (schema.items !== undefined) {
      if (schema.type !== 'array' || !object(schema.items) || !MATERIAL_TYPES.includes(schema.items.type)) throw new Error(`${path}.${name}.items: needs an array item type`);
    }
    if (output && !Object.hasOwn(schema, 'value')) throw new Error(`${path}.${name}.value: output binding is required`);
    if (!output && Object.hasOwn(schema, 'default')) assertType(schema.default, schema, `${path}.${name}.default`);
    ports[name] = structuredClone(schema);
  }
  return ports;
}

export function bindInputs(ports = {}, values = {}) {
  if (!object(values)) throw new Error('inputs: must be an object');
  const bound = {};
  for (const name of Object.keys(values)) if (!Object.hasOwn(ports, name)) throw new Error(`inputs.${name}: undeclared input`);
  for (const [name, schema] of Object.entries(ports)) {
    let value = Object.hasOwn(values, name) ? values[name] : schema.default;
    if (value === undefined) {
      if (schema.required !== false) throw new Error(`inputs.${name}: required input is missing`);
      continue;
    }
    assertType(value, schema, `inputs.${name}`);
    bound[name] = structuredClone(value);
  }
  return bound;
}

/** A whole reference retains its JSON type. Mixed text remains a string.
 * Substituted data is never scanned again as template code. */
export function resolveBinding(value, context) {
  if (typeof value === 'string') {
    if (/^\{\{[^{}]+\}\}$/.test(value.trim())) {
      const result = resolveTemplateValue(value, context);
      if (result === undefined) throw new Error(`Unresolved binding: ${value}`);
      return structuredClone(result);
    }
    const result = resolveTemplateReport(value, context);
    if (result.unresolved.length) throw new Error(`Unresolved binding: ${result.unresolved.join(', ')}`);
    return result.text;
  }
  if (Array.isArray(value)) return value.map(item => resolveBinding(item, context));
  if (object(value)) {
    const out = {};
    for (const [key, entry] of Object.entries(value)) {
      if (['__proto__', 'constructor', 'prototype'].includes(key)) throw new Error(`Unsafe binding key: ${key}`);
      out[key] = resolveBinding(entry, context);
    }
    return out;
  }
  return value;
}

export function bindOutputs(ports = {}, context) {
  const out = {};
  for (const [name, schema] of Object.entries(ports)) {
    const value = resolveBinding(schema.value, context);
    assertType(value, schema, `outputs.${name}`);
    out[name] = value;
  }
  return out;
}
