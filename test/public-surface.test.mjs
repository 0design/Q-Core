import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

const root = resolve('.');
const check = (cwd) => spawnSync(process.execPath, ['scripts/check-public-surface.mjs'], {
  cwd,
  encoding: 'utf8',
});

test('public-surface guard scans tracked source files excluded from npm package', (t) => {
  const temporaryRoot = mkdtempSync(join(tmpdir(), 'qloops-public-surface-'));
  const worktree = join(temporaryRoot, 'source');
  execFileSync('git', ['worktree', 'add', '--detach', worktree, 'HEAD'], {
    cwd: root,
    stdio: 'pipe',
  });
  // The fixture starts from committed source. Copy the candidate guard so this
  // test exercises the code under test while its tracked-file set remains real.
  copyFileSync(join(root, 'scripts', 'check-public-surface.mjs'), join(worktree, 'scripts', 'check-public-surface.mjs'));
  t.after(() => {
    execFileSync('git', ['worktree', 'remove', '--force', worktree], {
      cwd: root,
      stdio: 'pipe',
    });
    rmSync(temporaryRoot, { recursive: true, force: true });
  });

  const sourceOnlyDocument = join(worktree, 'docs', 'source-only-guard-fixture.md');
  writeFileSync(sourceOnlyDocument, 'Public source fixture.\n');
  execFileSync('git', ['add', '--', 'docs/source-only-guard-fixture.md'], {
    cwd: worktree,
    stdio: 'pipe',
  });
  const packed = JSON.parse(execFileSync('npm', ['pack', '--dry-run', '--ignore-scripts', '--json'], {
    cwd: worktree,
    encoding: 'utf8',
  }))[0];
  assert.equal(
    packed.files.some(({ path }) => path === 'docs/source-only-guard-fixture.md'),
    false,
    'fixture must exercise a tracked source file outside the npm package',
  );
  assert.equal(check(worktree).status, 0, 'valid tracked source must pass');

  const privateUrl = ['https://linear.app', '0dhaus/issue', ['0D', '999'].join('-')].join('/');
  writeFileSync(sourceOnlyDocument, `Private fixture: ${privateUrl}\n`);
  execFileSync('git', ['add', '--', 'docs/source-only-guard-fixture.md'], {
    cwd: worktree,
    stdio: 'pipe',
  });
  const negative = check(worktree);
  assert.equal(negative.status, 1, 'tracked source with a private workspace reference must fail');
  assert.match(negative.stderr, /tracked source must not include private workspace references/);
});
