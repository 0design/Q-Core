# Changelog

## 0.2.0-q-core.56 — 2026-11-25

Registry 2026.11.25-registry.44-candidate. Core.55 and Registry 43 were pushed for
review with other bytes and are skipped, as are Digest 0.9.0 (used by unmerged
candidates for other bytes) and 0.8.2 (the Core.55 review candidate).

- An operator input array can feed a fan-out of fetches: with `urlInput: <input>`
  a `fetch` takes `url: "{{item}}"` only when the item is the exact entry of the
  root invocation's bound input array at that index, an absolute HTTP(S) address
  without user info (`user:pass@`), whitespace or template syntax. Step or model
  data cannot choose another address, and a child workflow cannot use this opt-in.
- Input arrays may declare `minItems`, `maxItems` and `format: http-url` for their
  items; defaults and bound inputs are checked before anything runs. An array with
  `envPrefix: QF_DIGEST_FEED_` lets each non-empty `QF_DIGEST_FEED_1`, `_2`, …
  replace the matching default entry; an explicit input wins, and overrides never
  add entries.
- A value read through `envPrefix` is saved in the run's inputs and is protected
  like a referenced `{{env.NAME}}`: `[REDACTED]` unless declared `secret: false`,
  and still redacted when it is an address carrying credentials.
- `parse-web` with `items: feed` and `fetchStep: <id>` collects every successful
  fetch of that step in the current invocation, in execution order, including all
  fan-out lanes.
- Digest and Digest CLI 0.8.3 read their ten default feeds from one `sources`
  input array instead of ten separate fetch steps. `QF_DIGEST_FEED_1..10` still
  replace the defaults; parsing, grouping, drafting, fact-check, review, checks,
  approval and delivery are unchanged.
- Digest and Digest CLI declare their date, window, topic and feed addresses
  `secret: false` and the receiver address `secret: true`. With 0.8.1 on Core.54
  the date in the digest header was saved as `[REDACTED]`, so the saved approval
  subject no longer matched and `q-core approve` (which reloads the saved run)
  refused every Digest run as stale.

## 0.2.0-q-core.54 — 2026-11-21

Core.52 and Core.53 were used by earlier unmerged candidates; this release skips
them so no version names two different archives.

- A workflow manifest can say under `env:` which environment values are secret
  (`secret: true` / `secret: false`). A value declared `secret: false`, such as the
  feed or page a post cites, stays visible in saved run state, approval subjects,
  receipts and the sent output. A value that is undeclared or `secret: true` is
  still saved as `[REDACTED]`, and a value with a credential shape or an address
  carrying credentials stays redacted even when declared public. A name that reads
  like a credential cannot be declared `secret: false`; the manifest is refused.
- Content Feed and Telegram Content declare their source address public, so the
  link in the saved and sent digest or post is no longer `[REDACTED]`. Their bot
  token, the webhook address of nine other Registry workflows and the OpenRouter
  key of Podcast Summary are declared `secret: true`.
- A human approval through `q-core approve`, `q-core agent approve` or
  `q-core content approve` counts only when the terminal confirmation issued the
  record after the one-time code was typed back, and only once. A record written by
  hand, copied or replayed is refused and the run keeps waiting.

Earlier changes released with this version:

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
