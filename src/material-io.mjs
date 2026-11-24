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
  if (schema.minItems !== undefined && value.length < schema.minItems) throw new Error(`${path}: requires at least ${schema.minItems} item(s)`);
  if (schema.maxItems !== undefined && value.length > schema.maxItems) throw new Error(`${path}: allows at most ${schema.maxItems} item(s)`);
  if (schema.format === 'http-url') {
    let url;
    try { url = new URL(value); } catch { /* The common error below also covers malformed absolute URLs. */ }
    const authority = value.match(/^https?:\/\/([^/?#\\]+)/i)?.[1];
    if (!authority || authority.includes('@') || /[\s\u0000-\u001f\u007f\\{}]/u.test(value) ||
        !url?.hostname || !['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
      throw new Error(`${path}: expected an absolute HTTP(S) URL with a hostname and no credentials`);
    }
  }
  if (schema.items && Array.isArray(value)) value.forEach((item, index) => assertType(item, schema.items, `${path}[${index}]`));
}

function validateSchema(schema, path) {
  if (!object(schema) || !MATERIAL_TYPES.includes(schema.type)) throw new Error(`${path}: needs an explicit supported type`);
  if (schema.required !== undefined && typeof schema.required !== 'boolean') throw new Error(`${path}.required: must be boolean`);
  if (schema.items !== undefined) {
    if (schema.type !== 'array') throw new Error(`${path}.items: needs an array item type`);
    validateSchema(schema.items, `${path}.items`);
  }
  for (const field of ['minItems', 'maxItems']) {
    if (schema[field] !== undefined && (schema.type !== 'array' || !Number.isSafeInteger(schema[field]) || schema[field] < 0)) {
      throw new Error(`${path}.${field}: must be a nonnegative integer on an array`);
    }
  }
  if (schema.minItems !== undefined && schema.maxItems !== undefined && schema.minItems > schema.maxItems) throw new Error(`${path}.minItems: must not exceed maxItems`);
  if (schema.format !== undefined && (schema.type !== 'string' || schema.format !== 'http-url')) throw new Error(`${path}.format: only http-url on a string is supported`);
  if (schema.envPrefix !== undefined && (schema.type !== 'array' || typeof schema.envPrefix !== 'string' || !/^[A-Z][A-Z0-9_]*$/.test(schema.envPrefix))) {
    throw new Error(`${path}.envPrefix: needs an uppercase environment prefix on an array`);
  }
}

export function validatePorts(raw = {}, { output = false, path = 'inputs' } = {}) {
  if (!object(raw)) throw new Error(`${path}: must be a mapping`);
  const ports = {};
  for (const [name, schema] of Object.entries(raw)) {
    if (!safeName(name) || !object(schema) || !MATERIAL_TYPES.includes(schema.type)) throw new Error(`${path}.${name}: needs a safe name and explicit supported type`);
    validateSchema(schema, `${path}.${name}`);
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
    const supplied = Object.hasOwn(values, name);
    let value = supplied ? values[name] : schema.default;
    if (value === undefined) {
      if (schema.required !== false) throw new Error(`inputs.${name}: required input is missing`);
      continue;
    }
    if (!supplied && schema.envPrefix && Array.isArray(value)) {
      value = value.map((entry, index) => {
        const override = process.env[`${schema.envPrefix}${index + 1}`];
        return override === undefined || override === '' ? entry : override;
      });
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
