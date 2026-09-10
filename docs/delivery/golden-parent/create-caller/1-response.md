Created a reusable local service-readiness loop.

Files:

- [service-readiness.yaml](/Users/oleg.design/PORN/projects/QFactory.io/repo/qloops/.qf/golden-parent/create-caller/.qf/service-readiness/service-readiness.yaml)
- [negative variant](/Users/oleg.design/PORN/projects/QFactory.io/repo/qloops/.qf/golden-parent/create-caller/.qf/service-readiness/service-readiness-negative.yaml)
- [independent verifier](/Users/oleg.design/PORN/projects/QFactory.io/repo/qloops/.qf/golden-parent/create-caller/.qf/service-readiness/verify-service-readiness.mjs)

Validation and execution:

- Success manifest: valid; 2/2 fetches succeeded.
- Health: HTTP 200, `status=ready`.
- Data: HTTP 200, `total=6`.
- Independent success run: `4a171c35-2ede-40d1-b12e-f306804eb695`.
- Negative run exited non-zero and visibly failed on HTTP 422.
- Independent negative run: `ba199aa3-e0ff-4a7b-a395-37854b0a7903`.

Evidence is retained in [evidence/](/Users/oleg.design/PORN/projects/QFactory.io/repo/qloops/.qf/golden-parent/create-caller/.qf/service-readiness/evidence/).

The loop uses only `fetch`; no model inference, POSTs, external writes, or invented step kinds. It was built with verified qloops `0.2.0-core.11`, contract revision `7`, and the pinned SHA-256.