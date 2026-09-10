Created and validated a reusable local loop using only the pinned `fetch` component:

- [service-readiness.yaml](/Users/oleg.design/PORN/projects/QFactory.io/repo/qloops/.qf/golden-parent/create/service-readiness.yaml)
- [service-readiness-negative.yaml](/Users/oleg.design/PORN/projects/QFactory.io/repo/qloops/.qf/golden-parent/create/service-readiness-negative.yaml)
- [verify-service-readiness.mjs](/Users/oleg.design/PORN/projects/QFactory.io/repo/qloops/.qf/golden-parent/create/verify-service-readiness.mjs)

Validation passed for both manifests.

Successful run:

- Run ID: `14c7cd69-d3ef-404c-85dc-f1b51d346789`
- `/health`: HTTP 200, `status=ready`
- `/data`: HTTP 200, `total=6`
- Independent verifier passed
- Evidence: `.qf/runs/14c7cd69-d3ef-404c-85dc-f1b51d346789.json`

Negative run:

- Run ID: `652e9e36-8aab-4c0a-a28c-06fb21ae13c2`
- `/fail`: visibly failed with HTTP 422
- Process exit code: `1`
- Evidence: `.qf/runs/652e9e36-8aab-4c0a-a28c-06fb21ae13c2.json`

Installed engine: `qloops 0.2.0-core.9`, contract revision 5. No model calls, POSTs, external writes, or existing loop changes were made.