import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

test('Touch ID helper compiles without running setup or biometric authentication', { timeout: 240_000 }, t => {
  if (process.platform !== 'darwin') {
    t.skip('The Touch ID helper requires macOS.');
    return;
  }
  const compiler = spawnSync('swiftc', ['--version'], { encoding: 'utf8', timeout: 15_000 });
  if (compiler.error?.code === 'ENOENT') {
    t.skip('swiftc is not installed.');
    return;
  }
  assert.equal(compiler.status, 0, compiler.error?.message ?? compiler.stderr);
  const directory = mkdtempSync(join(tmpdir(), 'q-core-touchid-compile-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const source = fileURLToPath(new URL('../tools/touchid-approve/main.swift', import.meta.url));
  const compiled = spawnSync('swiftc', [
    '-module-cache-path', join(directory, 'module-cache'),
    source, '-o', join(directory, 'touchid-approve'),
  ], { encoding: 'utf8', timeout: 200_000 });
  assert.equal(compiled.status, 0, compiled.error?.message ?? compiled.stderr);
});
