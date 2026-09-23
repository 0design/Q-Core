# Local trigger host

`q-core-host <manual|schedule|webhook> config.json [manual-event-id]` hosts one
explicitly installed loop. It neither installs a background service nor hosts
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
session: a loop using caller inference pauses until its caller supplies a reply.

Webhook mode binds only `127.0.0.1`, port `QF_HOST_PORT` (default 8789). Requests
must be `POST /trigger`, with `Authorization: Bearer <QF_HOST_WEBHOOK_TOKEN>`
and `X-QFactory-Event-Id`. Token length is 32–512; keep it in the local process
environment, never in a manifest or public Registry. Body is bounded to 1024
bytes and ignored; remote input cannot change loop config or instructions.
Use of tunnels/public exposure is not implemented or accepted by this host.

Host event receipts and a dispatch lock live beside the installed loop under
`.qf/host/`. Repeating a completed event returns its original run ID without new
execution. A claimed event with no completed receipt is uncertain and requires
reconciliation. An earlier run waiting for approval/inference blocks new events;
resume that run using the normal CLI. There is no implicit approval or provider
fallback. Receipts do not guarantee exactly-once external effects after a crash.

Success means an actual recorded Core run; waiting states remain waiting. The
host never turns an unresolved run into success or silently retries uncertain
side effects.
