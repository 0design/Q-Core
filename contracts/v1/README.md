# Core contract revision 3 (qf.agent/v1)

Additive to qf.loop/v1. Consumers pin the package tarball SHA256 and this directory.
No sibling source imports. Contract fixtures are synthetic, not live acceptance.

`qloops agent request.json` (or `-` for bounded stdin) emits exactly one JSON
result on stdout. Logs belong on stderr. Status/exit: success/0, failed/1,
needs_human/2, cancelled/130; malformed request failed/64. No implicit provider.

Request: protocolVersion, requestId, loop {id,version}, intent, workspace (absolute),
allowedPaths (exact relative files), allowedTools (verifier executable paths),
provider {kind: claude|codex|openrouter, model, executable? or keyRef?, payerScope},
deadlineMs (1..300000), maxRepairAttempts (0..5), verifier {command,args},
optional approval {hash,decision:approve|reject}, resumeRunId.
Supported loops: sdd-pipeline@1.0.0 and synthetic-sdd@1.0.0 (test alias). Canonical SDD manifests are site-owned;
this executable synthetic entry point is the integration reference.

ModelProvider: generate(messages, limits, signal) -> content, provider identity,
requestId, usage {tokensIn,tokensOut,costUsd}, error. Missing metrics are null.
Claude inference has NO tools. It proposes structured spec/plan/file contents;
WorkspaceExecutor alone applies approved exact files. No shell interpolation.
Verifier is an explicitly caller-authorized executable+argv independent of model.
Policy binds spec, criteria, scope, provider and verifier to SHA256 approval.
The model cannot change verifier or policy. Local permissions are not an OS sandbox.
Only run trusted verifiers in trusted workspaces. No arbitrary shell command adapter.

State: unique UUID, atomic snapshots, exclusive workspace lock, explicit resume.
An interrupted applying phase requires reconciliation; never replay blindly.
Completed runs return cached evidence only if artifacts still match. Approval is
an authorization assertion from the caller (local same-user trust boundary), not
an authentication service. Caller protects request/state files. No “approve latest”.
Result: protocolVersion, requestId, runId, status, summary, artifacts (revision/hash),
evidence (verifier outcomes), error {code,message}|null, nextAction|null,
provider, usage. Unknown verification never means success. Repair cannot edit tests.

Resource note: optional maxCostUsd requires caller-estimated maxCallCostUsd. Unknown or exceeded reported cost stops subsequent calls. This is a reservation check, not a provider billing guarantee.

Revision 2 adds `codex` with absolute executable, explicit model and `local-cli`.
Codex 0.153.4 requires ChatGPT authentication and never falls back to API billing.
It runs read-only in an isolated cwd, accepts text only, and rejects tool events.
Provider metadata uses `authMethod: chatgpt`, `permissionMode: read-only`,
`acceptedTools: []`, `model: null` (CLI does not emit resolved identity).
Direct usage includes `costKind: subscription-usage`, nullable cost, cached input
and input/output tokens. Agent aggregate usage retains the existing shape.
Existing revision 1 requests remain valid; consumers must accept the new provider
and repin package 0.2.0-core.2 to use it. Other protocols and exit codes unchanged.

Revision 3 adds specification import, durable clarification and explicit revisions:
see [specification](specification.md). Missing checker now requests human
configuration; invalid checker remains failed/64. Unavailable Codex model requests
explicit provider configuration. Existing approved scope cannot be silently changed.
Candidate core.4 also documents the [determined callback contract](determined.md),
including operational failure and cancellation behavior. Repin and run consumer
tests before adopting these changes; Site currently uses revision 2/core.2.
