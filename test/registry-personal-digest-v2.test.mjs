import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadManifest } from '../src/manifest.mjs';
import { createRun, driveRun, resumeRun, RunStore } from '../src/run.mjs';
import { cronMatches } from '../src/host.mjs';
import { runVerifySources } from '../src/registry-data-steps.mjs';

const provider = { kind: 'caller', agent: 'codex', model: 'test-double', payerScope: 'local-cli' };
const header = '**Штучно-інтелектуальний дайджест під суботню каву на [ХУЇКС](https://t.me/xyiikc) і by [QFactory.io](https://QFactory.io) 🧋DD.MM**';
const historicalNoSpaceHeader = '**Штучно-інтелектуальний дайджест під суботню каву на [ХУЇКС](https://t.me/xyiikc)і by [QFactory.io](https://QFactory.io) 🧋DD.MM**';

function waitingGate(run) {
  const gate = run.steps.find(step => step.status === 'waiting_human');
  assert.ok(gate, 'run must wait at a human gate');
  return gate.output.approvalHash;
}

test('Personal Digest v2 schedules the weekday and Saturday paths without changing generic Digest', () => {
  const daily = loadManifest(new URL('../registry/loops/personal-digest-daily.yaml', import.meta.url));
  const saturday = loadManifest(new URL('../registry/loops/personal-digest-saturday.yaml', import.meta.url));
  const generic = loadManifest(new URL('../registry/loops/digest.yaml', import.meta.url));
  const dailyCron = daily.triggers.find(trigger => trigger.kind === 'schedule').cron;
  const saturdayCron = saturday.triggers.find(trigger => trigger.kind === 'schedule').cron;

  assert.equal(dailyCron, '0 8 * * 1-5');
  assert.equal(saturdayCron, '0 8 * * 6');
  assert.equal(cronMatches(dailyCron, new Date('2026-09-21T08:00:00Z')), true);
  assert.equal(cronMatches(dailyCron, new Date('2026-09-26T08:00:00Z')), false);
  assert.equal(cronMatches(saturdayCron, new Date('2026-09-26T08:00:00Z')), true);
  assert.equal(cronMatches(saturdayCron, new Date('2026-09-25T08:00:00Z')), false);
  assert.deepEqual(generic.triggers, [{ kind: 'manual' }]);
  assert.equal(generic.steps.some(step => step.kind === 'api-request'), true);
  assert.equal(daily.steps.some(step => step.kind === 'api-request'), false);
  assert.equal(saturday.steps.some(step => step.kind === 'api-request'), false);
});

test('Personal Digest v2 creates only local approval-bound daily, weekly, and ХУЇКС artifacts', async () => {
  const root = mkdtempSync(join(tmpdir(), 'qf-personal-digest-v2-'));
  const server = createServer((req, res) => res.end('<main>Перевірений матеріал для персонального дайджесту.</main>'));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const urls = [1, 2, 3, 4].map(n => `${base}/source-${n}`);
  const env = Object.fromEntries(urls.map((url, index) => [`QF_PERSONAL_DIGEST_SOURCE_${index + 1}_URL`, url]));
  env.QF_PERSONAL_DIGEST_PROFILE = 'Продуктовий дизайнер; цінує прикладні зміни для малих команд.';
  const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  Object.assign(process.env, env);
  const daily = loadManifest(new URL('../registry/loops/personal-digest-daily.yaml', import.meta.url));
  const saturday = loadManifest(new URL('../registry/loops/personal-digest-saturday.yaml', import.meta.url));
  const opts = manifest => ({ store: new RunStore(join(root, manifest.id + '.yaml')), callerProvider: provider, settings: manifest.settings });
  const dailyText = `Україномовний щоденний персональний дайджест.\n${urls.map(url => `Джерело: ${url}`).join('\n')}`;
  const weeklyText = `## Короткі інфоприводи\nСтислий сигнал.\n\n## Помітні / відчутні / важливі новини\nВажливий вплив.\n${urls.map(url => `Джерело: ${url}`).join('\n')}`;
  const postText = `${header}\n\n## Важливе за тиждень\nСтисла тема.\n${urls.map(url => `Джерело: ${url}`).join('\n')}`;
  try {
    const dailyRun = createRun(daily, { trigger: 'schedule' });
    await driveRun(dailyRun, opts(daily));
    assert.equal(dailyRun.status, 'waiting_inference');
    await driveRun(dailyRun, { ...opts(daily), inferenceReply: { jobId: dailyRun.pendingInference.jobId, hash: dailyRun.pendingInference.hash, output: { text: dailyText } } });
    assert.equal(dailyRun.status, 'waiting_human');
    const dailyHash = waitingGate(dailyRun);
    await assert.rejects(resumeRun(dailyRun, { ...opts(daily), decision: 'approve', approvalHash: '0'.repeat(64) }), /Approval/);
    await resumeRun(dailyRun, { ...opts(daily), decision: 'approve', approvalHash: dailyHash });
    assert.equal(dailyRun.status, 'success');

    const saturdayRun = createRun(saturday, { trigger: 'schedule' });
    await driveRun(saturdayRun, opts(saturday));
    assert.equal(saturdayRun.status, 'waiting_inference');
    await driveRun(saturdayRun, { ...opts(saturday), inferenceReply: { jobId: saturdayRun.pendingInference.jobId, hash: saturdayRun.pendingInference.hash, output: { text: weeklyText } } });
    assert.equal(saturdayRun.status, 'waiting_human');
    await resumeRun(saturdayRun, { ...opts(saturday), decision: 'approve', approvalHash: waitingGate(saturdayRun) });
    assert.equal(saturdayRun.status, 'waiting_inference');
    await driveRun(saturdayRun, { ...opts(saturday), inferenceReply: { jobId: saturdayRun.pendingInference.jobId, hash: saturdayRun.pendingInference.hash, output: { text: postText } } });
    assert.equal(saturdayRun.status, 'waiting_human');
    await resumeRun(saturdayRun, { ...opts(saturday), decision: 'approve', approvalHash: waitingGate(saturdayRun) });
    assert.equal(saturdayRun.status, 'success');
    assert.equal(saturdayRun.steps.some(step => step.kind === 'api-request'), false);
    assert.equal(saturdayRun.steps.find(step => step.stepId === 'huyiks-post').output.text.startsWith(header), true);
  } finally {
    for (const [key, value] of Object.entries(previous)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    await new Promise(resolve => server.close(resolve));
    rmSync(root, { recursive: true, force: true });
  }
});

test('Saturday ХУЇКС contract keeps the accepted header and rejects the superseded no-space form', () => {
  const text = readFileSync(new URL('../registry/loops/personal-digest-saturday.yaml', import.meta.url), 'utf8');
  assert.equal(text.includes(header), true);
  assert.equal(text.includes(historicalNoSpaceHeader), false);
  assert.equal(text.includes('do not deliver or publish it'), true);
  assert.equal(loadManifest(new URL('../registry/loops/personal-digest-saturday.yaml', import.meta.url)).steps.some(step => step.id === 'huyiks-checks'), false);
});

test('Core20 source verifier refuses the required stable header links, so the final post remains a human-approved artifact', () => {
  assert.throws(() => runVerifySources(
    { config: { draft: '{{steps.post.output}}', sources: '{{steps.sources.output}}', language: 'uk' } },
    { priorOutputs: { post: { text: `${header}\nУкраїнський текст.\nhttps://example.test/source` }, sources: { sources: [{ url: 'https://example.test/source', text: 'source' }] } } },
  ), /unverified URL/);
});
