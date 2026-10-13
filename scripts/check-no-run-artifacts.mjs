// Q-Core is public and holds only the Core and what is published from it.
// Run results, receipts, evidence dumps, transcripts, captured media, packed
// archives and build output stay out of the repository. This guard refuses a
// tracked path that looks like one of them. Published Registry demos
// (registry/demos/) are release objects checked by check-public-surface.mjs
// and are not matched here.
import { execFileSync } from 'node:child_process';
import { statSync } from 'node:fs';

const MAX_BYTES = 1024 * 1024;

const rules = [
  ['generated delivery receipt', /^docs\/delivery\/(?!\.gitkeep$)/],
  ['evidence dump', /(^|\/)evidence\//],
  ['run output directory', /(^|\/)(runs?|out|outputs|artifacts|captures?|transcripts?|downloads)\//],
  ['local run state', /(^|\/)\.qf\//],
  ['dependency or build output', /(^|\/)(node_modules|dist|build|coverage)\//],
  ['log or run marker', /\.(log|started)$/],
  ['transcript or captions', /(^|\/)[^/]*transcript[^/]*\.(json|txt|md|vtt|srt)$|\.(vtt|srt)$/i],
  ['run verification record', /(^|\/)verification\.json$/],
  ['packed archive', /\.(tgz|tar|tar\.gz|zip)$/],
  ['captured media', /\.(mp4|mov|webm|mp3|wav|m4a)$/i],
  ['screenshot or image outside docs/assets', /^(?!docs\/assets\/).*\.(png|jpe?g|webp|gif)$/i],
];

export function classify(path) {
  for (const [reason, pattern] of rules) if (pattern.test(path)) return reason;
  return null;
}

export function findRunArtifacts(paths, sizeOf = () => 0) {
  const found = [];
  for (const path of paths) {
    const reason = classify(path) ?? (sizeOf(path) > MAX_BYTES ? `file larger than ${MAX_BYTES} bytes` : null);
    if (reason) found.push({ path, reason });
  }
  return found;
}

if (import.meta.url === new URL(process.argv[1], 'file:').href) {
  const tracked = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);
  const sizeOf = (path) => { try { return statSync(path).size; } catch { return 0; } };
  const found = findRunArtifacts(tracked, sizeOf);
  for (const { path, reason } of found) console.error(`::error file=${path}::${reason} does not belong in Q-Core: ${path}`);
  if (found.length) {
    console.error(`${found.length} run artifact path(s) tracked. Keep run results, receipts, evidence and transcripts outside the public repository.`);
    process.exit(1);
  }
  console.log(JSON.stringify({ trackedFiles: tracked.length, runArtifacts: 0 }));
}
