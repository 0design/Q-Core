# SPEC-MANIFEST — `q-core.workflow/v1`

The file format a workflow is written in, and exactly what the runner does with each
field.

**One rule governs this document: nothing is described here that the engine does
not do.** Anything reserved for later is marked `RESERVED` and is *refused* at
validation rather than accepted and ignored — a manifest that claims a behaviour
which will not happen is worse than one that fails to load.

---

## 1. Syntax

Manifests are YAML, read by a documented **subset** (`src/yaml.mjs`). The subset
exists so the runner has zero dependencies and works on a machine with nothing
installed.

Supported: block mappings and sequences; `plain`, `'single'` and `"double"`
scalars; block scalars `|` and `>` with `-`/`+` chomping; flow collections
`[a, b]` and `{a: 1}`, nested; comments; one leading `---`.

Types: `true`/`false`, `null`/`~`, integers, floats. **Anything quoted is always a
string** — `maxItems: "3"` and `maxItems: 3` both reach the engine as `"3"`.

Refused, with the line number: anchors `&a`, aliases `*a`, tags `!!str`, more
than one document per file, tab indentation, duplicate keys.

---

## 2. Top level

```yaml
manifest: q-core.workflow/v1      # REQUIRED, verbatim
id: content-feed          # REQUIRED — names the workflow in state and logs
name: "Morning digest"    # defaults to id
version: 1.0.0            # free-form
description: >            # free-form
  What this workflow is for.
owner: oleg               # free-form
enabled: true             # false ⇒ `q-core run` does nothing and says so
triggers: [...]           # §3
settings: {...}           # §4
steps: [...]              # REQUIRED, at least one — §5
```

`manifest:` is required so this file can be told apart from any other YAML, and
so the format can be versioned later. A different version is named in the error,
never guessed at.

---

## 3. Triggers

Triggers are **inputs, not steps**. They never appear in `steps:`; putting one
there is a validation error with the fix in the message. Materialising a trigger
as a step run would begin every run with a step that does nothing and always
succeeds — noise somebody later reads as work.

```yaml
triggers:
  - kind: schedule
    cron: "0 7 * * *"     # 5 fields, UTC. Checked: field count and ranges.
  - kind: manual
```

Kinds: `schedule` · `manual` · `webhook` · `signal` · `intent-input` ·
`workflow-input` · `event`.

**The runner does not act on any of them.** `q-core run` performs one pass; `cron:`
documents the intended cadence, and launchd or cron actually fires it (README
§Scheduling). In the product, the scheduler is what reads these.

---

## 4. Settings — the three knobs

```yaml
settings:
  model: "anthropic/claude-3-haiku"
  budgetUsd: 0.10
  limits:
    daily: { runs: 2, budgetUsd: 0.60 }
  exit:
    kind: always_done
```

### 4.1 Model (knob 2)

Precedence, strongest first: a step's own `config.model` → `settings.model` →
`OPENROUTER_MODEL`. No model is selected implicitly. A model-backed YAML step
requires an explicit OpenRouter model; it does not use CLI caller inference.
`q-core validate` reports the selected model or an unconfigured value.

### 4.2 Budget (knob 3)

USD per run, **forced**, and checked **before** each paid step (`llm-call`,
`approval-gate`) — never after. A ceiling verified afterwards is not a ceiling,
it is a report of an overrun. When it cuts, the step fails with
`gateReason: budget` and the run stops; nothing further is sent.

Three distinct states, and they mean different things:

| | |
|---|---|
| absent | take the documented default, **$1.00** |
| `budgetUsd: 0.10` | that ceiling |
| `budgetUsd: null` | no ceiling, **lifted on purpose** |

The rate is the same table the product bills on (`src/cost.mjs`), so a manifest
costs the same in both homes.

### 4.3 Sensitivity (knob 1) — REFUSED by this runner

`settings.sensitivity` is part of the format and the product implements it. **The
local runner refuses a manifest that sets one** rather than run it with the knob
ignored: the profile exists to hold back irreversible and outbound steps, so
ignoring it would carry them out. Run such a workflow in the product, or remove the
profile.

### 4.4 Windowed limits · exit criteria

`limits` (daily / weekly / monthly caps on runs and spend) and `exit` are
validated for shape and carried through to the product, which enforces them.
**The local runner does not enforce `limits`** — it has no cross-run ledger to
count against. `q-core validate` says so on the line where it prints them.

---

## 5. Steps

