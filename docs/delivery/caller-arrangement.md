# Caller arrangement after fresh parent proof — 2026-09-10

## Current implementation — core.11

Coordinator authorized this protocol as internal MVP implementation. The historical proposal below is retained for rationale, not a new approval gate. Explicit caller mode is now implemented and passes 134/134 runtime tests and six clean-installed caller scenarios with scripted replies and real verifier/HTTP effects. Fresh parent HTTP proof remains pending. See ../../contracts/v1/caller-inference.md and caller-package.json.

## Finding

The configured Codex0.153.4 authenticates and runs as the fresh parent. Under its
workspace-write shell, starting another CLI fails before model events with
`failed to initialize in-process app-server client: Operation not permitted`.
The PATH-alias warning is also present; evidence does not establish that it is
the cause. No auth/nesting guard was removed and no sandbox was widened.
Standalone Core→CLI proof outside this parent boundary remains valid for that
different environment only. core.10 makes this a typed human stop, not a solution.

The parent can fetch/install/validate/run ordinary Core steps and independent
local Node verifiers. Actual customize and create cases demonstrate these pieces.
The denied capability is a new nested Codex client, not all Core execution.

## What is available now

- The HTTP/CLI `qloops agent` and `qloops content` routes use provider descriptors
  for Codex/Claude/OpenRouter. There is no configured caller-inference descriptor,
  response mailbox, broker URL or transport in the published request contracts.
- `runAgent(request,{generate})` is a trusted **in-process** SDK injection point.
  It receives messages/runId/cwd/limits and returns content/provider/usage. Content
  has `runContent(...,{generate,check,publish})`. These are extension points, not a
  durable two-phase bridge that the parent CLI can already use out of the box.
- SDD specification import avoids only the first generation. Execution/repair
  still calls the configured model. The fresh start imported a parent-created
  specification, obtained Core approval, then hit the same nested-client denial.
- Official `codex exec resume <SESSION_ID>` resumes the **parent conversation**;
  it does not feed a model answer into a currently blocked Core subprocess.
  See [Codex non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode).

Therefore no existing published one-command arrangement is proven for full SDD/
Content in this tested sandbox. Do not relabel parent-written files plus a self
report as the original Core execute/verify/repair acceptance.

## Proposed next implementation: explicit caller-inference protocol

Use the already running parent Codex as an explicit inference provider; keep Core
responsible for state, exact approval, scoped file application, independent verifier
execution, bounded repair and Content receipts. This requires a new agreed
provider mode and versioned two-phase protocol, not a silent fallback.

1. Core returns needs_human/needs_inference with a persisted inference job: runId,
   unique jobId, phase, input/context hash, spec/artifact revision, bounded messages,
   expected structured output and limits. Core exits; the parent gets its tool
   result and can think in the same conversation without launching another CLI.
2. Parent generates only the requested structured answer in its current session,
   saves it in the permitted workspace, and submits the response referencing that
   exact job/hash/revision. Provider evidence explicitly says caller-supplied live
   inference; unavailable usage stays unknown. No claim of CLI child invocation.
3. Core validates correlation, one-time acceptance, schema, limits and state.
   The answer cannot supply approval, widen paths, replace verifier bytes, mark
   evidence passed, replay a consumed job or advance a changed artifact revision.
4. Core proceeds through existing spec approval and WorkspaceExecutor. The
   independent verifier is a separately authorized executable bound before model
   execution; it is actually run by Core and its evidence controls success/repair.
   Another needed generation yields another bounded job, rather than nested IPC.
5. Content drafting similarly yields a caller job; Core still performs source
   attribution checks and returns the exact text/receiver approval. Only its
   authorized publisher sends and records/reconciles actual receipts.

The generated answer is not independent verification. Independence is retained
only by keeping verifier code/policy outside model-writable scope, binding it into
the human approval, and executing it through Core. Parent tool permissions and
local state remain a same-user trust boundary, not protection against a malicious
host agent with unrestricted filesystem access.

This adds no mandatory paid provider account: it uses the active Codex session's
existing allowance. It does not promise free/unlimited usage. It can also support
Claude later without nested CLI if that caller passes the same acceptance matrix.

## Alternative: caller-owned external broker

A deliberately installed trusted local service outside the parent's sandbox can
own the CLI and exchange bounded authenticated jobs with Core. Such a service is
not present/proven here; starting one to evade this denial is not an approved
workaround. It needs explicit architecture/permission approval, authentication,
queue limits, lifecycle, cancellation and side-effect reconciliation, and could
add a setup step that weakens the one-prompt experience. Estimated 3–5 engineering
days plus deployment/acceptance; not the recommended next experiment.

## Estimate and acceptance for the proposal

Proposed caller protocol: roughly 2–4 working days Core implementation/tests plus
1–2 working days Site skill integration and fresh SDD/Content parent proofs;
overlap is possible. This is incremental scope beyond the typed-error fix and
was explicitly authorized by the coordinator for implementation. Keep existing CLI-provider mode
for environments where it is actually supported; never switch to caller mode
without an explicit request/approval identity change.

Acceptance: fresh parent + HTTP-pinned package only; actual SDD edit + independently
failed verifier → bounded repair → actual pass; stale/replayed/mismatched job,
changed verifier/scope, cancellation and limits refuse safely; real synthetic
Content exact-text approval→localhost receipt→dedup; operator decisions disclosed.
Then repeat the four entry paths and finally Claude. Owner editorial/channel
acceptance and public release are still separate.

Next: Site consumes the immutable caller package and exposes the protocol through its public skill, followed by fresh parent acceptance. No new owner approval is needed for this internal implementation.
