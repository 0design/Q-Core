import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import { spawnSync } from 'node:child_process';
import { createMcpSession, serveMcp } from '../src/mcp.mjs';
import { createRun, driveRun } from '../src/run.mjs';
import { RunStore } from '../src/state.mjs';
import { loadWorkflow } from '../src/workflow-policy.mjs';
import { createTestTouchIdAnchor } from './helpers/touchid-anchor.mjs';

const rpc = (id, method, params) => ({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) });
const initialize = (capabilities = { elicitation: { form: {} } }, protocolVersion = '2025-11-25') =>
  rpc('init', 'initialize', { protocolVersion, capabilities, clientInfo: { name: 'test-client', version: '1' } });
const initialized = { jsonrpc: '2.0', method: 'notifications/initialized' };
const reply = (form, decision = 'approve') => ({ jsonrpc: '2.0', id: form.id, result: { action: 'accept', content: { decision } } });
async function waitFor(messages, predicate) {
  const until = Date.now() + 2000;
  while (Date.now() < until) {
    const message = messages.find(predicate);
    if (message) return message;
    await new Promise(done => setTimeout(done, 5));
  }
  assert.fail('Timed out waiting for an MCP message');
}
async function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'q-core-mcp-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  createTestTouchIdAnchor(t, dir);
  const manifestFile = join(dir, 'workflow.yaml');
  writeFileSync(manifestFile, 'manifest: q-core.workflow/v1\nid: approval-test\nversion: 1.0.0\nsteps:\n  - id: review\n    kind: approval-gate\n    config:\n      reviewer: human\n      bind: sha256\n      anchor: Delivery\n');
  const store = new RunStore(manifestFile);
  const run = await driveRun(createRun(loadWorkflow(manifestFile)), { store });
  assert.equal(run.status, 'waiting_human');
  return { manifestFile, store, run, args: { run_id: run.runId, gate_id: 'review' } };
}
async function client(t, manifestFile, capabilities, version) {
  const messages = [];
  const session = createMcpSession({ manifestFile, send: message => messages.push(message) });
  t.after(() => session.close());
  await session.receive(initialize(capabilities, version));
  await session.receive(initialized);
  return { session, messages };
}

test('MCP lifecycle negotiates capabilities and publishes a decision-free tool schema', async t => {
  const messages = [];
  const session = createMcpSession({ manifestFile: 'workflow.yaml', send: message => messages.push(message) });
  t.after(() => session.close());
  await session.receive(rpc('early', 'tools/list'));
  assert.equal(messages.at(-1).error.code, -32000);
  await session.receive(initialize({}, 'unknown-version'));
  assert.equal(messages.at(-1).result.protocolVersion, '2025-11-25');
  assert.deepEqual(messages.at(-1).result.capabilities, { tools: {} });
  await session.receive(rpc('still-early', 'tools/list'));
  assert.equal(messages.at(-1).error.code, -32000);
  await session.receive(initialized);
  await session.receive(rpc('list', 'tools/list'));
  const [tool] = messages.at(-1).result.tools;
  assert.equal(tool.name, 'request_approval');
  assert.deepEqual(Object.keys(tool.inputSchema.properties), ['run_id', 'gate_id']);
  assert.deepEqual(tool.inputSchema.required, ['run_id', 'gate_id']);
  assert.equal(tool.inputSchema.additionalProperties, false);
  await session.receive(initialize({ elicitation: {} }));
  assert.equal(messages.at(-1).error.code, -32600);
});

test('tool arguments and call parameters cannot smuggle an approval or client capabilities', async t => {
  const { session, messages } = await client(t, 'workflow.yaml');
  const args = { run_id: 'unused', gate_id: 'review' };
  for (const field of ['approval', 'decision', 'confirmation', 'content', 'anchor', 'signature', 'nonce', '_meta', 'manifestFile', 'capabilities']) {
    await session.receive(rpc(field, 'tools/call', { name: 'request_approval', arguments: { ...args, [field]: 'approve' } }));
    assert.equal(messages.at(-1).error.code, -32602, field);
    await session.receive(rpc(field, 'tools/call', { name: 'request_approval', arguments: args, [field]: 'approve' }));
    assert.equal(messages.at(-1).error.code, -32602, field);
  }
  assert.equal(messages.filter(message => message.method === 'elicitation/create').length, 0);
});

