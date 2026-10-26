import assert from 'node:assert/strict';
import test, { beforeEach } from 'node:test';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { requestApproval } from '../src/mcp-approval.mjs';
import { createRun, driveRun, resumeRun, RunStore } from '../src/run.mjs';
import { loadWorkflow } from '../src/workflow-policy.mjs';
import { AGENT_SESSION_ENV } from '../src/human-confirmation.mjs';

const HASH = /^[a-f0-9]{64}$/;
const END = 'END OF THE EXACT SYNTHETIC DELIVERY';
const DRAFT = [...Array.from({ length: 55 }, (_, i) => `Synthetic draft line ${i + 1}.`), END].join('\n');
const approve = async () => ({ action: 'accept', content: { decision: 'approve' } });
const reject = async () => ({ action: 'accept', content: { decision: 'reject' } });

beforeEach(t => t.mock.method(globalThis, 'fetch', async () => {
  assert.fail('Approval tests must not dispatch network requests');
}));

async function fixture(t, { bound = true, anotherGate = false } = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'mcp-approval-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const manifestFile = join(dir, 'approval.yaml');
  const output = join(dir, 'delivery.jsonl');
  writeFileSync(join(dir, 'draft.txt'), DRAFT);
  writeFileSync(join(dir, 'verify.mjs'), 'process.exit(0);\n');
  writeFileSync(manifestFile, `manifest: q-core.workflow/v1
id: synthetic-chat-approval
version: 1.0.0
settings:
  budgetUsd: 1
steps:
  - id: source
    kind: workspace-read
    config: {}
  - id: review
    kind: approval-gate
    config:
      reviewer: human
${bound ? '      bind: sha256\n' : ''}      anchor: "Review the exact draft and destination"
  - id: deliver
    kind: api-request
    config:
      url: ${JSON.stringify(pathToFileURL(output).href)}
      body: ${JSON.stringify(JSON.stringify({ draft: '{{steps.source.output.files.0.content}}' }))}
${anotherGate ? `  - id: final-review
    kind: approval-gate
    config:
      reviewer: human
      bind: sha256
` : ''}`);
  const manifest = loadWorkflow(manifestFile);
  const store = new RunStore(manifestFile);
  const run = createRun(manifest);
  run.workspacePolicy = {
    workspace: dir,
    allowedPaths: ['draft.txt'],
    intent: 'Deliver the exact synthetic draft after a human decision',
    verifier: { command: process.execPath, args: ['verify.mjs'], timeoutMs: 3000 },
  };
  await driveRun(run, { store, settings: manifest.settings });
  assert.equal(run.status, 'waiting_human', run.summary);
  const gate = run.steps.find(step => step.status === 'waiting_human');
  return {
    dir, manifestFile, store, run, gate, output,
    args: { run_id: run.runId, gate_id: gate.rowId },
    context: { manifestFile, capabilities: { elicitation: {} }, elicit: approve },
  };
}

const persisted = f => readFileSync(f.store.runFile(f.run.runId), 'utf8');
const deliveries = f => existsSync(f.output) ? readFileSync(f.output, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];

test('chat approval in an agent session shows the full exact delivery and records the human channel', async t => {
  const f = await fixture(t);
  const previous = process.env.CODEX_SANDBOX;
  process.env.CODEX_SANDBOX = 'synthetic-agent-session';
  t.after(() => previous === undefined ? delete process.env.CODEX_SANDBOX : process.env.CODEX_SANDBOX = previous);
  let form;
  const result = await requestApproval(f.args, { ...f.context, elicit: async params => {
    form = params;
    assert.equal(deliveries(f).length, 0, 'nothing is delivered before the human responds');
    return approve();
  } });
  assert.equal(result.run_id, f.run.runId);
  assert.equal(result.gate_id, f.gate.rowId);
  assert.equal(result.decision, 'approve');
  assert.equal(result.status, 'success');
  assert.match(result.delivery_hash, HASH);
  const shown = JSON.stringify(form);
  assert.ok(shown.includes(END), 'the form includes content beyond the terminal preview limit');
  assert.ok(shown.includes(pathToFileURL(f.output).href), 'the form names the exact destination');
  assert.ok(shown.includes(result.delivery_hash), 'the displayed and recorded delivery hash agree');
  assert.ok(shown.includes(f.gate.output.approvalHash), 'the pinned subject hash is shown');
  assert.deepEqual(form.requestedSchema.properties.decision.enum, ['approve', 'reject']);
  assert.deepEqual(deliveries(f), [{ draft: DRAFT }]);
  const gate = f.store.load(f.run.runId).steps.find(step => step.rowId === f.gate.rowId);
  assert.equal(gate.decision, 'approve');
  assert.equal(gate.confirmation.channel, 'mcp-elicitation');
});

