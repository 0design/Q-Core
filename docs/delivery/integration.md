# Site integration handoff — contract revision 1

Package candidate: qloops@0.2.0-core.1. Artifact and SHA256 are recorded in
package-evidence.json and SHA256SUMS. Install the local tarball, then explicitly
repin the site lock and dependency in the Site-owned repo. Core does not do that.

```sh
npm install /absolute/qloops/artifacts/qloops-0.2.0-core.1.tgz
```

Imports: `openRouter`, `runAgent`, `runContent`, `runContentRequest`,
`reconcilePublication`, `determined`, `qualityCheck`, `loadAindf`, `loadUnslop`,
`upstreamDigest`, `validateRequest`, `validateManifest`, `loadManifest`,
`installPinned`, `loadRelease` from `qloops`. Existing `qloops/src/manifest.mjs`
and `qloops/src/run.mjs` imports remain exported. No sibling imports required.

## Contracts to pin

- qf.loop/v1: unchanged YAML structural validator; legacy reserved kinds stay refused.
- qf.agent/v1: request schema + executable validator + result schema + fixtures
  in contracts/v1. `qloops agent request.json` is the supported CLI entry point.
- qf.content-request/v1: `qloops content request.json`, concrete source/model/
  attribution-check/webhook adapters. Example below. Host API `runContent` allows
  explicit publisher/checker customization. It does not imply Telegram support.
- qf.content-state/v1: durable dedup/approval/receipt. `reconcilePublication`
  requires receiver lookup; an approval is not a fabricated delivery receipt.
- qf.quality/v1: explicit upstream pin, artifact revision/hash, requiredRules,
  per-rule findings/evidence, hard/soft split and browser evidence correlation.
- determined: immutable plan-time verifiers, AND of criteria, bounded repair;
  host provides scoped execute/verify/getArtifact callbacks and persistence.

## Canonical manifests

Site owns sdd-pipeline/content-factory/aindf-check/determined/unslop. Do not label
old qf.loop/v1 skeletons as executing the new capability APIs. The installed
agent command accepts sdd-pipeline@1.0.0 and synthetic-sdd@1.0.0 as its test alias.
Canonical capability manifests remain pending joint contract review; no automatic mapping of reserved YAML agent-call/check.
The site can expose capability launch instructions before canonical YAML support,
with pending acceptance clearly labeled.

New manifests need exact capability/package versions, origin/license, required
secret references, permissions, actual checker coverage and evidenceKind. Record
both package and framework versions for AINDF. Preserve unslop-design as an
explicit migration alias; never copy the canon or point to unrelated npm unslop.

## Concrete synthetic content request

```json
{
  "protocolVersion": "qf.content-request/v1",
  "requestId": "synthetic-content",
  "workspace": "/absolute/trusted/workspace",
  "allowedOrigins": ["http://127.0.0.1:8780"],
  "sources": [{"id":"source-1","url":"http://127.0.0.1:8780/source"}],
  "profile": {"tone":"concise, attribute every source"},
  "provider": {"kind":"claude","executable":"/usr/local/bin/claude","model":"sonnet","payerScope":"local-cli"},
  "receiver": {"kind":"webhook","url":"http://127.0.0.1:8780/receiver"},
  "deadlineMs": 90000
}
```

First call returns the draft/hash. Add `approval:{hash,decision:"approve"}` to the
same request. Receiver must return `{id,delivered:true}` and should honor the
Idempotency-Key header. Three synthetic localhost deliveries are tested; this is
not proof of Oleg's editorial profile or Telegram/LinkedIn delivery.

## Required Site/coordinator acceptance

1. Repin candidate and run package imports/callers in the Site test suite.
2. Rebuild immutable catalog with exact installed engine version and checksums.
3. Catalog -> install -> validate/run, composer -> validate/export, MCP shared
   validator tests. Check negative checksum/version/permission cases too.
4. Wire canonical capability manifests; fixture label cannot become live proof.
5. Complete CLI login/live SDD, real API evidence, controlled editorial channel,
   released upstream pins and browser evidence. Only coordinator accepts release.

Read-only check of Site's current export: all 11 legacy manifests validate;
Site now pins an earlier 0.2.0-core.1 snapshot (SHA b5a346c6eebddb05f1c62380b94ef4e2c4d4bb69a28024a8e7303fa3c0b78eb6). Final artifact SHA differs, so integration is pending-consumer-repin.
Run `node scripts/check-site-export.mjs /absolute/site-repo` to recheck without
writing Site files. Schema compatibility alone is not combined E2E acceptance.

Behavior changes: mutable default remote removed; legacy remote reads need
explicit catalog SHA256. New installed registry releases must match the engine
pin exactly. Nullable provider usage replaces invented zero in the public adapter;
legacy driver estimates remain explicitly labeled in README.
