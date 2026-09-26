// Core34: a multi-source Digest — feed items as sources, meaning clusters proposed by a model and checked
// deterministically, every thesis linked to a selected source, section shape checks, a bounded model input,
// and a podcast summary without the channel header. Every test here is offline: fetch is stubbed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadManifest, validateManifest } from '../src/manifest.mjs';
import { createRun, driveRun, resumeRun, RunStore } from '../src/run.mjs';
import { runParseWeb, runDeduplicate, runVerifySources } from '../src/registry-data-steps.mjs';

const HEADER = date => `**Штучно-інтелектуальний дайджест під суботню каву на [ХУЇКС](https://t.me/xyiikc)і by [QFactory.io](https://QFactory.io) 🧋${date}**`;
const rss = items => `<?xml version="1.0"?><rss><channel><title>Feed</title>${items.map(([title, link, date, summary]) => `<item><title>${title}</title><link>${link}</link><pubDate>${date}</pubDate><description><![CDATA[${summary}]]></description></item>`).join('')}</channel></rss>`;
const atom = items => `<feed xmlns="http://www.w3.org/2005/Atom">${items.map(([title, link, date, summary]) => `<entry><title>${title}</title><link href="${link}" rel="alternate"/><published>${date}</published><summary type="html">${summary}</summary></entry>`).join('')}</feed>`;
const fetched = (url, body) => ({ status: 200, url, body, truncated: false });
const withEnv = (vars, fn) => {
  const previous = Object.fromEntries(Object.keys(vars).map(k => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  const restore = () => { for (const [k, v] of Object.entries(previous)) if (v === undefined) delete process.env[k]; else process.env[k] = v; };
  let out;
  try { out = fn(); } catch (error) { restore(); throw error; }
  if (out && typeof out.then === 'function') return out.finally(restore);
  restore();
  return out;
};

const MEDIA = rss([
  ['OpenAI pauses training', 'https://media.example/openai-pause', 'Sat, 26 Sep 2026 09:00:00 +0000', '<p>OpenAI paused training of its most capable models.</p>'],
  ['Old story', 'https://media.example/old', 'Mon, 21 Sep 2026 09:00:00 +0000', 'Outside the window.'],
  ['Meta&#8217;s Muse', 'https://media.example/muse', 'Fri, 25 Sep 2026 12:00:00 +0000', 'Muse &amp; filesystem &#039;exposed&#039;.'],
]);
const BLOG = atom([
  ['Quoting a pause', 'https://blog.example/pause', '2026-09-26T10:00:00+00:00', '&lt;blockquote&gt;&lt;p&gt;The pause matters.&lt;/p&gt;&lt;/blockquote&gt;'],
  ['Undated'.replace('d', 'd'), 'https://blog.example/undated', 'not a date', 'No usable date.'],
]);
const items = (config = {}, prior = { media: fetched('https://media.example/feed', MEDIA), blog: fetched('https://blog.example/atom', BLOG) }) =>
  runParseWeb({ config: { items: 'feed', since: '2026-09-24T21:00:00Z', until: '2026-09-26T21:00:00Z', ...config } }, { priorOutputs: prior, priorStepNames: {} });

test('parse-web items: feed turns RSS and Atom items into dated sources inside the window, newest first, clean text', () => {
  const out = items().output;
  assert.deepEqual(out.sources.map(s => s.url), ['https://media.example/openai-pause', 'https://media.example/muse', 'https://blog.example/pause']);
  const muse = out.sources.find(s => s.url.endsWith('/muse'));
  assert.equal(muse.title, 'Meta’s Muse');
  assert.equal(muse.text, "Muse & filesystem 'exposed'.");
  assert.equal(out.sources.find(s => s.url.endsWith('/pause')).text, 'The pause matters.');
  assert.equal(muse.feed, 'https://media.example/feed');
  assert.equal(muse.published, '2026-09-25T12:00:00.000Z');
  assert.deepEqual(out.feeds.map(f => [f.entries, f.inWindow, f.kept]), [[3, 2, 2], [2, 1, 1]]);
  assert.match(out.extraction, /linked articles were not read/);
  assert.equal(out.window.since, '2026-09-24T21:00:00.000Z');
  // Without a window every item with a link is kept, undated last.
  const all = items({ since: undefined, until: undefined }).output;
  assert.equal(all.sources.length, 5);
  assert.equal(all.sources.at(-1).url, 'https://blog.example/undated');
  assert.equal(items({ maxItemsPerSource: '1' }).output.sources.length, 2);
  assert.ok(items({ itemChars: '100' }).output.sources.every(s => s.text.length <= 100));
});

test('parse-web items: feed fails closed on a non-feed page, an empty window and bad bounds', () => {
  assert.throws(() => items({}, { page: fetched('https://site.example/', '<html><main>News</main></html>') }), /not an RSS\/Atom feed/);
  assert.throws(() => items({ since: '2026-09-27T00:00:00Z', until: '2026-09-28T00:00:00Z' }), /No feed items in the requested time window/);
  assert.throws(() => items({ since: '{{env.QF_TEST_UNSET_SINCE}}' }), /unresolved template placeholder/);
  assert.throws(() => items({ since: 'yesterday' }), /ISO date/);
  assert.throws(() => items({ since: '2026-09-26T00:00:00Z', until: '2026-09-25T00:00:00Z' }), /since must be before until/);
  assert.throws(() => items({ maxItemsPerSource: '0' }), /maxItemsPerSource must be 1\.\.50/);
  assert.throws(() => items({ itemChars: '5000' }), /itemChars must be 100\.\.2000/);
  assert.throws(() => items({ items: 'html' }), /items must be "feed"/);
  withEnv({ QF_TEST_SINCE: '2026-09-26T00:00:00Z' }, () => assert.equal(items({ since: '{{env.QF_TEST_SINCE}}' }).output.sources.length, 2));
});

const POOL = { sources: [
  { n: 1, url: 'https://a.example/1', feed: 'https://a.example/feed', title: 'A1', text: 'Pause' },
  { n: 2, url: 'https://b.example/1', feed: 'https://www.b.example/feed', title: 'B1', text: 'Pause too' },
  { url: 'https://a.example/2', feed: 'https://a.example/feed', title: 'A2', text: 'Muse' },
  { url: 'https://c.example/1', feed: 'https://c.example/feed', title: 'C1', text: 'Off topic' },
] };
const cluster = (clusters, config = {}) => runDeduplicate({ config: { source: '{{steps.unique.output}}', clusters: '{{steps.cluster.output}}', ...config } }, { priorOutputs: { unique: POOL, cluster: { clusters } }, priorStepNames: {} });

test('deduplicate clusters: sources may be named by item number n, which a model cannot misspell into a URL', () => {
  const out = cluster([{ topic: 'Pause', sources: [1, 2] }, { topic: 'Muse', sources: ['https://a.example/2'] }]).output;
  assert.deepEqual(out.clusters.map(c => c.sources.map(s => s.url)), [['https://a.example/1', 'https://b.example/1'], ['https://a.example/2']]);
});

test('deduplicate clusters: a meaning keeps every source that reports it, ranked, bounded and checked', () => {
  const out = cluster([
    { topic: 'Pause', summary: 'Both report the pause.', sources: ['https://a.example/1', 'https://b.example/1', 'https://a.example/1'] },
    { topic: 'Muse', summary: 'One report.', sources: ['https://a.example/2'] },
  ]).output;
  assert.deepEqual(out.clusters.map(c => [c.rank, c.topic, c.independentOutlets, c.sources.length]), [[1, 'Pause', 2, 2], [2, 'Muse', 1, 1]]);
  assert.deepEqual(out.sources.map(s => [s.url, s.cluster]), [['https://a.example/1', 1], ['https://b.example/1', 1], ['https://a.example/2', 2]]);
  assert.equal(out.unclustered, 1);
  assert.equal(out.removed, 1);
  assert.match(out.sourceHash, /^[0-9a-f]{64}$/);
  // More independent outlets rank first, whatever the model's order; ties keep the model's order.
  const ranked = cluster([{ topic: 'Muse', sources: ['https://a.example/2'] }, { topic: 'Pause', sources: ['https://a.example/1', 'https://b.example/1'] }], { maxClusters: '1' }).output;
  assert.deepEqual(ranked.clusters.map(c => [c.rank, c.modelRank, c.topic]), [[1, 2, 'Pause']]);
  const top = cluster([{ topic: 'Pause', sources: ['https://a.example/1'] }, { topic: 'Muse', sources: ['https://a.example/2'] }], { maxClusters: '1' }).output;
  assert.equal(top.clusters.length, 1);
  assert.equal(top.droppedClusters, 1);
  assert.deepEqual(top.sources.map(s => s.url), ['https://a.example/1']);
});

test('deduplicate clusters refuses invented URLs, a source counted twice and malformed proposals', () => {
  assert.throws(() => cluster([{ topic: 'X', sources: ['https://invented.example/1'] }]), /not a selected source/);
  assert.throws(() => cluster([{ topic: 'X', sources: [99] }]), /item 99, which is not a selected source/);
  assert.throws(() => cluster([{ topic: 'X', sources: [1] }, { topic: 'Y', sources: ['https://a.example/1'] }]), /a meaning is counted once/);
  assert.throws(() => cluster([{ topic: 'X', sources: [true] }]), /item numbers or URLs/);
  assert.throws(() => cluster([{ topic: 'X', sources: ['https://a.example/1'] }, { topic: 'Y', sources: ['https://a.example/1'] }]), /a meaning is counted once/);
  assert.throws(() => cluster([{ topic: '', sources: ['https://a.example/1'] }]), /needs a topic/);
  assert.throws(() => cluster([{ topic: 'X', sources: [] }]), /nonempty sources array/);
  assert.throws(() => cluster([]), /1\.\.50 clusters/);
  assert.throws(() => cluster([{ topic: 'X', sources: ['https://a.example/1'] }], { maxClusters: '0' }), /maxClusters must be 1\.\.20/);
});

const A = 'https://media.example/openai-pause', B = 'https://blog.example/pause', C = 'https://media.example/muse';
const SELECTED = { sources: [{ url: A, text: 'a' }, { url: B, text: 'b' }, { url: C, text: 'c' }, { url: 'https://media.example/unused', text: 'u' }] };
const DIGEST_FORMAT = {
  citation: 'links', forbidLocalLinks: 'true', fixedLinks: '["https://t.me/xyiikc","https://QFactory.io"]',
  requiredPrefix: `${HEADER('26.09')}\n\n`, requiredHeadings: '["## Загальна картина","## Кейси"]',
  sectionSentences: '{"## Загальна картина":"2..4"}', sectionItems: '{"## Кейси":"2..3"}',
};
const OVERVIEW = `Лабораторії гальмують найпотужніші моделі через агентів ([Media](${A}), [Blog](${B})). Паралельно споживчі агенти на кшталт Muse викликають питання приватності, і це вже 2.5-й такий сигнал ([Media](${C})).`;
const CASES = `- **Пауза OpenAI** — тренування призупинено ([Media](${A}), [Blog](${B})).\n- **Muse** — файлова система виявилась відкритою ([Media](${C})).\n`;
const DIGEST = `${HEADER('26.09')}\n\n## Загальна картина\n\n${OVERVIEW}\n\n## Кейси\n\n${CASES}`;
const verify = (text, config = DIGEST_FORMAT, sources = SELECTED) => runVerifySources({ config: { draft: '{{steps.draft.output}}', sources: '{{steps.clusters.output}}', language: 'uk', ...config } }, { priorOutputs: { clusters: sources, draft: { text } }, priorStepNames: {} });

test('verify-sources citation: links — every thesis links a selected source; not every source must be cited', () => {
  const out = verify(DIGEST).output;
  assert.deepEqual(out.checks, ['bounded-text', 'source-link-allowlist', 'every-thesis-cites-a-selected-source', 'required-literal-prefix', 'required-markdown-sections', 'no-local-links', 'section-item-counts', 'section-sentence-counts']);
  // A bare selected URL is a citation too.
  assert.doesNotThrow(() => verify(DIGEST.replace(`([Media](${C}))`, `${C}`)));
});

test('verify-sources citation: links and section shape fail closed on every deviation', () => {
  const cases = {
    'case without a link': [DIGEST.replace(`відкритою ([Media](${C})).`, 'відкритою.'), /Every thesis needs a link to a selected source/],
    'overview sentence without a link': [DIGEST.replace('через агентів ([Media]', 'через агентів. Це нова норма ([Media]'), /Every thesis needs a link to a selected source; uncited: Лабораторії/],
    'only a header link in a thesis': [DIGEST.replace(`([Media](${C})).\n`, '([ХУЇКС](https://t.me/xyiikc)).\n'), /Every thesis needs a link/],
    'invented article URL': [DIGEST.replace(`](${C})).`, '](https://media.example/invented)).'), /unverified URL|Every thesis needs a link/],
    'lookalike of a selected URL': [DIGEST.replace(`](${C})).`, `](${C}-2)).`), /unverified URL|Every thesis needs a link/],
    'one case': [DIGEST.replace(/- \*\*Muse\*\*[^\n]*\n/, ''), /2\.\.3 list items; found 1/],
    'four cases': [`${DIGEST}- **Три** — ще ([Media](${A})).\n- **Чотири** — ще ([Media](${B})).\n`, /2\.\.3 list items; found 4/],
    'prose in the cases section': [DIGEST.replace('## Кейси\n\n', `## Кейси\n\nВступ до кейсів ([Media](${A})).\n\n`), /must be a list only/],
    'one-sentence overview': [DIGEST.replace(OVERVIEW, `Лабораторії гальмують моделі ([Media](${A})).`), /2\.\.4 sentences; found 1/],
    'five-sentence overview': [DIGEST.replace(OVERVIEW, `${OVERVIEW} Три ([Media](${A})). Чотири ([Media](${A})). П'ять ([Media](${A})).`), /2\.\.4 sentences; found 5/],
    'list in the overview': [DIGEST.replace(OVERVIEW, `- Пункт ([Media](${A})).\n- Ще пункт ([Media](${B})).`), /must be prose/],
    'header with a space before і': [DIGEST.replace(')і by', ') і by'), /required literal prefix/],
    'extra section': [`${DIGEST}\n## Джерела\n\n- [Media](${A})\n`, /required Markdown sections/],
    'local link': [DIGEST.replace(`](${C})).`, '](http://127.0.0.1:8080/x)).'), /local link|unverified URL|Every thesis needs a link/],
  };
  for (const [name, [text, error]] of Object.entries(cases)) assert.throws(() => verify(text), error, name);
  assert.throws(() => verify(DIGEST, { ...DIGEST_FORMAT, sectionItems: '{"## Інше":"2..3"}' }), /only name headings from requiredHeadings/);
  assert.throws(() => verify(DIGEST, { ...DIGEST_FORMAT, sectionItems: '{"## Кейси":"3..2"}' }), /min\.\.max/);
  assert.throws(() => verify(DIGEST, { citation: 'links' }), /require requiredHeadings/);
  assert.throws(() => verify(DIGEST, { ...DIGEST_FORMAT, citation: 'bogus' }), /citation must be "timestamps" or "links"/);
});

test('verify-sources itemMaxWords, oneClusterPerItem and one-line theses refuse the defects seen in live drafts', () => {
  const clustered = { sources: [{ url: A, text: 'a', cluster: 1 }, { url: B, text: 'b', cluster: 1 }, { url: C, text: 'c', cluster: 2 }] };
  const format = { ...DIGEST_FORMAT, itemMaxWords: '{"## Кейси":12}', oneClusterPerItem: '["## Кейси"]' };
  const out = verify(DIGEST, format, clustered).output;
  assert.ok(out.checks.includes('item-word-limits') && out.checks.includes('one-cluster-per-item'));
  const cases = {
    'two clusters in one case': [DIGEST.replace(`([Media](${A}), [Blog](${B})).\n- **Muse**`, `([Media](${A}), [Media](${C})).\n- **Muse**`), /cites 2 clusters/],
    'a long case': [DIGEST.replace('тренування призупинено', 'тренування призупинено на невизначений час через кілька інцидентів з агентами'), /more than 12 words/],
    'a word split across lines': [DIGEST.replace('файлова система виявилась', 'файлова сис\nтема виявилась'), /must be one line/],
    'a paragraph split across lines': [DIGEST.replace('Паралельно споживчі', 'Паралельно\nспоживчі'), /paragraph must be one line/],
  };
  for (const [name, [text, error]] of Object.entries(cases)) assert.throws(() => verify(text, format, clustered), error, name);
  assert.throws(() => verify(DIGEST, format, SELECTED), /requires sources from deduplicate clusters/);
  assert.throws(() => verify(DIGEST, { ...format, itemMaxWords: '{"## Кейси":2}' }, clustered), /5\.\.500 words/);
  assert.throws(() => verify(DIGEST, { ...format, oneClusterPerItem: '["## Інше"]' }, clustered), /only name headings/);
});

test('verify-sources introLinks work without a fixed header (a document that starts with its introduction)', () => {
  const video = 'https://video.example/watch?v=1';
  const sources = { sources: [{ url: 'https://t.example/part-1', text: '[00:10] Думка. [00:31] Ще думка.' }] };
  const format = { requiredHeadings: '["## Сигнали","## Новини"]', introLinks: JSON.stringify([video]), requiredIntroPrefix: 'Цікаві тези із [', citation: 'timestamps' };
  const text = `Цікаві тези із [відео «Назва»](${video}) про модель.\n\n## Сигнали\n\n- Перша думка [00:10].\n\n## Новини\n\n- Друга думка [00:31].\n`;
  assert.ok(verify(text, format, sources).output.checks.includes('intro-links-inline'));
  assert.throws(() => verify(`Вступ.\n${text}`, format, sources), /one paragraph on one line|must begin with/);
  assert.throws(() => verify(`${HEADER('26.09')}\n\n${text}`, format, sources), /one paragraph on one line|must begin with|unverified URL/);
});

async function withFetch(handler, work) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => { calls.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : null }); return handler(String(url), init, calls); };
  try { return await work(calls); } finally { globalThis.fetch = original; }
}
const completion = content => new Response(JSON.stringify({ id: 'gen-1', model: 'anthropic/claude-sonnet-5', choices: [{ message: { content }, finish_reason: 'stop' }], usage: { prompt_tokens: 1000, completion_tokens: 200, cost: 0.004 } }), { status: 200, headers: { 'content-type': 'application/json' } });

