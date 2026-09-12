import { execFileSync } from 'node:child_process';
import { readFileSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { acceptance, bindCandidate, contextSlice, digest, observe } from './gate.mjs';
import { render } from './render.mjs';

const PREFIX = 'examples/acceptance-gate/';
const HERE = dirname(fileURLToPath(import.meta.url));
const trustedFiles = ['gate.mjs', 'controller.mjs', 'render.mjs', 'publish-github.mjs', 'trust.json'];

export function git(repo, args) {
  return execFileSync('git', ['--no-replace-objects', '-c', 'core.hooksPath=/dev/null', ...args], {
    cwd: repo, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024,
  });
}

export function fileAt(repo, sha, path) {
  if (!/^[a-f0-9]{40}$/.test(sha) || !path.startsWith(PREFIX) || path.includes('..')) throw new Error('Invalid Git object request');
  const spec = sha + ':' + path;
  const size = Number(git(repo, ['cat-file', '-s', spec]).trim());
  if (!Number.isSafeInteger(size) || size > 65_536) throw new Error('Oversized candidate or contract');
  return git(repo, ['show', spec]);
}

export function verifyCandidate({ repository, baseSha, headSha, receiptDirectory, outputDirectory, nowMs }) {
  const contract = JSON.parse(fileAt(repository, baseSha, PREFIX + 'contract.json'));
  const ds = JSON.parse(fileAt(repository, baseSha, PREFIX + 'ds.json'));
  const trust = JSON.parse(fileAt(repository, baseSha, PREFIX + 'trust.json'));
  const sources = {};
  for (const name of trustedFiles) {
    const fromBase = Buffer.from(fileAt(repository, baseSha, PREFIX + name));
    if (!readFileSync(join(HERE, name)).equals(fromBase)) throw new Error('Execute the exact trusted base verifier: ' + name);
    sources[name] = digest(fromBase);
  }
  const changedFiles = git(repository, ['diff', '--no-ext-diff', '--no-textconv', '--name-only', '-z', baseSha, headSha]).split('\0').filter(Boolean);
  const files = contract.allowedFiles.map(path => ({ path, sha256: digest(Buffer.from(fileAt(repository, headSha, path))) }));
  const binding = bindCandidate({ baseSha, headSha, contract, ds, verifierDigest: digest(sources), files });
  const screen = JSON.parse(fileAt(repository, headSha, contract.allowedFiles[0]));
  const observation = observe(screen, contract, ds);
  const readReceipt = name => {
    if (!receiptDirectory) return null;
    try { return JSON.parse(readFileSync(join(receiptDirectory, name + '.json'), 'utf8')); }
    catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  };
  const decision = acceptance({
    binding, changedFiles, contract, review: readReceipt('review'), sync: readReceipt('linear-sync'),
    reviewPublicKey: trust.review, syncPublicKey: trust.linearSync, nowMs,
  });
  let preview = null;
  try { preview = render(screen, contract, ds); } catch { /* Unsupported recipes remain observations for reviewer triage. */ }
  const report = {
    ...decision, observation, sourceDigests: sources,
    previewDigest: preview === null ? null : digest(Buffer.from(preview)),
    coverage: { scope: 'Synthetic task and registered Core/Instance mappings only', system: 'incomplete' },
  };
  if (outputDirectory) {
    mkdirSync(outputDirectory, { recursive: true });
    writeFileSync(join(outputDirectory, 'report.json'), JSON.stringify(report, null, 2) + '\n');
    writeFileSync(join(outputDirectory, 'context-slice.json'), JSON.stringify(contextSlice(contract, ds), null, 2) + '\n');
    if (preview !== null) writeFileSync(join(outputDirectory, 'preview.html'), preview);
    else rmSync(join(outputDirectory, 'preview.html'), { force: true });
  }
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [repository, baseSha, headSha, outputDirectory, receiptDirectory] = process.argv.slice(2);
  try {
    const report = verifyCandidate({ repository, baseSha, headSha, outputDirectory, receiptDirectory });
    console.log(JSON.stringify({ state: report.state, checks: report.checks, observations: report.observation.findings.length }));
    process.exitCode = report.state === 'eligible' ? 0 : report.state === 'pending' ? 2 : 1;
  } catch (e) { console.error(e.message); process.exitCode = 1; }
}
