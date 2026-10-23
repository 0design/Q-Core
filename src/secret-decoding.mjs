// Detection only: decoded provider data is never returned to an output sink.
// This is defence in depth. Provider diagnostics must first discard free text.
import { HTML_NAMED_ENTITIES } from './secret-html-entities.mjs';

const MAX_DEPTH = 6;
const MAX_STATES = 131072;
const MAX_BYTES = 64 * 1024 * 1024;

// HTML numeric references use these Windows-1252 replacements for the C1
// range. Invalid scalar values use the same replacement character as HTML.
const HTML_NUMERIC_REPLACEMENTS = new Map([
  [128, 8364], [130, 8218], [131, 402], [132, 8222], [133, 8230],
  [134, 8224], [135, 8225], [136, 710], [137, 8240], [138, 352],
  [139, 8249], [140, 338], [142, 381], [145, 8216], [146, 8217],
  [147, 8220], [148, 8221], [149, 8226], [150, 8211], [151, 8212],
  [152, 732], [153, 8482], [154, 353], [155, 8250], [156, 339],
  [158, 382], [159, 376],
]);

function htmlReference(reference) {
  const name = reference.slice(1);
  if (name.startsWith('#')) {
    const hex = /^#x/i.test(name);
    let code = Number.parseInt(name.slice(hex ? 2 : 1), hex ? 16 : 10);
    if (!code || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) code = 0xfffd;
    return String.fromCodePoint(HTML_NUMERIC_REPLACEMENTS.get(code) ?? code);
  }
  // Longest-match HTML behaviour also handles legacy aliases without a
  // semicolon, followed immediately by ordinary text (for example &ampX).
  for (let length = name.length; length; length--) {
    const prefix = name.slice(0, length);
    if (Object.hasOwn(HTML_NAMED_ENTITIES, prefix)) return HTML_NAMED_ENTITIES[prefix] + name.slice(length);
  }
  return reference;
}

function jsonBytes(array) {
  let value;
  try { value = JSON.parse(array); } catch { return array; }
  if (!value.every(byte => Number.isInteger(byte) && byte >= 0 && byte <= 255)) return array;
  return Buffer.from(value).toString('utf8');
}

function refused(code) {
  const error = new Error(code === 'SECRET_DECODE_MATCH'
    ? 'Secret detected during bounded decoding' : 'Secret decoding budget exceeded');
  error.code = code;
  return error;
}

/** Visit bounded JSON/JS, HTML, JSON byte-array, percent, hex and base64
 * decoding paths, failing closed. This finite set is not arbitrary decoding.
 * Four base64 alignments cover arbitrary adjacent/prefixed base64 characters;
 * both hex alignments cover an adjacent hexadecimal prefix. A decoded token
 * is checked even when surrounding bytes are not valid UTF-8.
 */
export function assertNoDecodedSecrets(input, matches, { minSecretBytes = 12 } = {}) {
  // Runtime credentials may be shorter than release-scanner key shapes. Never
  // use a token threshold longer than the smallest registered credential.
  if (!Number.isSafeInteger(minSecretBytes) || minSecretBytes < 1 || minSecretBytes > 12) throw refused('SECRET_DECODE_BUDGET');
  const hex = new RegExp(`[\\da-f]{${minSecretBytes * 2},}`, 'gi');
  const base64Length = Math.max(2, Math.floor(minSecretBytes * 4 / 3));
  const base64 = new RegExp(`[A-Za-z0-9+/_-]{${base64Length},}={0,2}`, 'g');
  const wrappedBase64 = new RegExp(`[A-Za-z0-9+/_-](?:[\\t\\r\\n ]*[A-Za-z0-9+/_-]){${base64Length - 1},}={0,2}`, 'g');
  const initial = Buffer.isBuffer(input) ? input.toString('utf8') : String(input);
  const pending = [], seen = new Set();
  let bytes = 0, states = 0;
  const enqueue = (text, depth) => {
    if (seen.has(text)) return;
    bytes += Buffer.byteLength(text);
    if (depth > MAX_DEPTH || ++states > MAX_STATES || bytes > MAX_BYTES) throw refused('SECRET_DECODE_BUDGET');
    if (matches(text)) throw refused('SECRET_DECODE_MATCH');
    seen.add(text);
    pending.push({ text, depth });
  };
  enqueue(initial, 0);
  while (pending.length) {
    const { text, depth } = pending.pop();
    const unescaped = text.replace(/\\(?:x([\da-f]{2})|u\{([\da-f]+)\}|u([\da-f]{4})|(["\\/bfnrt]))/gi,
      (match, hex, point, unicode, short) => {
        if (hex || unicode) return String.fromCharCode(Number.parseInt(hex ?? unicode, 16));
        if (point) {
          const code = Number.parseInt(point, 16);
          return code <= 0x10ffff ? String.fromCodePoint(code) : match;
        }
        return ({ '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' })[short.toLowerCase()];
      });
    if (unescaped !== text) enqueue(unescaped, depth + 1);
    // HTML5's longest named reference is 32 characters including its
    // semicolon. Numeric references have no lexical length limit, but all
    // traversal and decoded output share the global byte/state/depth budget.
    const html = text.replace(/&(?:#[xX][\da-fA-F]+;?|#\d+;?|[A-Za-z][A-Za-z0-9]{0,31};?)/g, htmlReference);
    if (html !== text) enqueue(html, depth + 1);
    // Only JSON arrays containing numbers that resolve to integer bytes are
    // interpreted. No eval, general JSON object traversal, or code execution.
    const arrays = text.replace(/\[[\s\d,+.eE-]*\]/g, jsonBytes);
    if (arrays !== text) enqueue(arrays, depth + 1);
    const percent = text.replace(/(?:%[\da-f]{2})+/gi, value => Buffer.from(value.replaceAll('%', ''), 'hex').toString('utf8'));
    if (percent !== text) enqueue(percent, depth + 1);
    for (const match of text.matchAll(hex)) {
      for (let offset = 0; offset < 2; offset++) enqueue(Buffer.from(match[0].slice(offset), 'hex').toString('utf8'), depth + 1);
    }
    for (const match of text.matchAll(base64)) {
      for (let offset = 0; offset < 4; offset++) enqueue(Buffer.from(match[0].slice(offset), 'base64').toString('utf8'), depth + 1);
    }
    // MIME and other ordinary base64 transports may wrap between any two
    // characters. Inspect the compacted run as well as its individual tokens.
    for (const match of text.matchAll(wrappedBase64)) {
      if (!/\s/.test(match[0])) continue;
      const compact = match[0].replace(/\s/g, '');
      for (let offset = 0; offset < 4; offset++) enqueue(Buffer.from(compact.slice(offset), 'base64').toString('utf8'), depth + 1);
    }
  }
}
