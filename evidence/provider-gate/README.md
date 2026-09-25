# Provider gate evidence · OpenRouter and Claude CLI

Evidence for the pinned pair **Core29 / Registry15**: `q-core-0.2.0-q-core.29.tgz`,
SHA-256 `246bb675e7c60795dfe02cc349185b015403d5053b23d982ffd509324b5d1fba`, equal to
the `vendor/` pin in `registry/SHA256SUMS`; `src/` of this branch base is byte-identical
to the installed Core29 package. Not part of the npm package or the Registry release.

Outputs were produced under earlier, workspace-internal gate labels; those label strings
(gate name, workflow id/name, directory names) were normalized after the run to keep
the public repository free of private workspace references. Numbers, timestamps,
hashes and outcomes are unchanged.

No credential value is printed, logged, passed as an argument or placed in a global
environment. Scripts that touch the stored key go through Q-Core's own
`secretSource: "keychain"` resolution; every evidence write is refused if it contains a
key-shaped value, the resolved value itself or a local home path.

## OpenRouter (`openrouter/`)

| Step | Script | Output | Paid |
| --- | --- | --- | --- |
| Prerequisites + budget ledger | `01-preflight.mjs` | `out/01-preflight.json` | no |
| Failure matrix, 28 rows | `02-failure-matrix.mjs` | `out/02-failure-matrix.json` | no |
| Workflow ceiling (`budgetUsd: 0`) via `q-core run` | `budget-cap.yaml` | `out/02b-budget-cap-run.json` | no |
| One bounded live call | `03-live-call.mjs` | `out/03-live-call.json` | **1 call** |
| Provider-side reconciliation | `04-reconcile.mjs` | `out/04-reconcile.json` | no |

Run: `QCORE_PKG=<installed q-core dir> node <script>` (01 also needs `QCORE_TARBALL`
and `REGISTRY_SUMS`). `03` is one-shot: a sentinel is written before the request and
the script refuses to run again.

### Model choice

`mistralai/mistral-nemo` — the cheapest paid, non-reasoning, text model in the public
OpenRouter catalogue at check time (lowest endpoint $0.018 / $0.03 per 1M tokens; most
expensive live endpoint $0.15 / $0.17). Non-reasoning matters: a reasoning model can
spend a 16-token cap on hidden reasoning and return `finish_reason: length`. Free
(`:free`) variants were not used because they do not exercise cost accounting.

### Bounds

`maxTokens: 16`, `temperature: 0`, `retries: 0` (one billable attempt), `timeoutMs: 30000`,
106-byte prompt. Worst case at the most expensive endpoint: $0.0000282 per call.
Per-call cap $0.01; target ceiling $0.50; authorization $5. The key itself reports a
provider-side `limit` of $5.

### Result

Success at 2026-09-25T20:37:25Z; actual model `mistralai/mistral-nemo` (routed to
Io Net); 13 prompt / 2 completion tokens; cost **$0.00000082** (response `usage.cost`
and `/generation` agree); key usage 0 → 0.00000082; output `ok`,
SHA-256 `2689367b205c16ce32ed4200942b8b8b1e262dfc70d9bc9fbc77c49699a4f1df`.

### Findings (not fixed here)

1. `registry/components/llm-call-openrouter.json` documents only `needsEnv: OPENROUTER_API_KEY`;
   it has no `keyRef` / `secretSource` inputs, so the keychain path is not in the public
   component contract. `acceptance.status` is still `pending`.
2. The manifest `llm-call` path (`runLlmCall` → `chatOnce`) cannot set `retries` or
   `timeoutMs`: it uses the adapter default `retries: 2` (up to 3 attempts on 429/5xx/network),
   and it drops `usage.costUsd`; run cost comes from `cost.mjs` (default-model rates quirk,
   unknown models priced at the $3/$15 fallback). The live call therefore used the public
   `openRouter()` adapter with `retries: 0`.
3. The adapter has no money cap of its own; spend is bounded by `maxTokens`, the
   preflight ledger, the workflow `budgetUsd` knob and the provider-side key limit.

## Claude CLI-agent provider (`claude-cli/`)

| Step | Script | Output | Real CLI launched |
| --- | --- | --- | --- |
| Failure matrix, 15 rows | `01-claude-matrix.mjs` | `out/01-claude-matrix.json` | no (fake executables) |
| One bounded live smoke | `02-claude-live-smoke.mjs` | `out/02-claude-live-smoke.json` | yes — **not run yet** |

The installed CLI reports `2.1.156 (Claude Code)`, the only reviewed version in Core29.
The live smoke was **not** executed: this evidence was produced inside an active Claude
Code session, and Core29's nesting guard (`CLAUDECODE` set → `UNSUPPORTED_NESTING`)
refuses the launch by design. The guard is not bypassed. The smoke must be started from
an ordinary terminal or by a non-Claude agent:

```sh
QCORE_PKG=<installed q-core dir> CLAUDE_BIN="$(command -v claude)" node evidence/provider-gate/claude-cli/02-claude-live-smoke.mjs
```

The matrix script runs its fake-executable rows in a child without `CLAUDECODE`; it
refuses to target the real CLI, and the nesting-guard row sets the marker explicitly.
