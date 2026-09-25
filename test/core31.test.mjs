// Core31: env defaults and the up-front missing-environment error, file:/// delivery, verify-sources Low fixes,
// clearer scope/help/renamed-format messages and self-ignoring run state (end-to-end review findings).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { resolveTemplate, missingEnvRefs } from '../src/template.mjs';
import { loadManifest } from '../src/manifest.mjs';
import { createRun, driveRun, RunStore, requiredEnvMissing } from '../src/run.mjs';
import { runVerifySources } from '../src/registry-data-steps.mjs';
import { scopedPath } from '../src/workspace.mjs';

const BIN = new URL('../bin/q-core.mjs', import.meta.url).pathname;
function withEnv(values, fn) {
  const previous = Object.fromEntries(Object.keys(values).map(k => [k, process.env[k]]));
  for (const [k, v] of Object.entries(values)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  const restore = () => { for (const [k, v] of Object.entries(previous)) if (v === undefined) delete process.env[k]; else process.env[k] = v; };
  try { const out = fn(); if (out?.then) return out.finally(restore); restore(); return out; } catch (e) { restore(); throw e; }
}
function workflow(yaml) {
  const dir = mkdtempSync(join(tmpdir(), 'q-core31-')), file = join(dir, 'workflow.yaml');
  writeFileSync(file, yaml);
  return { dir, file, manifest: loadManifest(file), store: new RunStore(file) };
}

test('{{env.NAME:-default}} uses the default when NAME is unset or empty, and such a reference is never missing', () => withEnv({ Q31_A: undefined, Q31_B: '' , Q31_C: 'set' }, () => {
  assert.equal(resolveTemplate('{{env.Q31_A:-https://example.org/feed.xml}}', {}), 'https://example.org/feed.xml');
  assert.equal(resolveTemplate('{{env.Q31_B:-fallback}}', {}), 'fallback');
  assert.equal(resolveTemplate('{{env.Q31_C:-fallback}}', {}), 'set');
  assert.equal(resolveTemplate('{{env.Q31_A}}', {}), '{{env.Q31_A}}', 'without a default an unset reference stays visible');
  assert.deepEqual(missingEnvRefs('{{env.Q31_A:-x}} {{env.Q31_A}}'), ['Q31_A']);
  assert.deepEqual(missingEnvRefs('{{env.Q31_A:-x}}'), []);
}));

test('a run names every missing required variable before the first step; dry runs and optional file-sink URLs are exempt', async () => {
  const w = workflow(`manifest: q-core.workflow/v1
id: env-check
name: Env check
steps:
  - id: read
    kind: fetch
    config:
      url: "{{env.Q31_SOURCE}}"
  - id: optional
    kind: api-request
    config:
      url: "{{env.Q31_OPTIONAL_HOOK}}"
  - id: required
    kind: api-request
    config:
      url: "{{env.Q31_RECEIVER}}"
      receiptKey: "fixed"
`);
  try {
    await withEnv({ Q31_SOURCE: undefined, Q31_RECEIVER: undefined, Q31_OPTIONAL_HOOK: undefined }, async () => {
      assert.deepEqual(requiredEnvMissing(createRun(w.manifest).steps), ['Q31_SOURCE', 'Q31_RECEIVER']);
      const run = createRun(w.manifest);
      await driveRun(run, { store: w.store, settings: w.manifest.settings });
      assert.equal(run.status, 'failed');
      assert.match(run.summary, /^Missing environment variables: Q31_SOURCE, Q31_RECEIVER\./);
      assert.equal(run.steps[0].status, 'failed');
      assert.ok(run.steps.slice(1).every(s => s.status === 'pending'), 'nothing ran');
      const dry = createRun(w.manifest);
      await driveRun(dry, { store: w.store, settings: w.manifest.settings, dryRun: true });
      assert.notEqual(dry.status, 'failed', 'a dry run only plans');
    });
  } finally { rmSync(w.dir, { recursive: true, force: true }); }
});

test('api-request delivers to a file:/// destination once per receipt and refuses unsafe destinations', async () => {
  const w = workflow(`manifest: q-core.workflow/v1
id: file-delivery
name: File delivery
steps:
  - id: deliver
    kind: api-request
    config:
      url: "{{env.Q31_FILE}}"
      receiptKey: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      body: '{"text":"Привіт\\nсвіт"}'
`);
  const out = join(w.dir, 'deliveries.jsonl');
  try {
    await withEnv({ Q31_FILE: pathToFileURL(out).href }, async () => {
      const first = createRun(w.manifest);
      await driveRun(first, { store: w.store, settings: w.manifest.settings });
      assert.equal(first.status, 'success', first.summary);
      const lines = readFileSync(out, 'utf8').trim().split('\n');
      assert.equal(lines.length, 1);
      assert.deepEqual(JSON.parse(lines[0]), { text: 'Привіт\nсвіт' });
      const repeat = createRun(w.manifest);
      await driveRun(repeat, { store: w.store, settings: w.manifest.settings });
      assert.equal(repeat.status, 'success');
      assert.equal(repeat.steps.at(-1).output.duplicatePrevented, true);
      assert.equal(readFileSync(out, 'utf8').trim().split('\n').length, 1, 'the receipt prevents a second line');
    });
    for (const bad of [pathToFileURL(join(w.dir, 'missing-folder', 'x.jsonl')).href, 'file://relative.jsonl', pathToFileURL(w.dir).href]) {
      await withEnv({ Q31_FILE: bad }, async () => {
        const run = createRun({ ...w.manifest, steps: w.manifest.steps.map(s => ({ ...s, config: { ...s.config, receiptKey: createHash('sha256').update(bad).digest('hex') } })) });
        await driveRun(run, { store: w.store, settings: w.manifest.settings });
        assert.equal(run.status, 'failed', bad);
      });
    }
  } finally { rmSync(w.dir, { recursive: true, force: true }); }
});

test('run state ignores itself in git', async () => {
  const w = workflow(`manifest: q-core.workflow/v1
id: ignore-check
name: Ignore check
steps:
  - id: out
    kind: api-request
    config:
      url: "{{env.Q31_UNSET_HOOK}}"
`);
  try {
    await withEnv({ Q31_UNSET_HOOK: undefined }, async () => {
      const run = createRun(w.manifest);
      await driveRun(run, { store: w.store, settings: w.manifest.settings });
      assert.equal(readFileSync(join(w.dir, '.qf', '.gitignore'), 'utf8'), '*\n');
    });
  } finally { rmSync(w.dir, { recursive: true, force: true }); }
});

const SOURCES = { sources: [{ url: 'https://example.org/a', text: 'A' }] };
const check = (text, config) => runVerifySources({ config: { draft: '{{steps.draft.output}}', sources: '{{steps.unique.output}}', language: 'uk', ...config } }, { priorOutputs: { unique: SOURCES, draft: { text } } });
const FORMAT = { requiredHeadings: '["## Сигнали","## Новини"]' };
const OK = '## Сигнали\n\n- Сигнал і джерело https://example.org/a\n\n## Новини\n\n- Новина.\n';

test('verify-sources requiredEnvPatterns: the variable must be set and match fully', () => {
  const config = { ...FORMAT, requiredEnvPatterns: '{"Q31_DATE":"(0[1-9]|[12][0-9]|3[01])\\\\.(0[1-9]|1[0-2])"}' };
  withEnv({ Q31_DATE: '26.09' }, () => assert.doesNotThrow(() => check(OK, config)));
  for (const bad of [undefined, '', '26.9', '26.09.2026', '32.01', 'hello', '[26.09](https://t.me/x)'])
    withEnv({ Q31_DATE: bad }, () => assert.throws(() => check(OK, config), /Q31_DATE must match/, String(bad)));
  assert.throws(() => check(OK, { ...FORMAT, requiredEnvPatterns: '["Q31_DATE"]' }), /requiredEnvPatterns must be/);
});

test('verify-sources format mode refuses headings nested in lists or quotes and scheme-less linked addresses', () => {
  assert.doesNotThrow(() => check(OK, FORMAT));
  for (const extra of ['- ## Зайва', '1. ## Зайва', '> ## Зайва', '> - ### Зайва'])
    assert.throws(() => check(`${OK}\n${extra}\n`, FORMAT), /required Markdown sections/, extra);
  for (const extra of ['Див. t.me/evil', 'evil.example/path', '(docs.example.org/x)'])
    assert.throws(() => check(`${OK}\n${extra}\n`, FORMAT), /unverified URL/, extra);
  assert.doesNotThrow(() => check(`${OK}\nQFactory.io і Q-Core/Registry без адрес.\n`, FORMAT), 'a bare name or a slash without a domain is not a link');
  assert.doesNotThrow(() => check(`${OK}\nДив. t.me/evil\n`, {}), 'without a format contract prose is unchanged');
});

test('scope refusal explains the hidden-segment rule', () => {
  const dir = mkdtempSync(join(tmpdir(), 'q-core31-scope-'));
  try {
    mkdirSync(join(dir, '.qfactory'));
    assert.throws(() => scopedPath(dir, '.qfactory/verify.mjs'), /Path outside allowed scope: \.qfactory\/verify\.mjs \(.*hidden segments such as \.qfactory\/ .*visible folder\)/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('CLI help: OpenRouter key only for OpenRouter steps, and the exit codes', () => {
  const r = spawnSync(process.execPath, [BIN, '--help'], { encoding: 'utf8', env: { ...process.env, QF_NO_UPDATE_CHECK: '1' } });
  const help = r.stdout + r.stderr;
  assert.doesNotMatch(help, /required for llm-call/);
  assert.match(help, /caller inference \(provider: cli\)\s+needs no key/);
  assert.match(help, /Exit codes[\s\S]*\b2\s+waiting: the run is paused on a human decision \(approve\) or on a caller/);
});

test('CLI explains the renamed manifest format instead of "older or newer"', () => {
  const dir = mkdtempSync(join(tmpdir(), 'q-core31-renamed-'));
  try {
    const file = join(dir, 'old.yaml');
    writeFileSync(file, ['manifest: qloops', 'loop/v1'].join('.') + '\nid: old\nsteps:\n  - id: a\n    kind: fetch\n    config:\n      url: https://example.org\n');
    const r = spawnSync(process.execPath, [BIN, 'validate', file], { encoding: 'utf8', env: { ...process.env, QF_NO_UPDATE_CHECK: '1' } });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /The manifest format was renamed: .* is now q-core\.workflow\/v1/);
    assert.match(r.stderr, /no\s+silent compatibility/);
    const other = join(dir, 'other.yaml');
    writeFileSync(other, 'manifest: something/v9\nid: x\nsteps:\n  - id: a\n    kind: fetch\n    config:\n      url: https://example.org\n');
    assert.doesNotMatch(spawnSync(process.execPath, [BIN, 'validate', other], { encoding: 'utf8' }).stderr, /was renamed/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('Digest 0.3 defaults to reachable official feeds, keeps the receiver and the dated header required', () => withEnv({ QF_DIGEST_OPENAI_URL: undefined, QF_DIGEST_ANTHROPIC_URL: undefined, QF_DIGEST_LINEAR_URL: undefined, QF_DIGEST_FIGMA_URL: undefined, QF_DIGEST_RECEIVER_URL: undefined, QF_DIGEST_DATE: undefined }, () => {
  const manifest = loadManifest(new URL('../registry/workflows/digest.yaml', import.meta.url).pathname);
  const urls = manifest.steps.filter(s => s.kind === 'fetch').map(s => resolveTemplate(s.config.url, {}));
  assert.deepEqual(urls, ['https://openai.com/news/rss.xml', 'https://www.anthropic.com/news', 'https://linear.app/rss/changelog.xml', 'https://www.figma.com/blog/feed/atom.xml']);
  assert.deepEqual(requiredEnvMissing(createRun(manifest).steps), ['QF_DIGEST_DATE', 'QF_DIGEST_RECEIVER_URL']);
}));

test('introLinks: the episode link only inline in the introduction sentence', () => {
  const header = '**H**\n\n';
  const video = 'https://video.example/watch?v=1';
  const config = { requiredPrefix: header, requiredHeadings: '["## Сигнали","## Новини"]', introLinks: JSON.stringify([video]), requiredIntroPrefix: 'Цікаві тези із [' };
  const body = '\n\n## Сигнали\n\n- Сигнал і джерело https://example.org/a\n\n## Новини\n\n- Новина.\n';
  const good = `${header}Цікаві тези із [подкасту Автора](${video}) про нову модель.${body}`;
  assert.deepEqual(check(good, config).output.checks.slice(-1), ['intro-links-inline']);
  const bad = {
    'standalone link line': `${header}[Подкаст](${video})${body}`,
    'labelled link line': `${header}Цікаві тези з випуску.\nПосилання: [подкаст](${video})${body}`,
    'bare URL in the introduction': `${header}Цікаві тези із подкасту ${video} про модель.${body}`,
    'URL as the link text': `${header}Цікаві тези із [${video}](${video}) про модель.${body}`,
    'link repeated in a section': `${good.replace('- Новина.', `- Новина [00:31](${video}).`)}`,
    'link missing': `${header}Цікаві тези із подкасту про модель.${body}`,
    'labelled link inside a sentence': `${header}Цікаві тези з випуску. Посилання: [подкаст](${video}) — дивіться тут.${body}`,
    'long label on its own line': `${header}Цікаві тези з випуску.\nДивіться повний випуск тут: [подкаст](${video})${body}`,
    'link first on its own line': `${header}[Подкаст](${video}) дивіться тут зараз${body}`,
    'brand link first, episode link on a second line': `${header}Цікаві тези із [ХУЇКС](https://t.me/xyiikc) випуску.\n[Подкаст](${video}) дивіться тут зараз${body}`,
    'episode link on a second line of the paragraph': `${header}Цікаві тези із [подкасту Автора](https://t.me/xyiikc) і коротко.\nПовний випуск тут [подкаст](${video})${body}`,
    'two paragraphs': `${header}Цікаві тези із [подкасту Автора](${video}) про модель.\n\nЩе абзац.${body}`,
    'different opening': `${header}Тези із [подкасту Автора](${video}) про нову модель.${body}`,
    'link only in a section': `${header}Цікаві тези з випуску про модель.${body.replace('- Новина.', `- Новина з [подкасту](${video}) і текстом.`)}`,
  };
  for (const [name, text] of Object.entries(bad)) assert.throws(() => check(text, config), /Introduction (must link|link)|introduction must|unverified URL/, name);
  assert.throws(() => check(good, { ...config, introLinks: '["{{env.Q31_UNSET_VIDEO}}"]' }), /HTTP\(S\)|unresolved/);
});

test('review fixes: an optional sink step is exempt as a whole, empty values count as missing, destinations are checked up front', async () => {
  const sink = workflow(`manifest: q-core.workflow/v1
id: sink-body
name: Sink body
steps:
  - id: post
    kind: api-request
    config:
      url: "https://api.telegram.org/bot{{env.Q31_BOT_TOKEN}}/sendMessage"
      body: '{"chat_id":"{{env.Q31_CHAT_ID}}","text":"hi"}'
`);
  try {
    await withEnv({ Q31_BOT_TOKEN: undefined, Q31_CHAT_ID: undefined }, async () => {
      assert.deepEqual(requiredEnvMissing(createRun(sink.manifest).steps), []);
      const run = createRun(sink.manifest);
      await driveRun(run, { store: sink.store, settings: sink.manifest.settings });
      assert.equal(run.status, 'success', run.summary);
      assert.equal(run.steps[0].output.sink, 'file');
      assert.equal(run.steps[0].output.dispatched, false);
    });
  } finally { rmSync(sink.dir, { recursive: true, force: true }); }
  withEnv({ Q31_EMPTY: '' }, () => assert.deepEqual(missingEnvRefs('{{env.Q31_EMPTY}}'), ['Q31_EMPTY']));
  const dest = workflow(`manifest: q-core.workflow/v1
id: dest
name: Dest
steps:
  - id: read
    kind: fetch
    config:
      url: "https://example.invalid/never-fetched"
  - id: deliver
    kind: api-request
    config:
      url: "{{env.Q31_DEST}}"
      receiptKey: "${'b'.repeat(64)}"
`);
  try {
    for (const bad of [pathToFileURL(join(dest.dir, 'x.txt')).href, pathToFileURL(join(dest.dir, 'none', 'x.jsonl')).href, 'file://relative.jsonl', 'file:relative.jsonl']) {
      await withEnv({ Q31_DEST: bad }, async () => {
        const run = createRun(dest.manifest);
        await driveRun(run, { store: dest.store, settings: dest.manifest.settings });
        assert.equal(run.status, 'failed', bad);
        assert.match(run.summary, /^Invalid delivery destination before any step ran/, bad);
        assert.equal(run.steps[1].status, 'pending', 'the fetch never ran');
      });
    }
  } finally { rmSync(dest.dir, { recursive: true, force: true }); }
});

test('review fixes: file delivery is JSON Lines only, never follows a symlinked file, and prints in human mode', async () => {
  const { symlinkSync } = await import('node:fs');
  const w = workflow(`manifest: q-core.workflow/v1
id: file-text
name: File text
steps:
  - id: deliver
    kind: api-request
    config:
      url: "{{env.Q31_FILE}}"
      body: 'plain text line'
`);
  try {
    const out = join(w.dir, 'plain.jsonl');
    await withEnv({ Q31_FILE: pathToFileURL(out).href }, async () => {
      const run = createRun(w.manifest);
      await driveRun(run, { store: w.store, settings: w.manifest.settings });
      assert.equal(run.status, 'success', run.summary);
      assert.equal(readFileSync(out, 'utf8'), '"plain text line"\n', 'a text body is JSON-encoded on one line');
    });
    const victim = join(w.dir, 'victim.txt');
    writeFileSync(victim, 'keep\n');
    symlinkSync(victim, join(w.dir, 'link.jsonl'));
    await withEnv({ Q31_FILE: pathToFileURL(join(w.dir, 'link.jsonl')).href }, async () => {
      const run = createRun(w.manifest);
      await driveRun(run, { store: w.store, settings: w.manifest.settings });
      assert.equal(run.status, 'failed');
      assert.equal(readFileSync(victim, 'utf8'), 'keep\n');
    });
    const human = join(w.dir, 'human.jsonl');
    const r = spawnSync(process.execPath, [BIN, 'run', w.file], { encoding: 'utf8', env: { ...process.env, QF_NO_UPDATE_CHECK: '1', Q31_FILE: pathToFileURL(human).href } });
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.match(r.stdout, /→ delivered to .*human\.jsonl/);
    assert.doesNotMatch(r.stdout + r.stderr, /NOT SENT|Cannot read properties/);
  } finally { rmSync(w.dir, { recursive: true, force: true }); }
});

test('review fixes: the renamed-format message replaces "older or newer"', () => {
  const dir = mkdtempSync(join(tmpdir(), 'q-core31-renamed2-'));
  try {
    const file = join(dir, 'old.yaml');
    writeFileSync(file, ['manifest: qloops', 'loop/v2'].join('.') + '\nid: old\nsteps:\n  - id: a\n    kind: fetch\n    config:\n      url: https://example.org\n');
    const r = spawnSync(process.execPath, [BIN, 'validate', file], { encoding: 'utf8', env: { ...process.env, QF_NO_UPDATE_CHECK: '1' } });
    assert.match(r.stderr, /^✗ The manifest format was renamed/);
    assert.doesNotMatch(r.stderr, /older or newer/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
