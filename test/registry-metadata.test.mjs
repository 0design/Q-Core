import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRegistry } from '../scripts/build-registry.mjs';
import { workflowMetadata } from '../scripts/registry-workflow-metadata.mjs';
test('new Registry workflows have truthful manifest-derived consumer metadata', () => {
  const { catalog } = buildRegistry();
  const digest = catalog.workflows.find(workflow => workflow.id === 'digest');
  assert.equal(digest.steps, 21, 'Digest 0.6.0 adds the factcheck step, 0.7.0 the articles step, 0.8.0 the review step');
  assert.equal(digest.humanGate, true);
  assert.ok(digest.kinds.includes('verify-sources'));
  assert.equal(digest.needsEnv.includes('OPENROUTER_API_KEY'), false);
  assert.ok(digest.needsEnv.includes('QF_DIGEST_RECEIVER_URL'));
  const sdd = catalog.workflows.find(workflow => workflow.id === 'sdd-pipeline');
  assert.equal(sdd.steps, 7);
  assert.equal(sdd.humanGate, true);
  assert.ok(sdd.kinds.includes('determined'));
  assert.deepEqual(sdd.needsEnv, []);
});
test('metadata includes alternative branches and provider-specific access', () => {
  const metadata = workflowMetadata({ steps: [{
    kind: 'if', then: [], else: [{
      kind: 'switch', cases: { a: [{ kind: 'llm-call', config: { provider: 'cli' } }] },
      default: [
        { kind: 'approval-gate', config: { reviewer: 'human' } },
        { kind: 'fetch', config: { url: '{{env.SOURCE}}' } },
      ],
    }],
  }] });
  assert.equal(metadata.steps, 5);
  assert.equal(metadata.humanGate, true);
  assert.deepEqual(metadata.needsEnv, ['SOURCE']);
  // An OpenRouter step without a model in the manifest only runs with OPENROUTER_MODEL.
  assert.deepEqual(workflowMetadata({steps:[{kind:'llm-call'}]}).needsEnv, ['OPENROUTER_API_KEY', 'OPENROUTER_MODEL']);
  assert.deepEqual(workflowMetadata({settings:{model:'a/b'},steps:[{kind:'llm-call'}]}).needsEnv, ['OPENROUTER_API_KEY']);
  assert.deepEqual(workflowMetadata({steps:[{kind:'llm-call',config:{model:'a/b',secretSource:'keychain'}}]}).needsEnv, []);
  assert.deepEqual(workflowMetadata({steps:[{kind:'llm-call',config:{secretSource:'keychain'}}]}).needsEnv, ['OPENROUTER_MODEL']);
  assert.deepEqual(workflowMetadata({steps:[{kind:'approval-gate',config:{reviewer:'agent'}}]}).needsEnv, ['OPENROUTER_API_KEY', 'OPENROUTER_MODEL']);
  assert.deepEqual(workflowMetadata({steps:[{kind:'llm-call',config:{provider:'cli'}}]}).needsEnv, []);
});
test('optionalEnv lists names read only with a default; a name also read without one stays in needsEnv', () => {
  const metadata = workflowMetadata({ steps: [
    { kind: 'fetch', config: { url: '{{env.QF_FEED:-https://d.example/feed}}', x: '{{env.QF_EMPTY_OK:-}}' } },
    { kind: 'fetch', config: { url: '{{env.QF_A}}', y: '{{ env.QF_BOTH:-x }} {{env.QF_BOTH}}' } },
  ] });
  assert.deepEqual(metadata.needsEnv, ['QF_A', 'QF_BOTH']);
  assert.deepEqual(metadata.optionalEnv, ['QF_FEED', 'QF_EMPTY_OK']);
});
test('every env name a published manifest reads is in needsEnv or optionalEnv, and the brief explains it', async () => {
  const { readFileSync } = await import('node:fs');
  const { catalog } = buildRegistry();
  const byId = Object.fromEntries(catalog.workflows.map(w => [w.id, w]));
  for (const w of catalog.workflows) {
    const yaml = readFileSync(new URL(`../registry/${w.file}`, import.meta.url), 'utf8');
    const names = new Set([...yaml.matchAll(/\{\{\s*env\.([A-Z][A-Z0-9_]*)/g)].map(m => m[1]));
    const listed = new Set([...w.needsEnv, ...w.optionalEnv]);
    for (const name of names) assert.ok(listed.has(name), `${w.id}: ${name} missing from needsEnv/optionalEnv`);
    for (const name of w.optionalEnv) assert.ok(!w.needsEnv.includes(name), `${w.id}: ${name} in both lists`);
    const explained = name => w.brief.requires.env.some(e => e.name === name || (e.name.includes('..') && name.startsWith(e.name.split('..')[0].replace(/_?\d+$/, ''))));
    for (const name of w.optionalEnv) assert.ok(explained(name), `${w.id}: brief does not explain ${name}`);
  }
  assert.deepEqual(byId.digest.optionalEnv, [...Array.from({ length: 10 }, (_, i) => `QF_DIGEST_FEED_${i + 1}`), 'QF_DIGEST_TOPIC']);
  assert.deepEqual(byId['digest-cli'].optionalEnv, byId.digest.optionalEnv);
  assert.deepEqual(byId['podcast-summary'].optionalEnv, ['QF_PODCAST_SOURCE_KIND']);
  assert.deepEqual(byId['podcast-summary-cli'].optionalEnv, ['QF_PODCAST_SOURCE_KIND']);
  for (const id of ['digest', 'podcast-summary']) assert.ok(!byId[id].needsEnv.some(name => name.startsWith('OPENROUTER_')), `${id} reads the key from the Keychain and fixes its models`);
});
test('no OpenRouter brief presents the environment as the default place for the key', () => {
  const { catalog } = buildRegistry();
  for (const w of catalog.workflows) for (const p of w.brief.requires.providers) {
    if (p.id !== 'openrouter' || !/OPENROUTER_API_KEY/.test(p.how)) continue;
    assert.match(p.how, /q-core auth set openrouter/, `${w.id}: Keychain path first`);
    assert.ok(p.how.indexOf('q-core auth set openrouter') < p.how.indexOf('OPENROUTER_API_KEY'), `${w.id}: Keychain is named before the environment`);
    assert.match(p.how, /only if you set it up that way yourself/, `${w.id}: the environment is the user's own choice`);
  }
});
