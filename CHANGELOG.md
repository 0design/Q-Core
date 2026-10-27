# Changelog

## 0.2.0-q-core.52 candidate — 2026-10-27

- Add terminal-enrolled remote human request/receipt verification and durable
  single-run gate consumption; agent-origin approval remains refused.
- Continue through a shared workflow lease, current signed decision and durable
  checkpoints. Recheck authority after awaited preflight; ordinary continuations
  refuse native-owned runs. Post-gate caller replies validate output before saving.
- Hold interrupted nonstructural steps for reconciliation. Provider transport,
  stale-process lease recovery and platform publication remain integration work.
- Pin a separate Registry candidate to the exact Core archive; no public pointer
  promotion or installed-runtime upgrade is performed by this source change.

## Unreleased

- A human `approval-gate` directly after agent gates now shows and binds the
  content those gates judged (the step output that goes on to delivery), not the
  agent verdict. The verdicts are listed beside the subject (`reviews`) and are
  not part of its SHA-256. `subject: previous` keeps the earlier behaviour for
  existing descriptions; runs already waiting keep their recorded subject.
- An escalated agent gate shows the candidate it judged as its `subject`
  (bound under `bind: sha256`).
- An agent gate's answer budget is its `maxTokens` (1 to 32000, default 1024)
  instead of a fixed 300. An answer cut off at that budget is no verdict: like
  an unreadable verdict it follows `escalateOn` (to a person by default) and
  keeps its billed usage, instead of failing the run. It still fails over the
  call's `maxCallCostUsd`.
- An agent gate whose call takes the run (or an enclosing child workflow) over
  its `budgetUsd`, or leaves its spend unknown under one, stops the run by
  budget instead of handing the escalation to a person.
- The output a step goes on from (a delivery without `body`, an agent gate's
  candidate, a human gate's subject) is the last one in execution order. With
  integer-like step IDs such as `"0"` it used to follow the order of the IDs, so
  a delivery could send an output other than the one a person approved.

## 0.2.0-q-core.51 — 2026-10-23

- YAML `llm-call` steps can use `provider: anthropic` to call the Messages API
  directly with environment or Keychain credentials and an optional workspace ID.
- First-party model prices, reasoning controls and usage feed the existing call
  caps and run budgets. Streaming reads share the per-attempt timeout and retry
  policy; truncated answers retain their billed usage and fail with `OUTPUT_LIMIT`.
- OpenRouter remains the default provider. No external fetch shim is required.

## 0.2.0-q-core.50 — 2026-10-22

- `workspace-apply` can run autonomously without a preceding human approval gate.
  Writes still require the explicit workspace policy and remain bounded by its
  allowed paths and pinned workspace/verifier hashes.
- An explicit `approval-gate` retains SHA-256 subject binding and human-only
  terminal confirmation with a one-time code; agents cannot approve it. The
  existing approval policy for data-sending `api-request` steps is unchanged.
- Validation diagnostics and reference documentation distinguish optional
  workspace approval from mandatory workspace write policy.
