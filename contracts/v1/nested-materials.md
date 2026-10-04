# Nested workflows and executable components

This local execution contract extends `q-core.workflow/v1`. An executable reusable
component uses `q-core.component/v1` with the same steps, inputs, outputs, settings,
and dependency rules. Existing Registry `.json` component descriptors remain
metadata: validation or export never makes a descriptor executable.

```yaml
manifest: q-core.workflow/v1
id: parent
version: "1.0.0"
inputs:
  sources: {type: array, items: {type: object}}
dependencies:
  cleaner:
    kind: component
    id: clean
    version: "1.0.0"
    path: ./deps/clean.yaml
    sha256: <64 lowercase hexadecimal digits of the exact file bytes>
outputs:
  removed: {type: integer, value: "{{steps.clean.output.removed}}"}
steps:
  - id: clean
    kind: workflow-call
    config:
      ref: cleaner
      inputs: '{"sources":"{{inputs.sources}}"}'
```

Ports declare `string`, `number`, `integer`, `boolean`, `object`, `array`, or
`null`. Array ports may declare an `items` type. Inputs are required unless
`required: false` or a typed `default` is supplied. Extra input names and wrong
types fail. Output ports require a `value` binding and are checked before a
successful return. Whole `{{inputs.name}}`, `{{steps.id.output.name}}`, or
`{{item.name}}` references retain their JSON type, including null and false.
Mixed text is a string. Substituted data is not interpreted again as template
code. Each child has its own inputs and step-output namespace.

Dependency paths are relative to their containing manifest, below the entry
directory; absolute paths, traversal and escaping symlinks are refused. Every
reference pins kind, id, exact version and SHA-256. The loader verifies the entire
closure before execution, including unused declared dependencies. Missing files,
unreadable files, identity mismatch, checksum mismatch, cycles, more than 16 call
levels or 128 distinct materials fail. A file is bounded to 1 MiB. Runtime row
expansion remains bounded to 10,000 rows. URL downloads and mutable registry
resolution are not part of this execution primitive; resolve materials into local
pinned files before using it.

One persisted run contains child invocation snapshots and scoped rows. A child
human gate pauses the same run; the existing human-only confirmation and exact
subject check govern resume. Caller inference also pauses/resumes the same run.
Failure propagates to the call and parent. Completed child steps are not repeated
after a gate. Changing source files cannot rewrite the saved execution snapshot.
Run state is local trusted-user data, with the same unsigned-file boundary as
existing runs; it is not a remote authorization service.

Every billable leaf contributes once to global run usage. Calls expose
`childUsage` and `childStatus`; their own cost is zero to prevent double counting.
All ancestor budget ceilings apply, and unknown spend remains unknown. Existing
per-call cost policy still applies; the per-run spent-so-far stop is not a provider
reservation. CLI inference requires explicit `budgetUsd: null` in every ancestor
because its usage is unknown. A child cannot remove its parent's human policy,
workspace policy or budget ceiling.

## API and CLI

- `validateManifest(doc)` validates the workflow/executable-component shape and
  dependency declarations. It does not read dependencies or prove execution.
- `loadManifestGraph(file)` verifies and snapshots the complete pinned closure.
- `loadWorkflow(file)` additionally applies human-side-effect policy through
  child calls. A gate on the parent path covers the child; a gate inside a
  conditional branch does not cover another branch.
- `validateComponentDescriptor(doc)` validates current Registry block metadata
  without claiming implementation, acceptance or executability.
- `createRun(manifest, { inputs })` binds root input values. Use a graph loaded
  by `loadWorkflow` for executable calls; unresolved dependencies are refused.
- `exportMaterialBundle(file, newDirectory)` copies exact source bytes and their
  dependency closure, returning `{ protocolVersion: "q-core.bundle/v1", entry,
  files: [{ path, sha256, id, version, kind }] }`. It never overwrites a directory.
  A descriptor export sets `executable: false`; descriptor `builtFrom` metadata
  does not claim an executable closure.
- Registry export includes reachable YAML dependency assets and their checksums.
  `installPinned` verifies the catalog, parent and every child pin before writing
  the complete local closure. Existing files and conflicting destination paths
  are refused. A portable export alone does not publish or accept a Registry entry.

```sh
q-core validate parent.yaml
q-core run parent.yaml --inputs inputs.json --json
q-core export parent.yaml ./portable --json
q-core run ./portable/parent.yaml --inputs inputs.json --json
q-core validate component.json --json
```

`--dry-run` reports a child as planned with verified pins; it does not fabricate
child outputs or prove dynamic bindings. `q-core approve` still requires a real
person in their terminal. Executable nested materials have no bridge, daemon,
device pairing or server execution transport.
