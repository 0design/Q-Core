# Contributing to the versioned Registry

Open a pull request with an independently runnable workflow, a supported component,
or version-bound demo evidence. The public Registry source is `registry/`.
The root `workflows/` and `catalog.json` are legacy bundled examples; adding there
alone does not publish a Registry entry.

## Files and metadata

- Workflows: `registry/workflows/<id>.yaml` plus an entry in
  `registry/catalog.source.json` with value, version, origin, author, MIT license,
  exact Core engine pin and dependency versions.
- Components: `registry/components/<id>.json` and catalog source metadata. Use
  actual supported engine kinds from SPEC-MANIFEST.md. A description does not
  implement a runtime adapter. Planned entries remain unavailable.
- Demos: catalog source entry plus `registry/demos/<id>.txt` containing a
  reviewable result/evidence record; refer to an existing workflow/template ID.
  Set `live` only when its public result is actually reachable.
- Authors: `registry/authors/<id>.json`; templates and builtin pins live in
  `registry/composition.json`.

Preserve source attribution and license. Never include secrets or private drafts.
Use environment references for service access. Cost/tokens stay null when not
measured. Evidence records must distinguish fixtures, controlled local runs, and
externally observable results.

## Local checks

```sh
node bin/q-core.mjs validate registry/workflows/your-workflow.yaml
node scripts/build-registry.mjs
node scripts/build-registry.mjs --check
npm test
```

The builder generates `registry/catalog.json`; do not edit it directly. To test
an exact Core/Registry pair, pack the intended reviewed Core build, pin its byte
SHA256 in catalog source, regenerate, then export:

```sh
node scripts/build-registry.mjs --export /absolute/registry-export --core-artifact /absolute/q-core-VERSION.tgz
```

Install from that export through the public CLI Registry path and exercise the
actual template. A transport-only test does not exercise a composed workflow.
Supply positive and negative cases, failed verification/repair, limits and stale
evidence where applicable. A planned component must remain unavailable and cannot
become installable through metadata alone.

Human approvals must bind the concrete artifact/version. Irreversible external
actions require the appropriate permission. Receipt-aware `api-request` supports
an explicit `receiptKey`; unknown delivery outcomes must be reconciled before
retry. This is not a blanket exactly-once guarantee for arbitrary integrations.

## PR, CI, review and publication

Run the repository's current PR workflows without production credentials.
A clean local test is useful evidence but does not replace PR CI or review. Record
the exact commit reviewed. Contributors cannot self-approve a change.

The publisher creates an immutable snapshot only through the repository's review
and distribution process, verifies checksums and consumer compatibility, and then
updates a public pointer when authorized. A merged file does not automatically
update every installed runtime: clients resolve the versioned catalog and
explicitly install a compatible pinned entry. `q-core init` is a legacy
convenience, not a universal compatibility promise.

Contributions ship under MIT. Include only material you may distribute under
that license; third-party services and their access terms remain separate.
