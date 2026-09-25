import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, copyFileSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadManifest } from '../src/manifest.mjs';
import { createRun, driveRun, resumeRun, RunStore } from '../src/run.mjs';
import { runParseWeb, runDeduplicate, runVerifySources } from '../src/registry-data-steps.mjs';
const HEADER = date => `**Штучно-інтелектуальний дайджест під суботню каву на [ХУЇКС](https://t.me/xyiikc)і by [QFactory.io](https://QFactory.io) 🧋${date}**`;
const provider = { kind: 'caller', agent: 'codex', model: 'test-double', payerScope: 'local-cli' };

test('actual Digest manifest enforces pending inference, exact approval and durable duplicate/uncertain receipts', async () => {
  const root = mkdtempSync(join(tmpdir(), 'qf-registry-digest-'));
  const file = join(root, 'digest.yaml');
  copyFileSync(new URL('../registry/workflows/digest.yaml', import.meta.url), file);
  let deliveries = 0, fail = false;
  const server = createServer((req, res) => {
    if (req.url === '/receive') { deliveries++; req.resume(); res.writeHead(fail ? 503 : 200); res.end('receipt'); }
    else { res.end('<html><nav>Not source content</nav><main>Новина: перевірений приклад для тесту.</main></html>'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const urls = ['openai','anthropic','linear','figma'].map(id => `${base}/${id}`);
  const env = { QF_DIGEST_OPENAI_URL: urls[0], QF_DIGEST_ANTHROPIC_URL: urls[1], QF_DIGEST_LINEAR_URL: urls[2], QF_DIGEST_FIGMA_URL: urls[3], QF_DIGEST_RECEIVER_URL: `${base}/receive`, QF_DIGEST_DATE: '26.09' };
  const previous = Object.fromEntries(Object.keys(env).map(k => [k, process.env[k]]));
  Object.assign(process.env, env);
  const manifest = loadManifest(file), store = new RunStore(file);
  const opts = { store, callerProvider: provider, settings: manifest.settings };
  const draft = `${HEADER('26.09')}\n\n## Короткі інформаційні сигнали\n\n- Перевірений тестовий сигнал ([джерело](${urls[0]})), ${urls[1]}.\n\n## Notable / impactful / important news\n\n### Тема\n\n- Новина: ${urls[2]} і ${urls[3]}.\n`;
  async function pending() { const run = createRun(manifest); await driveRun(run, opts); assert.equal(run.status, 'waiting_inference'); return run; }
  async function answer(run) { const job = run.pendingInference; await driveRun(run, { ...opts, inferenceReply: { jobId: job.jobId, hash: job.hash, output: { text: draft } } }); assert.equal(run.status, 'waiting_human'); return run.steps.find(s => s.status === 'waiting_human').output.approvalHash; }
  try {
    const first = await pending();
    assert.ok(JSON.stringify(first.pendingInference).length < 64000);
    const approvalHash = await answer(first);
    await assert.rejects(resumeRun(first, { ...opts, decision: 'approve', approvalHash: '0'.repeat(64) }), /Approval/);
    assert.equal(deliveries, 0);
    await resumeRun(first, { ...opts, decision: 'approve', approvalHash });
    assert.equal(first.status, 'success');
    assert.equal(deliveries, 1);
    const repeat = await pending();
    await resumeRun(repeat, { ...opts, decision: 'approve', approvalHash: await answer(repeat) });
    assert.equal(repeat.status, 'success');
    assert.equal(repeat.steps.at(-1).output.duplicatePrevented, true);
    assert.equal(deliveries, 1);
    const rejected = await pending();
    await resumeRun(rejected, { ...opts, decision: 'reject', approvalHash: await answer(rejected) });
    assert.equal(rejected.status, 'failed');
    assert.equal(deliveries, 1);
    process.env.QF_DIGEST_RECEIVER_URL = `${base}/receive?failure`;
    // A distinct receiver which reports failure is never replayed automatically.
    server.removeAllListeners('request');
    server.on('request', (req, res) => { if (req.url.startsWith('/receive')) { deliveries++; res.writeHead(503); res.end('unavailable'); } else res.end('<main>Новина: перевірений приклад для тесту.</main>'); });
    const failed = await pending();
    await resumeRun(failed, { ...opts, decision: 'approve', approvalHash: await answer(failed) });
    assert.equal(failed.status, 'failed');
    assert.equal(deliveries, 2);
    const uncertain = await pending();
    await resumeRun(uncertain, { ...opts, decision: 'approve', approvalHash: await answer(uncertain) });
    assert.match(uncertain.summary, /uncertain/);
    assert.equal(deliveries, 2);
  } finally {
    for (const [k,v] of Object.entries(previous)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
    await new Promise(resolve => server.close(resolve));
    rmSync(root, { recursive: true, force: true });
  }
});

test('source components refuse hallucinated links, empty sources and normalize duplicates', () => {
  const parsed = runParseWeb({ config: { maxChars: '500' } }, { priorOutputs: { source: { status: 200, url: 'https://example.org/news', body: '<script>bad()</script><main>Real source</main>' } } });
  assert.equal(parsed.output.sources[0].text, 'Real source');
  const context = { priorOutputs: { parsed: { sources: [parsed.output.sources[0], parsed.output.sources[0]] }, draft: { text: 'Відомості https://invented.example/' } } };
  const unique = runDeduplicate({ config: { source: '{{steps.parsed.output}}' } }, context);
  assert.equal(unique.output.removed, 1);
  assert.throws(() => runVerifySources({ config: { draft: '{{steps.draft.output}}', sources: '{{steps.parsed.output}}', language: 'uk' } }, context), /unverified URL/);
});

test('Digest is a Q-Core workflow consumer without retired product aliases', () => {
  const source = readFileSync(new URL('../registry/workflows/digest.yaml', import.meta.url), 'utf8');
  assert.match(source, /^manifest: q-core\.workflow\/v1$/m);
  assert.match(source, /Put each cited\s+source URL directly in the sentence or bullet that relies on it/i);
  assert.match(source, /do not\s+replace inline citations with a standalone source list/i);
  assert.match(source, /do not invent social signals/i);
  assert.match(source, /imitate a private author's personal experience/i);
  assert.match(source, /If source metadata says\s+textTruncated is true, name the affected source or sources/i);
  assert.doesNotMatch(source, /\bqloops?\b|\bloopId\b|\bloops?\s+(?:catalog|manifest|version|id)\b/i);
});

const SOURCES = { sources: [{ url: 'https://example.org/a', text: 'A' }, { url: 'https://example.org/b', text: 'B' }] };
const FORMAT = {
  fixedLinks: '["https://t.me/xyiikc","https://QFactory.io"]',
  requiredPrefix: `${HEADER('{{env.QF_TEST_DIGEST_DATE}}')}\n\n`,
  requiredHeadings: '["## Короткі інформаційні сигнали","## Notable / impactful / important news"]',
};
const SECTIONS = '## Короткі інформаційні сигнали\n\n- Сигнал: https://example.org/a\n\n## Notable / impactful / important news\n\n### Блок\n\n- Новина [джерело](https://example.org/b).\n';
function check(text, config = FORMAT) {
  return runVerifySources({ config: { draft: '{{steps.draft.output}}', sources: '{{steps.unique.output}}', language: 'uk', ...config } }, { priorOutputs: { unique: SOURCES, draft: { text } } });
}
function withDate(value, fn) {
  const previous = process.env.QF_TEST_DIGEST_DATE;
  if (value === undefined) delete process.env.QF_TEST_DIGEST_DATE; else process.env.QF_TEST_DIGEST_DATE = value;
  try { return fn(); } finally { if (previous === undefined) delete process.env.QF_TEST_DIGEST_DATE; else process.env.QF_TEST_DIGEST_DATE = previous; }
}

test('verify-sources accepts the exact fixed header links and both sections', () => withDate('26.09', () => {
  const result = check(`${HEADER('26.09')}\n\n${SECTIONS}`);
  assert.deepEqual(result.output.checks, ['bounded-text', 'source-link-allowlist', 'all-selected-sources-cited', 'required-literal-prefix', 'required-markdown-sections']);
  assert.deepEqual(result.output.fixedLinks, ['https://t.me/xyiikc', 'https://QFactory.io']);
}));

test('verify-sources format contract fails closed on every deviation', () => withDate('26.09', () => {
  const ok = `${HEADER('26.09')}\n\n${SECTIONS}`;
  const cases = {
    'space before і': [ok.replace(')і by', ') і by'), /required literal prefix/],
    'other date': [ok.replace('🧋26.09', '🧋27.09'), /required literal prefix/],
    'date as a link': [ok.replace('🧋26.09**', '🧋[26.09](https://t.me/xyiikc/1)**'), /required literal prefix/],
    'header not first': [`Вступ.\n${ok}`, /required literal prefix/],
    'missing section': [ok.replace('## Notable / impactful / important news\n', ''), /required Markdown sections/],
    'swapped sections': [`${HEADER('26.09')}\n\n## Notable / impactful / important news\n\n- https://example.org/a\n\n## Короткі інформаційні сигнали\n\n- https://example.org/b\n`, /required Markdown sections/],
    'extra section': [`${ok}\n## Джерела\n\n- Список.\n`, /required Markdown sections/],
    'empty section': [`${HEADER('26.09')}\n\n## Короткі інформаційні сигнали\n\n## Notable / impactful / important news\n\n- https://example.org/a https://example.org/b\n`, /section is empty/],
    'invented link': [`${ok}\nДив. https://invented.example/`, /unverified URL/],
    'fixed link used as a lookalike': [`${ok}\nhttps://t.me/xyiikc/962`, /unverified URL/],
    'source not cited': [ok.replace('https://example.org/a', 'https://t.me/xyiikc'), /cite each selected source/],
  };
  for (const [name, [text, error]] of Object.entries(cases)) assert.throws(() => check(text), error, name);
}));

test('verify-sources refuses an unresolved format placeholder instead of matching literal braces', () => withDate(undefined, () => {
  assert.throws(() => check(`${HEADER('{{env.QF_TEST_DIGEST_DATE}}')}\n\n${SECTIONS}`), /unresolved template placeholder/);
  assert.throws(() => check(`${HEADER('26.09')}\n\n${SECTIONS}`, { ...FORMAT, requiredPrefix: undefined, fixedLinks: '["{{env.QF_TEST_UNSET_LINK}}"]' }), /HTTP\(S\)|unresolved/);
  assert.throws(() => check(`${HEADER('26.09')}\n\n${SECTIONS}`, { ...FORMAT, fixedLinks: 'not json' }), /JSON array/);
}));

test('verify-sources without format fields keeps the Core29 source-link behavior', () => {
  const plain = 'Дайджест і сигнали: https://example.org/a та [b](https://example.org/b).';
  const result = check(plain, {});
  assert.deepEqual(result.output.checks, ['bounded-text', 'source-link-allowlist', 'all-selected-sources-cited']);
  assert.equal('fixedLinks' in result.output, false);
  assert.throws(() => check(`${plain} [ХУЇКС](https://t.me/xyiikc)`, {}), /unverified URL/);
});

test('Podcast→Digest manifest pins OpenRouter through the Keychain, the same format contract and no delivery', () => {
  const manifest = loadManifest(new URL('../registry/workflows/podcast-digest.yaml', import.meta.url).pathname);
  const draft = manifest.steps.find(step => step.id === 'draft');
  assert.equal(draft.kind, 'llm-call');
  assert.equal(draft.config.provider, 'openrouter');
  assert.equal(draft.config.secretSource, 'keychain');
  assert.equal(draft.config.keyRef, 'OPENROUTER_API_KEY');
  assert.ok(manifest.settings.budgetUsd > 0 && manifest.settings.budgetUsd <= 1);
  const checks = manifest.steps.find(step => step.id === 'checks');
  const digestChecks = loadManifest(new URL('../registry/workflows/digest.yaml', import.meta.url).pathname).steps.find(step => step.id === 'checks');
  assert.equal(checks.config.requiredPrefix, digestChecks.config.requiredPrefix);
  assert.equal(checks.config.requiredHeadings, digestChecks.config.requiredHeadings);
  assert.equal(manifest.steps.at(-1).kind, 'approval-gate');
  assert.ok(!manifest.steps.some(step => step.kind === 'api-request'));
});
