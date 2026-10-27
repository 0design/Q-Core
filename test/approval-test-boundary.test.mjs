import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve, relative } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

test('the software signer constructor is unreachable through CLI/MCP imports and package exports', () => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const pending = ['bin/q-core.mjs', 'bin/q-core-mcp.mjs', 'src/index.mjs'].map(file => resolve(root, file));
  const visited = new Set();
  while (pending.length) {
    const file = pending.pop();
    if (visited.has(file)) continue;
    visited.add(file);
    assert.ok(!relative(root, file).startsWith('test/'), `production imports test-only code: ${relative(root, file)}`);
    const source = readFileSync(file, 'utf8');
    assert.doesNotMatch(source, /createTestTouchIdAnchor|test\/helpers\/touchid-anchor/);
    const imports = source.matchAll(/\b(?:import|export)\s+(?:[^;]*?\s+from\s*)?['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g);
    for (const match of imports) {
      const specifier = match[1] ?? match[2];
      if (specifier.startsWith('.')) pending.push(resolve(dirname(file), specifier));
    }
  }
  assert.ok(visited.has(resolve(root, 'src/mcp-approval.mjs')));
  const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
  assert.ok(manifest.files.every(file => !file.startsWith('test')));
  assert.throws(() => import.meta.resolve('q-core/test/helpers/touchid-anchor.mjs'), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' });
});