test('llm-call input: the model sees only the referenced step output, not every prior raw output', async () => {
  const m = validateManifest({ manifest: 'q-core.workflow/v1', id: 'core34-input', settings: { model: 'anthropic/claude-sonnet-5', budgetUsd: 0.1 }, steps: [
    { id: 'raw', kind: 'fetch', config: { url: 'https://raw.example/feed', format: 'text' } },
    { id: 'ask', kind: 'llm-call', config: { instructions: 'Say done.', input: '{{steps.raw.output.url}}', retries: '0' } },
  ] });
  await withFetch(url => url.startsWith('https://openrouter.ai') ? completion('done') : new Response('RAW BODY '.repeat(100)), async calls => {
    const run = createRun(m);
    await driveRun(run, { apiKey: 'test-key', settings: m.settings });
    assert.equal(run.status, 'success');
    const user = calls.find(c => c.url.startsWith('https://openrouter.ai')).body.messages[1].content;
    assert.equal(user, JSON.stringify('https://raw.example/feed', null, 2));
    assert.doesNotMatch(user, /RAW BODY/);
  });
  const bad = validateManifest({ manifest: 'q-core.workflow/v1', id: 'core34-input-bad', settings: { model: 'anthropic/claude-sonnet-5', budgetUsd: 0.1 }, steps: [
    { id: 'ask', kind: 'llm-call', config: { instructions: 'Say done.', input: '{{steps.missing.output}}', retries: '0' } },
  ] });
  await withFetch(() => completion('done'), async calls => {
    const run = createRun(bad);
    await driveRun(run, { apiKey: 'test-key', settings: bad.settings });
    assert.equal(run.status, 'failed');
    assert.equal(calls.length, 0, 'nothing is sent when the input reference does not resolve');
  });
});

