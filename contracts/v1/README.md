# Core contracts (qf.agent/v1)

The contracts cover Registry SDD/Digest composition, specification and approval
subjects, determined verification with persisted bounded repair, source checks,
durable receiver receipts, local host triggers, and authored skill execution. See
SPEC-MANIFEST.md §11 and [the skill contract](skill.md).
Direct `q-core agent` and `q-core content` use does not establish compatibility
with a Registry template.

Content has a separate [HTTP request, approval, repeat and receipt contract](content.md)
and a shipped [synthetic request](../../examples/content-request.json).

YAML manifests use `q-core.workflow/v1`; older manifest namespaces are rejected.
Migrate a copy of a manifest and revalidate it with the installed package. Do not
resume old runs or rewrite historical evidence. Consumers pin the package tarball
SHA256 and this directory. No sibling source imports. Contract fixtures are
synthetic and do not exercise external providers or delivery destinations.

`q-core agent request.json` (or `-` for bounded stdin) emits exactly one JSON
result on stdout. Logs belong on stderr. Status/exit: success/0, failed/1,
needs_human/2, cancelled/130; malformed request failed/64. No implicit provider.

Request: protocolVersion, requestId, loop {id,version}, intent, workspace (absolute),
allowedPaths (exact relative files), allowedTools (verifier executable paths),
provider {kind: claude|codex|openrouter, model, executable? or keyRef?, payerScope,
secretSource? (openrouter: env|keychain)},
deadlineMs (1..300000), maxRepairAttempts (0..5), verifier {command,args},
optional approval {hash,decision:approve|reject}, resumeRunId.
Supported workflows: sdd-pipeline@1.0.0 and synthetic-sdd@1.0.0 (test alias). This
executable synthetic entry point is the integration reference.

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

## Compatibility and limits

`codex` accepts an absolute executable, explicit model and `local-cli` payer
scope. It requires ChatGPT authentication and never falls back to API billing. It
runs read-only in an isolated cwd, accepts text only, and rejects tool events.
Provider metadata uses `authMethod: chatgpt`, `permissionMode: read-only`,
`acceptedTools: []`, and `model: null` when the CLI does not emit a resolved
identity. Usage may contain nullable cost and token fields.

Consumers must compare the installed package version and contract revision in
`version.json` with their own compatibility pin, then run their consumer checks.
An older package pin does not establish compatibility with newly used fields.
Agent and loop protocol namespaces and exit codes are separate compatibility
boundaries.

Specification import, durable clarification and explicit revisions are described
in [specification](specification.md). Missing checkers request human
configuration; invalid checkers remain failed/64. An unavailable provider requests
explicit configuration, and approved scope cannot be silently changed. The
[determined callback contract](determined.md) covers operational failure and
cancellation behavior.

Quality reports and recipes require the checksum fields in
[quality.md](quality.md); incomplete or stale evidence yields `needs_human`.
[Registry validation](registry.md) refuses ambiguous or malformed dependencies,
section/file identity mismatches, and engine drift.

Recoverable SDD and Content outcomes use `needs_human`/exit2:
`AUTH_REQUIRED` → `configure_access`,
`MISSING_EXECUTABLE`/`UNSUPPORTED_CLI` → `configure_provider`,
`UNSUPPORTED_NESTING` or `CLI_ENVIRONMENT_DENIED` → `configure_caller`, and
`PERMISSION_DENIED`/`SCOPE_DENIED` → `review_permissions`. These actions never
alter permissions, bypass guards, grant approval, or send content automatically.
Retry an SDD request with its run ID after its prerequisite is restored; retry
Content with the same request and workspace. Changing provider or scope requires a
new request or fresh documented approval.

Read `coreCapabilities()` from the installed package before selecting a local CLI;
it reports the supported provider and secret-store capabilities for those exact
package bytes. Explicit current-agent inference for SDD and Content is specified
in the [caller protocol](caller-inference.md). There is no automatic provider
fallback: Core retains approval, execution and independent verification.
