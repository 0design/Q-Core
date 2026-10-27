import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Only disposable fixtures are run with this explicit simulation environment.
// The parent agent session is not modified; no existing run can be passed in.
const fixture = fileURLToPath(new URL('./fixtures/remote-human-host-case.mjs', import.meta.url));
for (const scenario of ['approve','reject','enrollment','mutations','expiration','failed-write','symlinks-lock','agent-refusal']) {
  test(`remote human disposable fixture: ${scenario}`, () => {
    const env = { PATH: process.env.PATH, ...(scenario === 'agent-refusal' ? { AI_AGENT: 'fixture' } : {}) };
    const child = spawnSync(process.execPath, [fixture, scenario], { env, encoding: 'utf8', timeout: 20000 });
    assert.equal(child.status, 0, child.stderr || child.error?.message);
    const result = JSON.parse(child.stdout);
    assert.equal(result.passed, true); assert.ok(result.probes >= 3);
  });
}
