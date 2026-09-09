# Core delivery candidate — 2026-09-10

Current local package: qloops@0.2.0-core.4, contract revision 3 / qf.agent/v1.
SHA256: `f509bcb00c7d04e22582b33d055c3ba697f08327f6f03fa00da7d0a157bcbfc2`. Zero runtime dependencies. This is a local delivery candidate;
full MVP/MLP and cross-track acceptance remain open. No push/npm publication,
deployment, donor or Site mutation occurred.

## Verified current work

112/112 tests passed. Clean-install exports, validate, human gate, installed caller
and cached resume pass. The installed determined consumer uses real filesystem
changes and trusted Node verifier subprocesses: two failures → one repair → two
passes. Limit, stale evidence and human criteria remain needs_human. Adversarial
checks cover in-place artifact mutation, immutable plan/history, cancellation after
the last verifier, callback errors and invalid artifact revision progression.

Spec import, durable clarification and explicit spec/scope revisions were committed
in e364d7c; live package proof and current Codex compatibility in dba7437. The real
core.3 Codex ChatGPT proof covers clarification → revision 1→2 → stale approval
refusal → scoped code change → 6 independent assertions → cached resume and
import without inference. This evidence is core.3, not a claim of new live model
inference for core.4; core.4's new determined proof uses a scripted executor.

Codex currently works with explicit gpt-5.6-luna and CLI 0.153.4. The account now
rejects the previously supported gpt-5.4-mini. Missing model requests explicit
configuration; no automatic fallback. Existing read-only/tool-denial, auth,
bounded subprocess, cancellation and nesting protections remain enforced.

Evidence: specification-live.json, determined-package.json, package-evidence.json,
site-contract-evidence.json, SHA256SUMS; test output in .qf/autonomous-tests.log.
The earlier core.2 live SDD/failure/cancellation evidence remains separately dated.

## Consumer handoff

Site currently pins core.2 / contract revision 2, exact SHA
`eca09fc168d46aeba50bc1a915914082b25751fae1d926a335c06676713e59d2`.
Its lock records a 2026-09-08 live SDD consumer proof. This supersedes the earlier
statement that Site was still on core.1. Current read-only validation accepts all
11 catalog manifests. That does not approve a consumer repin or canonical loops.

Install the candidate from this repository:

```sh
npm install /absolute/path/to/qloops/artifacts/qloops-0.2.0-core.4.tgz
npx qloops agent request.json
node node_modules/qloops/examples/determined-caller.mjs
```

Consumer must pin the exact package and updated request/contract checksums in
SHA256SUMS, handle revision-3 question/revision/configuration outcomes, and run
its own catalog/composer/MCP and real scenario tests. Contract migration:
contracts/v1/specification.md and contracts/v1/determined.md. Canonical manifests,
UI and registry aliases remain Site-owned. No sibling source imports are required.

## Remaining work and gates

- Continue auditing all owned Core paths and shared runtime portions; this report
  does not close the autonomous objective or accept remaining policy gaps by default.
- OpenRouter real inference needs an authorized key/usage proof; last process
  inspection found no OPENROUTER_API_KEY. Codex success is not a substitute.
- Revalidate public registry availability and independent download/install/run;
  npm deprecation/publication requires a separate release decision.
- Content's real editorial profile/sources and controlled owner-channel delivery
  remain coordinator inputs. Local receipt/dedup proofs do not establish that.
- Revalidate released AINDF pin and required UI coverage; the last native evidence
  uses an RC and composition-only coverage. Uncovered rules remain unknown.
- Revalidate unslop upstream recipe MCP and browser acceptance; prior constraints
  do not by themselves prove a current permanent blocker.
- A2D successor instructions are now prepared in the shipped determined contract.
  Updating historical public donor instructions remains owner/release work.
- Generic callbacks are trusted host code. Host owns locks, deadlines, persistence,
  approval and crash reconciliation. No guarantee that arbitrary callbacks terminate.

## Preservation

Only qloops on codex/qf-core-delivery was edited. Baseline 9f68327; six inherited
changes were preserved in 8f47212 (inherited.sha256/patch). Existing core.1/.2/.3
artifacts were preserved. Untracked docs/architecture from the Archify task is
untouched. Coordinator retains final cross-track approval.
