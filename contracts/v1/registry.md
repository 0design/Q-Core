# Pinned registry consumption

`q-core install <base> <catalog-sha256> <id> <version> <destination>` downloads,
checks and installs an exact workflow plus a sidecar origin/dependency lock. The base
is an absolute export directory or static HTTPS directory containing catalog.json
and workflows/components/demos subdirectories. HTTP is allowed only on localhost for
controlled development. The Site /api/registry route is a different API layout;
it is not automatically treated as a static export base.

The catalog must pin the installed q-core version exactly and q-core.workflow/v1. A newer
local engine must not rewrite a downloaded catalog or silently accept the old pin.
Use the engine artifact pinned by the catalog. Catalog and every resolved asset
need SHA256 verification; the root manifest is parsed and checked before
destination writes.

The installer rejects malformed sections/dependencies, mismatched entry engine
metadata, files outside their declared section/ID, and ambiguous same-ID
dependencies spanning workflows/components. Dependencies are exact IDs/versions;
missing targets, cycles or checksum mismatch fail before installation. Each section
has at most 1000 entries, each dependency list at most 100 entries. Workflow default
path is workflows/<id>.yaml; component/demo default is <section>/<id>.json.

Existing destination or lock is never overwritten. Download failure does not become
success. Installation writes a manifest and then its lock as separate exclusive
files; this is not an atomic two-file transaction. If interrupted between those
writes, inspect/remove only the new incomplete installation before retrying. The
lock is provenance, not permission to run external actions or a ban on intentional
local editing. Review environment, target URLs and manifest actions before running.

## Reproduce from the Core source checkout

```sh
node scripts/test-registry-package.mjs /absolute/path/to/QFactory.io
```

This installs the exact pinned engine into a fresh temporary caller, serves
unmodified export bytes over localhost, downloads `webhook-relay`, validates and
executes it against a controlled local source/receiver. It also checks engine-pin
refusal and a synthetic catalog with identical manifest bytes and different engine
metadata.