test('Digest 0.4 end to end offline: feeds -> clusters -> draft -> checks -> exact approval -> one file delivery, no duplicate', async () => {
  const root = mkdtempSync(join(tmpdir(), 'qf-digest-04-'));
  const manifest = loadManifest(new URL('../registry/workflows/digest.yaml', import.meta.url).pathname);
  assert.equal(manifest.version, '0.4.0');
  // Offline: the key comes from the test, not the Keychain; everything else is the shipped manifest.
  for (const step of manifest.steps) if (step.kind === 'llm-call') { assert.equal(step.config.secretSource, 'keychain'); step.config.secretSource = 'env'; }
  const feeds = manifest.steps.filter(s => s.kind === 'fetch');
  assert.equal(feeds.length, 10);
  const env = { QF_DIGEST_DATE: '26.09', QF_DIGEST_SINCE: '2026-09-24T21:00:00Z', QF_DIGEST_UNTIL: '2026-09-26T21:00:00Z', QF_DIGEST_RECEIVER_URL: `file://${join(root, 'delivery.jsonl')}` };
  feeds.forEach((_, i) => { env[`QF_DIGEST_FEED_${i + 1}`] = i === 0 ? 'https://media.example/feed' : i === 1 ? 'https://blog.example/atom' : `https://empty.example/${i}`; });
  const clusters = JSON.stringify({ clusters: [
    { topic: 'OpenAI pause', summary: 'Two outlets report the pause.', sources: [1, 3] },
    { topic: 'Muse', summary: 'Muse filesystem.', sources: [C] },
  ] });
  let modelCalls = 0;
  const handler = url => {
    if (url.startsWith('https://openrouter.ai')) { modelCalls += 1; return completion(modelCalls % 2 === 1 ? clusters : DIGEST); }
    if (url === 'https://media.example/feed') return new Response(MEDIA);
    if (url === 'https://blog.example/atom') return new Response(BLOG);
    return new Response(rss([['Stale', 'https://empty.example/stale', 'Mon, 01 Sep 2026 00:00:00 +0000', 'Old.']]));
  };
  await withEnv(env, () => withFetch(handler, async calls => {
    const store = new RunStore(join(root, 'digest.yaml'));
    const opts = { store, apiKey: 'test-key', settings: manifest.settings };
    const run = createRun(manifest);
    await driveRun(run, opts);
    assert.equal(run.status, 'waiting_human', run.summary);
    const step = id => run.steps.find(s => s.stepId === id);
    assert.equal(step('items').output.sources.length, 3);
    const clusterInput = JSON.parse(calls.find(c => c.url.startsWith('https://openrouter.ai')).body.messages[1].content);
    assert.deepEqual(Object.keys(clusterInput), ['sources', 'removed', 'sourceHash'], 'the cluster call sees the deduplicated items only');
    assert.equal(step('clusters').output.clusters[0].independentOutlets, 2);
    assert.equal(step('checks').output.text, DIGEST.trim());
    assert.ok(step('cluster').costUsd > 0 && step('draft').costUsd > 0);
    const approvalHash = step('approval').output.approvalHash;
    await assert.rejects(resumeRun(run, { ...opts, decision: 'approve', approvalHash: '0'.repeat(64) }), /Approval/);
    await resumeRun(run, { ...opts, decision: 'approve', approvalHash });
    assert.equal(run.status, 'success', run.summary);
    const lines = readFileSync(join(root, 'delivery.jsonl'), 'utf8').trim().split('\n');
    assert.equal(lines.length, 1);
    assert.match(lines[0], /Штучно-інтелектуальний дайджест/);
    const repeat = createRun(manifest);
    await driveRun(repeat, opts);
    await resumeRun(repeat, { ...opts, decision: 'approve', approvalHash: repeat.steps.find(s => s.stepId === 'approval').output.approvalHash });
    assert.equal(repeat.status, 'success');
    assert.equal(repeat.steps.at(-1).output.duplicatePrevented, true);
    assert.equal(readFileSync(join(root, 'delivery.jsonl'), 'utf8').trim().split('\n').length, 1);
  })).finally(() => rmSync(root, { recursive: true, force: true }));
});

