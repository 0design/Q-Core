import { test } from 'node:test';
import assert from 'node:assert/strict';
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { RunStore } from '../src/state.mjs';
import { createLocalHost } from '../src/host.mjs';
import { hash } from '../src/contracts.mjs';
import { createRun, driveRun } from '../src/run.mjs';
import { validateManifest } from '../src/manifest.mjs';
import { deliverOnce } from '../src/delivery-receipts.mjs';
import { exportMaterialBundle } from '../src/material-graph.mjs';
import { runApiRequest } from '../src/steps.mjs';
import { anthropic } from '../src/providers/anthropic.mjs';
import { openRouter } from '../src/providers/openrouter.mjs';
import { getKeychainSecret } from '../src/secrets.mjs';
import { guardedStreamWrite, guardedWriteFileSync, guardedWriteSync, registerPersistenceSecret, withPersistenceSecrets } from '../src/persistence.mjs';
import { checkPersistenceWrites, inspectPersistenceSource } from '../scripts/check-persistence-writes.mjs';

// All credentials are deliberately synthetic and assembled in memory. No real
// environment/keychain credential is read and no provider/network is called.
const KEY = ['sk', 'ant', 'persistence', 'fixture-A97'].join('-');
const OPENROUTER = ['sk', 'or', 'persistence', 'fixture-B98'].join('-');
const OTHER = ['local', 'credential', '+/?"\\caféÿ'].join(':');
const RESOLVED = ['resolver', 'fixture', 'C99'].join('-');
const PADDED = ` \t${KEY}\r\n `;
const ENV = { ANTHROPIC_API_KEY: PADDED, OPENROUTER_API_KEY: OPENROUTER, EXTRA_RUN_VALUE: OTHER };
const unicode = value => [...value].map(char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`).join('');
const fullPercent = value => [...Buffer.from(value)].map(byte => `%${byte.toString(16).padStart(2, '0').toUpperCase()}`).join('');
const escaped = value => JSON.stringify(value).slice(1, -1);
const b64 = value => Buffer.from(value).toString('base64');
const b64url = value => Buffer.from(value).toString('base64url');
const fixtures = [
  ['raw Anthropic', KEY],
  ['padded Anthropic', PADDED],
  ['raw OpenRouter', OPENROUTER],
  ['arbitrary env', OTHER],
  ['resolver secret', RESOLVED],
  ['JSON escaped special characters', escaped(OTHER)],
  ['JSON optional solidus escaping', escaped(OTHER).replaceAll('/', '\\/')],
  ['JSON escaped whitespace', escaped(PADDED)],
  ['all JSON Unicode', unicode(KEY)],
  ['mixed JSON Unicode', `\\u0073${KEY.slice(1, 5)}\\u0074${KEY.slice(6)}`],
  ['uppercase JSON Unicode hex', unicode(OTHER).replace(/[a-f]/g, char => char.toUpperCase())],
  ['URL standard', encodeURIComponent(OTHER)],
  ['URL fully percent encoded', fullPercent(KEY)],
  ['URL partially percent encoded', `%73${KEY.slice(1)}`],
  ['URL lowercase percent hex', encodeURIComponent(OTHER).replace(/%[0-9A-F]{2}/g, token => token.toLowerCase())],
  ['URL form whitespace', encodeURIComponent(PADDED).replace(/%20/g, '+')],
  ['base64', b64(KEY)],
  ['base64 with JSON Unicode escaping', unicode(b64(KEY))],
  ['base64 padded credential', b64(PADDED)],
  ['base64 without padding', b64(RESOLVED).replace(/=+$/, '')],
  ['base64 URL safe', b64(OTHER).replaceAll('+', '-').replaceAll('/', '_')],
  ['base64 URL safe without padding', b64url(OTHER)],
];

function directory(t) {
  const root = mkdtempSync(join(tmpdir(), 'q-core-persistence-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
function filesBelow(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const file = join(directory, entry.name);
    return entry.isDirectory() ? filesBelow(file) : [file];
  });
}
function assertClean(file) {
  const bytes = readFileSync(file, 'utf8');
  const forbidden = new Set([KEY, PADDED, OPENROUTER, OTHER, RESOLVED]);
  for (const value of [...forbidden]) {
    for (const variant of [escaped(value), unicode(value), encodeURIComponent(value), fullPercent(value), b64(value), b64(value).replace(/=+$/, ''), b64url(value)]) {
      forbidden.add(variant);
      forbidden.add(escaped(variant));
    }
  }
  for (const [label, value] of fixtures) {
    assert.equal(bytes.includes(value), false, `${file}: ${label} must not reach disk`);
    assert.equal(bytes.includes(escaped(value)), false, `${file}: serialized ${label} must not reach disk`);
  }
  for (const value of forbidden) assert.equal(bytes.includes(value), false, `${file}: configured credential representation must not reach disk`);
  return bytes;
}
const makeRun = text => ({ runId: 'fixture-run', workflowId: 'fixture-workflow', status: 'failed', summary: text,
  steps: [{ stepId: 'answer', name: 'Answer', kind: 'llm-call', status: 'failed', output: { text }, errorText: text }],
  startedAt: '2026-10-23T00:00:00.000Z', finishedAt: '2026-10-23T00:00:01.000Z', costUsd: 0 });
const descriptor = description => ({ id: 'fixture-component', name: 'Fixture component', kind: 'step', input: {}, output: {}, needsEnv: [], description });

const paths = {
  state: async (root, text) => {
    const store = new RunStore(join(root, 'workflow.yaml'));
    store.save(makeRun(text));
    return [store.runFile('fixture-run')];
  },
  'last-run': async (root, text) => {
    const store = new RunStore(join(root, 'workflow.yaml'));
    store.saveLastRun(makeRun(text));
    return [join(store.dir, 'last-run.json')];
  },
  sink: async (root, text) => {
    const store = new RunStore(join(root, 'workflow.yaml'));
    return [store.writeSink('fixture-run', text)];
  },
  receipt: async (root, text) => {
    const store = new RunStore(join(root, 'workflow.yaml'));
    const result = await deliverOnce({ store, destination: { method: 'LOCAL' }, key: 'a'.repeat(64), payloadHash: 'b'.repeat(64) },
      async () => ({ output: { dispatched: true, echo: text } }));
    assert.ok(result.output.redactedSecrets > 0, 'receiver receipt reports redaction without including a secret');
    const files = filesBelow(join(store.dir, 'receipts'));
    assert.equal(files.length, 1);
    assert.ok(JSON.parse(readFileSync(files[0], 'utf8')).redactedSecrets > 0, 'disk receipt reports redaction');
    return files;
  },
  export: async (root, text) => {
    const source = join(root, 'component.json');
    writeFileSync(source, JSON.stringify(descriptor(text)));
    const target = join(root, 'exported');
    // Exact-byte exports cannot change content without invalidating their pins.
    assert.throws(() => exportMaterialBundle(source, target), error => error.code === 'PERSISTENCE_SECRET_UNSAFE');
    assert.equal(existsSync(target), false);
    assert.deepEqual(readdirSync(root), ['component.json'], 'failed export removes all temporary output');
    return [];
  },
  log: async (root, text) => {
    const file = join(root, 'events.jsonl');
    const result = await runApiRequest({ kind: 'api-request', config: { url: pathToFileURL(file).href, body: JSON.stringify({ text }) } },
      { runId: 'fixture-run', templateId: 'fixture-workflow', priorOutputs: {}, inputs: {} });
    assert.equal(result.output.dispatched, true);
    assert.equal(readFileSync(file, 'utf8').split('\n').length, 2, 'file log still appends one JSON value');
    return [file];
  },
  'redirected stream log': async (root, text) => {
    const file = join(root, 'stream.log');
    // A real fd behind a stream-shaped sink models stdout/stderr redirected by
    // a shell. The sink itself deliberately does no sanitization.
    const fd = openSync(file, 'a');
    try {
      guardedStreamWrite({ write(value) { writeFileSync(fd, value); return true; } }, text);
    } finally { closeSync(fd); }
    return [file];
  },
};

for (const [encoding, value] of fixtures) {
  for (const [path, write] of Object.entries(paths)) {
    test(`persistence boundary: ${encoding} through ${path}`, async t => {
      const root = directory(t), receipt = {};
      await withPersistenceSecrets({ env: ENV, secrets: [RESOLVED], receipt }, async () => {
        const files = await write(root, `safe-before ${value} safe-after`);
        for (const file of files) {
          const bytes = assertClean(file);
          assert.match(bytes, /\[REDACTED\]/);
          assert.match(bytes, /safe-before/);
          assert.match(bytes, /safe-after/);
        }
        if (path !== 'export') assert.ok(receipt.redactedSecrets > 0, 'scope receipt records a non-secret count');
      });
    });
  }
}

test('persistence boundary preserves normal serialized bytes and normal export pins', async t => {
  const root = directory(t), receipt = {}, text = 'Звичайний результат: café, {"count":42}, [REDACTED]\n';
  await withPersistenceSecrets({ env: ENV, secrets: [RESOLVED], receipt }, async () => {
    const file = join(root, 'normal.txt');
    guardedWriteFileSync(file, text, 'utf8');
    assert.deepEqual(readFileSync(file), Buffer.from(text));
    const run = makeRun(text), store = new RunStore(join(root, 'workflow.yaml'));
    store.save(run);
    assert.equal(readFileSync(store.runFile(run.runId), 'utf8'), `${JSON.stringify(run, null, 2)}\n`);
    store.saveLastRun(run);
    assert.equal(store.lastRun().summary, text);
    assert.equal(readFileSync(store.writeSink(run.runId, text), 'utf8'), text);
    const log = join(root, 'normal.jsonl');
    await runApiRequest({ kind: 'api-request', config: { url: pathToFileURL(log).href, body: JSON.stringify({ text }) } },
      { runId: run.runId, templateId: run.workflowId, priorOutputs: {}, inputs: {} });
    assert.equal(readFileSync(log, 'utf8'), `${JSON.stringify({ text })}\n`);
    const streamLog = join(root, 'normal-stream.log'), fd = openSync(streamLog, 'a');
    try { guardedStreamWrite({ write(value) { writeFileSync(fd, value); return true; } }, text); }
    finally { closeSync(fd); }
    assert.equal(readFileSync(streamLog, 'utf8'), text);
    const delivery = await deliverOnce({ store, destination: { method: 'LOCAL' }, key: 'c'.repeat(64), payloadHash: 'd'.repeat(64) },
      async () => ({ output: { dispatched: true, text } }));
    assert.equal(delivery.output.text, text);
    const source = join(root, 'normal.json'), sourceBytes = JSON.stringify(descriptor(text));
    writeFileSync(source, sourceBytes);
    exportMaterialBundle(source, join(root, 'normal-export'));
    assert.equal(readFileSync(join(root, 'normal-export', 'normal.json'), 'utf8'), sourceBytes);
    assert.equal(receipt.redactedSecrets ?? 0, 0);
  });
});

test('persistence boundary registers resolver credentials within their run scope', async t => {
  const root = directory(t), receipt = {};
  await withPersistenceSecrets({ env: {}, receipt }, async () => {
    registerPersistenceSecret(RESOLVED);
    const file = join(root, 'resolved.txt');
    guardedWriteFileSync(file, RESOLVED);
    assert.equal(readFileSync(file, 'utf8'), '[REDACTED]');
    assert.ok(receipt.redactedSecrets > 0);
  });
});

test('run persistence protects output from a provider with no provider-level sanitizer', async t => {
  const root = directory(t), store = new RunStore(join(root, 'workflow.yaml'));
  const apiKey = ['run', 'apiKey', 'isolated-D100'].join('-');
  const manifest = validateManifest({ manifest: 'q-core.workflow/v1', id: 'provider-echo', settings: { budgetUsd: null },
    steps: [{ id: 'answer', kind: 'llm-call', config: { provider: 'anthropic', model: 'claude-sonnet-5', maxTokens: '100', retries: '0', instructions: 'Return the answer.' } }] });
  const run = await driveRun(createRun(manifest), { store, settings: manifest.settings, apiKey,
    providers: { anthropic: async () => ({ content: `echo ${apiKey} and ${b64(apiKey)}`, provider: { model: 'claude-sonnet-5' },
      usage: { tokensIn: 1, tokensOut: 1, costUsd: 0 } }) } });
  assert.equal(run.status, 'success', run.summary);
  assert.ok(run.steps[0].output.text.includes(apiKey), 'injected provider supplies an unsanitized in-memory response');
  assert.ok(run.redactedSecrets > 0, 'run receipt reports persistence redaction');
  assert.equal(store.load(run.runId).steps[0].output.text, 'echo [REDACTED] and [REDACTED]');
  assertClean(store.runFile(run.runId));
  assert.equal(readFileSync(store.runFile(run.runId), 'utf8').includes(apiKey), false);
  assert.equal(readFileSync(store.runFile(run.runId), 'utf8').includes(b64(apiKey)), false);
  store.saveLastRun(run);
  assertClean(join(store.dir, 'last-run.json'));
});

test('normal provider output and run success remain unchanged', async t => {
  const root = directory(t), store = new RunStore(join(root, 'workflow.yaml'));
  const manifest = validateManifest({ manifest: 'q-core.workflow/v1', id: 'normal-provider', settings: { budgetUsd: null },
    steps: [{ id: 'answer', kind: 'llm-call', config: { provider: 'anthropic', model: 'claude-sonnet-5', maxTokens: '100', retries: '0', instructions: 'Return the answer.' } }] });
  const run = await driveRun(createRun(manifest), { store, settings: manifest.settings,
    providers: { anthropic: async () => ({ content: 'Нормальна відповідь', provider: { model: 'claude-sonnet-5' }, usage: { tokensIn: 1, tokensOut: 1, costUsd: 0 } }) } });
  assert.equal(run.status, 'success', run.summary);
  assert.deepEqual(store.load(run.runId).steps[0].output, { text: 'Нормальна відповідь', model: 'claude-sonnet-5' });
  assert.equal(run.redactedSecrets ?? 0, 0);
});

for (const provider of ['anthropic', 'openrouter']) {
  test(`${provider} resolver results enter persistence protection before output is written`, async t => {
    const root = directory(t), file = join(root, `${provider}.json`), receipt = {};
    const credential = ['isolated', provider, 'resolver-D101'].join('-');
    const request = { model: provider === 'anthropic' ? 'claude-sonnet-5' : 'test/model', payerScope: 'local-byok',
      maxTokens: 100, retries: 0, timeoutMs: 1000, messages: [{ role: 'user', content: 'Hello' }] };
    let requests = 0;
    await withPersistenceSecrets({ env: {}, receipt }, async () => {
      const result = await (provider === 'anthropic' ? anthropic : openRouter)(request, {
        env: {}, secretResolver: async () => credential,
        fetcher: async (_url, init) => {
          requests++;
          assert.equal(provider === 'anthropic' ? init.headers['x-api-key'] : init.headers.Authorization, provider === 'anthropic' ? credential : `Bearer ${credential}`);
          return provider === 'anthropic'
            ? Response.json({ id: 'fixture-message', model: request.model, stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: 'text', text: b64(credential) }] })
            : Response.json({ id: 'fixture-message', model: request.model, choices: [{ message: { content: b64(credential) }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, cost: 0 } });
        },
      });
      assert.equal(result.content, b64(credential), 'provider-level literal filtering does not remove this encoded probe');
      guardedWriteFileSync(file, JSON.stringify(result));
      const saved = readFileSync(file, 'utf8');
      assert.equal(saved.includes(credential), false);
      assert.equal(saved.includes(b64(credential)), false);
      assert.equal(JSON.parse(saved).content, '[REDACTED]');
      assert.ok(receipt.redactedSecrets > 0);
    });
    assert.equal(requests, 1);
  });
}

test('protected keychain retrieval registers its value for later disk writes', async t => {
  const root = directory(t), file = join(root, 'keychain.txt');
  const credential = ['isolated', 'keychain', 'D102'].join('-');
  let calls = 0;
  const result = await getKeychainSecret({ provider: 'anthropic', keyRef: 'FIXTURE_ALIAS', platform: 'darwin' }, {
    launch: async (command, args) => {
      calls++;
      assert.equal(command, '/usr/bin/security');
      assert.equal(args.includes(credential), false);
      return { code: 0, stdout: `${credential}\n`, stderr: '' };
    },
  });
  assert.equal(result, credential);
  guardedWriteFileSync(file, b64(result));
  assert.equal(readFileSync(file, 'utf8'), '[REDACTED]');
  assert.equal(calls, 1);
});

for (const reference of ['keyRef', 'env template']) {
  test(`initial run snapshot protects an arbitrary env alias referenced by ${reference}`, t => {
    const root = directory(t), alias = 'QCORE_OPAQUE_VALUE', credential = ['initial', reference, 'env-D103'].join('-');
    const previous = process.env[alias];
    process.env[alias] = credential;
    t.after(() => { if (previous === undefined) delete process.env[alias]; else process.env[alias] = previous; });
    const config = { provider: 'anthropic', model: 'claude-sonnet-5', instructions: reference === 'env template' ? `Use {{env.${alias}}}` : 'Return the answer.',
      ...(reference === 'keyRef' ? { keyRef: alias } : {}) };
    const manifest = validateManifest({ manifest: 'q-core.workflow/v1', id: 'initial-snapshot', steps: [{ id: 'answer', kind: 'llm-call', config }] });
    const run = createRun(manifest), store = new RunStore(join(root, 'workflow.yaml'));
    run.summary = b64(credential);
    store.save(run);
    assert.equal(readFileSync(store.runFile(run.runId), 'utf8').includes(b64(credential)), false);
    assert.equal(store.load(run.runId).summary, '[REDACTED]');
    assert.ok(store.load(run.runId).redactedSecrets > 0);
  });
}

test('specification integrity refuses secret-bearing bytes without leaving a specification or lock', t => {
  const root = directory(t), store = new RunStore(join(root, 'workflow.yaml'));
  const alias = 'QCORE_SPECIFICATION_VALUE', credential = ['isolated', 'specification', 'D105'].join('-'), previous = process.env[alias];
  process.env[alias] = credential;
  t.after(() => { if (previous === undefined) delete process.env[alias]; else process.env[alias] = previous; });
  assert.throws(() => store.recordSpecification({ workflow: 'fixture' }, { source: `{{env.${alias}}}`, content: b64(credential) }),
    error => error.code === 'PERSISTENCE_SECRET_UNSAFE');
  assert.equal(filesBelow(store.dir).some(file => /spec-.*\.(?:json|lock)$/.test(file)), false);
  for (const file of filesBelow(store.dir)) assert.equal(readFileSync(file, 'utf8').includes(credential), false);
});

test('persistence boundary fails closed before creating or truncating unsafe binary/encoded files', async t => {
  const root = directory(t);
  await withPersistenceSecrets({ env: ENV }, async () => {
    const existing = join(root, 'existing.txt'), missing = join(root, 'missing.txt');
    writeFileSync(existing, 'keep-existing');
    const invalid = Buffer.concat([Buffer.from([0xff]), Buffer.from(KEY)]);
    for (const file of [existing, missing]) {
      assert.throws(() => guardedWriteFileSync(file, invalid), error => error.code === 'PERSISTENCE_SECRET_UNSAFE');
      assert.throws(() => guardedWriteFileSync(file, KEY, { encoding: 'utf16le' }), error => error.code === 'PERSISTENCE_SECRET_UNSAFE');
    }
    assert.equal(readFileSync(existing, 'utf8'), 'keep-existing');
    assert.equal(existsSync(missing), false);
  });
});

test('guarded fd append redacts encoded credentials and fails before unsafe bytes are written', async t => {
  const root = directory(t), file = join(root, 'fd.log'), receipt = {};
  const fd = openSync(file, 'a');
  t.after(() => closeSync(fd));
  await withPersistenceSecrets({ env: ENV, receipt }, async () => {
    const written = guardedWriteSync(fd, `${b64(KEY)}\n`);
    assert.ok(Number.isInteger(written));
    assert.equal(readFileSync(file, 'utf8'), '[REDACTED]\n');
    assert.throws(() => guardedWriteSync(fd, Buffer.concat([Buffer.from([0xff]), Buffer.from(KEY)])),
      error => error.code === 'PERSISTENCE_SECRET_UNSAFE');
    assert.equal(readFileSync(file, 'utf8'), '[REDACTED]\n');
    assert.ok(receipt.redactedSecrets > 0);
  });
});

test('unsafe JSON key collisions fail closed with a non-secret error', async t => {
  const root = directory(t), file = join(root, 'collision.json');
  await withPersistenceSecrets({ env: ENV }, async () => {
    const source = JSON.stringify({ [KEY]: 'first', '[REDACTED]': 'second' });
    assert.throws(() => guardedWriteFileSync(file, source), error => {
      assert.equal(error.code, 'PERSISTENCE_SECRET_UNSAFE');
      assert.match(error.message, /Persistence refused/);
      assert.equal(error.message.includes(KEY), false);
      return true;
    });
    assert.equal(existsSync(file), false);
  });
});

for (const encoding of ['raw', 'base64']) {
  for (const kind of ['append file', 'fd', 'stream']) {
    test(`credential split across two ${kind} writes fails closed (${encoding})`, async t => {
      const root = directory(t), file = join(root, 'split.log');
      const credential = ['isolated', 'split', encoding, kind, 'D104'].join('-');
      const text = encoding === 'raw' ? credential : b64(credential);
      const midpoint = Math.floor(text.length / 2), parts = [text.slice(0, midpoint), text.slice(midpoint)];
      await withPersistenceSecrets({ env: {}, secrets: [credential] }, async () => {
        let fd;
        if (kind !== 'append file') fd = openSync(file, 'a');
        const stream = { write(value) { writeFileSync(fd, value); return true; } };
        const write = value => kind === 'append file' ? guardedWriteFileSync(file, value, { flag: 'a' })
          : kind === 'fd' ? guardedWriteSync(fd, value) : guardedStreamWrite(stream, value);
        try {
          write(parts[0]);
          assert.throws(() => write(parts[1]), error => error.code === 'PERSISTENCE_SECRET_UNSAFE');
          assert.equal(readFileSync(file, 'utf8').includes(text), false);
        } finally { if (fd !== undefined) closeSync(fd); }
      });
    });
  }
}

test('all runtime disk writers pass through the guarded persistence module', () => {
  const result = checkPersistenceWrites();
  assert.ok(result.files > 20);
  assert.deepEqual(result.findings, []);
});

for (const [label, source] of [
  ['new direct write', "import { writeFileSync } from 'node:fs'; writeFileSync(file, output);"],
  ['aliased direct write', "import { writeFileSync as persist } from 'node:fs'; persist(file, output);"],
  ['commented aliased direct write', "import { /* persistence? */ writeFileSync as persist } from 'node:fs'; persist(file, output);"],
  ['promises direct write', "import { appendFile as persist } from 'node:fs/promises'; await persist(file, output);"],
  ['promises namespace re-export', "import { promises as disk } from 'node:fs'; await disk.writeFile(file, output);"],
  ['namespace fs writer', "import * as disk from 'node:fs'; disk.writeFileSync(file, output);"],
  ['default fs writer', "import disk from 'node:fs'; disk.writeFileSync(file, output);"],
  ['dynamic fs writer', "const disk = await import('node:fs/promises'); await disk.writeFile(file, output);"],
  ['template-literal fs import', 'const disk = await import(`node:fs/promises`); await disk.writeFile(file, output);'],
  ['CommonJS fs writer', "const {writeFileSync: persist} = require('fs'); persist(file, output);"],
  ['FileHandle writer', "import { open } from 'node:fs/promises'; const file = await open(path, 'w'); await file.write(output);"],
  ['copy bypass', "import { copyFileSync } from 'node:fs'; copyFileSync(source, artifact);"],
  ['stdout redirected log', 'process.stdout.write(output);'],
  ['stderr redirected log', 'process.stderr.write(output);'],
  ['injectable output log', 'out.write(output);'],
  ['console redirected log', 'console.error(output);'],
]) {
  test(`persistence writer check rejects a bypass: ${label}`, () => {
    assert.ok(inspectPersistenceSource(source, 'src/new-writer.mjs').length > 0);
  });
}

test('terminal exception cannot authorize another disk writer', () => {
  const source = readFileSync(new URL('../src/human-confirmation.mjs', import.meta.url), 'utf8');
  assert.deepEqual(inspectPersistenceSource(source, 'src/human-confirmation.mjs'), []);
  assert.ok(inspectPersistenceSource(`${source}\nwriteSync(otherFd, output);`, 'src/human-confirmation.mjs').length > 0);
  assert.ok(inspectPersistenceSource(`${source}\nimport {writeFileSync} from 'node:fs';`, 'src/human-confirmation.mjs').length > 0);
  assert.ok(inspectPersistenceSource(`${source}\nimport {writeSync as writeDisk} from 'node:fs';\nwriteDisk(otherFd, output);`, 'src/human-confirmation.mjs').length > 0);
});

test('normal append to an existing JSONL log preserves earlier bytes', async t => {
  const root = directory(t), file = join(root, 'existing.jsonl');
  const previous = '{"text":"previous run"}\n';
  writeFileSync(file, previous);
  await runApiRequest({ kind: 'api-request', config: { url: pathToFileURL(file).href, body: '{"text":"next run"}' } },
    { runId: 'normal-append', templateId: 'test', priorOutputs: {}, inputs: {} });
  assert.equal(readFileSync(file, 'utf8'), `${previous}{"text":"next run"}\n`);
});

test('stdout and stderr sharing one log inode cannot complete a split credential', async t => {
  const root = directory(t), file = join(root, 'shared-stream.log');
  const credential = ['isolated', 'shared-stream', 'D105'].join('-');
  const first = openSync(file, 'a'), second = openSync(file, 'a');
  try {
    const stdout = { fd: first, write(value) { writeFileSync(first, value); return true; } };
    const stderr = { fd: second, write(value) { writeFileSync(second, value); return true; } };
    withPersistenceSecrets({ secrets: [credential] }, () => {
      guardedStreamWrite(stdout, credential.slice(0, 10));
      // Atomic state writes use fresh inodes and may evict the disk-read cache;
      // active log continuity must survive them.
      for (let i = 0; i < 65; i++) guardedWriteFileSync(join(root, `state-${i}.json`), '{}');
      assert.throws(() => guardedStreamWrite(stderr, credential.slice(10)), { code: 'PERSISTENCE_SECRET_UNSAFE' });
    });
    assert.equal(readFileSync(file, 'utf8'), credential.slice(0, 10));
  } finally { closeSync(first); closeSync(second); }
});

test('credential-bearing filenames are refused before any file is created', t => {
  const root = directory(t), credential = ['isolated', 'filename', 'D106'].join('-');
  const file = join(root, `${credential}.txt`);
  withPersistenceSecrets({ secrets: [credential] }, () => {
    assert.throws(() => guardedWriteFileSync(file, 'safe bytes'), { code: 'PERSISTENCE_SECRET_UNSAFE' });
  });
  assert.equal(existsSync(file), false);
});

for (const mode of ['a', 'a+']) {
  test(`an existing redirected log cannot complete a credential on its first guarded write (${mode})`, t => {
    const root = directory(t), file = join(root, 'prior-stream.log');
    const credential = ['isolated', 'existing-stream', mode === 'a' ? 'D108' : 'D109'].join('-');
    const prefix = credential.slice(0, 10);
    writeFileSync(file, prefix);
    const fd = openSync(file, mode);
    try {
      const stream = { fd, write(value) { writeFileSync(fd, value); return true; } };
      withPersistenceSecrets({ secrets: [credential] }, () => {
        assert.throws(() => guardedStreamWrite(stream, credential.slice(10)), { code: 'PERSISTENCE_SECRET_UNSAFE' });
      });
      assert.equal(readFileSync(file, 'utf8'), prefix);
    } finally { closeSync(fd); }
  });
}

test('directly configured host webhook token is protected without opening a network socket', async t => {
  const root = directory(t), file = join(root, 'host.yaml');
  writeFileSync(file, 'manifest: q-core.workflow/v1\nid: guarded-host\nenabled: true\ntriggers:\n  - kind: manual\nsteps:\n  - id: approval\n    kind: approval-gate\n    config:\n      reviewer: human\n');
  const host = createLocalHost({ manifest: file, manifestSha256: hash(readFileSync(file)) });
  const credential = ['isolated', 'host-webhook-credential', 'D107'].join('-');
  const server = host.webhookServer(credential);
  assert.equal(server.listening, false);
  await host.dispatch('manual', credential);
  for (const output of filesBelow(join(root, '.qf'))) {
    assert.equal(readFileSync(output, 'utf8').includes(credential), false);
  }
});
