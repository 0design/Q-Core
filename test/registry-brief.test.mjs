// Registry29 (owner decision 28.09): every workflow and component carries a structured brief, so an agent
// briefs the user from Registry data instead of inventing steps, settings or prices.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const catalog = JSON.parse(readFileSync(new URL('../registry/catalog.json', import.meta.url), 'utf8'));
const nonEmpty = value => typeof value === 'string' && value.trim().length > 0;

test('every workflow carries a complete brief', () => {
  for (const w of catalog.workflows) {
    const b = w.brief;
    assert.ok(b && typeof b === 'object', w.id);
    assert.ok(nonEmpty(b.summary) && nonEmpty(b.price), `${w.id}: summary, price`);
    for (const key of ['howItWorks', 'inputs', 'outputs', 'limits', 'exampleRequests']) assert.ok(Array.isArray(b[key]) && b[key].length > 0 && b[key].every(nonEmpty), `${w.id}: ${key}`);
    assert.ok(b.exampleRequests.length >= 2 && b.exampleRequests.length <= 3, `${w.id}: 2–3 example requests`);
    assert.ok(Array.isArray(b.knobs) && b.knobs.every(k => nonEmpty(k.name) && nonEmpty(k.what)), `${w.id}: knobs`);
    assert.ok(Array.isArray(b.requires?.access) && Array.isArray(b.requires?.providers) && Array.isArray(b.requires?.env), `${w.id}: requires`);
    for (const p of b.requires.providers) assert.ok(['cli', 'openrouter'].includes(p.id) && nonEmpty(p.how), `${w.id}: provider ${p.id}`);
    // Every variable the catalog says the workflow needs is explained in the brief.
    for (const name of w.needsEnv ?? []) assert.ok(b.requires.env.some(e => e.name === name), `${w.id}: env ${name}`);
    if (w.executionProfile?.inference === 'openrouter') assert.ok(b.requires.providers.some(p => p.id === 'openrouter'), `${w.id}: openrouter route`);
  }
});

test('contract facts agents had to invent on 27–28.09 are in the Registry', () => {
  const byId = Object.fromEntries(catalog.workflows.map(w => [w.id, w]));
  // Registry30: the CLI route is published as its own workflow (no edited copy, no OpenRouter key).
  for (const id of ['digest', 'podcast-summary']) {
    const variant = byId[`${id}-cli`];
    assert.ok(variant, `${id}-cli is published`);
    assert.deepEqual(variant.executionProfile, { inference: 'cli', callerReady: true });
    assert.ok(!variant.needsEnv.includes('OPENROUTER_API_KEY'), `${id}-cli needs no OpenRouter key`);
    assert.ok(variant.dependencies.some(d => d.id === 'llm-call-cli') && !variant.dependencies.some(d => d.id === 'llm-call-openrouter'), `${id}-cli depends on llm-call-cli`);
    assert.deepEqual(variant.brief.requires.providers.map(p => p.id), ['cli']);
    assert.match(variant.brief.requires.providers[0].how, /q-core reply/);
    assert.match(byId[id].brief.requires.providers.find(p => p.id === 'cli').how, new RegExp(`${id}-cli`));
    assert.equal(variant.humanGate, true, `${id}-cli keeps the human approval gate`);
  }
  assert.match(byId['digest-cli'].brief.limits.join('\n'), /q-core reply must run with the same QF_DIGEST_\* variables/);
  // Negative: the variant is a candidate; only digest 0.8.0 carries the owner's acceptance.
  assert.equal(byId['digest-cli'].acceptance.status, 'pending');
  const cliComponent = catalog.components.find(c => c.id === 'llm-call-cli');
  assert.match(cliComponent.brief.limits.join('\n'), /60000 bytes/);
});

test('Digest 0.8.0 is accepted; the other workflows keep their status', () => {
  const digest = catalog.workflows.find(w => w.id === 'digest');
  assert.equal(digest.version, '0.8.1');
  assert.equal(digest.status, 'accepted');
  assert.equal(digest.acceptance.status, 'accepted');
  assert.equal(digest.acceptance.evidence[0].runId, '5b9ffaf1-cb7f-426e-a7e3-eb68d9224452');
  // Negative: the acceptance is scoped; the OpenRouter route is not claimed.
  assert.match(digest.acceptance.evidence[0].scope, /OpenRouter route of 0\.8\.0 was not re-run/);
  for (const w of catalog.workflows.filter(w => w.id !== 'digest')) assert.notEqual(w.status, 'accepted', w.id);
});

test('every component carries a short brief', () => {
  for (const c of catalog.components) {
    assert.ok(nonEmpty(c.brief?.summary), c.id);
    assert.ok(Array.isArray(c.brief.requires) && Array.isArray(c.brief.limits), c.id);
  }
  assert.match(catalog.components.find(c => c.id === 'agentation').brief.summary, /[Pp]lanned/);
});

// Digest 0.8.1 and digest-cli 0.8.1 change only YAML comments: without `version`, the parsed manifests equal the
// 0.8.0 ones the acceptance record refers to. Any change of steps or settings breaks this and needs a new acceptance.
test('Digest 0.8.1 and digest-cli 0.8.1 parse to exactly the 0.8.0 manifests apart from the version', async () => {
  const { parseYaml } = await import('../src/yaml.mjs');
  const { createHash } = await import('node:crypto');
  const { readFileSync: read } = await import('node:fs');
  const expected = {
    digest: '74112f05e265e0c13f146c3abf585d71de03a1ebf8a6a729e6720e93d1c97031',
    'digest-cli': 'a9f35257a41e50a1daadc85faaf7c48607f16883e5c729a0f82ed8d1d94ee183',
  };
  for (const [id, sha] of Object.entries(expected)) {
    const manifest = parseYaml(read(new URL(`../registry/workflows/${id}.yaml`, import.meta.url), 'utf8'));
    assert.equal(manifest.version, '0.8.1', id);
    delete manifest.version;
    assert.equal(createHash('sha256').update(JSON.stringify(manifest)).digest('hex'), sha, id);
  }
});
