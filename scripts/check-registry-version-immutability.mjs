// A published Registry entry is named by (section, id, version). The same name must keep the
// same bytes in the next release: a changed workflow, component or demo needs a new version.
// Compares the generated catalog with the catalog of a base Git ref (the previous release).
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SECTIONS = ['workflows', 'components', 'demos'];

export function sameVersionChangedBytes(previous, current) {
  const changed = [];
  for (const section of SECTIONS) {
    const before = new Map((previous?.[section] ?? []).map(entry => [`${entry.id}@${entry.version}`, entry.sha256]));
    for (const entry of current?.[section] ?? []) {
      const key = `${entry.id}@${entry.version}`;
      if (before.has(key) && before.get(key) !== entry.sha256) changed.push({ section, id: entry.id, version: entry.version, before: before.get(key), after: entry.sha256 });
    }
  }
  return changed;
}

export function assertVersionsImmutable(previous, current) {
  const changed = sameVersionChangedBytes(previous, current);
  if (changed.length) throw Error(`Same version, different bytes (bump the version): ${changed.map(c => `${c.section}/${c.id}@${c.version}`).join(', ')}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const at = process.argv.indexOf('--base'), base = at < 0 ? undefined : process.argv[at + 1];
  if (!base || !/^[\w./-]+$/.test(base)) throw Error('Usage: node scripts/check-registry-version-immutability.mjs --base <git ref>');
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  let previousBody;
  try { previousBody = execFileSync('git', ['-C', root, 'show', `${base}:registry/catalog.json`], { encoding: 'utf8', maxBuffer: 50_000_000, stdio: ['ignore', 'pipe', 'ignore'] }); }
  catch { throw Error(`Base ${base} has no readable registry/catalog.json`); }
  const previous = JSON.parse(previousBody), current = JSON.parse(readFileSync(resolve(root, 'registry/catalog.json'), 'utf8'));
  assertVersionsImmutable(previous, current);
  console.log(JSON.stringify({ base, previous: previous.releaseVersion, current: current.releaseVersion, sameVersionChangedBytes: 0 }));
}
