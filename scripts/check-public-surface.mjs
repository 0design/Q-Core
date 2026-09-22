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

const privateMarker = /linear\.app\/0dhaus|\b0D-\d+/;
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
  deliveryReceiptsPacked: false,
  privateWorkspaceMarkers: false,
}));
