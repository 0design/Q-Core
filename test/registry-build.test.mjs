import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, cpSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { assertCoreArtifact, buildRegistry } from '../scripts/build-registry.mjs';
import { installPinned } from '../src/registry-release.mjs';
import { hash } from '../src/contracts.mjs';

test('shared registry export installs through Core and rejects unreviewed metadata', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'registry-build-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  cpSync(new URL('../registry', import.meta.url), dir, { recursive: true });
  const { catalog } = buildRegistry(dir);
  assert.ok(catalog.loops.length > 0);
  assert.ok([...catalog.loops, ...catalog.components, ...catalog.demos].every(entry => entry.license === 'MIT'));
  const installedVersion = JSON.parse(readFileSync(new URL('../package.json', import.meta.url))).version;
  const originalBytes = JSON.stringify(catalog);
  writeFileSync(join(dir, 'catalog.json'), originalBytes);
  if (catalog.core.version !== installedVersion) {
    await assert.rejects(installPinned({ base: dir, catalogSha256: hash(originalBytes), id: 'webhook-relay', version: '1.1.0', destination: join(dir, 'rejected.yaml') }), e => e.code === 'ENGINE_INCOMPATIBLE');
  }
  // Rebind only the temporary fixture; this does not upgrade the published catalog.
  catalog.core.version = installedVersion;
  for (const entry of [...catalog.loops, ...catalog.components, ...catalog.demos]) {
    entry.engine.version = installedVersion;
  }
  const bytes = JSON.stringify(catalog);
  writeFileSync(join(dir, 'catalog.json'), bytes);
  await installPinned({ base: dir, catalogSha256: hash(bytes), id: 'webhook-relay', version: '1.1.0', destination: join(dir, 'installed.yaml') });
  const sourcePath = join(dir, 'catalog.source.json');
  const source = JSON.parse(readFileSync(sourcePath));
  const value = source.loops[0].value;
  delete source.loops[0].value;
  writeFileSync(sourcePath, JSON.stringify(source));
  assert.throws(() => buildRegistry(dir), /Loop value/);
  source.loops[0].value = value;
  source.loops[0].license = 'LicenseRef-Pending';
  writeFileSync(sourcePath, JSON.stringify(source));
  assert.throws(() => buildRegistry(dir), /license/);
  source.loops[0].license = 'MIT';
  source.loops[0].file = '../package.json';
  writeFileSync(sourcePath, JSON.stringify(source));
  assert.throws(() => buildRegistry(dir), /Unsafe/);
});

test('Core export pin binds both SHA256 and npm integrity', () => {
  const body = Buffer.from('exact candidate bytes');
  const core = {
    version: '0.2.0-test.1',
    artifact: 'vendor/qloops-0.2.0-test.1.tgz',
    artifactSha256: hash(body),
    integrity: `sha512-${createHash('sha512').update(body).digest('base64')}`,
  };
  assert.doesNotThrow(() => assertCoreArtifact({ core }, body));
  assert.throws(() => assertCoreArtifact({ core: { ...core, integrity: `sha512-${Buffer.alloc(64).toString('base64')}` } }, body), /catalog pin/);
});
