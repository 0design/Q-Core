import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { assertInferenceOutput } from '../src/caller-inference.mjs';

test('shared caller output shape preserves content and text compatibility', () => {
  for (const kind of ['content','text']) {
    assert.doesNotThrow(() => assertInferenceOutput(kind, { text: 'Synthetic caller output.' }));
    for (const output of [{ text: 17 }, { text: ' ' }, {}, { text: 'fixture', extra: true }, null, []])
      assert.throws(() => assertInferenceOutput(kind, output), error => error.code === 'INVALID_RESPONSE');
  }
  assert.doesNotThrow(() => assertInferenceOutput('specification', { summary: 'fixture', criteria: ['fixture'], plan: ['fixture'] }));
  assert.doesNotThrow(() => assertInferenceOutput('specification', { questions: ['fixture'] }));
  assert.doesNotThrow(() => assertInferenceOutput('files', { files: [] }));
});

// Only disposable fixtures are run with this explicit simulation environment.
// The parent agent session is not modified; no existing run can be passed in.
const fixture = fileURLToPath(new URL('./fixtures/remote-human-host-case.mjs', import.meta.url));
for (const scenario of ['approve','reject','enrollment','mutations','expiration','cached-corruption','failed-write','symlinks-lock','agent-refusal',
  'native-execution','native-reject','native-restart','native-mutations','native-interrupted','native-preflight','native-expired','native-expiry-between-steps','native-overlap','native-legacy-locks',
  'native-enrollment-during-preflight','native-inference','native-expired-inference','native-ordinary-writers']) {
  test(`remote human disposable fixture: ${scenario}`, () => {
    const env = { PATH: process.env.PATH, ...(scenario === 'agent-refusal' ? { AI_AGENT: 'fixture' } : {}) };
    const child = spawnSync(process.execPath, [fixture, scenario], { env, encoding: 'utf8', timeout: 20000 });
    assert.equal(child.status, 0, child.stderr || child.error?.message);
    const result = JSON.parse(child.stdout);
    assert.equal(result.passed, true); assert.ok(result.probes >= 3);
  });
}
