import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { verifyCandidate } from './controller.mjs';

function api(endpoint, body) {
  const args = ['api', endpoint];
  if (body !== undefined) args.push('--method', 'POST', '--input', '-');
  return JSON.parse(execFileSync('gh', args, {
    input: body === undefined ? undefined : JSON.stringify(body),
    encoding: 'utf8', maxBuffer: 1024 * 1024,
  }));
}

// Operator-only adapter. No GitHub credential, this command, or signing key is
// exposed to the worker. Recompute from Git and signed receipts, never trust a
// worker-supplied "eligible" report.
export function publish({ githubRepository, prNumber, expectedBaseBranch, evidenceUrl, ...verification }) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(githubRepository) || !/^[1-9]\d*$/.test(String(prNumber))) throw new Error('Invalid repository/PR');
  if (!expectedBaseBranch.startsWith('codex/gate-pilot-base-')) throw new Error('Only an isolated pilot branch is supported');
  const endpoint = 'repos/' + githubRepository;
  const pr = api(endpoint + '/pulls/' + prNumber);
  if (pr.head.sha !== verification.headSha || pr.base.sha !== verification.baseSha || pr.base.ref !== expectedBaseBranch || pr.state !== 'open') {
    throw new Error('PR moved or has an unexpected base; re-slice and re-review');
  }
  const report = verifyCandidate(verification);
  const url = new URL(evidenceUrl);
  if (url.origin !== 'https://github.com' || !url.pathname.startsWith('/' + githubRepository + '/')) throw new Error('Evidence must belong to this GitHub repository');
  const checks = [
    ['qgate/contract', report.checks.contract],
    ['qgate/review', report.checks.review],
    ['qgate/linear-sync', report.checks.linearSync],
    ['qgate/observations', { state: 'success', reason: report.observation.findings.length + ' observations; independent review is required' }],
  ];
  for (const [context, check] of checks) {
    api(endpoint + '/statuses/' + verification.headSha, {
      state: check.state, context, description: check.reason.slice(0, 140), target_url: evidenceUrl,
    });
  }
  return { state: report.state, headSha: verification.headSha, statuses: checks.map(([context, c]) => ({ context, state: c.state })) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [githubRepository, prNumber, expectedBaseBranch, repository, baseSha, headSha, outputDirectory, receiptDirectory, evidenceUrl] = process.argv.slice(2);
  try { console.log(JSON.stringify(publish({ githubRepository, prNumber, expectedBaseBranch, repository, baseSha, headSha, outputDirectory, receiptDirectory, evidenceUrl }))); }
  catch (e) { console.error(e.message); process.exitCode = 1; }
}
