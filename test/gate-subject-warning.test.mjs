import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { digest } from '../src/material-graph.mjs';
import { loadWorkflow, approvalSubjectWarnings, workflowWarnings } from '../src/workflow-policy.mjs';

const cli = resolve('bin/q-core.mjs');
const yaml = doc => Object.entries(doc).map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join('\n') + '\n';
const draft = id => ({ id, kind: 'llm-call', config: { provider: 'cli', format: 'text', instructions: `Write the ${id} draft.` } });
const gate = { id: 'review', kind: 'approval-gate', config: { reviewer: 'human', bind: 'sha256', anchor: 'All drafts' } };
const send = body => ({ id: 'deliver', kind: 'api-request', config: { method: 'POST', url: '{{env.QCORE_WEBHOOK_URL}}', expect: '2xx', body } });
const workflow = (steps, extra = {}) => ({ manifest: 'q-core.workflow/v1', id: 'drafts', version: '1.0.0', settings: { budgetUsd: null }, steps, ...extra });
function directory(t) { const dir = mkdtempSync(join(tmpdir(), 'q-core-gate-subject-')); t.after(() => rmSync(dir, { recursive: true, force: true })); return dir; }
const write = (dir, name, doc) => { const bytes = yaml(doc); writeFileSync(join(dir, name), bytes); return digest(bytes); };

test('a gate after several steps warns when the side effect also sends outputs the person does not see', () => {
  const steps = [draft('telegram'), draft('linkedin'), draft('x'), gate,
    send('{"t":"{{steps.telegram.output.text}}","l":"{{steps.linkedin.output.text}}","x":"{{steps.x.output.text}}"}')];
  const [warning, ...rest] = approvalSubjectWarnings(steps);
  assert.equal(rest.length, 0);
  assert.equal(warning.code, 'GATE_SUBJECT_PARTIAL');
  assert.equal(warning.gate, 'review');
  assert.equal(warning.subject, 'x');
  assert.deepEqual(warning.uncovered, ['telegram', 'linkedin']);
  assert.deepEqual(warning.effects, ['deliver']);
  assert.equal(warning.path, 'steps[3]');
});

test('references by step name count, and only what is sent is judged', () => {
  const named = [{ ...draft('a'), config: { ...draft('a').config, name: 'Write A' } }, draft('b'), gate,
    { ...send('{"b":"{{steps.b.output.text}}"}'), config: { ...send('').config, body: '{"b":"{{steps.b.output.text}}","a":"{{steps.Write A.output.text}}"}' } }];
  assert.deepEqual(approvalSubjectWarnings(named)[0].uncovered, ['a']);
  // a delivery dedup key is local state, not part of what is sent
  const keyed = [draft('a'), draft('b'), gate, { ...send('{"b":"{{steps.b.output.text}}"}'), config: { ...send('{"b":"{{steps.b.output.text}}"}').config, receiptKey: '{{steps.a.output.text}}' } }];
  assert.deepEqual(approvalSubjectWarnings(keyed), []);
});

test('no warning when the gate subject is the whole payload, when nothing is sent, or after control flow', () => {
  assert.deepEqual(approvalSubjectWarnings([draft('a'), draft('b'), gate, send('{"b":"{{steps.b.output.text}}"}')]), []);
  assert.deepEqual(approvalSubjectWarnings([draft('a'), draft('b'), gate]), []);
  assert.deepEqual(approvalSubjectWarnings([draft('a'), { id: 'branch', kind: 'if', config: { condition: 'true' }, then: [draft('b')] }, gate, send('{"a":"{{steps.a.output.text}}"}')]), []);
  // a later human gate re-approves: the effect after it is judged against that gate
  assert.deepEqual(approvalSubjectWarnings([draft('a'), draft('b'), gate, { ...gate, id: 'again' }, send('{"a":"{{steps.a.output.text}}"}')]), []);
});