test('chat rejection is recorded and never delivers', async t => {
  const f = await fixture(t);
  const result = await requestApproval(f.args, { ...f.context, elicit: reject });
  assert.equal(result.decision, 'reject');
  assert.equal(result.status, 'failed');
  assert.match(result.delivery_hash, HASH);
  const gate = f.store.load(f.run.runId).steps.find(step => step.rowId === f.gate.rowId);
  assert.equal(gate.decision, 'reject');
  assert.equal(gate.confirmation.channel, 'mcp-elicitation');
  assert.equal(deliveries(f).length, 0);
});

for (const [label, capabilities] of [
  ['no elicitation capability', {}],
  ['URL-only elicitation', { elicitation: { url: {} } }],
]) test(`chat approval refuses a client with ${label}`, async t => {
  const f = await fixture(t);
  const before = persisted(f);
  let called = false;
  await assert.rejects(requestApproval(f.args, { ...f.context, capabilities, elicit: async () => {
    called = true;
    return approve();
  } }), /elicitation|form/i);
  assert.equal(called, false);
  assert.equal(persisted(f), before);
  assert.equal(deliveries(f).length, 0);
});

for (const [label, mutate] of [
  ['subject', (run, gate) => { gate.output.subject.files[0].content = 'Changed after the form was shown'; }],
  ['source output', run => { run.steps.find(step => step.stepId === 'source').output.files[0].content = 'Changed source'; }],
  ['delivery body', run => { run.steps.find(step => step.stepId === 'deliver').config.body = JSON.stringify({ draft: 'Changed delivery' }); }],
  ['delivery destination', (run, gate, f) => { run.steps.find(step => step.stepId === 'deliver').config.url = pathToFileURL(join(f.dir, 'other.jsonl')).href; }],
]) test(`a changed ${label} invalidates the pending human answer`, async t => {
  const f = await fixture(t);
  await assert.rejects(requestApproval(f.args, { ...f.context, elicit: async () => {
    const current = f.store.load(f.run.runId);
    const gate = current.steps.find(step => step.rowId === f.gate.rowId);
    mutate(current, gate, f);
    f.store.save(current);
    return approve();
  } }), /changed|stale|match/i);
  const run = f.store.load(f.run.runId);
  const gate = run.steps.find(step => step.rowId === f.gate.rowId);
  assert.equal(run.status, 'waiting_human');
  assert.equal(gate.decision, null);
  assert.equal(gate.confirmation, undefined);
  assert.equal(deliveries(f).length, 0);
});

test('a successful approval is single-use and replay never delivers twice', async t => {
  const f = await fixture(t);
  await requestApproval(f.args, f.context);
  let askedAgain = false;
  await assert.rejects(requestApproval(f.args, { ...f.context, elicit: async () => {
    askedAgain = true;
    return approve();
  } }));
  assert.equal(askedAgain, false);
  assert.deepEqual(deliveries(f), [{ draft: DRAFT }]);
});

for (const extra of [
  { approval: 'approve' },
  { decision: 'approve' },
  { confirmation: { channel: 'mcp-elicitation' } },
  { content: { decision: 'approve' } },
]) test(`model arguments cannot smuggle ${Object.keys(extra)[0]} into the tool`, async t => {
  const f = await fixture(t);
  const before = persisted(f);
  let asked = false;
  await assert.rejects(requestApproval({ ...f.args, ...extra }, { ...f.context, elicit: async () => {
    asked = true;
    return approve();
  } }));
  assert.equal(asked, false);
  assert.equal(persisted(f), before);
  assert.equal(deliveries(f).length, 0);
});

