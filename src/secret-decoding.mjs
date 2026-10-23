// Detection only: decoded provider data is never returned to an output sink.
// This is defence in depth. Provider diagnostics must first discard free text.
const MAX_DEPTH = 6;
const MAX_STATES = 131072;
const MAX_BYTES = 64 * 1024 * 1024;

function refused(code) {
  const error = new Error(code === 'SECRET_DECODE_MATCH'
    ? 'Secret detected during bounded decoding' : 'Secret decoding budget exceeded');
  error.code = code;
  return error;
}

/** Visit bounded JSON, percent, hex and base64 decoding paths, failing closed.
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
    const unescaped = text.replace(/\\u([\da-f]{4})|\\(["\\/bfnrt])/gi, (_match, code, short) => code
      ? String.fromCharCode(Number.parseInt(code, 16))
      : ({ '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' })[short]);
    if (unescaped !== text) enqueue(unescaped, depth + 1);
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
