<!-- Say which kind this PR is. One kind per PR when you can. -->

## Kind

- [ ] Workflow
- [ ] Component
- [ ] Demo

Do not hand-edit `catalog.json`. After you add files, run `npm run catalog` and commit the generated result.

---

## Workflow

One manifest, one pull request. A `.yaml` file in `workflows/`.

- [ ] `q-core validate workflows/your-workflow.yaml` passes
- [ ] It runs as shipped, against a real key-free endpoint where you can
- [ ] No secrets in the file — `{{env.YOUR_VAR}}` only
- [ ] Comments say WHY, not what
- [ ] The irreversible step is last, and behind a gate if it publishes, charges, sends or deletes
- [ ] `settings.budgetUsd` is set explicitly
- [ ] An agent-gate rubric is a condition, not a wish
- [ ] Optional proof: `examples/<id>.run.json` and `examples/<id>.txt` via `node scripts/record-proof.mjs <id>`

---

## Component

A contract in `registry/components/<id>.json`. Not a new engine kind unless SPEC-MANIFEST.md already has one.

- [ ] `id`, `name`, `kind` (`step` | `trigger` | `composite`), `description`
- [ ] `input` / `output` field maps with `type` and `notes` (input also has `required`)
- [ ] `needsEnv` is a string array
- [ ] Description quotes SPEC-MANIFEST.md — no invented runner behaviour
- [ ] A composite names `builtFrom` and is a recipe, not a new step kind
- [ ] Ran `npm run catalog`

---

## Demo

A named run in `registry/demos/<id>.json` against a workflow that already exists.

- [ ] `workflowId` matches a file in `workflows/`
- [ ] `proof` points at a recorded file in `examples/` (or says there is none)
- [ ] `live` is true only when `resultUrl` is a public URL that actually works
- [ ] Ran `npm run catalog`
