# Autonomous Core delivery — active, 2026-09-10

Objective remains all requested Core work and unblocked Linear tasks, excluding
Site changes. No complete/blocked goal claim has been made.

Baseline: df7019a; untracked docs/architecture/ from the user's Archify task is
preserved. Current Linear Core issues re-read. Baseline 99/100 exposed a race in
process termination assertion; the OS may finish delivering/reaping after the
parent closes. A bounded eventual-exit assertion now checks the real invariant.

Implemented this pass: imported spec input, durable question/answer clarification,
explicit CAS spec/scope revisions, new approval hash per revision, idempotent
replays, immutable prior spec history, rejecting late changes without destroying
cached success; MISSING_CHECKER human gate and deadline/limit human outcomes.
105 tests passed before the final small rejection of combined clarification/change
and documentation additions; final full validation still required.

Remaining active work: adversarial and live clarification/revision checks,
clean-installed real-task proof, full policy acceptance audit, versioned package
and consumer handoff; audit all currently unblocked shared Core portions in Linear
(104/105/106/143/39 plus labeled Core issues), verify public registry read/install
with current Site export read-only. Recheck external gates without inventing
credentials or bypassing publication restrictions. Prior source and channel access
limits must be revalidated rather than treated as permanently blocked.

Do not publish npm, mutate donor/Site repos, push or deploy under this autonomy.
Current source is a candidate; do not mark 0D-137 Done until all acceptance evidence
including real CLI and package paths is recorded. Existing core.2 artifact remains
untouched and identifies the earlier implementation only.

## Verified continuation — 2026-09-10

Candidate core.3 now passes all 108 tests and the clean-install package check.
The installed-package live specification proof passed on explicit gpt-5.6-luna:
clarification, spec revision 1→2, stale approval rejection, actual code execution,
6 independent checks, cached success, and import without model generation.
Evidence: specification-live.json; local artifacts/qloops-0.2.0-core.3.tgz
SHA256: 69a50ecc136ca90344f5f5e0204e51277d647572fe99f059b8fae01bfbed3851.

Current account rejects the formerly supported gpt-5.4-mini. No provider fallback
was added. MODEL_UNAVAILABLE now requests explicit provider configuration. The
pinned CLI emits a pre-turn error item for its intentionally disabled code-mode
host; only that exact reviewed diagnostic is accepted and recorded. Unknown
diagnostics, tool use, duplicate/reordered events still fail closed. New adversarial
tests cover classification, diagnostic handling and no-write provider human gate.

This completes the Core spec-workflow candidate proof, not the full autonomous
objective. Shared Core work and external release/integration gates listed above
remain to be audited and completed. Existing core.2 artifact and architecture maps
are preserved. No publish, push, Site or donor edits performed.

## determined continuation — 2026-09-10

Fixed mixed-revision evidence from mutable artifact readers, mutable previous
history passed to repairs, last-verifier cancellation and operational callback
failures. 112/112 tests; installed core.4 real file/subprocess repair proof passes
(1,1 → 0,0). Package SHA f509bcb00c7d04e22582b33d055c3ba697f08327f6f03fa00da7d0a157bcbfc2. Shipped callback contract and A2D successor
instructions added. Read-only Site check: 11/11 manifests valid, Site already
uses core.2 with its own Sep8 live proof; core.4 repin remains pending. See updated
core.md. This turn made concrete verified progress; full objective remains active.

## Quality continuation — 2026-09-10

Core.5 fixes mutable coverage/identity, report/checksum/DS pin binding, native
file-rule applicability and hard/soft mapping, cached-module root reuse, empty DS
vacuous pass, cancellation and malformed evidence. 119/119 tests. Clean-installed
native AINDF good/bad readiness and composition, unslop source+actual browser
captures, missing/stale/malformed/unsupported cases all verified. SHA 91a2ccf4adc1faea36c0177b4e48c2007435e5221c8925c5669d442b9157ace6.

Browser access works now on synthetic local UI; historical policy limitation is
not a current blanket blocker. AINDF npm recheck E404; unslop112 still blocked.
AINDF full rendered UI, released framework, MCP recipes and canonical consumer
acceptance remain pending. This turn made concrete verified progress.

## Registry continuation — 2026-09-10

120/120 tests; exact Site export on retained engine plus current synthetic catalog
pass clean-installed HTTP download/validate/run. Ambiguous dependencies and
malformed/mismatched metadata now fail before writes. Core.6 SHA 3b9958e08c78b9f98411b95f1069a4ed0a094b1b0127c70c1ea66516a084aaf9.
Public Site registry route404; Linear74 provisioning/licenses still gated. Old npm
0.1.0/.1 metadata lacks deprecation; OR key and own .env absent. Full requirements
audit added; no completed/blocked goal claim, since this turn made progress.

## Content live continuation — 2026-09-10

123/123 tests; core.7 clean-installed actual Codex creates three synthetic drafts,
explicit test-harness approvals deliver exact text to localhost, replay gives no
duplicates. SHA d23fa0f35d921894b89ffe51caf44be65a40f7aa00fc358c9db6356a75f8a573. Stale rejection and pre-send cancellation/body deadline
behavior fixed and tested. Owner135/channel acceptance still external. This is
concrete progress; no unfinished command sessions remain for this continuation.

## 2026-09-10: new golden-path scope audit

Implementation ceb84ee, core.8/revision5. 126/126 tests, installed fixture proof, real installed Claude AUTH_REQUIRED with source unchanged; explicit auth/CLI/caller/permission recovery added. Four-entry matrix, owner inputs and conditional estimates are in golden-path-audit.md. Previous blocked conclusion was for the earlier scope; new requirements add unproven Claude parent and one-prompt integration work. Site/shared files untouched; no public release.

Owner clarified order: stabilize Codex now, Claude final testing last; not a final scope reduction. Fresh core.8 Codex package live proof passed with one recorded clarification, approval, independent check and cached resume. Initial proof-harness immediate-approval assumption fixed with bounded clarification handling. Linear199 In Progress;38,138,104 updated.

## Content discoverability follow-up

core.9 / fe0d774 ships the exact Content request/approval/repeat/receiver contract and synthetic JSON example. npm run test:package includes clean installed example proof: fixture model, real localhost exact-text/receipt, missing-key/reject/stale/dedup/uncertain no-resend all passed. No runtime change; revision5 unchanged. Site received artifact/hash; current read-only pin8, 11 manifests valid. Real owner Content remains pending.

## Fresh parent acceptance and core.10

Five fresh parent sessions via HTTP: initial start SHA transcription fail; fresh updated-skill start recovered without hints. Actual customize/create outputs and repeats verified; Content/SDD blocked at nested Codex client IPC/startup permission. 0eec745 adds actionable error/runId preservation;128 tests and installed consumers pass. Full report golden-parent/report.md. Coordinator authorized two-phase caller mode next; no sandbox/broker workaround.
