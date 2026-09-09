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
