Implemented the reusable export in [tags.mjs](/Users/oleg.design/PORN/projects/QFactory.io/repo/qloops/.qf/golden-parent/start-caller-ready/tags.mjs).

Validation:

- Pinned qloops `0.2.0-core.11`, contract revision `7`.
- Artifact SHA-256 verified: `2a5a38b29594a4a8eef2d928ae35548f042f200816176a549a30af1efb5851d6`.
- Only `tags.mjs` was in Core’s writable scope.
- [verify-tags.mjs](/Users/oleg.design/PORN/projects/QFactory.io/repo/qloops/.qf/golden-parent/start-caller-ready/verify-tags.mjs) was preserved unchanged.

Actual run evidence:

- Run ID: `cb766880-ad53-4873-a500-d608873a7422`
- Status: `success`
- Core verifier: passed, exit code `0`
- Fresh standalone verifier: `normalizeTags independent verification passed`
- Verified trimming, lowercase conversion including Ukrainian characters, filtering, stable deduplication, and input immutability.

No external writes or delivery occurred.