for (const action of ['cancel', 'decline']) test(`elicitation ${action} keeps the run waiting without a decision`, async t => {
  const f = await fixture(t);
  const before = persisted(f);
  await Promise.resolve(requestApproval(f.args, { ...f.context, elicit: async () => ({ action }) })).catch(error => {
    assert.match(error.message, /cancel|declin|decision|confirm/i);
  });
  assert.equal(persisted(f), before);
  assert.equal(deliveries(f).length, 0);
});

test('two concurrent approval requests consume one human decision and deliver once', async t => {
  const f = await fixture(t);
  let release;
  const answer = new Promise(resolve => { release = resolve; });
  let started;
  const eliciting = new Promise(resolve => { started = resolve; });
  const first = requestApproval(f.args, { ...f.context, elicit: async () => {
    started();
    return answer;
  } });
  await eliciting;
  const second = requestApproval(f.args, f.context);
  release(await approve());
  const outcomes = await Promise.allSettled([first, second]);
  assert.equal(outcomes.filter(outcome => outcome.status === 'fulfilled').length, 1);
  assert.equal(outcomes.filter(outcome => outcome.status === 'rejected').length, 1);
  assert.deepEqual(deliveries(f), [{ draft: DRAFT }]);
});

test('an unambiguous step name can identify a gate and an unbound gate still receives a delivery hash', async t => {
  const f = await fixture(t, { bound: false });
  const result = await requestApproval({ run_id: f.run.runId, gate_id: f.gate.stepId }, f.context);
  assert.equal(result.decision, 'approve');
  assert.match(result.delivery_hash, HASH);
  assert.deepEqual(deliveries(f), [{ draft: DRAFT }]);
});

test('approval stops at the next human gate and the old gate cannot consume another decision', async t => {
  const f = await fixture(t, { anotherGate: true });
  const result = await requestApproval(f.args, f.context);
  assert.equal(result.status, 'waiting_human');
  const current = f.store.load(f.run.runId);
  assert.equal(current.steps.find(step => step.stepId === 'final-review').status, 'waiting_human');
  await assert.rejects(requestApproval(f.args, f.context));
  assert.deepEqual(deliveries(f), [{ draft: DRAFT }]);
});

test('a plain forged MCP channel cannot bypass the existing agent-session guard', async t => {
  const f = await fixture(t);
  const saved = Object.fromEntries(AGENT_SESSION_ENV.map(name => [name, process.env[name]]));
  process.env.CODEX_SANDBOX = 'synthetic-agent-session';
  t.after(() => {
    for (const [name, value] of Object.entries(saved)) value === undefined ? delete process.env[name] : process.env[name] = value;
  });
  await assert.rejects(resumeRun(f.run, {
    decision: 'approve', approvalHash: f.gate.output.approvalHash,
    confirmation: { channel: 'mcp-elicitation', decision: 'approve' }, store: f.store,
  }), error => error.code === 'HUMAN_CONFIRMATION_REQUIRED');
  assert.equal(f.store.load(f.run.runId).status, 'waiting_human');
  assert.equal(deliveries(f).length, 0);
});

test('an ambiguous step name is refused before asking the human', async t => {
  const f = await fixture(t);
  const run = f.store.load(f.run.runId);
  run.steps.find(step => step.stepId === 'source').stepId = f.gate.stepId;
  f.store.save(run);
  let asked = false;
  await assert.rejects(requestApproval({ run_id: f.run.runId, gate_id: f.gate.stepId }, {
    ...f.context, elicit: async () => { asked = true; return approve(); },
  }), /one gate|repeated|ambiguous|identify/i);
  assert.equal(asked, false);
  assert.equal(deliveries(f).length, 0);
});