test('nested: three children called in the parent warn; one child returning all drafts does not', t => {
  const dir = directory(t);
  const leafSha = write(dir, 'leaf.yaml', { manifest: 'q-core.component/v1', id: 'leaf', version: '1.0.0', settings: { budgetUsd: null },
    inputs: { channel: { type: 'string' } }, outputs: { draft: { type: 'string', value: '{{steps.d.output.text}}' } },
    steps: [{ id: 'd', kind: 'llm-call', config: { provider: 'cli', format: 'text', instructions: 'Draft for {{inputs.channel}}.' } }] });
  const dep = { kind: 'component', id: 'leaf', version: '1.0.0', path: './leaf.yaml', sha256: leafSha };
  const call = (id) => ({ id, kind: 'workflow-call', config: { ref: 'leaf', inputs: `{"channel":"${id}"}` } });
  write(dir, 'partial.yaml', workflow([call('telegram'), call('x'), gate, send('{"t":"{{steps.telegram.output.draft}}","x":"{{steps.x.output.draft}}"}')], { dependencies: { leaf: dep } }));
  const partial = workflowWarnings(loadWorkflow(join(dir, 'partial.yaml')));
  assert.equal(partial.length, 1);
  assert.equal(partial[0].materialPath, 'partial.yaml');
  assert.deepEqual(partial[0].uncovered, ['telegram']);

  const setSha = write(dir, 'set.yaml', { manifest: 'q-core.component/v1', id: 'set', version: '1.0.0', settings: { budgetUsd: null }, dependencies: { leaf: dep },
    outputs: { telegram: { type: 'string', value: '{{steps.telegram.output.draft}}' }, x: { type: 'string', value: '{{steps.x.output.draft}}' } },
    steps: [call('telegram'), call('x')] });
  write(dir, 'whole.yaml', workflow([{ id: 'drafts', kind: 'workflow-call', config: { ref: 'set', inputs: '{}' } }, gate, send('{"drafts":"{{steps.drafts.output}}"}')],
    { dependencies: { set: { kind: 'component', id: 'set', version: '1.0.0', path: './set.yaml', sha256: setSha } } }));
  assert.deepEqual(workflowWarnings(loadWorkflow(join(dir, 'whole.yaml'))), []);
});

test('q-core validate prints the warning and adds it to --json only when present; it still validates', t => {
  const dir = directory(t);
  write(dir, 'partial.yaml', workflow([draft('a'), draft('b'), gate, send('{"a":"{{steps.a.output.text}}","b":"{{steps.b.output.text}}"}')]));
  write(dir, 'whole.yaml', workflow([draft('a'), gate, send('{"a":"{{steps.a.output.text}}"}')]));
  const env = { PATH: process.env.PATH, HOME: dir };
  const text = spawnSync(process.execPath, [cli, 'validate', join(dir, 'partial.yaml')], { encoding: 'utf8', env });
  assert.equal(text.status, 0, text.stderr);
  assert.match(text.stdout, /⚠ GATE_SUBJECT_PARTIAL in partial\.yaml at steps\[2\]: approval-gate "review" shows the person only the output of "b"/);
  const json = JSON.parse(spawnSync(process.execPath, [cli, 'validate', join(dir, 'partial.yaml'), '--json'], { encoding: 'utf8', env }).stdout);
  assert.deepEqual(json.warnings.map(w => [w.code, w.uncovered]), [['GATE_SUBJECT_PARTIAL', ['a']]]);
  const clean = JSON.parse(spawnSync(process.execPath, [cli, 'validate', join(dir, 'whole.yaml'), '--json'], { encoding: 'utf8', env }).stdout);
  assert.equal(Object.hasOwn(clean, 'warnings'), false);
});

test('every Registry workflow is free of the warning', () => {
  for (const file of readdirSync(resolve('registry/workflows')).filter(f => f.endsWith('.yaml'))) {
    const manifest = loadWorkflow(resolve('registry/workflows', file), { reviewed: true });
    assert.deepEqual(workflowWarnings(manifest), [], file);
  }
});
