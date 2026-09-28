// Core32: timestamp citations checked against the transcript markers, no local links, and two fail-closed false
// refusals fixed (a thematic break after a list item or quote, a link with a title).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runVerifySources } from '../src/registry-data-steps.mjs';
import { loadManifest } from '../src/manifest.mjs';

const PART1 = 'http://127.0.0.1:5000/episode/part-1', PART2 = 'http://127.0.0.1:5000/episode/part-2';
const SOURCES = { sources: [
  { url: PART1, text: '[00:00] Вступ до теми. [00:10] Перша думка про модель. [00:31] Друга думка про ціни.' },
  { url: PART2, text: '[09:21] Тести коштували центи. [10:54] Порівняння швидкості.' },
] };
const video = 'https://video.example/watch?v=1';
const header = '**H**\n\n';
const FORMAT = { requiredPrefix: header, requiredHeadings: '["## Сигнали","## Новини"]', introLinks: JSON.stringify([video]), requiredIntroPrefix: 'Цікаві тези із [', citation: 'timestamps', forbidLocalLinks: 'true' };
const intro = `Цікаві тези із [відео «Назва»](${video}) про нову модель.\n\n`;
const OK = `${header}${intro}## Сигнали\n\n- Автор називає першу думку про модель [00:10].\n- Друга думка стосується цін [00:31].\n\n## Новини\n\n### Тести\n\nЗа словами автора, тести коштували центи [09:21], а швидкість порівнювали окремо [10:54].\n`;
const check = (text, config = FORMAT, sources = SOURCES) => runVerifySources({ config: { draft: '{{steps.draft.output}}', sources: '{{steps.unique.output}}', language: 'uk', ...config } }, { priorOutputs: { unique: sources, draft: { text } } });

test('citation: timestamps accepts markers that exist in the transcript, one per item, and no source URLs', () => {
  const out = check(OK);
  assert.ok(out.output.checks.includes('timestamp-citations') && out.output.checks.includes('no-local-links') && out.output.checks.includes('selected-sources-cited-by-timestamp'));
});

test('citation: timestamps refuses unknown markers, other time forms, uncited items and local links', () => {
  const bad = {
    'marker not in the transcript': [OK.replace('[00:31]', '[00:32]'), /not markers of the selected sources: \[00:32\]/],
    'round brackets': [OK.replace('[00:31]', '(00:31)'), /outside the \[mm:ss\] form/],
    'bare time': [OK.replace('[09:21]', '09:21'), /outside the \[mm:ss\] form/],
    'item without a marker': [OK.replace(' [00:31]', ''), /Every item needs its own \[mm:ss\] timestamp/],
    'paragraph without a marker': [OK.replace('[09:21], а швидкість порівнювали окремо [10:54]', 'а швидкість порівнювали окремо'), /Every item needs its own|no \[mm:ss\]/],
    'no markers at all': [OK.replace(/ \[\d\d:\d\d\]/g, ''), /cites no \[mm:ss\]|needs its own/],
    'transcript part link': [OK.replace('[00:10]', `[00:10] ([джерело](${PART1}))`), /local link|unverified URL/],
    'localhost link': [OK.replace('[00:10]', '[00:10] http://localhost:8080/x'), /local link|unverified URL/],
    'file link': [OK.replace('[00:10]', '[00:10] file:///tmp/x.jsonl'), /local link|unverified URL/],
    'timestamp as a video link': [OK.replace('[00:10]', `[00:10](${video}&t=10)`), /unverified URL|Introduction/],
  };
  for (const [name, [text, error]] of Object.entries(bad)) assert.throws(() => check(text), error, name);
  assert.throws(() => check(OK, FORMAT, { sources: [{ url: PART1, text: 'no markers here' }] }), /carry no \[mm:ss\] markers/);
  assert.throws(() => check(OK, { ...FORMAT, citation: 'bogus' }), /citation must be "timestamps" or "links"/);
});

test('forbidLocalLinks alone refuses local sources even when they are selected', () => {
  const plain = `Дайджест і джерело [a](${PART1}) та ${PART2}.`;
  assert.doesNotThrow(() => check(plain, {}));
  assert.throws(() => check(plain, { forbidLocalLinks: 'true' }), /local link/);
});