```yaml
steps:
  - id: cf-fetch          # REQUIRED, unique — outputs are addressed by id
    kind: fetch           # REQUIRED
    config:               # scalars only; every value reaches the engine as a string
      name: "Fetch feed"  # the human label, used in output and in templates
      url: "https://…"
    then: [...]           # only meaningful on fan-out
```

`config` holds **scalars only**. Nested structure travels as a JSON *string* on
one line — `body: '{"a":1}'` — because that is how the database stores it. A
nested mapping is a validation error that says this.

### 5.1 `fetch` — read a source

| field | | |
|---|---|---|
| `url` | REQUIRED | templated |
| `format` | `text` \| `json` \| `rss` | default `text` |
| `limit` | rss only, entries kept | default 10 |
| `timeoutSec` | | default 30 |

Output: `{status, url, body}` · `{status, url, json}` · `{status, url, count, entries[]}`
where each entry is `{title, link, summary, published}`.

Fails on non-2xx, on a network error, and — for `format: rss` — on a feed with no
items. An empty feed is not a success: the steps after it expect material.

The RSS reader is regex-based, not an XML parser. It handles CDATA, `<item>` and
`<entry>`; it does not handle nested same-name tags or namespace prefixes.

### 5.2 `llm-call` — an isolated model request

| field | | |
|---|---|---|
| `instructions` | REQUIRED | templated |
| `format` | `text` \| `json` | default `text` |
| `maxTokens` | | default 1200 |
| `temperature` | | default 0.3 |
| `role` | prepended as "You are the ⟨role⟩ agent…" | |
| `model` | overrides the workflow's model | |

The step's **input is every prior successful output**, as JSON, capped at 60 000
characters. Inside a fan-out lane, its own item comes first.

Output: `{text, model}`, or the parsed object when `format: json`.

**No key means the step fails.** There is no canned fallback: invented text would
travel down the chain and out through the next request as if it were real.

*Isolated* is the point — no memory of its own. `agent-call` (a call to an agent
**with** its own context) is `RESERVED`.

### 5.3 `api-request` — an outgoing request

| field | | |
|---|---|---|
| `url` | REQUIRED | templated |
| `method` | GET/POST/PUT/PATCH/DELETE | default POST |
| `body` | JSON string or text | templated, deeply |
| `headers` | JSON string | templated |
| `expect` | `2xx` \| `any` | default `2xx` |
| `timeoutSec` | | default 30 |

Without `body`, the last successful output is sent in an envelope
`{runId, templateId, payload}` — a receiver has to know which run and which workflow
sent a thing.

**A workflow may end here.** This is a complete workflow, not an unfinished one.

### 5.4 `approval-gate` — Human-Gate or Agent-Gate

One kind, two modes; they differ only in *who* decides.

| field | | |
|---|---|---|
| `reviewer` | `human` \| `agent` | default `human` |
| `anchor` | what is being decided about | |
| `rubric` | REQUIRED when `reviewer: agent` | |
| `escalateOn` | `objection` hands a failed check to a person | default `objection` |
| `mode` | `check` is `RESERVED` — refused | |

**`reviewer: human`** parks the run as `waiting_human`. `q-core approve` continues it,
`--reject` fails it. **A human gate is optional** — nothing in the format or the
engine assumes a run must meet a person.

**`reviewer: agent`** is a machine check whose verdict is `{pass, reason}`.
Today that check is an LLM judge; `mode: check` (a real, non-model checker) is
reserved and a manifest claiming it is refused. Without a key the gate does
**not** wave anything through — it escalates to a human, because a check that
reports "fine" when its tool was missing leaves a record of a check that never
happened.

### 5.5 `fan-out` — a lane per item

| field | | |
|---|---|---|
| `over` | a single template resolving to an ARRAY | |
| `maxItems` | cap | default 50 |
| `then` | REQUIRED — the lane | |

`over` must be exactly one placeholder, e.g.
`{{steps.Fetch feed.output.entries}}`. Mixed text returns nothing rather than
guessing. If it does not resolve to an array, the step fails and says why — a
silent zero would hide a configuration error as an empty feed.

Each lane step sees **its own** item through `{{item.…}}` and `{{index}}`.

**Truncation is never silent.** The node's output carries `itemsFound`,
`itemsTaken`, `stepsCreated` and a `truncated` note.

Without `over`, the lane is inlined and runs **once**, and the node says so
rather than pretending to expand.