test('standard request metadata is ignored and cannot supply capabilities or an approval', async t => {
  const metadata = { progressToken: 'progress-1', approval: 'approve', capabilities: { elicitation: { form: {} } } };
  const { manifestFile, store, run, args } = await fixture(t);
  const { session, messages } = await client(t, manifestFile);
  await session.receive(rpc('list', 'tools/list', { _meta: metadata }));
  assert.equal(messages.at(-1).result.tools[0].name, 'request_approval');
  const call = session.receive(rpc('approve', 'tools/call', { name: 'request_approval', arguments: args, _meta: metadata }));
  const form = await waitFor(messages, message => message.method === 'elicitation/create');
  assert.equal(store.load(run.runId).status, 'waiting_human');
  assert.equal(store.load(run.runId).steps[0].decision, null);
  await session.receive(reply(form, 'reject'));
  await call;
  assert.equal(store.load(run.runId).steps[0].decision, 'reject');

  const fresh = await fixture(t);
  const unsupported = await client(t, fresh.manifestFile, {});
  await unsupported.session.receive(rpc('unsupported', 'tools/call', { name: 'request_approval', arguments: fresh.args, _meta: metadata }));
  assert.equal(unsupported.messages.at(-1).result.isError, true);
  assert.match(unsupported.messages.at(-1).result.content[0].text, /ELICITATION_UNSUPPORTED/);
  assert.equal(unsupported.messages.filter(message => message.method === 'elicitation/create').length, 0);
  assert.equal(fresh.store.load(fresh.run.runId).status, 'waiting_human');
  await unsupported.session.receive(rpc('arguments-meta', 'tools/call', { name: 'request_approval', arguments: { ...fresh.args, _meta: metadata } }));
  assert.equal(unsupported.messages.at(-1).error.code, -32602);
});

for (const [version, capabilities, mode] of [
  ['2025-11-25', { elicitation: { form: {} } }, 'form'],
  ['2025-11-25', { elicitation: {} }, 'form'],
  ['2025-06-18', { elicitation: {} }, undefined],
]) test(`client form approval works for ${version} with ${JSON.stringify(capabilities)}`, async t => {
  const { manifestFile, store, run, args } = await fixture(t);
  const { session, messages } = await client(t, manifestFile, capabilities, version);
  const call = session.receive(rpc('approve', 'tools/call', { name: 'request_approval', arguments: args }));
  const form = await waitFor(messages, message => message.method === 'elicitation/create');
  assert.equal(form.params.mode, mode);
  assert.match(form.params.message, /SHA-256: [a-f0-9]{64}/);
  assert.notEqual(form.id, 'approve');
  await session.receive(reply(form));
  await call;
  assert.equal(store.load(run.runId).status, 'success');
  assert.equal(store.load(run.runId).steps[0].confirmation.channel, 'approval-anchor');
  const result = messages.find(message => message.id === 'approve').result;
  assert.equal(result.isError, undefined);
  assert.equal(JSON.parse(result.content[0].text).decision, 'approve');
});

test('client rejection records rejection while decline and cancel keep the gate waiting', async t => {
  for (const action of ['reject', 'decline', 'cancel']) {
    const { manifestFile, store, run, args } = await fixture(t);
    const { session, messages } = await client(t, manifestFile);
    const call = session.receive(rpc(action, 'tools/call', { name: 'request_approval', arguments: args }));
    const form = await waitFor(messages, message => message.method === 'elicitation/create');
    await session.receive(action === 'reject' ? reply(form, 'reject') : { jsonrpc: '2.0', id: form.id, result: { action } });
    await call;
    assert.equal(store.load(run.runId).status, action === 'reject' ? 'failed' : 'waiting_human');
    assert.equal(store.load(run.runId).steps[0].decision, action === 'reject' ? 'reject' : null);
  }
});

test('clients without form elicitation are refused and reinitialization cannot replace capabilities', async t => {
  const { manifestFile, store, run, args } = await fixture(t);
  for (const capabilities of [{}, { elicitation: { url: {} } }]) {
    const { session, messages } = await client(t, manifestFile, capabilities);
    await session.receive(initialize({ elicitation: {} }));
    assert.equal(messages.at(-1).error.code, -32600);
    await session.receive(rpc('unsupported', 'tools/call', { name: 'request_approval', arguments: args }));
    assert.equal(messages.at(-1).result.isError, true);
    assert.match(messages.at(-1).result.content[0].text, /ELICITATION_UNSUPPORTED/);
    assert.equal(messages.filter(message => message.method === 'elicitation/create').length, 0);
    assert.equal(store.load(run.runId).status, 'waiting_human');
  }
});

test('only the pending JSON-RPC response resolves an elicitation; requests and replay do not', async t => {
  const { manifestFile, store, run, args } = await fixture(t);
  const { session, messages } = await client(t, manifestFile);
  await session.receive({ jsonrpc: '2.0', id: 'unsolicited', result: { action: 'accept', content: { decision: 'approve' } } });
  const call = session.receive(rpc('approve', 'tools/call', { name: 'request_approval', arguments: args }));
  const form = await waitFor(messages, message => message.method === 'elicitation/create');
  await session.receive({ ...rpc(form.id, 'ping'), result: { action: 'accept', content: { decision: 'approve' } } });
  assert.equal(messages.at(-1).error.code, -32600);
  await session.receive(rpc(form.id, 'ping'));
  assert.equal(store.load(run.runId).status, 'waiting_human');
  await session.receive(reply(form));
  await call;
  const count = messages.length;
  await session.receive(reply(form, 'reject'));
  assert.equal(messages.length, count);
  assert.equal(store.load(run.runId).status, 'success');
  await session.receive(rpc('again', 'tools/call', { name: 'request_approval', arguments: args }));
  assert.equal(messages.at(-1).result.isError, true);
  assert.equal(messages.filter(message => message.method === 'elicitation/create').length, 1);
});