test('L9: a thematic break after a list item or a quote and a link with a title are not refused', () => {
  const format = { requiredHeadings: '["## Сигнали","## Новини"]' };
  const sources = { sources: [{ url: 'https://example.org/a', text: 'A' }] };
  const base = '## Сигнали\n\n- Сигнал і джерело https://example.org/a\n  продовження пункту\n---\n\n## Новини\n\n> Цитата і новина\n---\n\n- Новина [посилання](https://example.org/a "назва").\n';
  assert.doesNotThrow(() => check(base, format, sources));
  assert.throws(() => check(`${base}\nАбзац\n---\n`, format, sources), /required Markdown sections/, 'a setext heading under a paragraph is still refused');
});

test('podcast-summary (formerly podcast-digest) cites by timestamps, forbids local links and keeps the intro rule', () => {
  const manifest = loadManifest(new URL('../registry/workflows/podcast-summary.yaml', import.meta.url).pathname);
  const checks = manifest.steps.find(s => s.id === 'checks').config;
  assert.equal(manifest.version, '0.1.0');
  assert.equal(checks.citation, 'timestamps');
  assert.equal(checks.forbidLocalLinks, 'true');
  assert.equal(checks.requiredIntroPrefix, 'Цікаві тези із [');
  const instructions = manifest.steps.find(s => s.id === 'draft').config.instructions;
  for (const rule of [/One thesis per item/, /copied exactly from the\s+transcript/, /Do not link the transcript parts/, /\(як у відео\)/, /Do not present a date, deadline or offer mentioned in the episode as\s+current/, /do not call a\s+video a podcast/])
    assert.match(instructions, rule);
});

test('review round 1: nested setext headings, ### blocks without markers, local addresses anywhere, heading-first drafts', () => {
  const format = { requiredHeadings: '["## Сигнали","## Новини"]' };
  const sources = { sources: [{ url: 'https://example.org/a', text: 'A' }] };
  const ok = '## Сигнали\n\n- Сигнал і джерело https://example.org/a\n\n## Новини\n\n- Новина.\n';
  for (const extra of ['- Сигнал\n  Зайва секція\n  ---', '- Сигнал\n  Зайва секція\n  ===', '> Цитата\n> ---'])
    assert.throws(() => check(`${ok}\n${extra}\n`, format, sources), /required Markdown sections/, extra);
  for (const fine of ['Абзац\n- пункт\n---', '- пункт\n---', '- пункт\n ---'])
    assert.doesNotThrow(() => check(`${ok}\n${fine}\n`, format, sources), fine);
  for (const text of [OK.replace('### Тести\n\n', '### Тести\nТеза без маркера.\n\n'), OK.replace('### Тести\n\n', '### Тести\n- Пункт без маркера\n- Ще пункт\n\n')])
    assert.throws(() => check(text), /Every item needs its own/);
  for (const local of ['127.0.0.1:5000/episode/part-1', 'localhost:5000/x', 'printer.local.', 'localhost.', '169.254.1.1', '100.64.0.1', '[телеграм](https://t.me/xyiikc "http://127.0.0.1:5000/x")'])
    assert.throws(() => check(OK.replace('про модель [00:10]', `про модель ${local} [00:10]`)), /local (link|address)|unverified URL/, local);
  for (const host of ['[::ffff:127.0.0.1]', '[fe80::1]', '[fc00::1]', 'localhost.'])
    assert.throws(() => check(OK.replace('[00:10]', `[00:10] http://${host}/x`), { ...FORMAT, fixedLinks: JSON.stringify([`http://${host}/x`]) }), /local (link|address)/, host);
  assert.doesNotThrow(() => check(OK.replace('про модель [00:10]', 'про модель у співвідношенні 1:10 [00:10]')), 'a 1:10 ratio is not a timestamp');
  const headingFirst = OK.replace(`${header}${intro}`, '');
  const { requiredPrefix, introLinks, requiredIntroPrefix, ...headingOnly } = FORMAT;
  assert.throws(() => check(headingFirst.replace(' [00:31]', ''), headingOnly), /Every item needs its own/);
});
