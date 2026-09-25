# Provider gate evidence · OpenRouter and Claude CLI

Evidence for the **unreleased candidate pair Core29 / Registry15**:
`q-core-0.2.0-q-core.29.tgz`, SHA-256
`246bb675e7c60795dfe02cc349185b015403d5053b23d982ffd509324b5d1fba`, equal to the
`vendor/` pin in `registry/SHA256SUMS` and to the install lockfile integrity; the `src/`
tree of this branch base is identical to the installed package (`openrouter/out/00-pair-check.json`).
Release gates outside this evidence remain open; provider readiness is not publishing
or user acceptance. Nothing here is part of the npm package or the Registry release.

No credential value is printed, logged, passed as an argument or placed in a global
environment. Scripts that touch the stored key go through Q-Core's own
`secretSource: "keychain"` resolution; every OpenRouter evidence write is refused if it
contains a key-shaped value, the resolved value itself or a local home path.

## OpenRouter (`openrouter/`)

| Step | Script | Output | Paid |
| --- | --- | --- | --- |
| Pair identity | `00-pair-check.mjs` | `out/00-pair-check.json` | no |
| Prerequisites + budget ledger | `01-preflight.mjs` | `out/01-preflight.json` | no |
| Failure matrix, 28 rows | `02-failure-matrix.mjs` | `out/02-failure-matrix.json` | no |
| Workflow ceiling via `q-core run` | `02b-budget-cap.mjs` + `budget-cap.yaml` | `out/02b-budget-cap-run.json` | no |
| One bounded live call | `03-live-call.mjs` | `out/03-live-call.json` | **1 call** |
| Provider-side reconciliation | `04-reconcile.mjs` | `out/04-reconcile.json` | no |

Run: `QCORE_PKG=<installed q-core dir> node <script>` (00/01 also need `QCORE_TARBALL`,
00 `QCORE_LOCK`, 01 `REGISTRY_SUMS`). `03` is one-shot: a sentinel is written before the
request and the script refuses to run again in this checkout; independently, the key's
own usage moved by exactly one call's cost.

Matrix row kinds: `stub` injects the transport; `real-precheck` is rejected before any
network; `real-network` reaches OpenRouter with a bogus credential (401);
`real-network-stored-key` is the invalid-model row (400, not billed — key usage stayed 0);
`real-client-deadline` is a 1 ms client deadline that aborts before a server-side timeout
could occur; `real-keychain` resolves an absent Keychain entry.

`02b` only proves the pre-step ceiling: `run.mjs` compares spend accumulated before a
paid step, so the step (secret resolution and request) never starts. It cannot stop one
call from exceeding the ceiling; that bound is `maxTokens` plus the preflight ledger.

`01`, `03` and `04` were produced once under workspace-internal gate labels; only label
strings were substituted afterwards. `out/normalization.json` records original and
committed SHA-256 for each; the reverse substitution reproduces the originals byte-for-byte.

### Model choice

`mistralai/mistral-nemo` — the cheapest paid, non-reasoning, text model in the public
OpenRouter catalogue at check time (cheapest endpoint $0.018 input / $0.03 output per
1M tokens). Non-reasoning matters: a reasoning model can spend a 16-token cap on hidden
reasoning and return `finish_reason: length`. Free (`:free`) variants were not used
because they do not exercise cost accounting.

### Bounds

`maxTokens: 16`, `temperature: 0`, `retries: 0` (one billable attempt), `timeoutMs: 30000`,
106-byte prompt. Worst case $0.0000282 per call, computed conservatively from the highest
input price (Mistral, $0.15/1M) and the highest output price (Novita, $0.17/1M, then
degraded) across endpoints, counting every input byte plus 64 bytes as a token.
Per-call cap $0.01; target ceiling $0.50; authorization $5. The key reports a
provider-side `limit` of $5.

### Result

Success at 2026-09-25T20:37:25Z; actual model `mistralai/mistral-nemo` (routed to Io Net);
13 prompt / 2 completion tokens; response `usage.cost` **$0.00000082064**; output `ok`,
SHA-256 `2689367b205c16ce32ed4200942b8b8b1e262dfc70d9bc9fbc77c49699a4f1df`.
`03` shows `/generation` 404 and key-usage delta 0 because provider accounting lagged;
`04` (about 90 s later) shows `/generation` total_cost $0.00000082, key usage 0 → 0.00000082,
remaining limit $4.99999918.

### Findings (not fixed here)

1. `registry/components/llm-call-openrouter.json` documents only `needsEnv: OPENROUTER_API_KEY`;
   it has no `keyRef` / `secretSource` inputs, so the keychain path is not in the public
   component contract. `acceptance.status` is still `pending`.
2. The manifest `llm-call` path (`runLlmCall` → `chatOnce`) cannot set `retries` or
   `timeoutMs`: it uses the adapter default `retries: 2` (up to 3 attempts on 429/5xx/network),
   and it drops `usage.costUsd`; run cost comes from `cost.mjs` (default-model rates quirk,
   unknown models priced at the $3/$15 fallback). This evidence therefore covers the public
   `openRouter()` adapter with `retries: 0`, not the manifest product path.
3. The adapter has no money cap of its own; spend is bounded by `maxTokens`, the
   preflight ledger, the workflow `budgetUsd` knob (pre-step only) and the provider-side key limit.

## Claude CLI-agent provider (`claude-cli/`)

| Step | Script | Output | Real CLI launched |
| --- | --- | --- | --- |
| Failure matrix, 16 rows | `01-claude-matrix.mjs` | `out/01-claude-matrix.json` | no (fake executables only) |
| One bounded live smoke | `02-claude-live-smoke.mjs` | `out/02-claude-live-smoke.json` | yes — **not run yet** |

The installed CLI reports `2.1.156 (Claude Code)`, the only reviewed version in Core29.
The live smoke was **not** executed: this evidence was produced inside an active Claude
Code session, and Core29's nesting guard (`CLAUDECODE` set or `QCORE_DEPTH > 0` →
`UNSUPPORTED_NESTING`) refuses the launch by design. The guard is not bypassed. Caller
mode (`provider.kind: "caller"`) is not a substitute: it launches no process and does not
exercise the `claude()` adapter. The smoke must be started from an ordinary terminal or
by a non-Claude agent:

```sh
QCORE_PKG=<installed q-core dir> CLAUDE_BIN="$(command -v claude)" node evidence/provider-gate/claude-cli/02-claude-live-smoke.mjs
```

The matrix script must itself be started with `CLAUDECODE` unset (`env -u CLAUDECODE`)
and refuses otherwise; it launches only generated fake executables. Its nesting-guard
rows set `CLAUDECODE` / `QCORE_DEPTH` explicitly and prove, with a launch marker, that no
executable was started.
