# determined: execute → verify → repair

`determined` is the reusable execution reducer exported by `q-core`. Import it
from the installed package. It does not create a service, invoke a model, launch
shell commands or grant workspace permissions on its own. A trusted host supplies
`execute`, `verify`, and `getArtifact`. The shipped
`examples/determined-caller.mjs` is a runnable consumer using real files and Node
verifier subprocesses; its executor is explicitly scripted, not model inference.

Input: `criteria` (1–100 unique nonempty IDs, each with a verifier descriptor and
nonempty `type`), `maxRepairAttempts` (0–5), optional `AbortSignal`.
The criteria and verifier descriptors are copied at entry and hashed as `planHash`.
Each execute callback gets detached `criteria`, `attempt` and `previous` evidence.
Changing those values cannot weaken the plan or rewrite recorded history.

- `execute({attempt,criteria,previous,signal})`: apply only caller-authorized
  changes. Attempt zero is initial execution; later attempts repair failed criteria.
- `getArtifact({signal})`: read the actual current artifact and return at least
  `{revision,sha256}`. Revision is a nonnegative safe integer. Changed bytes must
  advance revision. The reducer detaches its snapshot even if the host reuses an
  object. Host must hash the real artifact, not a model's claimed result.
- `verify({criterion,artifact,signal})`: independently return
  `{outcome: 'pass'|'fail'|'unknown',artifactHash,revision}`. Keep trusted verifiers
  outside writable scope and validate their pinned contents in the host. A human
  criterion is always unknown here; it cannot be auto-approved by this reducer.

Every criterion must pass against the same snapshot. Missing/stale evidence,
changes during verification, invalid artifact revisions, unavailable callbacks
or human criteria return `needs_human`. Failed criteria permit at most the
specified repair count; exhausted attempts return `needs_human`. Callback failures
stop immediately with a bounded reason and no automatic replay of uncertain side
effects. Arbitrary callback exception messages are not exposed. Cancellation is
checked before/after awaited callbacks, including the final verifier. A callback
that throws during cancellation still returns `cancelled`.

Host callbacks must honor cancellation and enforce execution deadlines, workspace
locks and resource limits. The reducer cannot terminate an arbitrary JavaScript
promise or roll back external effects. Use the bounded subprocess helper for
trusted executable calls, as shown in the consumer example. Persistence and crash
reconciliation belong to the host; the reducer returns `history` for storage.

Results contain `status`, `planHash`, `history` (attempt, artifact snapshot and
per-criterion outcomes), and a reason when human attention is needed. Invalid
plan input throws `INVALID_REQUEST` before execution. Operational callback failures
return `needs_human`; consumers should handle that outcome.

## A2D successor and historical compatibility

The historical package `a2done`, binary/MCP ID `a2d`, and `.a2d` state have no
automatic compatibility layer. q-core does not replace their binary, MCP tools,
hooks or saved state. Do not point old clients at a nonexistent `q-core a2d`
command or rename state files.

For a new integration, convert plan-time criteria/verifiers to the descriptors
above, supply an authorized executor plus independent evidence callbacks, and
persist the resulting versioned history. Reapprove scope and regenerate evidence;
old completion claims are not transferable approval. Use `determined` for the new
workflow identity.
The shipped [A2D migration guide](../../docs/a2d-migration.md) gives the supported
replacement steps and fail-closed compatibility checks. It does not grant access
or define an automatic state conversion.
