import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadManifest } from '../src/manifest.mjs';
import { createRun, RunStore } from '../src/run.mjs';

/* A value an input array reads through envPrefix is saved in run.inputs. Core.54
   protects every undeclared environment value a workflow reads, so this path must
   too: the saved run keeps the default feeds and declared-public overrides, never
   an undeclared override or one carrying credentials. */

const PREFIX = 'QF_SOURCE_FEED_TEST_';
const DEFAULTS = ['https://default-one.example/feed', 'https://default-two.example/atom', 'https://default-three.example/rss'];

function manifestFile(env) {
  const dir = mkdtempSync(join(tmpdir(), 'qf-source-secrets-'));
  const file = join(dir, 'sources.yaml');
  const lines = [
    'manifest: q-core.workflow/v1',
    'id: source-secrets',
    'name: Source secrets',
    'version: 0.0.1',
    'inputs:',
    '  sources:',
    '    type: array',
    '    minItems: 1',
    '    maxItems: 20',
    '    items:',
    '      type: string',
    '      format: http-url',
    `    envPrefix: ${PREFIX}`,
    '    default:',
    ...DEFAULTS.map(url => `      - "${url}"`),
  ];
  if (env) lines.push('env:', ...Object.entries(env).flatMap(([name, secret]) => [`  ${name}:`, `    secret: ${secret}`]));
  lines.push(
    'steps:',
    '  - id: feeds',
    '    kind: fan-out',
    '    config:',
    '      over: "{{inputs.sources}}"',
    '      maxItems: 20',
    '    then:',
    '      - id: source-fetch',
    '        kind: fetch',
    '        config:',
    '          url: "{{item}}"',
    '          urlInput: sources',
    '          format: text',
  );
  writeFileSync(file, lines.join('\n') + '\n');
  return file;
}

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

function savedRun(file) {
  const run = createRun(loadManifest(file));
  const store = new RunStore(file);
  store.save(run);
  return { run, text: readFileSync(store.runFile(run.runId), 'utf8') };
}

test('an undeclared envPrefix override is redacted in the saved run; defaults stay visible', () => {
  const token = 'tok3n-undeclared-0123456789abcdef';
  const override = `https://private-undeclared.example/rss?token=${token}`;
  withEnv({ [`${PREFIX}1`]: undefined, [`${PREFIX}2`]: override, [`${PREFIX}3`]: undefined }, () => {
    const { run, text } = savedRun(manifestFile());
    assert.deepEqual(run.inputs.sources, [DEFAULTS[0], override, DEFAULTS[2]], 'the run itself uses the override');
    assert.deepEqual(run.inputEnv, [`${PREFIX}1`, `${PREFIX}2`, `${PREFIX}3`]);
    assert.equal(text.includes(token), false, 'the token is not saved');
    assert.equal(text.includes('private-undeclared.example'), false, 'an undeclared override is saved as [REDACTED]');
    assert.ok(text.includes('[REDACTED]'));
    assert.ok(text.includes(DEFAULTS[0]) && text.includes(DEFAULTS[2]), 'default feeds stay visible');
  });
});

test('a declared-public envPrefix override stays visible unless it carries credentials', () => {
  const visible = 'https://public-declared.example/feed';
  const token = 'tok3n-declared-public-0123456789abcdef';
  const withToken = `https://private-declared.example/rss?token=${token}`;
  withEnv({ [`${PREFIX}1`]: visible, [`${PREFIX}2`]: withToken, [`${PREFIX}3`]: undefined }, () => {
    const { run, text } = savedRun(manifestFile({ [`${PREFIX}1`]: false, [`${PREFIX}2`]: false }));
    assert.deepEqual(run.publicEnv, [`${PREFIX}1`, `${PREFIX}2`]);
    assert.ok(text.includes(visible), 'declared secret: false keeps an ordinary address');
    assert.equal(text.includes(token), false, 'an address with a token query is still redacted');
  });
});

test('a declared-secret envPrefix override is redacted', () => {
  const override = 'https://private-declared-secret.example/feed';
  withEnv({ [`${PREFIX}1`]: override, [`${PREFIX}2`]: undefined, [`${PREFIX}3`]: undefined }, () => {
    const { text } = savedRun(manifestFile({ [`${PREFIX}1`]: true }));
    assert.equal(text.includes('private-declared-secret.example'), false);
  });
});

test('Digest declares its feed overrides public, yet saves one that carries a token as [REDACTED]', () => {
  const token = 'tok3n-digest-feed-0123456789abcdef';
  withEnv({ QF_DIGEST_FEED_3: `https://private-digest.example/rss?token=${token}` }, () => {
    for (const id of ['digest', 'digest-cli']) {
      const file = join(mkdtempSync(join(tmpdir(), 'qf-digest-secrets-')), `${id}.yaml`);
      writeFileSync(file, readFileSync(new URL(`../registry/workflows/${id}.yaml`, import.meta.url)));
      const { run, text } = savedRun(file);
      assert.ok(run.inputEnv.includes('QF_DIGEST_FEED_3') && run.publicEnv.includes('QF_DIGEST_FEED_3'), id);
      assert.equal(run.publicEnv.includes('QF_DIGEST_RECEIVER_URL'), false, `${id} keeps the receiver address secret`);
      assert.equal(text.includes(token), false, id);
      assert.equal(text.includes('private-digest.example'), false, id);
      assert.ok(text.includes('https://techcrunch.com/category/artificial-intelligence/feed/'), `${id} default feed stays visible`);
    }
  });
});
