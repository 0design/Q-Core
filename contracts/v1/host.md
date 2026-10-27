# Local trigger host

`q-core-host <manual|schedule|webhook> config.json [manual-event-id]` hosts one
explicitly installed workflow. It neither installs a background service nor hosts
work on behalf of another account. The process and machine must remain awake.
Stopping it stops future triggers; currently running work is not rolled back.
Missed schedule minutes are not replayed on restart.

Configuration: `manifest` (absolute installed YAML path), `manifestSha256`
(SHA256 of its exact bytes), optional `callerProvider` and `workspacePolicy`
with the same contracts as `q-core run`. Changes require an explicit new pin.
The manifest must declare the requested trigger kind and be enabled.

Manual mode requires a unique bounded event ID. Schedule mode polls UTC cron
once per second and dispatches at most once per matching UTC minute. It supports
five fields, lists, ascending ranges and positive steps; restricted day-of-month
and weekday use conventional OR semantics. `schedule` does not create a model
session: a workflow using caller inference pauses until its caller supplies a reply.

Webhook mode binds only `127.0.0.1`, port `QF_HOST_PORT` (default 8789). Requests
must be `POST /trigger`, with `Authorization: Bearer <QF_HOST_WEBHOOK_TOKEN>`
and `X-QFactory-Event-Id`. Token length is 32–512; keep it in the local process
environment, never in a manifest or public Registry. Body is bounded to 1024
bytes and ignored; remote input cannot change workflow config or instructions.
Use of tunnels/public exposure is not implemented or accepted by this host.

Host event receipts and a dispatch lock live beside the installed workflow under
`.qf/host/`. Repeating a completed event returns its original run ID without new
execution. A claimed event with no completed receipt is uncertain and requires
reconciliation. An earlier run waiting for approval/inference blocks new events;
resume that run using the normal CLI. There is no implicit approval or provider
fallback. Receipts do not guarantee exactly-once external effects after a crash.

Success means an actual recorded Core run; waiting states remain waiting. The
host never turns an unresolved run into success or silently retries uncertain
side effects.

## Prepared object inputs (unreleased candidate)

The embedding API `createLocalHost(config).dispatch(kind, eventId, inputs)` accepts
declared typed JSON inputs. Inputs are copied before waiting for the lease, bounded
to one MiB/depth20/50,000 values, and validated against manifest ports. Getters,
functions, sparse arrays, non-finite numbers and non-JSON objects refuse. The
input hash is stored in the event receipt; the same event with different inputs
refuses. Legacy receipts without a hash can repeat only an input-free manifest.
The HTTP webhook body remains ignored, and the CLI is unchanged.

A human sha256 gate can declare `source: "{{inputs.subject}}"` where `subject` is
a required object port. It binds that entire object directly, including template
strings as literal data, without a fetch or model echo. Missing/wrong types refuse;
changed inputs invalidate the waiting decision. The normal person-only decision
and native signed-consumption rules remain in force. No input is itself a decision.
Only the existing default previous-content behavior applies when source is absent.
