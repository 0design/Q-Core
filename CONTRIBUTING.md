# Contributing

Yes — fork it, add a loop, a component, or a demo, and open a pull request.
Merged entries appear in `qloop catalog` and on the site, because both read the
same generated `catalog.json`. `qloop init <id>` copies a **loop** only.

## Do not hand-edit catalog.json

It is generated from `loops/` and `registry/`. If you edit it by hand, CI will
overwrite your edit and fail the check, which is the point: a catalogue somebody
maintains by hand starts lying within a month.

```bash
npm run catalog
```

## What a loop contribution is

**One manifest, one pull request.** A `.yaml` file in `loops/`, nothing else
required.

## The bar

A loop gets merged when it is **something a stranger can run**, not a sketch.

1. **It validates.** `qloop validate loops/your-loop.yaml` passes.
2. **It runs as shipped.** Point it at a real, key-free endpoint where you can.
   A loop that needs an account nobody has is a loop nobody tries.
3. **No secrets in the file, ever.** Use `{{env.YOUR_VAR}}`. A manifest goes
   into git; "share the loop" must never mean "share the token".
4. **The comments say WHY, not what.** `# fetch the feed` above a fetch step is
   noise. `# NOT hnrss.org: it answered 200 and then 502 within the same hour`
   is the reason somebody will need in six months.
5. **The irreversible step is last, and behind a gate** if it publishes,
   charges, sends or deletes. There is no idempotency key in the format: a
   re-run does it again.
6. **The budget is set explicitly** in `settings.budgetUsd`. Loops that fan out
   need it most — five lanes is five model calls.
7. **An agent-gate rubric is a condition, not a wish.** "PASS only if the rate
   is above 42.0" is checkable. "PASS if the post is good" passes everything and
   is worse than no gate.

## What we will ask you to change

- A description that sells rather than describes. The catalogue is read by
  people deciding whether to spend money; "revolutionise your workflow" tells
  them nothing and costs you the merge.
- A loop that only works against a service you own.
- A prompt that instructs the model to pad — "write at least three
  paragraphs". Loops that manufacture volume train the reader to skim.

## Proof of a run (optional, and it changes what the catalogue shows)

If you have actually run your loop, include the recording:

```bash
qloop run loops/your-loop.yaml
node scripts/record-proof.mjs your-loop
```

That writes `examples/your-loop.run.json` and `examples/your-loop.txt`, and the
catalogue then shows the **measured** cost and links the real output.

Without it the loop still merges — it simply reads as "not run yet", with no
cost and no proof. That is deliberate: a number nobody measured must not appear
next to numbers somebody did.

Check the recording before committing it. `record-proof.mjs` strips URLs to
their origin and redacts anything shaped like a token, but you know your own
payloads better than a regex does.

## Adding a component

A component is a contract in `registry/components/<id>.json`, not a new runner.
The engine kinds are listed in SPEC-MANIFEST.md §5. A composite is a named
recipe over those kinds — `telegram-publish` is `api-request`, not a sixth step.

Required fields: `id`, `name`, `kind` (`step` | `trigger` | `composite`),
`description`, `input`, `output`, `needsEnv`. A composite also names
`builtFrom`. `usedBy` is filled when the catalogue is generated.

Quote the spec. Do not invent engine behaviour. Then:

```bash
npm run catalog
```

## Adding a demo

A demo is a named run against a loop that already exists:
`registry/demos/<id>.json`.

Required fields: `id`, `loopId`, `name`, `description`, `proof`, `resultUrl`
(nullable), `live`. `measured` is copied from the loop at generate time.

`loopId` must match a loop in `loops/` — an orphan demo fails the generate.
`live: true` only when `resultUrl` is a public URL that actually works. Then:

```bash
npm run catalog
```

## What CI checks

Every pull request:

- the package's own tests pass;
- **every** manifest in `loops/` validates;
- `catalog.json` matches what regenerating it produces — so the catalogue can
  never drift from the loops or the registry;
- `catalog.json` has loops, components, and demos;
- no file contains anything shaped like an API key or a bot token.

CI cannot run your loop: that needs a model key, and a key does not go into a
pull request from a fork. Running it is the maintainer's step before merge.

## Review, and what happens after

Oleg reviews and merges. On merge:

1. `catalog.json` is regenerated,
2. the site picks it up from the same file,
3. `qloop init <your-id>` starts working for everyone — including people whose
   installed version predates your loop, because `init` falls back to the
   published catalogue when an id is not in their build.

## Licence

Contributions are MIT, same as the rest. By opening a pull request you agree
your loop ships under it.
