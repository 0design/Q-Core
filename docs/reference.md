# Q-Core reference

Technical details for people who run Q-Core by hand or build on it. To get
started, see the [README](../README.md).

## Limits

- No npm package, no hosted runner and no account: runs happen on your machine,
  with your model keys or your existing Claude/Codex CLI login.
- Model output is not deterministic. The order of steps, checks, approvals and
  stop conditions is.
- An immutable Registry release does not claim its own acceptance. Acceptance is
  a separate write-once record at `acceptance/<release>.json`.
- Q-Core confines writes against workflow content and ordinary mistakes. It does
  not defend against a concurrent hostile process running as the same OS user:
  filesystem races have the same trust limit as approval forgery or edits to
  unsigned run state. Use an OS sandbox or container for that isolation, and use trusted
  workspaces and verifiers. The hosted runtime will run Q-Core in a container.

## Persistence trust model

The primary protection for provider failures is structural: unrestricted error
bodies, headers, status text, request IDs and thrown diagnostics from Anthropic
and OpenRouter never enter persisted errors or logs. Rejected HTTP bodies are
discarded without reading them. JSON/SSE error envelopes become fixed local
messages and allowlisted codes, validated numeric status and usage fields; the
provider's free text and nested objects are dropped before the persistence
boundary. Successful model content is intended workflow output and may be
saved through that boundary; this rule does not discard successful answers.

The persistence guard is defence in depth, not a guarantee for **any encoding**
of a credential. It checks registered environment/resolver credentials in file
bytes, pathnames and stdout/stderr (which a shell can redirect to logs). Known
literal/JSON/percent spellings can be redacted; other detected encoded secrets
and decoding-budget exhaustion refuse the operation before writing. Detection
decodes only temporary in-memory candidates and never emits decoded data.
Covered representations are:

- Literal text, JSON Unicode and short escapes, and escaped backslashes.
- Percent-encoded UTF-8, hexadecimal bytes, base64 and base64url, including
  prefixed alignments and whitespace-wrapped base64.
- HTML decimal/hexadecimal numeric entities (with or without semicolons) and
  HTML5 named entities, including their legacy semicolonless aliases.
- JSON byte arrays containing only integer byte values from 0 through 255,
  interpreted as UTF-8.
- JavaScript `\xHH`, `\uHHHH` and `\u{…}` escapes.

These transformations can compose within bounded decoding: at most 12 levels
and an 8 MiB UTF-8 record. For an input of n bytes the work budget is 128n +
64 KiB of total distinct candidate bytes and 4n + 1,024 distinct candidates.
Every candidate is inspected; repeated encoded tokens share decoding work.
The fixed depth and proportional work budgets bound total decoding to O(n).
JSON wrapping and independent escapes in ordinary pages consume levels too;
the depth allowance includes those steps rather than only nested tokens.
Excessive record size, pathological nesting or expansion fail closed before
writing, with `PERSISTENCE_SECRET_DECODE_LIMIT` and a fixed explanation of the
limit. A detected unredactable credential retains `PERSISTENCE_SECRET_UNSAFE`.
Append and redirected-stream checks retain the most recent 1,048,576 UTF-16 code
units of text for continuity (or read a 1 MiB suffix of an existing file), shared
across stdout/stderr when they use the same destination. An encoded value split
across more history than that window is outside the
continuation guarantee (for example, byte arrays with extreme whitespace or
entities with extreme leading-zero padding).
Independent file/FIFO/socket stream queues keep one destination owner until all
write callbacks finish. After a write error, a regular file can recover only
after those callbacks settle: a readable descriptor must recheck the physical
bytes since the owner's last verified boundary, including up to 1 MiB of prior
overlap, within the existing 8 MiB whole-record limit. Recovery requires complete,
stable reads and valid UTF-8; the submitted buffers are never treated as proof
of what reached disk. An unreadable, changing or unverifiable file, or a failed
FIFO/socket/other non-regular destination, refuses further output with
`PERSISTENCE_DESTINATION_QUARANTINED`. A regular file may retry verification with
a readable descriptor; a non-regular destination needs a new generation.
Unknown transforms, encryption and arbitrary application-specific encodings
are outside this guard's coverage. The offline release scan uses the same
decoder against known credential shapes in package paths/contents, example
outputs and supplied decompressed archives; it cannot identify every arbitrary
runtime credential. Archive scanning checks every non-NUL byte run with the same
budgets: literal NUL bytes delimit all covered transports and credential shapes,
so unrelated tar headers and payloads do not multiply whole-archive branches.

