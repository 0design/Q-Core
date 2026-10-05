<!-- Follow docs/contributing/guide.md. Check applicable items; explain N/A and failures. -->

## Change and evidence

- Change: documentation / runtime fix / Registry workflow / Registry component
- Problem and resulting behavior:
- Target base/head commit, Core version and archive SHA256:
- Material ID/version, actual inputs, checks and observed result:
- Remaining unverified behavior or pending checks:

Keep fixtures, controlled local runs and real external results distinct. Leave
unmeasured cost/tokens unknown. Do not include secrets or private drafts.

## Registry contribution (when applicable)

Edit source assets and `registry/catalog.source.json`; never hand-edit generated
`registry/catalog.json`. Follow the [contribution guide](../docs/contributing/guide.md)
for archive creation and regeneration. `npm run catalog` builds the separate
top-level catalog, not the Registry.

- [ ] Workflow: `registry/workflows/<id>.yaml`, matching ID/version, with catalog
      author, origin, MIT license and exact compatible engine/dependency pins
- [ ] Component descriptor: `registry/components/<id>.json` and catalog metadata;
      supported contracts match `SPEC-MANIFEST.md`; metadata does not implement
      an adapter or make a planned integration available
- [ ] Optional demo evidence: `registry/demos/<id>.txt` and version-bound catalog
      metadata tied to an existing workflow/template; `live` only for a reachable
      public result. Evidence is supplementary, not a third material type
- [ ] Attribution and license preserved; included material may be distributed
      under MIT; third-party asset/service terms checked separately

### Nested workflows / executable components

The `main` baseline at `68cab95` is Core45. Core48 in
[PR46](https://github.com/0design/Q-Core/pull/46) is a candidate, not a published
Registry upgrade. Recheck the exact target's schema, validator and builder.
If unsupported, retain these required capabilities in a draft and stop before
submitting it as a ready Registry contribution; name the compatible Core/Registry
review and integration still needed. Do not silently downgrade the material.

- [ ] Compatible target confirmed: executable components use
      `registry/components/<id>.yaml`, `manifest: q-core.component/v1` and the
      target's `contracts/v1/nested-materials.md`; JSON descriptors remain distinct
- [ ] Entry and every reachable dependency retain relative paths, exact bytes,
      versions, SHA256 pins and typed I/O; missing/wrong-version/wrong-hash,
      cycle and depth refusals checked with the canonical graph validator
- [ ] Complete closure exported and validated/run by a relocated clean local
      consumer on the exact compatible Core; result and remaining gates recorded

## Checks and handoff

- [ ] Workflow: `node bin/q-core.mjs validate registry/workflows/<id>.yaml`;
      executable component only on a supporting target:
      `node bin/q-core.mjs validate registry/components/<id>.yaml`
- [ ] Exact archive supplied to
      `node scripts/build-registry.mjs --check --core-artifact <archive>`
- [ ] Changed Registry assets regenerated with
      `node scripts/build-registry.mjs --export registry --core-artifact <archive>`
      and checked again; never omit the archive
- [ ] `npm test` and
      `python3 -m unittest discover -s test -p test_registry_publish.py` recorded
- [ ] Registry change: guide's temporary export with `--core-artifact` and
      `node scripts/test-registry-export.mjs <export-directory>` recorded
- [ ] Positive, failure/recovery and repeat evidence provided where relevant;
      explicit budget and human gates preserved. Waiting for approval is not a
      completed run; ordinary PR checks do not authorize external delivery
- [ ] Own fork/head and intended upstream base verified; exact-head CI and
      independent maintainer review recorded, including any pending CI approval

Packaged Core changes may need a new reviewed Core/Registry pair. Report pin
mismatches; do not weaken checks or replace reviewed pins just to pass. Contributors
cannot self-approve. Merge, accepted version and publication are separate; passing
checks or a merged PR do not prove a live Registry release.
