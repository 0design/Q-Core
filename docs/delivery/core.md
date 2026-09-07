# Core delivery candidate — 2026-09-07

Status: substantial local implementation delivered; **MVP/MLP release acceptance
is not complete**. Live authentication, consumer repin and upstream/browser gates
below remain open. No push, publish, deployment or public post occurred.

## Checkout and preservation

Owned repo: /Users/oleg.design/PORN/projects/QFactory.io/repo/qloops.
Branch: codex/qf-core-delivery. Starting HEAD:
9f6832722e8982f2e5ea51d5e112c65386062bd8.
Initial six dirty files match the handoff. Exact initial SHA256 values are in
inherited.sha256; tracked initial patch is in inherited.patch.gz. All six were
verified against staged bytes and preserved in commit **8f47212**. Baseline tests
were 55/55. New implementation is committed separately; final revision is in Git
and revision.json. No neighboring product or coordination file was modified.

## Delivered locally

- Versioned request/result/fixtures, separate provider/executor/verifier/policy.
- Shared OpenRouter adapter, legacy chatOnce wrapper, explicit payer/model,
  typed failures, bounded transport, actual identity and nullable usage.
- Claude 2.1.156 no-tools adapter, executable argv/stdin/cwd/env tests, preserved
  nesting guards, bounded output/deadline, descendant termination, JSON failure
  translation. Installed subprocess fixtures exercise the real caller chain.
- Intent -> versioned spec/criteria/plan -> hash approval -> exact-file execution
  -> independent executable verifier -> bounded repair. State/locks, explicit
  resume, changed-scope/artifact refusal, interrupted-apply reconciliation.
- Pinned independent registry installation, checksum/version/dependency checks,
  no overwrite, lock artifact, removal of implicit mutable remote fallback.
- Content sources/model/attribution checks/draft approval/receipt/dedup and
  receiver reconciliation. Three real localhost deliveries with a fixture model;
  failure and replay do not duplicate sends. No owner channel touched.
- determined with A2D plan-bound criteria, AND verification, stale-evidence
  rejection, limits and human outcomes. Quality adapters for AINDF readiness/
  composition and pinned Oleg canon, explicit coverage/hard/soft/recipe boundary.
- Local package candidate qloops@0.2.0-core.1, zero runtime dependencies, clean
  installation/exports/caller tests and read-only Site manifest compatibility.

## Evidence

Final test commands/counts: test-summary.json. Clean package: package-evidence.json.
Native upstream execution: upstream-evidence.json and upstreams.md.
Site export: site-contract-evidence.json (11/11 current YAML manifests valid;
new capability integration pending consumer repin). Live failures: live-evidence.json.
Old npm inspection: legacy-package-evidence.json: both 0.1.0/0.1.1 still have no
`deprecated` metadata and both `--help` invocations exit 1 with ExitSignal. They
also expose the old qf alias. No registry mutation was made. Deprecation requires
a separate release action/owner credentials; evidence supports reviewing it.

Tests distinguish real local HTTP/subprocess/filesystem actions, fixture inference,
native upstream code, and live inference. None implies owner or release acceptance.
No screenshots were captured when browser policy denied access.

## Install and run

```sh
npm install /absolute/qloops/artifacts/qloops-0.2.0-core.1.tgz
npx qloops agent request.json
npx qloops content content-request.json
npx qloops install /absolute/registry-export CATALOG_SHA256 loop-id 1.0.0 ./loop.yaml
```

Complete request/approval flow: ../../README.md and integration.md. From the source
checkout run `npm test`, `npm run test:package`, and
`node scripts/check-site-export.mjs /absolute/site-repo`.
After refreshing Claude with its own login flow, the explicit synthetic proof is:
`node scripts/live-sdd.mjs --approve-synthetic`. Without that flag it stops at spec
approval. It creates a new synthetic workspace under .qf and records request/result.

## Remaining gates and limits

1. Claude OAuth expired (real 401 despite loggedIn status). Owner was asked to
   reauthenticate. Real CLI success, negative-verifier and cancellation/resume
   live acceptance remain pending. No OpenRouter key exists in this process;
   controlled real OpenRouter evidence is also pending.
2. Site has adopted an earlier 0.2.0-core.1 snapshot, SHA b5a346c6eebddb05f1c62380b94ef4e2c4d4bb69a28024a8e7303fa3c0b78eb6. It must repin the final artifact and run its own
   composer/catalog/MCP callers plus canonical capability manifests. Core schema
   validation alone cannot approve that integration. See integration.md.
3. Real editorial sources/profile and three controlled owner-channel deliveries
   remain coordinator/0D-135 inputs. Implemented webhook receipt contract is not
   a Telegram/LinkedIn adapter or proof of owner editorial quality.
4. AINDF local RC package/framework versions differ and npm aindf is absent.
   Native RC adapter tests pass, but released-upstream acceptance is pending.
   UI adapter covers composition-contract, not arbitrary DOM compliance. Uncovered
   criteria stay unknown and need upstream/external verifiers.
5. Oleg's canon is pinned locally; unrelated npm unslop is not used. Real recipe
   MCP integration depends on 0D-112. Browser access was blocked because admin
   policy could not be verified. Full visual/taste acceptance remains open.
6. Permissions are local policy, not OS isolation. Only trusted executables,
   workspaces and upstream adapters are supported. Trusted host callbacks own
   persistence/cancellation when using generic determined/content APIs. Legacy YAML
   reserved agent-call/check kinds remain refused, not silently mapped to new APIs.
7. Cost reservations rely on caller/provider estimates; no billing guarantee.
   Site atomic $10 quota remains Site-owned. Source dedup uses source ID+URL;
   updated content under the same identity is intentionally not republished.

Initial estimate remains 5–7 working days Core MVP plus 3–4 Core MLP with external
inputs available. This session's local implementation does not validate that live
acceptance fits those dates. MVP14.09 is at risk until auth and integration clear;
MLP23.09 is retained as owner target, not silently narrowed or declared achieved.

## Handoff sources

Read CORE-PROMPT.md, README.md, CONTRACT.md in QFactory.io/context/handoff and
QFactory.io/CLAUDE.md. Current Linear document ce8f4720e540, initiative QFactory,
MVP/MLP milestones and issues 0D-38/99/100/101/147/160/137/138/75/104/105/106/143/39/199
were consulted. Progress/evidence is recorded in owned issues; cross-track issues
remain open for their final owner/coordinator.