### 5.6 `schedule` — a trigger, not a step

See §3. Placing it in `steps:` is a validation error.

---

### 5.7 Control flow — `if`, `switch`, `loop`, `each`

Control nodes select or expand a bounded child tree. Their `config` remains
scalar text, and child steps use the same `then` list as a fan-out lane.

```yaml
- id: choose
  kind: if
  config: {condition: "{{steps.classify.output.pass}}"}
  then: [{id: publish, kind: api-request, config: {url: "https://example.test/ok"}}]
  else: [{id: hold, kind: approval-gate, config: {reviewer: human}}]
- id: route
  kind: switch
  config: {on: "{{steps.classify.output.route}}"}
  cases:
    news: [{id: news, kind: api-request, config: {url: "https://example.test/news"}}]
  default: [{id: fallback, kind: approval-gate, config: {reviewer: human}}]
- id: repeat
  kind: loop
  config: {maxIterations: 3}
  then: [{id: check, kind: fetch, config: {url: "https://example.test/status"}}]
- id: per-item
  kind: each
  config: {over: "{{steps.fetch.output.entries}}", maxItems: 20, maxConcurrency: 2}
  then: [{id: send, kind: api-request, config: {url: "https://example.test/item"}}]
```

`if.condition`/`when` selects `then` or `else`; `switch.on`/`value` selects a
string key in `cases` or `default`. `loop.maxIterations` is 1–50. `each.over`
must resolve to an array, `maxItems` is 1–50 and `maxConcurrency` is 1–10.
Expansion is capped to the sequence slot's 999 child rows; an overlarge branch
fails before it can run. A run also has a fixed maximum of 10,000 expanded rows
across all nested controls and fan-outs; the limit is checked before insertion
and fails the run. `each` records the requested concurrency and currently
executes its bounded rows in deterministic order; parallel execution remains a
product scheduler concern.

## 6. Templates

Resolved inside `url`, `body`, `headers`, `instructions` and `over`.

| | |
|---|---|
| `{{steps.<id or name>.output.<path>}}` | a prior step's output; the name match is case-insensitive and **may contain spaces** |
| `{{item}}` · `{{item.title}}` | the current item, inside a fan-out lane |
| `{{index}}` | 0-based lane position |
| `{{env.NAME}}` | an environment variable; `UPPER_SNAKE` only |

**An unresolved placeholder is left in place, verbatim.** Literal `{{…}}`
arriving at a receiver is a visible failure; an empty string is a silent one.

`{{env.…}}` exists so a manifest never carries a secret. A manifest is a file
that goes into git — "share the workflow" must not mean "share the bot token".

---

## 7. Errors, retries, partial runs

- A failed step **stops the run**. `.qf/last-run.json` records the status, the
  reason and the failing step; the process exits non-zero.
- **Fixed runtime retries, not manifest-configurable.** Fetch, model and API
  requests retry transient network/timeout/429/5xx failures twice, with 1.5s/4s
  backoff. Other 4xx fail immediately. Exhaustion remains a failure. Body parsing
  failures are not retried. Explicit transport cancellation does not retry.
- **No idempotency key.** A retry after an ambiguous response or a re-run can
  repeat outgoing writes. Publishing requires receiver de-duplication; this
  runtime does not promise exactly-once delivery.
- **No `continue_on_error` / `optional`.** One unreachable source fails the run.
  This is a known cost, not an oversight.
- A run parked at a gate is neither failed nor finished: it is held on disk and
  `q-core approve` resumes it from exactly there.

---

## 8. Memory

There is none, between runs. No cursor, no "last seen", nowhere to put one. A
feed workflow sends what the feed holds now. Claiming otherwise would be the most
expensive kind of wrong.

---

## 9. Divergences

The runner and the product engine execute the same manifest identically, and a
parity test in the product engine enforces that across four cases: a workflow
with no human, a gate that holds, a budget that cuts, and a fan-out lane per
item.

**On an unset `{{env.X}}` in a URL, neither home fires the request.** They differ
only in what they do instead:

| | |
|---|---|
| engine | the step **fails**, naming the variable: "TELEGRAM_BOT_TOKEN is not set … the missing value is a secret, not a broken endpoint" |
| runner | the payload goes to `.qf/out/<runId>.txt`, the run continues, and the CLI says `⚠ NOT SENT` |

Both refuse to send blind. The runner's file sink lets you validate an end-to-end
flow before configuring a real receiver. A missing environment value is reported
as a missing value, rather than treated as a receiver endpoint.

