# Changelog

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
