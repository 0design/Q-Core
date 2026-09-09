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
