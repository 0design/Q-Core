import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { anthropic } from '../src/providers/anthropic.mjs';
import { resolveProviderSecret } from '../src/secrets.mjs';
import { guardedStreamWrite, guardedWriteFileSync } from '../src/persistence.mjs';
import { createRun, driveRun, RunStore } from '../src/run.mjs';
import { validateManifest } from '../src/manifest.mjs';
import { deliverOnce } from '../src/delivery-receipts.mjs';

// All credentials and workspace IDs are synthetic. Every transport is injected:
// these probes neither read a real keychain nor open a local/network socket.
const KEY = 'workspace-review-synthetic-api-credential';
const WORKSPACE = 'workspace-review-protected-fixture';
const MODEL = 'claude-sonnet-5';
const request = (overrides = {}) => ({ model: MODEL, payerScope: 'local-byok',
  messages: [{ role: 'user', content: 'Hello' }], maxTokens: 100,
  retries: 0, timeoutMs: 1000, ...overrides });
const unicode = value => [...value].map(char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`).join('');
const completion = (text = 'Done', extra = {}) => Response.json({ id: 'msg-workspace-review',
  model: MODEL, stop_reason: 'end_turn', content: [{ type: 'text', text }],
  usage: { input_tokens: 100, output_tokens: 10 }, ...extra });
const envelope = (message, type = 'invalid_request_error', status = 400) =>
  Response.json({ error: { type, message } }, { status });
const explainError = error => JSON.stringify({ message: error.message, stack: error.stack, ...error });
const llm = (config = {}) => ({ id: 'answer', kind: 'llm-call', config: {
  provider: 'anthropic', model: MODEL, instructions: 'Return the result.',
  maxTokens: '100', retries: '0', ...config,
} });
const manifest = (config = {}) => validateManifest({ manifest: 'q-core.workflow/v1',
  id: 'workspace-review', settings: { budgetUsd: null }, steps: [llm(config)] });
async function directory(t) {
  const root = await mkdtemp(join(tmpdir(), 'q-core-workspace-review-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
function envForTest(t, values) {
  for (const [name, value] of Object.entries(values)) {
    const original = process.env[name];
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
    t.after(() => { if (original === undefined) delete process.env[name]; else process.env[name] = original; });
  }
}
function assertProtected(value, protectedValue = WORKSPACE) {
  const serialized = typeof value === 'string' ? value : JSON.stringify(value);
  assert.equal(serialized.includes(protectedValue), false);
  assert.equal(serialized.includes(unicode(protectedValue)), false);
  assert.equal(serialized.includes(JSON.stringify(unicode(protectedValue)).slice(1, -1)), false);
}

for (const [label, config, env, expected] of [
  ['default env reference', {}, { ANTHROPIC_WORKSPACE_ID: WORKSPACE }, WORKSPACE],
  ['custom env reference', { workspaceRef: 'OWNER_WORKSPACE_ALIAS' }, { OWNER_WORKSPACE_ALIAS: WORKSPACE,
    ANTHROPIC_WORKSPACE_ID: 'unselected-default-workspace' }, WORKSPACE],
  ['padded env value', {}, { ANTHROPIC_WORKSPACE_ID: ` \t${WORKSPACE}\r\n ` }, WORKSPACE],
  ['missing env value', {}, {}, null],
  ['empty env value', {}, { ANTHROPIC_WORKSPACE_ID: '' }, null],
  ['blank env value', {}, { ANTHROPIC_WORKSPACE_ID: ' \t\r\n ' }, null],
  ['missing custom alias does not fall back', { workspaceRef: 'OWNER_WORKSPACE_ALIAS' },
    { ANTHROPIC_WORKSPACE_ID: 'unselected-default-workspace' }, null],
]) {
  test(`Anthropic workspace: ${label} controls only the optional header`, async () => {
    let calls = 0;
    const result = await anthropic(request(config), { env: { ANTHROPIC_API_KEY: KEY, ...env },
      fetcher: async (_url, init) => {
        calls++;
        const headers = new Headers(init.headers);
        assert.equal(headers.get('x-api-key'), KEY);
        assert.equal(headers.get('anthropic-workspace-id'), expected);
        assertProtected(init.body);
        assertProtected(init.body, KEY);
        return completion();
      } });
    assert.equal(calls, 1);
    assert.equal(result.content, 'Done');
    assert.equal(result.usage.costUsd, 0.0003);
    assertProtected(result);
    assertProtected(result, KEY);
  });
}

for (const secretSource of ['env', 'keychain']) {
  test(`Anthropic workspace: custom key/workspace references share ${secretSource} resolver routing`, async () => {
    const reads = [];
    const result = await anthropic(request({ keyRef: 'OWNER_API_ALIAS', workspaceRef: 'OWNER_WORKSPACE_ALIAS', secretSource }), {
      env: { ANTHROPIC_WORKSPACE_ID: 'unselected-default-workspace' },
      secretResolver: async args => {
        reads.push({ provider: args.provider, keyRef: args.keyRef, secretSource: args.secretSource, optional: args.optional });
        if (args.keyRef === 'OWNER_API_ALIAS') return KEY;
        assert.equal(args.keyRef, 'OWNER_WORKSPACE_ALIAS');
        assert.equal(args.optional, true);
        return WORKSPACE;
      },
      fetcher: async (_url, init) => {
        assert.equal(new Headers(init.headers).get('anthropic-workspace-id'), WORKSPACE);
        return completion();
      },
    });
    assert.deepEqual(reads, [
      { provider: 'anthropic', keyRef: 'OWNER_API_ALIAS', secretSource, optional: undefined },
      { provider: 'anthropic', keyRef: 'OWNER_WORKSPACE_ALIAS', secretSource, optional: true },
    ]);
    assert.equal(result.content, 'Done');
  });
}

test('Anthropic workspace: missing keychain workspace never falls back to an env value', async () => {
  let calls = 0;
  await anthropic(request({ secretSource: 'keychain' }), {
    env: { ANTHROPIC_API_KEY: 'unselected-env-api', ANTHROPIC_WORKSPACE_ID: WORKSPACE },
    secretResolver: async args => {
      assert.equal(args.secretSource, 'keychain');
      if (args.keyRef === 'ANTHROPIC_API_KEY') return KEY;
      assert.equal(args.keyRef, 'ANTHROPIC_WORKSPACE_ID');
      assert.equal(args.optional, true);
      return undefined;
    },
    fetcher: async (_url, init) => {
      calls++;
      assert.equal(new Headers(init.headers).has('anthropic-workspace-id'), false);
      assert.equal(new Headers(init.headers).get('x-api-key'), KEY);
      return completion();
    },
  });
  assert.equal(calls, 1);
});

for (const code of ['SECRET_STORE_DENIED', 'SECRET_STORE_UNSUPPORTED', 'TIMEOUT']) {
  test(`Anthropic workspace: ${code} is sanitized and cannot silently omit a configured source`, async () => {
    let calls = 0;
    await assert.rejects(anthropic(request({ secretSource: 'keychain' }), {
      env: { ANTHROPIC_WORKSPACE_ID: WORKSPACE },
      secretResolver: async args => {
        if (args.keyRef === 'ANTHROPIC_API_KEY') return KEY;
        throw Object.assign(new Error(`untrusted source diagnostics ${WORKSPACE}`), { code });
      },
      fetcher: async () => { calls++; return completion(); },
    }), error => {
      assert.equal(error.code, code);
      assertProtected(explainError(error));
      assert.equal(explainError(error).includes('untrusted source diagnostics'), false);
      return true;
    });
    assert.equal(calls, 0);
  });
}

test('Anthropic workspace: optional env resolution does not change mandatory API-key behavior', async () => {
  for (const value of [undefined, '', ' \t\r\n ']) {
    const env = value === undefined ? {} : { ANTHROPIC_WORKSPACE_ID: value };
    assert.equal(await resolveProviderSecret({ provider: 'anthropic', keyRef: 'ANTHROPIC_WORKSPACE_ID',
      secretSource: 'env', optional: true, env }), undefined);
  }
  await assert.rejects(resolveProviderSecret({ provider: 'anthropic', env: {} }), { code: 'AUTH_REQUIRED' });
});

test('Anthropic workspace: optional keychain resolver suppresses only missing or blank entries', async () => {
  for (const result of [{ code: 44, stdout: '' }, { code: 0, stdout: '' }, { code: 0, stdout: ' \t\r\n' }]) {
    let launches = 0;
    const value = await resolveProviderSecret({ provider: 'anthropic', keyRef: 'ANTHROPIC_WORKSPACE_ID',
      secretSource: 'keychain', optional: true, platform: 'darwin' }, {
      launch: async (_command, args) => {
        launches++;
        assert.ok(args.includes('anthropic:ANTHROPIC_WORKSPACE_ID'));
        return result;
      },
    });
    assert.equal(launches, 1);
    assert.equal(value, undefined);
  }
  await assert.rejects(resolveProviderSecret({ provider: 'anthropic', keyRef: 'ANTHROPIC_WORKSPACE_ID',
    secretSource: 'keychain', optional: true, platform: 'darwin' }, {
    launch: async () => ({ code: 36, stdout: '' }),
  }), { code: 'SECRET_STORE_DENIED' });
});

test('Anthropic workspace: llm-call forwards the configured workspaceRef and source to the native provider', async () => {
  const m = manifest({ workspaceRef: 'OWNER_WORKSPACE_ALIAS', keyRef: 'OWNER_API_ALIAS', secretSource: 'keychain' });
  let calls = 0;
  const done = await driveRun(createRun(m), { settings: m.settings, providers: { anthropic: args => {
    assert.equal(args.workspaceRef, 'OWNER_WORKSPACE_ALIAS');
    assert.equal(args.keyRef, 'OWNER_API_ALIAS');
    assert.equal(args.secretSource, 'keychain');
    return anthropic(args, { env: {}, secretResolver: async read => read.optional ? WORKSPACE : KEY,
      fetcher: async (_url, init) => {
        calls++;
        assert.equal(new Headers(init.headers).get('anthropic-workspace-id'), WORKSPACE);
        return completion();
      } });
  } } });
  assert.equal(done.status, 'success', done.summary);
  assert.equal(calls, 1);
  assertProtected(done);
});

for (const encoding of ['literal', 'Unicode JSON']) {
  test(`Anthropic workspace: ${encoding} echoes in output and metadata remain protected through RunStore and receipts`, async t => {
    const root = await directory(t), store = new RunStore(join(root, 'workflow.yaml'));
    const spelling = encoding === 'literal' ? WORKSPACE : unicode(WORKSPACE);
    const text = `{"${spelling}":{"value":"before ${spelling} after"},"safe":[false,0,null,"ok"]}`;
    const m = manifest({ format: 'json' });
    const done = await driveRun(createRun(m), { settings: m.settings, store, providers: {
      anthropic: args => anthropic(args, { env: { ANTHROPIC_API_KEY: KEY, ANTHROPIC_WORKSPACE_ID: WORKSPACE },
        fetcher: async () => completion(text, { id: `msg-${WORKSPACE}` }) }),
    } });
    assert.equal(done.status, 'success', done.summary);
    assert.deepEqual(done.steps[0].output, { '[REDACTED]': { value: 'before [REDACTED] after' }, safe: [false, 0, null, 'ok'] });
    assertProtected(done);
    assertProtected(store.load(done.runId));
    store.saveLastRun(done);
    for (const file of [store.runFile(done.runId), join(store.dir, 'last-run.json')])
      assertProtected(await readFile(file, 'utf8'));

    // A later receiver receipt can echo the header independently of the model.
    // Registering this value at the provider boundary protects that write too.
    await deliverOnce({ store, destination: { url: 'fixture:offline', method: 'POST' },
      key: 'a'.repeat(64), payloadHash: 'b'.repeat(64) }, async () => ({
      output: { dispatched: true, receiver: WORKSPACE, encoded: unicode(WORKSPACE) },
    }));
    const receipts = await readdir(join(store.dir, 'receipts'));
    assert.equal(receipts.length, 1);
    assertProtected(await readFile(join(store.dir, 'receipts', receipts[0]), 'utf8'));
  });
}

test('Anthropic workspace: plain completion text and arbitrary provider metadata never expose the header', async () => {
  const result = await anthropic(request(), { env: { ANTHROPIC_API_KEY: KEY, ANTHROPIC_WORKSPACE_ID: WORKSPACE },
    fetcher: async () => completion(`Safe: ${WORKSPACE}.`, { id: `msg-${WORKSPACE}`, model: `model-${WORKSPACE}` }) });
  assert.equal(result.content, 'Safe: [REDACTED].');
  assert.equal(result.requestId, 'msg-[REDACTED]');
  assert.equal(result.provider.model, 'model-[REDACTED]');
  assertProtected(result);
});

test('Anthropic workspace: registering resolver values protects guarded logs and unrelated writes', async t => {
  const root = await directory(t), workspace = 'workspace-resolver-guard-only-fixture';
  await anthropic(request({ secretSource: 'keychain' }), { env: {},
    secretResolver: async args => args.optional ? workspace : KEY,
    fetcher: async () => completion(),
  });
  const file = join(root, 'guarded.json');
  assert.throws(() => guardedWriteFileSync(file, JSON.stringify({ value: workspace }), { failOnRedaction: true }),
    { code: 'PERSISTENCE_SECRET_UNSAFE' });
  let written = '';
  guardedStreamWrite({ write(value) { written += value.toString(); return true; } }, `workspace: ${workspace}`);
  assertProtected(written, workspace);
  assert.match(written, /\[REDACTED\]/);
});

for (const source of ['default env', 'custom env', 'legacy workspaceId']) {
  test(`Anthropic workspace: the first RunStore snapshot protects ${source} before dispatch`, async t => {
    const root = await directory(t), store = new RunStore(join(root, 'workflow.yaml'));
    // Each case uses a fresh ID: earlier adapter tests must not pre-register it.
    const workspace = `workspace-initial-snapshot-${source.replaceAll(' ', '-')}-fixture`;
    const config = { instructions: `A copied header must stay protected: ${workspace}` };
    envForTest(t, { ANTHROPIC_API_KEY: KEY, ANTHROPIC_WORKSPACE_ID: undefined, OWNER_WORKSPACE_ALIAS: undefined });
    if (source === 'default env') process.env.ANTHROPIC_WORKSPACE_ID = workspace;
    else if (source === 'custom env') {
      config.workspaceRef = 'OWNER_WORKSPACE_ALIAS';
      process.env.OWNER_WORKSPACE_ALIAS = workspace;
    } else config.workspaceId = workspace;
    const m = manifest(config), run = createRun(m);
    store.save(run);
    assertProtected(await readFile(store.runFile(run.runId), 'utf8'), workspace);
    assertProtected(store.load(run.runId), workspace);
  });
}

test('Anthropic workspace: legacy workspaceId keeps its header and is protected without another secret read', async () => {
  let reads = 0;
  const result = await anthropic(request({ workspaceId: WORKSPACE }), {
    env: { ANTHROPIC_WORKSPACE_ID: 'unselected-default-workspace' },
    secretResolver: async () => { reads++; return KEY; },
    fetcher: async (_url, init) => {
      assert.equal(new Headers(init.headers).get('anthropic-workspace-id'), WORKSPACE);
      return completion(`Header: ${WORKSPACE}`);
    },
  });
  assert.equal(reads, 1);
  assert.equal(result.content, 'Header: [REDACTED]');
  assertProtected(result);
});

for (const message of [
  'This API key is not scoped to a workspace, so this request must include the anthropic-workspace-id header',
  `Invalid workspace ${WORKSPACE}: protected provider diagnostic`,
]) {
  test('Anthropic workspace: a typed workspace-400 exposes only a stable code and static guidance', async () => {
    let calls = 0;
    await assert.rejects(anthropic(request({ retries: 2 }), {
      env: { ANTHROPIC_API_KEY: KEY }, fetcher: async () => { calls++; return envelope(message); },
    }), error => {
      assert.equal(error.code, 'ANTHROPIC_WORKSPACE_REQUIRED');
      assert.equal(error.status, 400);
      assert.match(error.message, /вкажіть workspaceRef/);
      assert.equal(error.usage, undefined);
      assert.equal(explainError(error).includes(message), false);
      assert.equal(explainError(error).includes('protected provider diagnostic'), false);
      assertProtected(explainError(error));
      assert.equal(Object.hasOwn(error, 'cause'), false);
      return true;
    });
    assert.equal(calls, 1);
  });
}

for (const [label, response, expected] of [
  ['another invalid request', () => envelope('max_tokens is invalid'), 'PROVIDER_ERROR'],
  ['workspace message with another type', () => envelope('workspace is missing', 'authentication_error'), 'PROVIDER_ERROR'],
  ['workspace message with another status', () => envelope('workspace is missing', 'invalid_request_error', 422), 'PROVIDER_ERROR'],
  ['workspace message in plain text', () => new Response('workspace is missing', { status: 400 }), 'PROVIDER_ERROR'],
  ['workspace message outside error.message', () => Response.json({ error: { type: 'invalid_request_error', detail: 'workspace is missing' } }, { status: 400 }), 'PROVIDER_ERROR'],
  ['malformed JSON', () => new Response('{"error":workspace', { status: 400 }), 'PROVIDER_ERROR'],
  ['oversized JSON', () => envelope(`workspace ${'x'.repeat(32_768)}`), 'PROVIDER_ERROR'],
  ['invalid UTF-8 JSON', () => new Response(Buffer.concat([
    Buffer.from('{"error":{"type":"invalid_request_error","message":"workspace '),
    Buffer.from([0xff]), Buffer.from('"}}'),
  ]), { status: 400 }), 'PROVIDER_ERROR'],
]) {
  test(`Anthropic workspace: ${label} preserves the generic sanitized rejection`, async () => {
    await assert.rejects(anthropic(request(), { env: { ANTHROPIC_API_KEY: KEY }, fetcher: async () => response() }), error => {
      assert.equal(error.code, expected);
      assert.equal(error.usage, undefined);
      assert.equal(explainError(error).includes('max_tokens is invalid'), false);
      assert.equal(explainError(error).includes('workspace is missing'), false);
      assertProtected(explainError(error));
      return true;
    });
  });
}

test('Anthropic workspace: a hanging rejected body times out without replay or unknown billing', async () => {
  let calls = 0, cancelled = 0;
  const keepAlive = setTimeout(() => {}, 1000);
  try {
    await assert.rejects(anthropic(request({ timeoutMs: 25, retries: 2 }), {
      env: { ANTHROPIC_API_KEY: KEY }, fetcher: async () => {
        calls++;
        return { ok: false, status: 400, headers: new Headers(), body: {
          getReader() { return {
            read: () => new Promise(() => {}),
            async cancel() { cancelled++; },
            releaseLock() {},
          }; },
          async cancel() { cancelled++; },
        } };
      },
    }), error => {
      assert.equal(error.code, 'TIMEOUT');
      assert.equal(error.usage, undefined, 'rejected Messages requests cannot have unknown paid usage');
      return true;
    });
    assert.equal(calls, 1);
    assert.ok(cancelled >= 1);
  } finally { clearTimeout(keepAlive); }
});

test('Anthropic workspace: workflow failure persists the safe workspace code without response diagnostics', async t => {
  const root = await directory(t), store = new RunStore(join(root, 'workflow.yaml')), m = manifest();
  const bodyText = `This API key is not scoped to a workspace; provider-private-detail ${WORKSPACE}`;
  const done = await driveRun(createRun(m), { settings: m.settings, store, providers: {
    anthropic: args => anthropic(args, { env: { ANTHROPIC_API_KEY: KEY }, fetcher: async () => envelope(bodyText) }),
  } });
  assert.equal(done.status, 'failed');
  assert.match(done.steps[0].errorText, /ANTHROPIC_WORKSPACE_REQUIRED|вкажіть workspaceRef/);
  assert.equal(done.costUsd, 0);
  assert.equal(done.steps[0].output, null);
  assert.equal(JSON.stringify(done).includes('provider-private-detail'), false);
  assertProtected(done);
  store.saveLastRun(done);
  for (const file of [store.runFile(done.runId), join(store.dir, 'last-run.json')]) {
    const saved = await readFile(file, 'utf8');
    assertProtected(saved);
    assert.equal(saved.includes('provider-private-detail'), false);
    assert.equal(saved.includes(bodyText), false);
  }
});