Runtime pathname mutations go through guarded wrappers in
`src/persistence.mjs`, which check relevant path arguments before creating,
opening, renaming or removing filesystem entries. The bypass lint checks
`src/` and `bin/`, rejecting direct filesystem mutation capabilities (including
write-mode opens, links, copies and metadata changes) outside that module.
Read-only operations do not grant write capability. This is an enforced source
boundary for Q-Core's runtime, not an OS sandbox for hostile same-user processes,
external tools or arbitrary executable workflow code.

## Hosted MCP

`https://qfactory.io/api/mcp` (Streamable HTTP, no key) exposes read-only tools
over the pinned Registry release: `catalog`, `search`, `get`, `schema`,
`validate`, `instructions`. It validates but never runs workflows. This
repository's `main` is the source of the newest Core and can be ahead of the
release that [`current.json`](https://registry.qfactory.io/current.json) names.

## Install a package

Install only an archive whose SHA-256 you verified first. Take the archive URL and its
`artifactSha256` from the `core` field of the exact Registry release catalog you pinned
(for example `https://registry.qfactory.io/releases/<version>/catalog.json`), never from
`latest` or a guessed npm version. The block below is fail-closed: it stops before
`npm install` when the hash is missing, malformed or different, and it works with macOS
`shasum`, Linux `sha256sum` or, when neither exists, Node.js itself.

<!-- verify-install:start -->
```sh
set -eu
ARCHIVE=q-core-VERSION.tgz
EXPECTED=ARTIFACT_SHA256_FROM_CATALOG
case "$EXPECTED" in *[!0-9a-f]*|"") echo "Expected SHA-256 is not 64 lowercase hex characters; not installing" >&2; exit 1;; esac
[ "${#EXPECTED}" -eq 64 ] || { echo "Expected SHA-256 is not 64 lowercase hex characters; not installing" >&2; exit 1; }
if command -v shasum >/dev/null 2>&1; then ACTUAL=$(shasum -a 256 "$ARCHIVE" | cut -d' ' -f1)
elif command -v sha256sum >/dev/null 2>&1; then ACTUAL=$(sha256sum "$ARCHIVE" | cut -d' ' -f1)
else ACTUAL=$(node -e 'process.stdout.write(require("node:crypto").createHash("sha256").update(require("node:fs").readFileSync(process.argv[1])).digest("hex"))' "$ARCHIVE"); fi
[ "$ACTUAL" = "$EXPECTED" ] || { echo "SHA-256 mismatch for $ARCHIVE; not installing" >&2; exit 1; }
npm install --prefix .qfactory/tools "./$ARCHIVE"
if [ -d .qfactory ]; then printf '*\n' > .qfactory/.gitignore; fi   # keep the installed tools out of git
```
<!-- verify-install:end -->

On Windows PowerShell, compare `(Get-FileHash -Algorithm SHA256 .\q-core-VERSION.tgz).Hash.ToLower()`
with the catalog value and run `npm install` only when they are equal.

```sh
./.qfactory/tools/node_modules/.bin/q-core validate ./workflow.yaml
./.qfactory/tools/node_modules/.bin/q-core run ./workflow.yaml
```

Q-Core installs `q-core` and `q-core-host`. No other CLI alias is provided. The package includes
runtime, schema, providers and synthetic contract fixtures. Install reusable workflows
from a versioned registry export.

```sh
./.qfactory/tools/node_modules/.bin/q-core install https://registry.qfactory.io/releases/VERSION CATALOG_SHA256 workflow-id 1.0.0 ./workflow.yaml
./.qfactory/tools/node_modules/.bin/q-core install /absolute/registry-export CATALOG_SHA256 workflow-id 1.0.0 ./workflow.yaml --release VERSION
```

The release version is pinned separately from the catalog hash: the catalog's
`releaseVersion` must equal the `releases/<version>` segment of the Registry base and
`--release` when given (`RELEASE_MISMATCH` otherwise); a remote non-localhost base must
name its release (`RELEASE_REQUIRED`). A truncated or corrupt catalog fails with
`CATALOG_INVALID`. Errors are printed as `CODE: message` with exit code 1.
The catalog must pin this engine version. Installer verifies catalog bytes,
manifest identity, checksums and exact dependencies, and writes `workflow.yaml.lock.json`.
It never overwrites files. HTTPS registries are supported; HTTP is localhost-only.
No implicit mutable remote catalog is used. Remote catalog discovery through environment variables requires both
`QCORE_CATALOG_URL` and `QCORE_CATALOG_SHA256`. `QFACTORY_REGISTRY` is an explicitly
trusted local development overlay, not a verified release install.

## Agent -> Core -> CLI -> result

```sh
./.qfactory/tools/node_modules/.bin/q-core agent request.json
# or pipe bounded JSON on stdin
./.qfactory/tools/node_modules/.bin/q-core agent - < request.json
```

See `contracts/v1/fixtures.json` for a complete request and
`contracts/v1/request.schema.json` for the structural schema. `validateRequest`
adds path and authorization checks. Substitute real absolute workspace, Node and
CLI paths. `sdd-pipeline@1.0.0` runs the built-in SDD capability;
`synthetic-sdd@1.0.0` is its test alias. A consumer must pin the manifest it runs.

The first call returns `needs_human` with `nextAction` `ask_human_to_approve`
(`humanOnly: true`), the spec, the approval hash and an exact `command`. Review the
specification, verifier, exact file scope and context. Only a person decides: they
run, in their own terminal, `q-core agent approve <workspace> <runId> --approval-hash
<hash>` (`--reject` to cancel), which asks for a one-time code on the terminal like
`q-core approve`. Then resume the same request with `resumeRunId` and **without**
`approval`; a request that carries `approval` is refused (`HUMAN_APPROVAL_REQUIRED`).
Changed scope/intent/provider/verifier invalidates the recorded decision. Core is not
an identity service. There is no implicit approval or “resume last chat”.

Claude Code CLI 2.1.156 is the reviewed version. Existing authentication is used;
no credential copying, nesting guard removal or permissions bypass. Claude inference
has no tools, hooks are disabled, MCP is explicitly empty, and no session is
persisted. It proposes text. Core applies only exact approved files, then runs a
caller-authorized executable/argument array as verifier. Tests/verifier files are
not writable. This is not an OS sandbox: use trusted workspaces and verifiers.

One JSON result is emitted on stdout. `success=0`, `failed=1`, `needs_human=2`,
`cancelled=130`, invalid request `64`. State lives in `.qf/agent-<UUID>.json`.
An exclusive workspace lock blocks overlapping runs. Interrupted writes require
reconciliation. Completed resume checks artifact hashes before returning cached
success. A failed verifier triggers only the configured bounded repairs.

Provider identity and usage are recorded; unknown values are null. Orchestration
is deterministic, model output is not. Deadline/output/token/repair bounds are
explicit. Optional `maxCostUsd` requires a caller-supplied conservative
`maxCallCostUsd`: it gates subsequent calls and stops on unknown/exceeded usage.
It is not a billing guarantee; provider estimates can differ from invoices.

## Use your existing Codex login

Codex CLI **0.153.4** and **0.154.0-alpha.6.2** are reviewed via a new
standalone `codex exec` session.
Set this provider in an agent or content request (choose your real absolute CLI path):

```json
{
  "kind": "codex",
  "executable": "/Applications/ChatGPT.app/Contents/Resources/codex",
  "model": "gpt-5.6-luna",
  "payerScope": "local-cli"
}
```

This is the path inside the ChatGPT desktop app on macOS. A standalone installation of the exact
reviewed CLI works too; q-core does not install or replace it. Run that executable's
`login status` first. ChatGPT authentication is required; saved API-key auth is
rejected, API-key environment variables are not forwarded, and API/provider/model
fallback is disabled. An older CLI version is rejected with `UNSUPPORTED_CLI`.

Codex uses an isolated temporary working directory, read-only sandbox, no approval
escalation, ignored user config, disabled hooks/plugins/apps/shell/browser tools,
and bounded stdin/JSONL/output/deadline. Only text results are accepted. The CLI
may still advertise built-in utility/apply-patch tools; attempted tool events fail
closed and the read-only sandbox prevents file changes. Core applies approved
file contents and runs the independent verifier. Existing policy/nesting guards
remain active; the parent's conversation is not inherited or resumed.

This uses your Codex/ChatGPT allowance, **not unlimited or zero-cost inference**.
Cost is `null`, with `costKind: subscription-usage`; token usage is recorded when
available. The CLI does not report resolved model identity, so `requestedModel`
is explicit while `model` remains `null`. Dollar-capped runs stop after unknown
cost; use deadlines and repair limits for subscription workflows.

A scheduler can launch q-core; for a simple recurring prompt, a built-in scheduled
task may already be enough. See [Codex integration details](codex.md).

## Reusable providers

```js
import { openRouter } from 'q-core';
const result = await openRouter({
  messages: [{ role: 'user', content: 'Summarize this synthetic input.' }],
  model: 'YOUR_EXPLICIT_MODEL', keyRef: 'OPENROUTER_API_KEY',
  payerScope: 'local-byok', maxTokens: 256, timeoutMs: 30000, retries: 2,
});
```

Set the named key in the environment; never put values in manifests. Results
include content, actual model, request ID and nullable usage/cost. Errors are
typed, provider/model fallback is never implicit. `site-funded` only labels who pays;
it does not enforce a quota. The caller must reserve funds before calling.
`chatOnce` remains a compatible wrapper over this adapter; `llm-call` is supported.
Estimated tokens and cost are not the same as provider-billed usage.
`maxCallCostUsd` is an optional per-call cap: the worst case of every attempt at the
model's listed price must fit, and an unlisted model is refused (`COST_UNKNOWN`).
In a workflow, a model step records the provider's reported cost, else the listed
price of the model that answered, else `null`; the run budget treats `null` as
unknown, not zero (see SPEC-MANIFEST.md §4.2 and §5.2).

### Native Anthropic

Use `provider: anthropic` on an `llm-call` step to spend the owner's Anthropic API
credit directly. No OpenRouter account, BYOK forwarding or external fetch shim is
involved. The reusable adapter is also exported:

```js
import { anthropic } from 'q-core';
const result = await anthropic({
  messages: [{ role: 'user', content: 'Summarize this synthetic input.' }],
  model: 'claude-sonnet-5', keyRef: 'ANTHROPIC_API_KEY',
  payerScope: 'local-byok', maxTokens: 256, timeoutMs: 30000, retries: 2,
});
```

Workflow model precedence is `config.model` → `settings.model` →
`ANTHROPIC_MODEL`; there is no default model or provider fallback. Workflow calls
use the existing `local-byok` payer scope.

`keyRef` defaults to `ANTHROPIC_API_KEY`; `secretSource: env | keychain` uses the
same secret resolver as OpenRouter. Only the alias belongs in a manifest. The
key is sent as `x-api-key`, never persisted in run state or included in errors.
A missing environment key fails with `AUTH_REQUIRED`; keychain failures retain
their typed secret-store errors. Requests go to
`https://api.anthropic.com/v1/messages`, with `anthropic-version: 2023-06-01`.
Optional `workspaceId` (or `ANTHROPIC_WORKSPACE_ID`) sets
`anthropic-workspace-id`. The adapter requires an explicit `payerScope` of
`local-byok` or `site-funded`; the label does not establish a separate quota.

Supported models and first-party prices in USD per million tokens:

| Anthropic model | Accepted OpenRouter alias | Input | Output |
|---|---|---:|---:|
| `claude-sonnet-5` | `anthropic/claude-sonnet-5` | 2.00 | 10.00 |
| `claude-haiku-5-5` | `anthropic/claude-haiku-5.5` | 0.10 | 0.50 |
| `claude-opus-5-5` | `anthropic/claude-opus-5.5` | 4.00 | 20.00 |
| `claude-haiku-4-5` | `anthropic/claude-haiku-4.5` | 1.00 | 5.00 |

For Haiku 5.5, input above 100,000 tokens changes both rates to 0.50 input and
2.50 output. These are the pinned direct-provider rates, separate from
OpenRouter's table. The documented response snapshot
`claude-haiku-4-5-20251001` maps explicitly to Haiku 4.5 pricing; unknown snapshot
IDs remain unpriced. Explicit snapshot requests retain their pinned model ID.
Total input (ordinary, cache-read and cache-creation tokens) selects the context
tier. Ordinary input costs the base rate, cache reads 0.1 times that rate,
five-minute writes 1.25 times and one-hour writes 2 times. Cache writes with
missing or inconsistent duration counts remain unpriced.

`maxTokens` becomes Messages API `max_tokens`. `reasoning: low | medium | high`
maps to `output_config.effort`. With reasoning omitted or `off`, Sonnet 5 and
Haiku 5.5 disable thinking; Opus 5.5 uses `low` effort because its thinking cannot
be disabled. Legacy Haiku 4.5 runs without thinking or an effort parameter. Only
legacy Haiku accepts `temperature`; sampling is omitted for the other models.

The adapter requests streaming and reads the complete answer within each
attempt's timeout. Only proven connection-establishment/DNS failures and rejected
429/5xx responses before body consumption may retry. Dropped/incomplete accepted
streams, body timeouts and ambiguous transport failures stop immediately with
unknown billing; ordinary 4xx fail immediately.
`stop_reason: max_tokens` fails as `OUTPUT_LIMIT`, preserving billed usage.
Usage-based cost enters the existing step/run budget accounting; per-call
`maxCallCostUsd` checks the worst case of all permitted attempts before sending.
Every native workflow call also reserves that bound against the remaining root
and all ancestor budgets, even without a per-call cap. The bound uses the highest
cache-write rate and applicable context tier. Sequential calls release the
reservation to actual spend after completion. Unreadable accepted usage may have
been billed: its cost remains unknown and the request is never replayed.

### HTTP retry policy

HTTP transport retries network/timeout/429/5xx failures with bounded backoff;
ordinary 4xx fail fast. Caller cancellation stops request/backoff without retry.
OpenRouter response body parsing errors are not retried. Anthropic reads and
validates its stream within the attempt deadline, with the narrower safe-retry
policy described above. Internal policy allows 0–10 retries,
positive timeouts and nonnegative delays; invalid policy fails before requests.
Retries of outgoing requests can duplicate writes: use receipt-aware content APIs
for publication. Retry is never exactly-once delivery.

## Content and quality capabilities

For Content, start with the shipped [exact request/approval/receiver contract](../contracts/v1/content.md)
(a person approves the exact draft with `q-core content approve`)
and [synthetic request example](../examples/content-request.json). They describe local
configuration, exact-text approval, repeat/dedup and uncertain-delivery recovery
without requiring a source checkout. The SDD request schema is not a Content schema.

`q-core content request.json` uses `qf.content-request/v1`: explicit sources,
allowedOrigins, profile, provider, receipt-aware webhook receiver and deadline.
`runContent` exports the same orchestration with caller-injected capabilities.
Source identity dedup, source-attribution checks, exact draft/receiver approval,
durable receipt and ambiguous-send reconciliation are implemented. Receiver JSON
must be `{ "id": "unique-receipt", "delivered": true }`. A file sink is not a
Telegram receipt. Configure and approve the receiver for each delivery.

`determined` exports a plan-bound execute → verify → repair reducer (see
[its contract](../contracts/v1/determined.md)). `qualityCheck`
exports aindf-check (ds-readiness/UI composition) and unslop with hard/soft split,
versioned findings, explicit coverage and optional recipe transport. `loadAindf`
and `loadUnslop` load checksum-pinned upstream installations. Missing DS, stale
evidence, unknown rules and missing browser evidence cannot pass.

## Human gates: only a person approves

A workflow with a `reviewer: human` gate (for example `sdd-pipeline` and `digest`)
stops as `waiting_human` and prints the command for a person. The person runs it in
their own terminal; Q-Core shows the subject and a one-time code on that terminal and
continues only when the code is typed back:

```sh
./.qfactory/tools/node_modules/.bin/q-core approve /abs/workflow.yaml RUN_ID --approval-hash HASH
```

An agent never runs this command. Without a terminal, inside an agent session
(`CLAUDECODE`, `AI_AGENT`, `CODEX_SANDBOX`, ...) or with piped input it refuses with
`HUMAN_CONFIRMATION_REQUIRED`, exits 2 and the run keeps waiting. Agents read
`nextAction` (`ask_human_to_approve`, `humanOnly: true`) from the JSON result of
`q-core run`, `reply`, `clarify` or `resume` that parked the run, show
the subject, ask the user to run the command and wait. Details and limits:
SPEC-MANIFEST.md, `reviewer: human`.

Approval is a component a workflow author places where a human decision is needed.
`workspace-apply` runs autonomously only when no preceding approval gate governs
it on its execution path, including across parent and nested workflows. Every
write requires the explicit local `--workspace-policy <json>`: allowed paths,
workspace snapshots and verifier hashes still bound the write. A genuinely
ungated source-only apply pins them at apply time; an optional `specification`
reference uses the earlier planned snapshot instead. Q-Core validates that
specification's structure and recomputes its canonical SHA-256 from the recorded
workflow/workspace identity, specification content, policy hash and revision;
changing the content while retaining its claimed hash refuses the write.

A governed apply must declare `approval` bound to the governing gate's approved
subject, and the gate must use `bind: sha256`. The validator checks this rule
through control paths and nested workflows; runtime checks the actual approved
subject and its hash again before writing. A later gate in the same workflow
can approve a new subject; a nested gate cannot discard the approval binding
inherited from its parent workflow. Omitting `approval`, substituting a
different specification or passing an invalid/unresolved approval never selects
autonomous execution. An already-approved legacy run without a separately
recorded subject-hash anchor fails closed; restart it for a fresh approval.
A legacy run still waiting at its gate can record that anchor when a person
approves its current subject. No policy, an out-of-policy path, changed pinned files,
symlinks or a changed verifier refuses the write. Human gates retain their pause
and terminal-only decision; an agent cannot approve them.

Created workflows still need a human gate before sending data (any `api-request`
except a plain `GET` to a literal http(s) URL); `q-core validate` and `q-core run`
refuse those sends otherwise (`GATE_REQUIRED`). A `workspace-read` that no later
step uses is refused too (`UNUSED_WORKSPACE_READ`). Reviewed Registry workflows
installed unchanged with `q-core install` keep their published shape. A rejected,
dismissed or unanswered question is not approval, and an agent never replaces a
Q-Core step with its own script.

## YAML workflow commands

`q-core validate`, `run [--dry-run]`, `status`, `approve [--reject]`, `catalog`,
`init` and `doctor` remain available for `q-core.workflow/v1`. Step kinds and fields are in
[SPEC-MANIFEST.md](../SPEC-MANIFEST.md). The JSON agent protocol above is a separate interface.
`run` performs one pass; scheduling belongs to the caller/launchd. State is local
in `.qf/`; no server/database is required. The step kind `agent-call` and the
agent-gate mode `check` are reserved and not implemented.

Also supported, not yet described in SPEC-MANIFEST.md:

- Before the first step a run names every required environment variable that is
  unset or empty (`Missing environment variables: …`); an `api-request` without
  `receiptKey` stays optional and falls back to `.qf/out/`.
- An `api-request` URL may be `file:///absolute/path.jsonl`: each delivery appends
  one JSON line, with the same `receiptKey` duplicate protection as HTTP. The
  folder must exist; a symlinked file is refused. The destination is checked
  before the first step.

## Verify

```sh
npm test
npm run test:package
```

Tests cover real localhost HTTP, subprocess fixtures, installed callers, negative
paths, approval and resume. Package verification is limited to these local checks.
The public-surface check also scans every tracked source file for private workspace
references, including files excluded from the npm package. `docs/delivery/` is
generated local receipt storage and has a separate invariant: only its `.gitkeep`
may be tracked.


### determined consumer

The installed package exports the execute → verify → repair reducer. See
[its callback contract](../contracts/v1/determined.md). Run the
synthetic file-and-test example with `node examples/determined-caller.mjs` from
the source checkout, or copy that shipped example into your installed caller.
It demonstrates real failing/passing subprocess checks with a scripted executor.

Explicit current-agent inference for SDD and Content: [caller protocol](../contracts/v1/caller-inference.md). No automatic provider fallback; Core retains approval, execution and independent verification.

Local manual, UTC schedule, and authenticated loopback webhook triggers use `q-core-host`; see [host contract](../contracts/v1/host.md). The host does not install a daemon or supply model inference.

`runSkill` enforces the explicit criteria of a pinned authored skill bundle with independent Node verifiers and version-bound human review. See [skill contract](../contracts/v1/skill.md) and `examples/skill-caller.mjs`; arbitrary prose is not automatically machine-verifiable.
