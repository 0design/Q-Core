import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

const extractor = new URL('../scripts/extract-podcast-transcript.mjs', import.meta.url);
const sha256 = value => createHash('sha256').update(value).digest('hex');
const source = transcript => JSON.stringify({ webpageMarkdown: 'Podcast — https://www.youtube.com/watch?v=RAGlJ_B9EfE', videoContent: { transcript: { hasTranscript: true, data: transcript } } });
function runFixture(transcript, { corrupt = false, wrongHash = false } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'qf-podcast-input-'));
  try {
    const raw = corrupt ? source(transcript).slice(0, -1) : source(transcript);
    const manifest = { videoId: 'RAGlJ_B9EfE', title: 'Podcast', sourceSha256: wrongHash ? '0'.repeat(64) : sha256(raw), maxAllowedInterSegmentGapSeconds: 10, requiredChapterStartsSeconds: [0, 10, 20] };
    writeFileSync(join(directory, 'source-export.json'), raw);
    writeFileSync(join(directory, 'source-manifest.json'), `${JSON.stringify(manifest)}\n`);
    const result = spawnSync(process.execPath, [extractor.pathname, directory], { encoding: 'utf8' });
    const output = { result, verification: JSON.parse(readFileSync(join(directory, 'verification.json'))), normalized: existsSync(join(directory, 'normalized-transcript.json')) ? JSON.parse(readFileSync(join(directory, 'normalized-transcript.json'))) : null };
    rmSync(directory, { recursive: true, force: true });
    return output;
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

test('accepts only a complete, well-formed, continuous authored transcript fixture', () => {
  const fixture = runFixture('[0:00] intro\n[0:08] first\n[0:16] second\n[0:24] third');
  assert.equal(fixture.result.status, 0);
  assert.equal(fixture.verification.status, 'pass');
  assert.equal(fixture.normalized.status, 'eligible-as-input');
});

test('rejects malformed JSON even when its text contains timestamps', () => {
  const fixture = runFixture('[0:00] intro\n[0:10] second\n[0:20] third', { corrupt: true });
  assert.equal(fixture.result.status, 1);
  assert.equal(fixture.verification.status, 'fail');
  assert.equal(fixture.verification.source.jsonParseable, false);
  assert.equal(fixture.normalized, null);
});

test('rejects an excessive gap instead of emitting an eligible input', () => {
  const fixture = runFixture('[0:00] intro\n[0:08] first\n[0:30] after gap');
  assert.equal(fixture.result.status, 1);
  assert.match(fixture.verification.errors.join('\n'), /inter-segment gap exceeds maximum/);
  assert.equal(fixture.normalized, null);
});


test('rejects a source whose bytes do not match its pinned manifest', () => {
  const fixture = runFixture('[0:00] intro\n[0:08] first\n[0:16] second\n[0:24] third', { wrongHash: true });
  assert.equal(fixture.result.status, 1);
  assert.match(fixture.verification.errors.join('\n'), /source SHA-256 mismatch/);
  assert.equal(fixture.normalized, null);
});