test('podcast-summary 0.1.0 is podcast-digest without the channel header; Digest 0.4 keeps the exact header', () => {
  const summary = loadManifest(new URL('../registry/workflows/podcast-summary.yaml', import.meta.url).pathname);
  assert.equal(summary.id, 'podcast-summary');
  assert.equal(summary.version, '0.1.0');
  const checks = summary.steps.find(s => s.id === 'checks').config;
  assert.equal(checks.requiredPrefix, undefined);
  assert.equal(checks.fixedLinks, undefined);
  assert.equal(checks.requiredEnvPatterns, undefined);
  assert.equal(checks.citation, 'timestamps');
  assert.equal(checks.requiredIntroPrefix, 'Цікаві тези із [');
  assert.equal(checks.requiredHeadings, '["## Короткі інформаційні сигнали","## Notable / impactful / important news"]');
  const source = readFileSync(new URL('../registry/workflows/podcast-summary.yaml', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /Штучно-інтелектуальний|t\.me\/xyiikc|QF_DIGEST_DATE/);
  assert.equal(summary.steps.at(-1).kind, 'approval-gate');
  assert.ok(!summary.steps.some(s => s.kind === 'api-request'));
  const digest = loadManifest(new URL('../registry/workflows/digest.yaml', import.meta.url).pathname);
  const dc = digest.steps.find(s => s.id === 'checks').config;
  assert.equal(dc.requiredPrefix, `${HEADER('{{env.QF_DIGEST_DATE}}')}\n\n`);
  assert.equal(dc.citation, 'links');
  assert.equal(dc.sources, '{{steps.clusters.output}}');
  assert.equal(digest.steps.find(s => s.id === 'delivery').config.receiptKey, '{{steps.clusters.output.sourceHash}}');
});
