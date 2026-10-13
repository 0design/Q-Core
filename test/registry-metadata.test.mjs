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
  assert.equal(sdd.steps, 10, 'sdd-pipeline 0.2.0: four own steps and the six steps of the pinned sdd-brief');
  assert.equal(sdd.humanGate, true);
  assert.ok(sdd.kinds.includes('determined'));
  assert.deepEqual(sdd.needsEnv, []);
  const brief = catalog.workflows.find(workflow => workflow.id === 'sdd-brief');
  assert.equal(brief.steps, 6);
  assert.equal(brief.humanGate, true);
  assert.equal(brief.kinds.includes('workspace-apply'), false, 'the brief writes no files');
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
  assert.deepEqual(workflowMetadata({steps:[{kind:'llm-call'}]}).needsEnv, ['OPENROUTER_API_KEY']);
});