**What the runner does not enforce at all:** `settings.sensitivity` (refused
outright) and `settings.limits` (validated, not counted — there is no cross-run
ledger locally). The product enforces both.

---

## 10. Versioning

`manifest: q-core.workflow/v1` is the contract. Within `v1`, fields may be **added**;
nothing that exists is repurposed or removed. A runner meeting a version it does
not read says so by name instead of trying its luck.

`RESERVED` fields — `agent-call`, `agent-gate mode: check` — are refused today
precisely so that implementing them later cannot break a manifest that was
written against this document.

## 11. Registry composition additions

The Registry driver also executes `parse-web`, `deduplicate`, `verify-sources`,
`workspace-read`, `specification`, `workspace-apply` and `verify-artifact`.
These are generic components, not shortcuts to the direct SDD/content APIs.

- `parse-web`: optional `source` references a successful text fetch; absent source
  selects prior fetched text pages. `maxChars` is 500..10000 per page (default6000).
  Static text extraction excludes scripts/navigation and reports truncation. It
  does not execute JavaScript or assert that source statements are factual.
- `deduplicate`: `source` references `{sources:[{url,text,...}]}`. Exact URL/text
  duplicates are removed; `sourceHash` identifies the selected set.
- `verify-sources`: `draft` references text or `{text}` and `sources` references
  the selected sources. Requires every selected source URL, rejects unknown URLs
  and enforces a 16000-character bound. Optional `language: uk` checks Ukrainian
  markers, not linguistic quality. Facts need independent review.
- `llm-call` with `provider: cli` may set `input` to one step-output reference to
  bound its input instead of sending every prior raw output. Caller replies stay
  bound to the exact pending job. No alternate provider fallback exists.
- A human `approval-gate` with `bind: sha256` requires `q-core approve <manifest>
  <runId> --approval-hash <hash>` (also for rejection). The displayed hash binds
  the exact persisted subject; a mismatched/stale subject cannot be approved.
- `api-request` may declare `receiptKey` resolving to a SHA-256 source identity.
  Persistent receipt is claimed before sending; delivered repeats return the
  receipt without a new request. Failure/interruption is uncertain and requires
  reconciliation. This mode performs no automatic retry or missing-env file
  fallback. The receiver destination must be explicitly configured.
- Workspace components require an explicit local `--workspace-policy <json>`:
  absolute `workspace`, `allowedPaths`, `intent`, immutable `verifier` command,
  file `args`, `timeoutMs`, and `maxRepairAttempts` (0..5). Optional
  `specification` imports bounded summary/criteria/plan but still needs approval.
  Policy is persisted with the run; it cannot be supplied by generated output.
- `workspace-read` pins files and independent verifier inputs. `specification`
  takes `source` and `workspace` references and records a revision when spec or
  policy changes. An ambiguous intent must be clarified before the caller replies;
  a scope change starts a new specification revision, not a silent in-run edit.
- `workspace-apply` takes `source` with `{files:[{path,content}]}` and `approval`
  with the approved spec. It refuses changed source files, checker changes,
  symlinks, out-of-scope paths and writable checker inputs. The verifier is a
  trusted user-selected command, not an operating-system sandbox.
- `verify-artifact` takes an applied artifact `source` and may set `repairFrom` to
  its caller proposal step. Failed checks repeat only the declared local
  proposal/apply/verify segment within the policy bound; missing/stale evidence
  or changed checker stops. Limit exhaustion is `needs_human`, never success.
  Repair evidence and revisions are retained. Interrupted applies require manual
  reconciliation; they are never blindly repeated.

Use an exact package pin and validate the actual template in its target
environment before relying on a Registry composition.
- `determined` shares `source`, `specification` and `repairFrom` references. It
  reuses the determined reducer's AND/freshness checks over approved criteria;
  all criteria bind to the explicitly selected independent verifier suite. The
  Registry driver persists pauses and bounded repair attempts around that reducer.
- `q-core cancel <manifest> <runId>` cancels only a paused inference/approval run.
  It invalidates the pending job. `q-core resume <manifest> <runId>` explicitly
  resumes that paused cancellation with a new job, without repeating completed
  steps. An interrupted active side effect cannot use this shortcut.
- `fetch.maxBodyBytes` optionally raises the bounded response capture from 64000
  to at most 2000000 bytes for static source pages; text output discloses truncation.
