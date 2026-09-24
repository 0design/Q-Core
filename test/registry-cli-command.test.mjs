import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
test('public CLI run/reply persists configuration and emits parseable JSON', () => {
  const dir = mkdtempSync(join(tmpdir(), 'q-core-reply-test-'));
  const cli = resolve('bin/q-core.mjs');
  const file = join(dir, 'loop.yaml');
  writeFileSync(file, 'manifest: q-core.workflow/v1\nid: test-cli\nname: CLI test\nversion: 1.0.0\nenabled: true\nsettings:\n  budgetUsd: null\nsteps:\n  - id: draft\n    kind: llm-call\n    config:\n      provider: cli\n      instructions: Return a brief summary\n');
  const provider = join(dir, 'provider.json');
  writeFileSync(provider, JSON.stringify({ kind: 'caller', agent: 'codex', model: 'caller-selected', payerScope: 'local-cli' }));
  const invoke = args => spawnSync(process.execPath, [cli, ...args], { cwd: dir, encoding: 'utf8' });
  try {
    const first = invoke(['run', file, '--json', '--caller-provider', provider]);
    assert.equal(first.status, 2, first.stderr + first.stdout);
    const run = JSON.parse(first.stdout);
    assert.equal(run.status, 'waiting_inference');
    const reply = join(dir, 'reply.json');
    writeFileSync(reply, JSON.stringify({ jobId: run.pendingInference.jobId, hash: run.pendingInference.hash, output: { text: 'Synthetic command test response' } }));
    const next = invoke(['reply', file, run.runId, reply, '--json']);
    assert.equal(next.status, 0, next.stderr + next.stdout);
    const finished = JSON.parse(next.stdout);
    assert.equal(finished.status, 'success');
    assert.equal(finished.costUsd, null);
    assert.notEqual(invoke(['reply', file, run.runId, reply, '--json']).status, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
