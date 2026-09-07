# qloop

Describe a loop in a file. Run it with one command.

No database, no server, no build step, no dependencies.

## Run one

Requires Node.js 20.3 or newer (combined timeout/cancellation signals).

```bash
npm install -g qloops
```

The package is `qloops`; the command it installs is `qloop`. npm refused the
bare `qloop` as too close to `q-loop`, an unrelated package last published in
2016 — so the registry name carries the `s` and what you type does not.

```bash
qloop init release-watch
qloop run release-watch.yaml
```

```
Release watch — what shipped in your dependencies · run 819fb995
  ✓ fetch          Fetch releases
  ✓ llm-call       Write the note
  ✓ api-request    Send the note

  SUCCESS: Completed 3/3 steps.
```

That is the whole tool. `qloop run` executes one pass and exits — see
[Scheduling](#scheduling) for making it happen every morning.

## Commands

| | |
|---|---|
| `qloop catalog` | loops, components, and demos in this build (`--section` filters; `--json` dumps the file) |
| `qloop init <id> [dir]` | copy one here, ready to edit |
| `qloop validate <manifest>` | check it and print what it would do |
| `qloop run <manifest>` | execute one pass |
| `qloop run <manifest> --dry-run` | resolve and order every step, touch nothing |
| `qloop status [<manifest>]` | recent runs, and why the last one stopped |
| `qloop approve <manifest> [runId]` | continue a run held at a human gate (`--reject` refuses) |
| `qloop doctor` | check this machine before blaming the loop |

Exit codes: `0` success · `1` failed · `2` waiting on a human · `64` bad usage.
They differ on purpose — whatever is watching has to tell "it broke" from "there
was nothing today", and both from "somebody needs to look at this".

Installed as `qloop`. There is deliberately no `qf` alias: that name belongs to
`@q-factory/bridge`, and claiming it made `npm i -g qloops` fail outright — not
partially — for anyone who already had Bridge installed.

## Setup

One variable covers most of the catalogue:

```bash
export OPENROUTER_API_KEY=sk-or-…
```

Loops that send somewhere need a receiver — a webhook you own, or a Telegram
bot:

```bash
export QLOOP_WEBHOOK_URL=https://…
export TELEGRAM_BOT_TOKEN=…   # from @BotFather
export TELEGRAM_CHAT_ID=…
```

**Without a receiver the loop still runs.** The result goes to `.qf/out/` and
the run says so, loudly — which is how you prove a loop end to end before you
have credentials for anything. Without a model key it is the other way round:
the step **fails** rather than inventing text, because invented text would
travel down the chain and out through the next request as if it were real.

`qloop doctor` tells you which of these is set. It prints names, never values.

## Catalogue

The public tree is three folders plus one generated file. The CLI and the site
read the same `catalog.json`.

```
loops/                  YAML manifests
registry/components/    step, trigger, and composite contracts
registry/demos/         named runs against a loop
examples/               recorded proofs
catalog.json            generated — do not edit
```

`npm run catalog` rebuilds `catalog.json` from those folders. Hand-editing it
is refused by CI.

`qloop catalog` prints all three sections. `--section loops|components|demos`
filters; `--json` dumps the file. `qloop init` still copies a loop.

## Templates

Eleven loops ship with qloops. Each has actually been executed — what
`qloop catalog` reports is measured from a real run recorded in `examples/`.

### release-watch — what shipped in your dependencies

The cheapest one to try: one credential, no accounts anywhere.

```bash
qloop init release-watch
```

Change the URL to a project you actually depend on — GitHub publishes a
releases feed for every public repository:

```yaml
url: "https://github.com/YOUR/REPO/releases.atom"
```

### content-feed — the morning digest

Reads a feed, writes a short digest, sends it. Runs to the end on its own.

```bash
qloop init content-feed
```

The message carries a signature line with the **real** cost of that run —
`{{run.costUsd}}` resolves to what the run has spent by the time the message
goes out. Delete the line if you do not want it.

### brand-mentions — who talked about you today

Searches a news feed and keeps only the mentions actually about you. Says
"No mentions today." when there are none, instead of padding.

Point the search at yourself:

```yaml
url: "https://news.google.com/rss/search?q=YOUR+BRAND&hl=en-US&gl=US&ceid=US:en"
```

### feed-fanout — a lane per entry

The alternative to one blended summary: `fan-out` opens a lane per item, so each
entry gets its own model call and its own outgoing message.

**Cost scales with items** — five lanes is five model calls. That is what the
budget knob is for; it cuts *before* the call that would cross the ceiling.

```yaml
maxItems: "5"     # raise this and raise budgetUsd with it
```

### price-watch — machine filters, human authorises

The shape to copy whenever a loop ends in something you cannot undo:

```
fetch → agent-gate → human-gate → api-request
```

The agent-gate is a machine check against your `rubric` — it decides whether
this is worth anyone's attention. The human gate sits in front of the
irreversible step. Run it and it stops:

```
  ⏸ approval-gate  Send it?
  WAITING_HUMAN: Waiting on a human at step "Send it?".
```

```bash
qloop approve price-watch.yaml          # or --reject
```

Write the rubric as a condition, not a wish. A vague rubric passes everything
and is worse than no gate at all.

### content-factory — draft, check, approve, publish

The same two gates, with publishing at the end. The irreversible step is last
and behind both, because a re-run publishes again — there is no idempotency key
in the format, and pretending otherwise would be the expensive kind of wrong.

## Write your own

A loop is a YAML file with steps. Six kinds, no more: `schedule` (a trigger),
`fetch`, `llm-call`, `api-request`, `approval-gate`, `fan-out`.

```yaml
manifest: qf.loop/v1
id: hello
steps:
  - id: pull
    kind: fetch
    config: { url: "https://news.ycombinator.com/rss", format: rss, limit: "5" }
  - id: write
    kind: llm-call
    config:
      name: "Write digest"
      instructions: "One line per entry: title and link. No preamble."
  - id: send
    kind: api-request
    config:
      url: "https://example.com/hook"
      body: '{"text":"{{steps.Write digest.output.text}}"}'
```

```bash
qloop validate hello.yaml && qloop run hello.yaml --dry-run
```

The full schema — every field of every step kind, the three knobs, what is
reserved for later — is in [SPEC-MANIFEST.md](./SPEC-MANIFEST.md).

Secrets never go in the file: `{{env.NAME}}` reads them from the environment,
so sharing a loop does not mean sharing your bot.

## State

Everything a run leaves behind sits in `.qf/`, beside the manifest:

```
.qf/runs/<runId>.json    every step, its output, its tokens, its cost
.qf/last-run.json        the newest outcome — status, reason, failing step
.qf/out/<runId>.txt      the file sink, when no receiver is configured
```

Plain files, because the question you actually ask at 09:35 is "what happened",
and `cat .qf/last-run.json` answers it without a client or a server.

## Scheduling

`qloop run` performs ONE pass. Repetition is launchd's job, where you can see it
in `launchctl list` and stop it with one command. The template runs daily at
09:30 local time.

```bash
sed -e "s#__NODE__#$(command -v node)#" -e "s#__QF__#$(command -v qloop)#" \
    -e "s#__MANIFEST__#$PWD/content-feed.yaml#" -e "s#__LOGDIR__#$HOME/Library/Logs#" \
    launchd/co.qfactory.content-feed.plist.template > ~/Library/LaunchAgents/co.qfactory.content-feed.plist
```

```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/co.qfactory.content-feed.plist
```

Stop it with `launchctl bootout gui/$(id -u)/co.qfactory.content-feed`.

Secrets come from `~/.qf/env`, which the job sources before every run — one file
you can `chmod 600`, never the plist, never the manifest.

**If the machine is asleep at 09:30, launchd runs the job on wake.** That is the
honest limit of a laptop. A digest that must arrive at 09:30 sharp belongs on
something that stays awake.

## When something does not arrive

```bash
qloop status content-feed.yaml
```

```
  ✗ 2026-08-01 14:53:14  failed  "Fetch feed": GET https://… → HTTP 502.

  last run FAILED: "Fetch feed": GET https://… → HTTP 502.
```

A failed run exits non-zero and writes the reason down, so "it broke" and
"nothing happened today" never look the same.

## What is free, and what is not

Running a loop on your machine is free and always will be — that is this
repository. Scheduling as a service, quotas, plans, shared workspaces and the
run-history UI are the product.

The line: **local execution free, orchestration paid.**

## What this does not do

Stated plainly, because a tool that implies more than it does costs more than
one that admits its edges.

- **No scheduler.** `qloop run` is one pass. See [Scheduling](#scheduling).
- **No memory between runs.** No cursor, no "last seen". A feed loop re-sends
  whatever the feed holds now; de-duplication belongs to the receiver.
- **No idempotency key.** Transient fetch/LLM/API failures retry twice (timeout,
  network, 429, 5xx), with 1.5s/4s backoff. An ambiguous failure can repeat an
  outgoing write; a full re-run repeats requests too. Publishing needs explicit
  receiver de-duplication before use. Retrying is not exactly-once delivery.
- **One failed step stops the run.** There is no `continue_on_error`.
- **No `sensitivity` policy.** A manifest that sets one is *refused*, not run
  with the knob ignored — the profile exists to hold back irreversible steps.
- **An agent-gate is an LLM** judging against your rubric, not a real checker.
  `mode: check` is reserved in the format and refused, rather than faked.
- **No `agent-call`.** Reserved in the format, not implemented.

## Keeping it honest

The shared transport lives in `src/http.mjs`; the `steps.mjs` export remains
compatible. Its internal policy accepts 0-10 retries, positive timeout durations
and non-negative delays. Invalid policy fails before a request. A caller-supplied
AbortSignal stops requests/backoff without retrying cancellation. The manifest
does not yet expose this cancellation control or a custom retry policy. Response
body parsing errors are not retried; callers consume the final response.

`npm test` includes local HTTP failure/recovery and persisted driver-state tests,
plus mocked model-caller tests. Those are not evidence of a live paid model call.

The same manifests also run inside the product, from a database. Two
implementations of one behaviour drift, so they are pinned together by a parity
test: one manifest, one loader, executed both ways, step sequence and outcomes
compared. A difference is a red test, not a footnote.

## License

MIT.
