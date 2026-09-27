import assert from 'node:assert/strict';
import test from 'node:test';
import { classify, findRunArtifacts } from '../scripts/check-no-run-artifacts.mjs';

// Paths that reached pushed branches of this repository as run results.
const junk = [
  'docs/delivery/host-core17.json',
  'docs/delivery/skill-core18.json',
  'evidence/provider-gate/openrouter/out/03-live-call.json',
  'evidence/provider-gate/claude-cli/out/02-claude-live-smoke.started',
  'examples/acceptance-gate/evidence/2026-09-12/preview.png',
  'examples/content-distribution/verification.json',
  'examples/podcast-input/RAGlJ_B9EfE/normalized-transcript.json',
  'downloads/q-core-0.2.0.tgz',
  'captions/episode.vtt',
  'runs/2026-09-27/result.json',
  '.qf/state.json',
  'node_modules/x/index.js',
  'debug.log',
];

// Core source, including code whose name mentions a transcript or evidence.
const core = [
  'docs/delivery/.gitkeep',
  'docs/assets/quickstart.gif',
  'scripts/extract-podcast-transcript.mjs',
  'scripts/sdd-registry-clarification-revision-evidence.mjs',
  'test/registry-evidence-pins.test.mjs',
  'registry/demos/digest-huyiks.txt',
  'registry/catalog.json',
  'src/run.mjs',
  'contracts/v1/result.schema.json',
];

test('run results, receipts, evidence, transcripts and archives are refused', () => {
  for (const path of junk) assert.ok(classify(path), `${path} must be refused`);
});

test('Core source and published Registry objects pass', () => {
  for (const path of core) assert.equal(classify(path), null, `${path} must pass`);
});

test('an oversized tracked file is refused even with a Core-looking path', () => {
  assert.deepEqual(
    findRunArtifacts(['src/huge.json', 'src/run.mjs'], (path) => (path === 'src/huge.json' ? 2 * 1024 * 1024 : 10)),
    [{ path: 'src/huge.json', reason: 'file larger than 1048576 bytes' }],
  );
});
