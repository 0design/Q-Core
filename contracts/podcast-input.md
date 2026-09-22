# Podcast input contract v1

This contract prepares a verified local input for the authorized video `RAGlJ_B9EfE`. It does not publish, infer facts, or accept a Podcast loop run.

## Capture boundary

The source capture is a local, read-only `source-export.json` accompanied by `source-manifest.json`; neither third-party transcript text nor credentials belong in this repository. The manifest pins the YouTube video ID, title, channel, expected chapter starts, maximum allowed inter-segment gap, and SHA-256 of the exact capture.

## Verification

`node scripts/extract-podcast-transcript.mjs <capture-directory>` verifies all of the following before an input can be eligible:

- `source-export.json` parses as complete JSON;
- its SHA-256, video ID, and title match the manifest;
- every nonblank transcript line is exactly `[MM:SS] nonempty text`, and timestamps are monotonic;
- every inter-segment gap is at most `maxAllowedInterSegmentGapSeconds`;
- every required chapter start is covered by a segment at or before that timestamp, and the transcript reaches the final required chapter;
- the manifest has a nonempty channel, a nonnegative integer gap limit, and a nonempty ascending unique list of nonnegative chapter starts.

The script writes `verification.json` for both outcomes. It writes `normalized-transcript.json` with `status: "eligible-as-input"` only when every check passes. A future Podcast loop must require both `normalized-transcript.status === "eligible-as-input"` and `verification.status === "pass"`; it must reject every other output.

## Non-claims

A successful fixture test proves the guard, not that this video has a complete transcript. The current local diagnostic capture is incomplete and remains ineligible until a complete, provenance-checked export is available.
