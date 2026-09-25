import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const git = (args) => execFileSync('git', args, { encoding: 'utf8' });
const generatedReceiptDirectory = 'docs/delivery/';
const trackedDelivery = git(['ls-files', '--', 'docs/delivery'])
  .trim()
  .split('\n')
  .filter(Boolean);

assert.deepEqual(
  trackedDelivery,
  ['docs/delivery/.gitkeep'],
  'docs/delivery stores generated local receipts only; track only .gitkeep',
);

const packed = JSON.parse(
  execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
    encoding: 'utf8',
  }),
)[0];
const paths = packed.files.map(({ path }) => path);
assert.equal(
  paths.some((path) => path.startsWith(generatedReceiptDirectory)),
  false,
  'the public package must not include delivery receipts',
);

// Exact allowed public content (Registry AC2): the npm package file list and the Registry
// release object list are fixed in scripts/public-surface.allowlist.json. Any extra or
// missing path fails, so new public content needs a reviewed allowlist change.
const allow = JSON.parse(readFileSync('scripts/public-surface.allowlist.json', 'utf8'));
const pkgVersion = JSON.parse(readFileSync('package.json', 'utf8')).version;
const sorted = (list) => [...list].sort((a, b) => a.localeCompare(b, 'en'));
assert.deepEqual(sorted(paths), sorted(allow.package), 'npm package files must equal the public-surface allowlist');
const registryPaths = readFileSync('registry/SHA256SUMS', 'utf8').trim().split('\n').map((line) => line.split('  ')[1]);
const coreArtifact = allow.registryRelease.coreArtifact.replace('{version}', pkgVersion);
assert.deepEqual(
  sorted(registryPaths),
  sorted([...allow.registryRelease.objects, coreArtifact]),
  'Registry release objects must equal the public-surface allowlist (plus the Core artifact of this version)',
);

const privateMarker = new RegExp(allow.privateMarkers.join('|'));
const registryText = registryPaths.filter((path) => !path.endsWith('.tgz'));
for (const path of [...paths, ...registryText.map((path) => `registry/${path}`)]) {
  assert.equal(
    privateMarker.test(readFileSync(path, 'utf8')),
    false,
    `public content must not include private workspace references: ${path}`,
  );
}
// Inspect repository source, rather than only npm-pack inputs: a tracked source
// document can be excluded from the package but is still public repository data.
// docs/delivery is generated local evidence. Its separate allowlist above admits
// only .gitkeep, so its untracked receipts cannot make this source check flaky.
const trackedSourceFiles = git(['ls-files', '-z'])
  .split('\0')
  .filter(Boolean)
  .filter((path) => !path.startsWith(generatedReceiptDirectory));
for (const path of trackedSourceFiles) {
  assert.equal(
    privateMarker.test(readFileSync(path, 'utf8')),
    false,
    `tracked source must not include private workspace references: ${path}`,
  );
}

console.log(JSON.stringify({
  trackedDelivery,
  trackedSourceFiles: trackedSourceFiles.length,
  packedFiles: paths.length,
  registryObjects: registryPaths.length,
  allowlist: 'scripts/public-surface.allowlist.json',
  deliveryReceiptsPacked: false,
  privateWorkspaceMarkers: false,
}));
