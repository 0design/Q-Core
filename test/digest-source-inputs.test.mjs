import test from 'node:test';
import assert from 'node:assert/strict';
import { validateManifest } from '../src/manifest.mjs';
import { createRun } from '../src/run.mjs';
import { bindInputs, validatePorts } from '../src/material-io.mjs';

const DEFAULTS = ['https://media.example/feed', 'https://blog.example/atom'];
const PREFIX = 'QF_DIGEST_INPUT_TEST_';
const schema = (extra = {}) => ({
  type: 'array', minItems: 1, maxItems: 20,
  items: { type: 'string', format: 'http-url' },
  default: DEFAULTS, envPrefix: PREFIX, ...extra,
});
const manifest = (port = schema()) => validateManifest({
  manifest: 'q-core.workflow/v1', id: 'digest-input-contract',
  inputs: { sources: port },
  steps: [{ id: 'fetch', kind: 'fetch', config: { url: 'https://unused.example/feed' } }],
});
const run = (inputs, port) => createRun(manifest(port), { inputs });

function withEnv(values, work) {
  const old = Object.fromEntries(Object.keys(values).map(name => [name, process.env[name]]));
  for (const [name, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
  try { return work(); } finally {
    for (const [name, value] of Object.entries(old)) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  }
}

test('digest source defaults are ordered, isolated arrays and accept absolute HTTP(S) addresses', () => {
  withEnv({ [`${PREFIX}1`]: undefined, [`${PREFIX}2`]: undefined }, () => {
    const first = run();
    assert.deepEqual(first.inputs.sources, DEFAULTS);
    first.inputs.sources[0] = 'https://mutated.example/feed';
    assert.deepEqual(run().inputs.sources, DEFAULTS);
    assert.deepEqual(run({ sources: ['HTTP://localhost:8080/feed?name=a%20b', 'https://example.org/atom#entries'] }).inputs.sources,
      ['HTTP://localhost:8080/feed?name=a%20b', 'https://example.org/atom#entries']);
  });
});

test('digest source inputs reject empty or oversized arrays and malformed addresses before execution', () => {
  assert.throws(() => run({ sources: [] }), /sources: requires at least 1 item/);
  assert.throws(() => run({ sources: Array(21).fill(DEFAULTS[0]) }), /sources: allows at most 20 item/);
  assert.throws(() => run({ sources: 'https://example.org/feed' }), /sources: expected array/);
  assert.throws(() => run({ sources: [false] }), /sources\[0\]: expected string/);
  for (const address of [
    '', '/relative/feed', '//example.org/feed', 'not a URL', 'ftp://example.org/feed',
    'http:example.org/feed', 'https:///example.org/feed', 'https://', 'https://example.org:99999/feed',
    ' https://example.org/feed', 'https://example.org/feed ', 'https://example.org/a b',
    'https://example.org/\nfeed', 'https://example.org/\u0000feed', 'https://example.org\\feed',
    'https://user:password@example.org/feed', 'https://@example.org/feed',
    '{{env.QF_DIGEST_SECRET_URL}}', 'https://example.org/{{env.QF_DIGEST_SECRET_URL}}',
  ]) assert.throws(() => run({ sources: [address] }), /sources\[0\]: expected an absolute HTTP\(S\) URL/, JSON.stringify(address));
});

test('digest positional environment overrides apply only to defaults, with empty values falling back', () => {
  withEnv({ [`${PREFIX}1`]: 'https://override.example/feed', [`${PREFIX}2`]: '', [`${PREFIX}3`]: 'https://ignored.example/feed' }, () => {
    assert.deepEqual(run().inputs.sources, ['https://override.example/feed', DEFAULTS[1]]);
    const supplied = ['https://caller.example/one'];
    assert.deepEqual(run({ sources: supplied }).inputs.sources, supplied);
    assert.deepEqual(DEFAULTS, ['https://media.example/feed', 'https://blog.example/atom']);
  });
  withEnv({ [`${PREFIX}1`]: 'invalid address' }, () => {
    assert.throws(() => run(), /sources\[0\]: expected an absolute HTTP\(S\) URL/);
    assert.deepEqual(run({ sources: DEFAULTS }).inputs.sources, DEFAULTS, 'an explicit array wins over an invalid environment override');
  });
});

test('environment values and input defaults remain data, never recursively expanded template code', () => {
  const literal = '{{env.QF_DIGEST_INPUT_SECRET_TEST}}';
  withEnv({ [`${PREFIX}1`]: literal, QF_DIGEST_INPUT_SECRET_TEST: 'https://must-not-expand.example/feed' }, () => {
    assert.throws(() => run(), /expected an absolute HTTP\(S\) URL/);
    const ports = validatePorts({ sources: { type: 'array', items: { type: 'string' }, default: ['fallback'], envPrefix: PREFIX } });
    assert.deepEqual(bindInputs(ports).sources, [literal]);
    assert.deepEqual(bindInputs(ports, { sources: [literal] }).sources, [literal]);
  });
  assert.deepEqual(bindInputs(validatePorts({ sources: { type: 'array', items: { type: 'string' }, default: [literal] } })).sources, [literal]);
});

test('source constraints and formats are validated in the manifest, including array item schemas', () => {
  assert.throws(() => manifest(schema({ default: [] })), /sources.default: requires at least 1 item/);
  assert.throws(() => manifest(schema({ default: ['broken'] })), /sources.default\[0\]: expected an absolute HTTP\(S\) URL/);
  for (const constraint of ['minItems', 'maxItems']) {
    for (const value of [-1, 1.5, '1', false]) assert.throws(() => manifest(schema({ [constraint]: value })), /must be a nonnegative integer on an array/);
    assert.throws(() => validatePorts({ text: { type: 'string', [constraint]: 1 } }), /must be a nonnegative integer on an array/);
  }
  assert.throws(() => manifest(schema({ minItems: 3, maxItems: 2 })), /must not exceed maxItems/);
  assert.throws(() => manifest(schema({ items: { type: 'string', format: 'uri' } })), /items.format: only http-url on a string is supported/);
  assert.throws(() => validatePorts({ source: { type: 'array', format: 'http-url' } }), /format: only http-url on a string is supported/);
  assert.throws(() => validatePorts({ source: { type: 'string', format: '' } }), /format: only http-url on a string is supported/);
  for (const envPrefix of ['', 'qf_feed_', 'QF-FEED_', '1QF_FEED_', '{{env.PREFIX}}', 1]) {
    assert.throws(() => manifest(schema({ envPrefix })), /envPrefix: needs an uppercase environment prefix on an array/);
  }
  assert.throws(() => validatePorts({ source: { type: 'string', envPrefix: PREFIX } }), /envPrefix: needs an uppercase environment prefix on an array/);
  assert.deepEqual(bindInputs(validatePorts({ optional: { type: 'array', minItems: 0, maxItems: 0, default: [] } })), { optional: [] });
});
