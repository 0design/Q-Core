import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, copyFileSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadManifest } from '../src/manifest.mjs';
import { createRun, driveRun, resumeRun, RunStore } from '../src/run.mjs';
import { runParseWeb, runDeduplicate, runVerifySources } from '../src/registry-data-steps.mjs';
const provider = { kind: 'caller', agent: 'codex', model: 'test-double', payerScope: 'local-cli' };

test('actual Digest manifest enforces pending inference, exact approval and durable duplicate/uncertain receipts', async () => {
  const root = mkdtempSync(join(tmpdir(), 'qf-registry-digest-'));
  const file = join(root, 'digest.yaml');
  copyFileSync(new URL('../registry/loops/digest.yaml', import.meta.url), file);
  let deliveries = 0, fail = false;
  const server = createServer((req, res) => {
    if (req.url === '/receive') { deliveries++; req.resume(); res.writeHead(fail ? 503 : 200); res.end('receipt'); }
    else { res.end('<html><nav>Not source content</nav><main>Новина: перевірений приклад для тесту.</main></html>'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const urls = ['openai','anthropic','linear','figma'].map(id => `${base}/${id}`);
  const env = { QF_DIGEST_OPENAI_URL: urls[0], QF_DIGEST_ANTHROPIC_URL: urls[1], QF_DIGEST_LINEAR_URL: urls[2], QF_DIGEST_FIGMA_URL: urls[3], QF_DIGEST_RECEIVER_URL: `${base}/receive` };
  const previous = Object.fromEntries(Object.keys(env).map(k => [k, process.env[k]]));
  Object.assign(process.env, env);
  const manifest = loadManifest(file), store = new RunStore(file);
  const opts = { store, callerProvider: provider, settings: manifest.settings };
  const draft = `Перевірений тестовий дайджест.\n${urls.map(url => `Джерело: ${url}`).join('\n')}`;
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
