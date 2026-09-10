# Core delivery candidate — 2026-09-10

Current local package: qloops@0.2.0-core.9, contract revision 5 / qf.agent/v1.
SHA256: `e29bd27088fb478574074a44d373a3031284de12c6c1da5fa38b26956c28e461`. Zero runtime dependencies. This is a local delivery candidate;
full MVP/MLP and cross-track acceptance remain open. No push/npm publication,
deployment, donor or Site mutation occurred.

## Content discoverability delivery

Implementation fe0d774 / core.9 ships contracts/v1/content.md and
examples/content-request.json, linked from README and contracts index. Exact
request/approval/repeat/receiver/reconciliation behavior is available to installed
consumers without private source access. No Content JSON schema is claimed; the
document and executable installed-example proof define this delivery. No runtime
change; contract revision5 and earlier 126-test runtime verification remain.

npm run test:package now also verifies the shipped Content example from a clean
tarball install: fixture Codex inference + real localhost HTTP, exact-text receipt,
approval required, dedup, stale approval/rejection, missing key and uncertain-send
replay without another POST. All passed; content-contract-package.json records
artifact/doc/example hashes and outputs. Fresh live Codex evidence remains bound to
core.8; the new fixture proof is not owner Content or golden-path acceptance.
Read-only Site now pins core.8, 11/11 manifests valid; core.9 repin is still pending.

For Site engine discovery export both the contract and the example, preserving or
rewriting the relative link between them. Do not present synthetic localhost data
as configured owner sources, a connected channel or a confirmed publication.

## Golden-path audit and recovery continuation

Latest owner sequence: stabilize Codex first, test Claude Code at the end. Claude
is retained for final acceptance but does not block active Codex work. See the
current sequence and conditional stage estimate in golden-path-audit.md.

Implementation ceb84ee; 126/126 tests pass and clean-installed package smoke/caller
proof passes with fixture inference. Actual installed Claude2.1.156 invocation
returns AUTH_REQUIRED with source unchanged; new configure_access action makes the
next step explicit. SDD auth recovery requires approval, missing CLI requests
configuration and guarded nesting requests a supported caller handoff without a
bypass. Content local access failures now also request human configuration.

Fresh core.8 live Codex installed proof also passes separately: one clarification,
recorded synthetic answer, exact approval, real addition file, independent verifier
and cached resume. codex-package-live.json records the current package SHA256 and
clarification. The initial harness incorrectly assumed immediate approve_spec;
it now supports bounded clarification rounds. This is not four-entry acceptance.

The revised MVP explicitly requires Codex + Claude Code and four clean agent entry
points. These are not accepted by existing component proofs. See
[golden-path-audit.md](golden-path-audit.md) for the eight-case matrix, genuine owner
inputs, engineering dependencies and conditional MVP/MLP estimates. This audit
supersedes earlier claims that all remaining work is exclusively external: Claude
caller integration and four-entry acceptance remain substantive engineering work.
No whole-product release date or Done follows from 126 tests. Site remains on
core.2; read-only 11/11 manifest validation does not count as consumer acceptance.

The sections below retain historical evidence at each named package version.

## Content live continuation

Core.7 clean installed live Codex drafts: three authored sources, exact-text test
approvals, three real localhost receipts, no duplicates on replay. Evidence:
content-package-live.json; reproduction and limits in content.md. This fills the
previous fixture-only Content inference gap without pretending to be owner sources
or Telegram/LinkedIn acceptance. Rejected approval is now hash-bound; pre-send
cancellation and partial-response deadlines are tested. Ambiguous sends still
require reconciliation, with no automatic retry.

## Registry continuation

Installed-package HTTP proof in registry-package.json: exact read-only Site export
on retained core.2 → download → validate → real webhook-relay run; new engine
rejects the old pin. A separately labeled synthetic metadata-repin catalog tests
current core.6 download/validate/run, overwrite refusal and checksum failures.
Two requests reached only the controlled localhost receiver; no model or external
publication. Malformed/ambiguous dependencies, file identities and per-entry engine
drift are rejected before destination writes. See contracts/v1/registry.md.

Public Site API route /api/registry currently HTTP404. Linear74 confirms public
provisioning/licenses are pending. Old npm0.1.0/.1 metadata still lacks deprecation;
no mutation authorization is inferred. Refreshed evidence: public-registry-current,
legacy-metadata-current and provider-availability JSON. requirements-audit.md keeps
the full original scope and separates current local proofs from missing acceptance.

## Quality continuation

Core.5 installed native quality proof: AINDF readiness good→success, semantic
bad→failed, empty/malformed→needs_human; native composition good/bad→pass/fail
but no AINDF rendered-composition proof is claimed. Actual Codex browser captures
of synthetic unslop CSS examples give selected B-1 good→success / bad→failed.
Unknown rule, inapplicable HTML, missing browser evidence and checksum mismatch
remain unknown/human. Native severity is retained; orange/white findings are soft.

A report now needs exact upstream checksum and AINDF design-system digest. Native
loaders recheck content, reject changed module roots, and bind source subjects.
The RC's vacuous empty-DS pass and skipped-rule-count pass are explicitly blocked.
Current npm check still returns E404 for aindf. 0D-112 remains Backlog with external
blockers. Browser access itself is now proven on these local examples; full visual
quality, AINDF UI evidence, upstream release and MCP recipes remain separate gates.

Evidence: quality-package.json, browser/observations.json and both screenshot PNGs.
Migration: contracts/v1/quality.md (revision 4); old callback pin omissions now
return needs_human. Package proof: scripts/test-quality-package.mjs with explicit
installed AINDF, synthetic DS, and Oleg canon paths. No canon source is copied.

## Verified earlier runtime work

123/123 tests passed. Clean-install exports, validate, human gate, installed caller
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
inference for core.4; core.4's determined proof uses a scripted executor.

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
npm install /absolute/path/to/qloops/artifacts/qloops-0.2.0-core.7.tgz
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
