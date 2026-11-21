import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { assertVersionsImmutable, sameVersionChangedBytes } from '../scripts/check-registry-version-immutability.mjs';

const current = JSON.parse(readFileSync(new URL('../registry/catalog.json', import.meta.url), 'utf8'));
const entry = current.workflows.find(workflow => workflow.id === 'content-feed');

test('the same workflow version with different bytes in the next release is refused', () => {
  const previous = structuredClone(current);
  previous.workflows.find(workflow => workflow.id === 'content-feed').sha256 = '0'.repeat(64);
  assert.deepEqual(sameVersionChangedBytes(previous, current).map(c => `${c.id}@${c.version}`), [`content-feed@${entry.version}`]);
  assert.throws(() => assertVersionsImmutable(previous, current), /Same version, different bytes.*workflows\/content-feed@/);
});

test('components and demos follow the same rule', () => {
  for (const section of ['components', 'demos']) {
    const previous = structuredClone(current);
    previous[section][0].sha256 = '0'.repeat(64);
    assert.throws(() => assertVersionsImmutable(previous, current), new RegExp(`${section}/${previous[section][0].id}@`));
  }
});

test('a new version, a new entry or unchanged bytes pass', () => {
  const previous = structuredClone(current);
  const old = previous.workflows.find(workflow => workflow.id === 'content-feed');
  old.version = '0.0.1'; old.sha256 = '0'.repeat(64);
  previous.workflows = previous.workflows.filter(workflow => workflow.id !== 'price-watch');
  assert.doesNotThrow(() => assertVersionsImmutable(previous, current));
  assert.doesNotThrow(() => assertVersionsImmutable(current, current));
});
