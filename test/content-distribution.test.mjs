// Content distribution 0.2.0 (parent + channel-set + channel-draft): pinned nested closure, one reviewed subject, link and
// objection guards, per-channel delivery keys, exact export. Model answers are written by this test (caller provider); nothing is
// sent: the runs stop at a human gate and no step after it executes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, copyFileSync, readFileSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadWorkflow } from '../src/workflow-policy.mjs';
import { createRun, driveRun, RunStore } from '../src/run.mjs';
import { exportMaterialBundle, loadManifestGraph } from '../src/material-graph.mjs';
import { AGENT_SESSION_ENV } from '../src/human-confirmation.mjs';
for (const name of AGENT_SESSION_ENV) delete process.env[name];

const FILES = ['content-distribution.yaml', 'channel-set.yaml', 'channel-draft.yaml'];
const callerProvider = { kind: 'caller', agent: 'claude', model: 'test-double', payerScope: 'local-cli' };
const SOURCE = { title: 'Release notes', text: 'The export now keeps exact bytes.', url: 'https://example.com/release' };
const CHANNELS = ['Telegram', 'LinkedIn', 'X'];

function workspace(t) {
  const root = mkdtempSync(join(tmpdir(), 'qf-distribution-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const file of FILES) copyFileSync(new URL(`../registry/workflows/${file}`, import.meta.url), join(root, file));
  process.env.QCORE_WEBHOOK_URL = `file://${join(root, 'outbox.jsonl')}`;
  return root;
}
const channelOf = content => CHANNELS.find(c => content.startsWith(`Check the ${c} draft`) || content.startsWith(`Adapt the approved source below for ${c}.`));

/** Drive the parent until it stops; `override(kind, channel)` may replace one model answer. */
async function drive(root, override = () => undefined, source = SOURCE) {
  const file = join(root, 'content-distribution.yaml');
  const manifest = loadWorkflow(file), store = new RunStore(file), run = createRun(manifest, { inputs: source });
  const opts = { store, callerProvider, settings: manifest.settings };
  await driveRun(run, opts);
  const asked = [];
  while (run.status === 'waiting_inference') {
    const job = run.pendingInference, content = job.messages[0].content, kind = content.startsWith('Check the ') ? 'check' : 'draft', channel = channelOf(content);
    asked.push(`${kind}:${channel}`);
    const text = override(kind, channel) ?? (kind === 'check' ? JSON.stringify({ pass: true, reason: 'ok' }) : `${channel} draft: ${source.text} ${source.url}`);
    await driveRun(run, { ...opts, inferenceReply: { jobId: job.jobId, hash: job.hash, output: { text } } });
  }
  return { run, asked };
}
const waiting = run => run.steps.find(s => s.status === 'waiting_human');

test('the parent pins channel-set, which pins channel-draft: three exact files, every child hash is checked', t => {
  const root = workspace(t);
  const graph = loadManifestGraph(join(root, 'content-distribution.yaml'));
  assert.deepEqual(Object.keys(graph.materialGraph).sort(), [...FILES].sort());
  writeFileSync(join(root, 'channel-draft.yaml'), readFileSync(join(root, 'channel-draft.yaml'), 'utf8') + '# edited\n');
  assert.throws(() => loadWorkflow(join(root, 'content-distribution.yaml')), /checksum|sha256|pin/i);
});

test('a run asks for three drafts and three checks, then stops at one human review that shows all three drafts', async t => {
  const { run, asked } = await drive(workspace(t));
  assert.deepEqual(asked.sort(), CHANNELS.flatMap(c => [`check:${c}`, `draft:${c}`]).sort());
  assert.equal(run.status, 'waiting_human');
  const gate = waiting(run);
  assert.equal(gate.stepId, 'review');
  const subject = JSON.stringify(gate.output.subject);
  for (const c of CHANNELS) assert.match(subject, new RegExp(`${c} draft:`), `${c} is in the reviewed subject`);
  assert.equal(run.steps.some(s => s.stepId.startsWith('send-') && s.status !== 'pending'), false, 'nothing is sent before approval');
});

test('every channel has its own delivery key made of the channel and the source hash; a changed source changes all three', async t => {
  const keysOf = async source => {
    const { run } = await drive(workspace(t), undefined, source);
    const out = run.steps.find(s => s.stepId === 'drafts').output;
    return { telegram: out.telegramKey, linkedin: out.linkedinKey, x: out.xKey };
  };
  const first = await keysOf(SOURCE), again = await keysOf(SOURCE), changed = await keysOf({ ...SOURCE, text: 'The export keeps exact bytes and says so.' });
  assert.deepEqual(first, again, 'the same source gives the same three keys');
  assert.match(first.telegram, /^Telegram:[a-f0-9]{16,}$/);
  assert.match(first.linkedin, /^LinkedIn:[a-f0-9]{16,}$/);
  assert.match(first.x, /^X:[a-f0-9]{16,}$/);
  assert.equal(new Set(Object.values(first).map(k => k.split(':')[1])).size, 1, 'one source hash for all channels');
  for (const channel of Object.keys(first)) assert.notEqual(changed[channel], first[channel], `${channel} is delivered again for a changed source`);
});

test('negative: a draft that links something other than the source stops the run before any human gate', async t => {
  const { run } = await drive(workspace(t), (kind, channel) => kind === 'draft' && channel === 'X' ? 'X draft: see https://elsewhere.example/x' : undefined);
  assert.equal(run.status, 'failed');
  assert.equal(waiting(run), undefined);
});

test('negative: a check that objects sends the draft to a person, and the final review is not reached', async t => {
  const { run } = await drive(workspace(t), (kind, channel) => kind === 'check' && channel === 'LinkedIn' ? JSON.stringify({ pass: false, reason: 'adds a claim' }) : undefined);
  assert.equal(run.status, 'waiting_human');
  assert.equal(waiting(run).stepId, 'objection-review');
});

test('export carries parent and both children byte for byte and the relocated copy loads the same graph', t => {
  const root = workspace(t), out = join(root, 'export');
  exportMaterialBundle(join(root, 'content-distribution.yaml'), out);
  const exported = readdirSync(out).filter(f => f.endsWith('.yaml')).sort();
  assert.deepEqual(exported, [...FILES].sort());
  for (const file of FILES) assert.equal(readFileSync(join(out, file), 'utf8'), readFileSync(join(root, file), 'utf8'));
  rmSync(join(root, 'channel-set.yaml')); rmSync(join(root, 'channel-draft.yaml'));
  assert.doesNotThrow(() => loadWorkflow(join(out, 'content-distribution.yaml')), 'the exported copy runs without the originals');
});
