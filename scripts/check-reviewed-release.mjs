// Publication is restricted to exact main commits produced by an approved PR.
import { execFileSync } from 'node:child_process';
const commit = process.argv[2];
if (!/^[a-f0-9]{40}$/.test(commit ?? '')) throw Error('Full commit required');
const repository = process.env.GITHUB_REPOSITORY;
if (repository !== '0design/Q-Core') throw Error('Unexpected repository');
execFileSync('git', ['merge-base', '--is-ancestor', commit, 'origin/main']);
const api = path => JSON.parse(execFileSync('gh', ['api', path], { encoding: 'utf8' }));
const prs = api(`repos/${repository}/commits/${commit}/pulls`);
const pr = prs.find(pr => pr.merged_at && pr.base.ref === 'main' && pr.merge_commit_sha === commit);
if (!pr) throw Error('Release commit must be an exact merged PR commit');
// A manually confirmed dispatch supports owner review outside GitHub (including
// single-maintainer repositories, whose author cannot approve their own PR).
const manuallyApproved = process.env.GITHUB_EVENT_NAME === 'workflow_dispatch' && process.env.RELEASE_APPROVED === 'true';
const reviews = JSON.parse(execFileSync('gh', ['api', '--paginate', '--slurp', `repos/${repository}/pulls/${pr.number}/reviews`], { encoding: 'utf8' })).flat();
const latest = new Map();
for (const review of reviews) if (review.state !== 'COMMENTED') latest.set(review.user.id, review);
const decisions = [...latest.values()];
if (decisions.some(review => review.state === 'CHANGES_REQUESTED') ||
    (!manuallyApproved && !decisions.some(review => review.state === 'APPROVED' && review.commit_id === pr.head.sha && review.user.id !== pr.user.id)))
  throw Error('Current PR head requires an approval and no outstanding requested changes');
console.log(JSON.stringify({ approvedMergedPR: pr.number, commit, approval: manuallyApproved ? 'explicit dispatch confirmation' : 'GitHub review' }));