test('a waiting clarification is not an approval gate', async t => {
  const f = await fixture(t);
  const run = f.store.load(f.run.runId);
  run.pendingClarification = { seq: f.gate.seq, questions: ['Which draft?'] };
  f.store.save(run);
  const before = persisted(f);
  let asked = false;
  await assert.rejects(requestApproval(f.args, { ...f.context, elicit: async () => {
    asked = true;
    return approve();
  } }), /waiting.*approval/i);
  assert.equal(asked, false);
  assert.equal(persisted(f), before);
});

test('a pending step that can change the delivery input is refused before elicitation', async t => {
  const f = await fixture(t);
  const run = f.store.load(f.run.runId);
  const deliver = run.steps.find(step => step.stepId === 'deliver');
  delete deliver.config.body;
  run.steps.splice(run.steps.indexOf(deliver), 0, {
    seq: f.gate.seq + 1, rowId: 'pending-verification', invocationId: 'root', stepId: 'verify',
    kind: 'verify-artifact', status: 'pending', config: { source: '{{steps.source.output}}' }, output: null,
  });
  f.store.save(run);
  const before = persisted(f);
  let asked = false;
  await assert.rejects(requestApproval(f.args, { ...f.context, elicit: async () => {
    asked = true;
    return approve();
  } }), /pending|content|ready|gate/i);
  assert.equal(asked, false, 'the exact future default body is not available to show');
  assert.equal(persisted(f), before);
  assert.equal(deliveries(f).length, 0);
});

test('a templated destination is displayed as the exact resolved receiver', async t => {
  const f = await fixture(t);
  const run = f.store.load(f.run.runId);
  run.inputs.filename = 'delivery';
  run.invocations.root.inputs.filename = 'delivery';
  run.steps.find(step => step.stepId === 'deliver').config.url = pathToFileURL(f.dir).href + '/{{inputs.filename}}.jsonl';
  f.store.save(run);
  let form;
  await requestApproval(f.args, { ...f.context, elicit: async params => {
    form = params;
    assert.ok(JSON.stringify(params).includes(pathToFileURL(f.output).href), 'the human sees the resolved destination');
    assert.ok(!JSON.stringify(params).includes('{{inputs.filename}}'), 'an unresolved receiver is not an exact preview');
    return approve();
  } });
  assert.ok(form);
  assert.deepEqual(deliveries(f), [{ draft: DRAFT }]);
});

test('a full URL template injection is refused before the human form', async t => {
  const f = await fixture(t);
  const run = f.store.load(f.run.runId);
  run.inputs.receiver = pathToFileURL(f.output).href;
  run.invocations.root.inputs.receiver = pathToFileURL(f.output).href;
  run.steps.find(step => step.stepId === 'deliver').config.url = '{{inputs.receiver}}';
  f.store.save(run);
  const before = persisted(f);
  let asked = false;
  await assert.rejects(requestApproval(f.args, { ...f.context, elicit: async () => {
    asked = true;
    return approve();
  } }), /url|scheme|host|template/i);
  assert.equal(asked, false);
  assert.equal(persisted(f), before);
  assert.equal(deliveries(f).length, 0);
});

test('a child workflow preview uses the same workflow identity as its delivery', async t => {
  const f = await fixture(t);
  const run = f.store.load(f.run.runId);
  const childKey = 'workflows/synthetic-child@1.0.0';
  run.materialGraph[childKey] = { manifest: { id: 'synthetic-child' } };
  run.invocations.child = { key: childKey, parent: 'root', inputs: {}, settings: {} };
  for (const row of run.steps) row.invocationId = 'child';
  run.steps.find(step => step.stepId === 'deliver').config.body = JSON.stringify({
    workflow: '{{run.workflowId}}', draft: '{{steps.source.output.files.0.content}}',
  });
  f.store.save(run);
  await requestApproval(f.args, { ...f.context, elicit: async params => {
    assert.ok(params.message.includes('synthetic-child'), 'the preview names the child workflow that will send');
    return approve();
  } });
  assert.deepEqual(deliveries(f), [{ workflow: 'synthetic-child', draft: DRAFT }]);
});
