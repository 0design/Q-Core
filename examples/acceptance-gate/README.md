# Independent acceptance: isolated pilot

This synthetic example separates a candidate from the authority that accepts it. It is an experiment on a dedicated branch, not a release, a production security boundary, or complete design-system conformance.

```text
Owner-approved task + Core + project Instance (trusted base)
  └─ contextSlice: all mandatory requirements and source digests
      └─ worker proposes bounded screen.json data
          └─ applyProposal: allowed path + previous hash + JSON only
              └─ candidate commit
                  ├─ scope check against frozen base
                  ├─ DS observations → independent review → signed review receipt
                  └─ actual Linear write/readback → signed sync receipt
                      └─ controller checks exact revisions and signatures
                          └─ operator publishes GitHub checks → PR for acceptance
```

## Core, Instance, extension

`ds.json` contains a tiny synthetic Core and one project Instance. Core owns registered components, role mappings and the foundations → semantic → component token chain. An Instance pins Core and registers project capabilities. An **extension is one capability inside an Instance**, not another name for the whole Instance. The shared discovery index and separate project DS packages are architectural direction; this fixture is not their production implementation.

The candidate selects `Button`, role `action`, variant `primary`, presentation `inline`, and optionally the Instance's `project-emphasis` extension. It cannot supply application styles, replacement HTML tags, new token values or waiver comments. The renderer is trusted DS implementation; its layout constants belong there, not in the candidate. This fixture only implements inline presentation, three elements and one extension. It does not claim overlay, Card patterns or the complete component taxonomy.

## Authority and evidence

- `contract.json`, `ds.json`, verifier code and public keys are read from the trusted **base commit**. The controller refuses to run if its own files differ from that base.
- Only `screen.json` may change. The worker interface accepts JSON data, an approved path and its previous hash. It exposes no shell, signing keys, GitHub token or Linear write capability.
- The controller binds receipts to base SHA, candidate SHA, contract digest, DS digest, verifier digest and candidate file digest. Missing receipts remain pending; forged, expired, rejected or stale receipts fail.
- Two separate Ed25519 keys attest review and synchronization. The operator signs only after receiving an independent review or verifying a real Linear write/readback. Keys stay outside the repository. A signed statement proves the attestor made it; it does not magically prove the review was correct or a remote service was read.
- The independent reviewer must inspect every applicable task requirement. **New DS detectors remain observational.** Their findings neither automatically accept nor reject the candidate. During this phase a reviewer confirms violations and rejects them; the absence of findings is not approval.
- `publish-github.mjs` recomputes the decision and checks the live PR's exact base/head before publishing. It cannot publish a worker-supplied “eligible” report. The three required contexts are `qgate/contract`, `qgate/review`, and `qgate/linear-sync`. `qgate/observations` is informative.

## Local reproduction

Requires Node 20+ and Git, with no package dependencies. Run from the repository root:

```sh
node --test examples/acceptance-gate/gate.test.mjs
node examples/acceptance-gate/controller.mjs REPOSITORY BASE_SHA HEAD_SHA OUTPUT_DIR RECEIPT_DIR
```

The second command runs **from a clean checkout of BASE_SHA**, inspecting HEAD_SHA as Git data. Missing receipts produce a report and a pending exit status (2), not a pass. Exit 0 means eligible for acceptance at the verification time; exit 1 means rejected or verification failed. Output includes the full context slice, observations, checks and a preview when the recipe is representable.

Receipt envelopes have `{ body, signature }`; signatures use canonical JSON from `gate.mjs`. Bodies contain schema `qgate.receipt/v1`, kind `review` or `linear-sync`, the full candidate binding, unique receipt ID, issued/expiry timestamps and SHA-256 evidence provenance. Review adds `independent: true` and `decision: approved|rejected`; synchronization adds `confirmed: true`. Synthetic tests use temporary keys. Real pilot receipts use the public keys in `trust.json`; the public evidence contains no private tracker data.

To publish from the trusted operator checkout after reviewing the actual evidence:

```sh
node examples/acceptance-gate/publish-github.mjs OWNER/REPO PR_NUMBER PILOT_BASE_BRANCH REPOSITORY BASE_SHA HEAD_SHA OUTPUT_DIR RECEIPT_DIR GITHUB_EVIDENCE_URL
```

This operation requires the operator's existing GitHub authentication. It supports only a branch named `codex/gate-pilot-base-*`. There is no merge or deployment command.

## Limits that must survive handoff

The data-only worker interface is a capability boundary, **not an OS sandbox for a full-power coding agent**. An operator or repository administrator can alter protection or sign a dishonest statement. A worker with the same account credentials could bypass this setup; production requires separate service identities, protected policy ownership, an isolated runner and app-bound checks. Those are outside this local pilot.

GitHub commit statuses persist after a receipt expires. They are a historical result, not a continuously renewed lease. Before any later acceptance, run the trusted controller again against current PR revisions and fresh evidence; this pilot never merges automatically. No always-on watcher or cloud controller is installed. Protected branch checks demonstrate missing/rejected → eligible results at measured instants, not perpetual freshness after the controller stops.

Test coverage is explicitly scoped to this synthetic task. A green result says nothing about untested components or unrelated projects. Rendered controls do not save account data.
