import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadManifest, validateManifest } from '../src/manifest.mjs';
import { loadManifestGraph } from '../src/material-graph.mjs';
import { createRun, driveRun } from '../src/run.mjs';
import { runFetch } from '../src/steps.mjs';
import { runParseWeb } from '../src/registry-data-steps.mjs';

const ids = ['techcrunch', 'the-verge', 'wired', 'the-decoder', 'ars-technica', 'mit-technology-review', 'marktechpost', 'simon-willison', 'latent-space', 'openai'];
const xml = text => String(text).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const rss = sources => `<rss><channel>${sources.map(source => `<item><title>${xml(source.title)}</title><link>${xml(source.url)}</link><pubDate>${source.stale ? '2026-09-01' : '2026-09-26'}T00:00:00Z</pubDate><description>${xml(source.text)}</description></item>`).join('')}</channel></rss>`;
const load = id => loadManifest(new URL(`../registry/workflows/${id}.yaml`, import.meta.url).pathname);

async function offline(env, handler, work) {
  const original = globalThis.fetch;
  const previous = Object.fromEntries(Object.keys(env).map(name => [name, process.env[name]]));
  for (const [name, value] of Object.entries(env)) if (value === undefined) delete process.env[name]; else process.env[name] = value;
  const calls = [];
  globalThis.fetch = async url => { calls.push(String(url)); return handler(String(url)); };
  try { return await work(calls); } finally {
    globalThis.fetch = original;
    for (const [name, value] of Object.entries(previous)) if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
}
const env = () => ({
  ...Object.fromEntries(ids.map((_, index) => [`QF_DIGEST_FEED_${index + 1}`, undefined])),
  QF_DIGEST_SINCE: '2026-09-25T00:00:00Z', QF_DIGEST_UNTIL: '2026-09-27T00:00:00Z',
});
function throughUnique(manifest, legacy = false) {
  const copy = structuredClone(manifest);
  const items = copy.steps.find(step => step.id === 'items');
  const unique = copy.steps.find(step => step.id === 'unique');
  if (legacy) {
    delete items.config.fetchStep;
    copy.steps = [...manifest.inputs.sources.default.map((url, index) => ({
      id: ids[index], kind: 'fetch', config: {
        url: `{{env.QF_DIGEST_FEED_${index + 1}:-${url}}}`, format: 'text', maxBodyBytes: '2000000',
      },
    })), items, unique];
    copy.inputs = {};
  } else copy.steps = [copy.steps[0], items, unique];
  return copy;
}

for (const id of ['digest', 'digest-cli']) for (const fixtureName of ['05a7f579', '65ef7d49']) {
  test(`${id}: saved fixture ${fixtureName} has identical parse/dedupe outputs after source fan-out`, async () => {
    const fixture = JSON.parse(readFileSync(new URL(`fixtures/digest-run-${fixtureName}.json`, import.meta.url)));
    const manifest = load(id);
    const defaults = manifest.inputs.sources.default;
    const bodies = new Map(defaults.map(url => {
      const sources = fixture.sources.filter(source => source.feed === url);
      return [url, rss(sources.length ? sources : [{ url: `${url.replace(/\/$/, '')}/stale`, title: 'Old item', text: 'Outside window', stale: true }])];
    }));
    await offline(env(), url => {
      assert.ok(bodies.has(url), `Unexpected request: ${url}`);
      return new Response(bodies.get(url));
    }, async calls => {
      const before = createRun(throughUnique(manifest, true));
      const after = createRun(throughUnique(manifest));
      await driveRun(before);
      await driveRun(after);
      assert.equal(before.status, 'success', before.summary);
      assert.equal(after.status, 'success', after.summary);
      assert.deepEqual(calls, [...defaults, ...defaults]);
      for (const stepId of ['items', 'unique']) {
        assert.deepEqual(after.steps.find(step => step.stepId === stepId).output,
          before.steps.find(step => step.stepId === stepId).output, stepId);
      }
      assert.equal(after.steps.find(step => step.stepId === 'items').output.sources.length, fixture.sources.length);
      assert.equal(after.steps.filter(step => step.stepId === 'source-fetch').length, defaults.length);
      assert.equal(after.steps[0].output.truncated, undefined);
    });
  });
}

test('source fan-out accepts a custom array, preserves order/duplicates and never expands feed text as templates', async () => {
  const manifest = throughUnique(load('digest'));
  const urls = ['https://custom.example/a?x=1&y=2', 'HTTPS://custom.example/b', 'https://custom.example/a?x=1&y=2'];
  const literal = '{{env.QF_DIGEST_ARRAY_TEST_SECRET}}';
  await offline({ ...env(), QF_DIGEST_FEED_1: 'https://ignored.example/feed', QF_DIGEST_ARRAY_TEST_SECRET: 'must-not-appear' },
    () => new Response(rss([{ title: 'Source', url: 'https://article.example/one', text: literal }])), async calls => {
      const run = createRun(manifest, { inputs: { sources: urls } });
      await driveRun(run);
      assert.equal(run.status, 'success', run.summary);
      assert.deepEqual(calls, urls);
      const items = run.steps.find(step => step.stepId === 'items').output;
      assert.deepEqual(items.feeds.map(feed => feed.url), urls);
      assert.ok(items.sources.every(source => source.text === literal));
      assert.equal(run.steps.find(step => step.stepId === 'unique').output.removed, 2);
    });
});

test('invalid digest arrays/defaults/env fail before fetch and the manifest validator enforces defaults', async () => {
  await offline(env(), () => { throw new Error('Network must never run'); }, async calls => {
    for (const id of ['digest', 'digest-cli']) {
      const manifest = load(id);
      for (const sources of [[], ['not a URL'], ['https://ok.example/feed', 'ftp://bad.example/feed'], Array(21).fill('https://ok.example/feed')]) {
        assert.throws(() => createRun(manifest, { inputs: { sources } }), /inputs.sources/);
      }
      const doc = { manifest: 'q-core.workflow/v1', id, inputs: manifest.inputs, steps: manifest.steps };
      doc.inputs.sources.default = [];
      assert.throws(() => validateManifest(doc), /inputs.sources.default/);
    }
    assert.deepEqual(calls, []);
  });
});

test('whole item URLs require an explicit operator input allowlist; step data keeps the authority guard', async () => {
  const step = { id: 'f', kind: 'fetch', config: { url: '{{item}}', urlInput: 'sources' } };
  const good = 'https://operator.example/feed';
  const base = { invocationId: 'root', inputs: { sources: [good] }, item: good, itemIndex: 0, priorOutputs: {} };
  await offline({}, () => new Response('feed'), async calls => {
    assert.equal((await runFetch(step, base)).output.url, good);
    const failures = [
      [step, { ...base, item: 'https://model.example/feed' }],
      [step, { ...base, itemIndex: 1 }],
      [step, { ...base, invocationId: 'child' }],
      [step, { ...base, invocationId: undefined }],
      [step, { ...base, inputs: {} }],
      [step, { ...base, item: '{{env.TOKEN}}', inputs: { sources: ['{{env.TOKEN}}'] } }],
      [{ ...step, config: { url: '{{item}}' } }, base],
      [{ ...step, config: { url: '{{steps.model.output.url}}', urlInput: 'sources' } }, { ...base, priorOutputs: { model: { url: good } } }],
    ];
    for (const [candidate, context] of failures) await assert.rejects(runFetch(candidate, context), /urlInput|scheme and host/);
    assert.deepEqual(calls, [good]);
  });
});

test('a child workflow cannot turn model output into an operator URL allowlist through input binding', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'q-core-digest-url-provenance-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const yaml = doc => Object.entries(doc).map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join('\n') + '\n';
  const child = yaml({
    manifest: 'q-core.workflow/v1', id: 'feed-child', version: '1.0.0',
    inputs: { sources: { type: 'array', minItems: 1, items: { type: 'string', format: 'http-url' } } },
    steps: [{ id: 'fan', kind: 'fan-out', config: { over: '{{inputs.sources}}' }, then: [
      { id: 'source-fetch', kind: 'fetch', config: { url: '{{item}}', urlInput: 'sources' } },
    ] }],
  });
  writeFileSync(join(dir, 'child.yaml'), child);
  writeFileSync(join(dir, 'parent.yaml'), yaml({
    manifest: 'q-core.workflow/v1', id: 'parent', version: '1.0.0',
    dependencies: { feed: { kind: 'workflow', id: 'feed-child', version: '1.0.0', path: 'child.yaml', sha256: createHash('sha256').update(child).digest('hex') } },
    steps: [
      { id: 'model', kind: 'llm-call', config: { provider: 'cli', format: 'json', instructions: 'Propose a source list.' } },
      { id: 'child', kind: 'workflow-call', config: { ref: 'feed', inputs: '{"sources":"{{steps.model.output.sources}}"}' } },
    ],
  }));
  const run = createRun(loadManifestGraph(join(dir, 'parent.yaml')));
  // Represent a completed model answer; the actual dependency expansion and
  // dynamic child input binding still run, with every network call refused.
  run.steps[0].status = 'success';
  run.steps[0].output = { sources: ['https://model-chosen.example/feed'] };
  await offline({}, () => { throw new Error('Model data must not select a fetch destination'); }, async calls => {
    await driveRun(run);
    assert.equal(run.status, 'failed');
    assert.match(run.summary, /root operator input array/);
    const fetch = run.steps.find(step => step.stepId === 'source-fetch');
    assert.equal(fetch.item, 'https://model-chosen.example/feed', 'the model value reached the real child lane');
    assert.notEqual(fetch.invocationId, 'root');
    assert.equal(fetch.status, 'failed');
    assert.deepEqual(calls, []);
  });
});

test('feed collection refuses no completed lanes and ambiguous source selectors', () => {
  assert.throws(() => runParseWeb({ config: { items: 'feed', fetchStep: 'missing' } }, { priorOutputs: {}, priorFetchOutputs: [] }), /1..20 fetched/);
  assert.throws(() => runParseWeb({ config: { items: 'feed', fetchStep: 'source-fetch', source: '{{steps.other.output}}' } }, { priorOutputs: {} }), /mutually exclusive/);
});
