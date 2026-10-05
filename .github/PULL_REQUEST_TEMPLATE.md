<!-- Follow docs/contributing/guide.md and CONTRIBUTING.md. State the exact scope and evidence. -->

## Change and evidence

- Kind: documentation / runtime fix / Registry workflow / component / demo
- Problem and resulting behavior:
- Exact versions, checks performed, and observed result:
- Remaining unverified behavior:

Keep fixtures, controlled local runs, and external results distinct. Do not include
secrets, private drafts, unmeasured cost claims, or live external actions as part
of ordinary PR checks.

## Registry contribution (when applicable)

Edit source files and `registry/catalog.source.json`; never hand-edit the generated
`registry/catalog.json`. Follow the [contribution guide](../docs/contributing/guide.md)
for packing the exact Core archive, regeneration, and checksum verification.

- [ ] Workflow: `registry/workflows/<id>.yaml` with author, origin, MIT license,
      version and exact compatible engine/dependency pins in catalog source
- [ ] Component: `registry/components/<id>.json` for supported block metadata;
      executable components use `registry/components/<id>.yaml` and
      `q-core.component/v1` under `contracts/v1/nested-materials.md`
- [ ] Demo: `registry/demos/<id>.txt` and version-bound catalog source metadata;
      `live` only when its public result is actually reachable
- [ ] Existing attribution and license preserved; planned adapters remain unavailable
- [ ] Workflow validated with `node bin/q-core.mjs validate registry/workflows/<id>.yaml`
- [ ] Exact archive supplied to `node scripts/build-registry.mjs --check --core-artifact <archive>`
- [ ] Changed Registry assets regenerated with `--export registry --core-artifact <archive>`
- [ ] `npm test` and relevant positive/negative/recovery checks passed

Packaged Core changes need a new reviewed Core/Registry pair. Report pin mismatches;
do not weaken checksum checks or claim publication from a passing local check.