test('disconnect and cancellation invalidate outstanding client responses', async t => {
  for (const how of ['disconnect', 'cancel-call', 'cancel-form']) {
    const { manifestFile, store, run, args } = await fixture(t);
    const { session, messages } = await client(t, manifestFile);
    const call = session.receive(rpc('approve', 'tools/call', { name: 'request_approval', arguments: args }));
    const form = await waitFor(messages, message => message.method === 'elicitation/create');
    if (how === 'disconnect') session.close();
    else await session.receive({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: how === 'cancel-call' ? 'approve' : form.id } });
    await session.receive(reply(form));
    await call;
    assert.equal(store.load(run.runId).status, 'waiting_human');
    assert.equal(store.load(run.runId).steps[0].decision, null);
  }
});

test('cancellation or disconnect after a response resolves still prevents recording a decision', async t => {
  for (const how of ['disconnect', 'cancel']) {
    const { manifestFile, store, run, args } = await fixture(t);
    const { session, messages } = await client(t, manifestFile);
    const call = session.receive(rpc('approve', 'tools/call', { name: 'request_approval', arguments: args }));
    const form = await waitFor(messages, message => message.method === 'elicitation/create');
    session.receive(reply(form));
    // Let the transport resolve its promise before the service resumes.
    await Promise.resolve();
    if (how === 'disconnect') session.close();
    else await session.receive({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 'approve' } });
    await call;
    const current = store.load(run.runId);
    assert.equal(current.status, 'waiting_human', how);
    assert.equal(current.steps[0].decision, null, how);
    assert.equal(current.steps[0].confirmation, undefined, how);
  }
});

test('stdio keeps reading while a tool awaits its elicitation response', async t => {
  const { manifestFile, store, run, args } = await fixture(t);
  const input = new PassThrough(), output = new PassThrough(), messages = [];
  let buffer = '';
  output.on('data', data => {
    buffer += data.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const line of lines) messages.push(JSON.parse(line));
  });
  const serving = serveMcp({ manifestFile, input, output });
  t.after(() => { input.destroy(); output.destroy(); });
  const send = message => input.write(JSON.stringify(message) + '\n');
  send(initialize()); send(initialized);
  send(rpc('approve', 'tools/call', { name: 'request_approval', arguments: args }));
  const form = await waitFor(messages, message => message.method === 'elicitation/create');
  send(rpc('during', 'ping'));
  await waitFor(messages, message => message.id === 'during');
  send(reply(form));
  const result = await waitFor(messages, message => message.id === 'approve');
  assert.equal(result.result.isError, undefined);
  assert.equal(store.load(run.runId).status, 'success');
  input.end();
  await serving;
});

test('stdio transport failure cancels an outstanding form and terminates the session', async t => {
  const { manifestFile, store, run, args } = await fixture(t);
  const input = new PassThrough(), output = new PassThrough(), messages = [];
  let buffer = '';
  output.on('data', data => {
    buffer += data.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const line of lines) messages.push(JSON.parse(line));
  });
  const serving = serveMcp({ manifestFile, input, output });
  t.after(() => { input.destroy(); output.destroy(); });
  input.write([initialize(), initialized, rpc('approve', 'tools/call', { name: 'request_approval', arguments: args })].map(message => JSON.stringify(message) + '\n').join(''));
  const form = await waitFor(messages, message => message.method === 'elicitation/create');
  output.destroy(new Error('client output disconnected'));
  await assert.rejects(serving, /client output disconnected/);
  input.write(JSON.stringify(reply(form)) + '\n');
  assert.equal(store.load(run.runId).status, 'waiting_human');
});

test('MCP CLI exposes help and pins exactly one startup manifest argument', () => {
  const cli = resolve('bin/q-core-mcp.mjs');
  const help = spawnSync(process.execPath, [cli, '--help'], { encoding: 'utf8' });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /Usage: q-core-mcp <manifest.yaml>/);
  const invalid = spawnSync(process.execPath, [cli, 'one.yaml', 'two.yaml'], { encoding: 'utf8' });
  assert.equal(invalid.status, 1);
  assert.equal(invalid.stdout, '');
  assert.match(invalid.stderr, /Usage:/);
});
