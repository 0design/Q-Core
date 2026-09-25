// Core31: env defaults and the up-front missing-environment error, file:/// delivery, verify-sources Low fixes,
// clearer scope/help/renamed-format messages and self-ignoring run state (E2E 0D-277 findings).
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

test('introLinks: the episode link only inline in the introduction sentence (decision 55)', () => {
  const header = '**H**\n\n';
  const video = 'https://video.example/watch?v=1';
  const config = { requiredPrefix: header, requiredHeadings: '["## Сигнали","## Новини"]', introLinks: JSON.stringify([video]) };
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
    'link only in a section': `${header}Цікаві тези з випуску про модель.${body.replace('- Новина.', `- Новина з [подкасту](${video}) і текстом.`)}`,
  };
  for (const [name, text] of Object.entries(bad)) assert.throws(() => check(text, config), /Introduction (must link|link)|unverified URL/, name);
  assert.throws(() => check(good, { ...config, introLinks: '["{{env.Q31_UNSET_VIDEO}}"]' }), /HTTP\(S\)|unresolved/);
});
