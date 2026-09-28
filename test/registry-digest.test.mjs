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

// Digest 0.4 (OpenRouter, many feeds) is exercised end to end, offline, in core34.test.mjs; the receipt paths of
// api-request (duplicate, failure, uncertain) keep their own tests.

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
  assert.match(source, /Cite as inline Markdown links/i);
  assert.match(source, /never merge two unrelated clusters into one item/i);
  assert.match(source, /do not invent social signals/i);
  assert.match(source, /imitate a private author's personal experience/i);
  assert.match(source, /Name sources only by their item number n/i);
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
  const allowed = `${ok}\n---\n\n- Список після роздільника й [посилання](https://example.org/a).\n`;
  assert.doesNotThrow(() => check(allowed), 'a thematic break after a blank line is not a heading');
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
    'setext level-two heading': [`${ok}\nЗайва\n---\n\n- Текст.\n`, /required Markdown sections/],
    'setext level-one heading': [`${ok}\nЗайва\n===\n\n- Текст.\n`, /required Markdown sections/],
    'indented ATX section': [`${ok}\n   ## Зайва\n\n- Текст.\n`, /required Markdown sections/],
    'level-one section': [`${ok}\n# Зайва\n\n- Текст.\n`, /required Markdown sections/],
    'uppercase scheme': [`${ok}\n[x](HTTPS://evil.example/)\n`, /unverified URL/],
    'scheme-relative Markdown target': [`${ok}\n[x](//evil.example/)\n`, /unverified URL/],
    'reference-style link': [`${ok}\n[x]: evil.example\n`, /unverified URL/],
    'scheme-less www address': [`${ok}\nДив. www.evil.example\n`, /unverified URL/],
    'raw HTML link': [`${ok}\n<a href="//evil.example">x</a>\n`, /unverified URL/],
  };
  for (const [name, [text, error]] of Object.entries(cases)) assert.throws(() => check(text), error, name);
}));

test('verify-sources refuses an unresolved format placeholder instead of matching literal braces', () => withDate(undefined, () => {
  assert.throws(() => check(`${HEADER('{{env.QF_TEST_DIGEST_DATE}}')}\n\n${SECTIONS}`), /unresolved template placeholder/);
  assert.throws(() => check(`${HEADER('26.09')}\n\n${SECTIONS}`, { ...FORMAT, requiredPrefix: undefined, fixedLinks: '["{{env.QF_TEST_UNSET_LINK}}"]' }), /HTTP\(S\)|unresolved/);
  assert.throws(() => check(`${HEADER('26.09')}\n\n${SECTIONS}`, { ...FORMAT, fixedLinks: 'not json' }), /JSON array/);
}));

test('verify-sources without format fields keeps Core29 source-link checks, except exact Markdown link targets', () => {
  const plain = 'Дайджест і сигнали: https://example.org/a та [b](https://example.org/b).';
  const result = check(plain, {});
  assert.deepEqual(result.output.checks, ['bounded-text', 'source-link-allowlist', 'all-selected-sources-cited']);
  assert.equal('fixedLinks' in result.output, false);
  assert.throws(() => check(`${plain} [ХУЇКС](https://t.me/xyiikc)`, {}), /unverified URL/);
  // The two intended differences from Core29: a target glued to text is read exactly, and a target is never trimmed.
  assert.doesNotThrow(() => check('Дайджест і [a](https://example.org/a)і [b](https://example.org/b).', {}));
  assert.throws(() => check('Дайджест і [a](https://example.org/a.) https://example.org/b', {}), /unverified URL/);
  // Without a format contract, prose mentioning www. is not refused (Core29 behavior).
  assert.doesNotThrow(() => check(`${plain} Див. www.example.org`, {}));
});

test('podcast-summary pins OpenRouter through the Keychain, keeps the two sections, has no channel header and no delivery', () => {
  const manifest = loadManifest(new URL('../registry/workflows/podcast-summary.yaml', import.meta.url).pathname);
  const draft = manifest.steps.find(step => step.id === 'draft');
  assert.equal(draft.kind, 'llm-call');
  assert.equal(draft.config.provider, 'openrouter');
  assert.equal(draft.config.secretSource, 'keychain');
  assert.equal(draft.config.keyRef, 'OPENROUTER_API_KEY');
  assert.ok(manifest.settings.budgetUsd > 0 && manifest.settings.budgetUsd <= 1);
  const checks = manifest.steps.find(step => step.id === 'checks');
  assert.equal(checks.config.requiredPrefix, undefined);
  assert.equal(checks.config.requiredHeadings, '["## Короткі інформаційні сигнали","## Notable / impactful / important news"]');
  assert.equal(manifest.steps.at(-1).kind, 'approval-gate');
  assert.ok(!manifest.steps.some(step => step.kind === 'api-request'));
});
