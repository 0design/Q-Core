import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const git = (args) => execFileSync('git', args, { encoding: 'utf8' });
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
  paths.some((path) => path.startsWith('docs/delivery/')),
  false,
  'the public package must not include delivery receipts',
);

const privateMarker = /linear\.app\/0dhaus|\b0D-\d+/;
for (const path of paths.filter((path) => path.endsWith('.md'))) {
  assert.equal(
    privateMarker.test(readFileSync(path, 'utf8')),
    false,
    `packed documentation must not include private workspace references: ${path}`,
  );
}

console.log(JSON.stringify({
  trackedDelivery,
  packedFiles: paths.length,
  deliveryReceiptsPacked: false,
  privateWorkspaceMarkers: false,
}));
