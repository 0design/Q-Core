// Content distribution 0.1.0: structure, spend and send guards. The run itself needs a coding agent and a person at a terminal.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadManifest } from '../src/manifest.mjs';
import { assertWorkflowPolicy } from '../src/workflow-policy.mjs';

const file = new URL('../registry/workflows/content-distribution.yaml', import.meta.url);
const manifest = loadManifest(file.pathname);
const steps = manifest.steps;

test('every model step answers through the caller and the run has no budget line', () => {
  const llm = steps.filter(s => s.kind === 'llm-call');
  assert.equal(llm.length, 6);
  for (const s of llm) assert.equal(s.config.provider, 'cli', s.id);
  assert.equal(manifest.settings.budgetUsd, null);
  assert.ok(llm.length <= 12, 'within the default inference job cap');
});

test('every delivery has a human gate bound to the exact text right before its checks, and a per-channel receipt key', () => {
  for (const channel of ['x', 'linkedin', 'telegram']) {
    const i = steps.findIndex(s => s.id === `deliver-${channel}`);
    assert.equal(steps[i - 1].id, `approve-${channel}`);
    assert.equal(steps[i - 1].config.reviewer, 'human');
    assert.equal(steps[i - 1].config.bind, 'sha256');
    assert.equal(steps[i - 2].id, `checks-${channel}`);
    assert.match(steps[i].config.receiptKey, new RegExp(`steps\\.unique\\.output\\.sourceHash\\}\\}:${channel}$`));
    // No endpoint is written in the manifest: delivery goes to the operator's receiver only.
    assert.equal(steps[i].config.url, '{{env.QF_DIST_RECEIVER_URL}}');
  }
});

test('the manifest names no host and no secret', () => {
  const text = readFileSync(file, 'utf8');
  assert.doesNotMatch(text, /https?:\/\/(?!\{\{)[^"'\s)]*/, 'no literal URL except in prose of instructions');
  assert.doesNotMatch(text, /TELEGRAM_BOT_TOKEN|OPENROUTER_API_KEY/);
});

test('policy passes as written and refuses a delivery whose gate is removed (negative)', () => {
  assert.doesNotThrow(() => assertWorkflowPolicy(manifest));
  const without = { ...manifest, steps: steps.filter(s => s.id !== 'approve-x') };
  assert.throws(() => assertWorkflowPolicy(without), /GATE_REQUIRED|human/i);
});
