# Measured acceptance experiment · 2026-09-12

Trusted base: `6f6098e4d44be70fdc36ded6c3a9fa1f0ba3f904`.
Candidate A: `e13b5bf201f33aac8fef9f02f65d4a828d2598ee`.
Candidate B: `9130b71b9128f52549fee14ccd905dca9f5d8c4a`.
[Candidate PR](https://github.com/0design/qloops/pull/1) targets the protected pilot branch. Main remained `9f6832722e8982f2e5ea51d5e112c65386062bd8`. No branch was merged and no package was released.

| Experiment | Independent review | Sync | GitHub result |
| --- | --- | --- | --- |
| A, receipts absent | pending | pending | BLOCKED |
| A, raw style reviewed | rejected | confirmed | BLOCKED |
| B, replay A receipts | stale / failure | stale / failure | BLOCKED |
| B, correct review only | approved | pending | BLOCKED |
| B, correct review and sync | approved | confirmed | CLEAN at recorded time |

Each GitHub snapshot is an actual API readback. Required contexts are configured on the dedicated pilot branch, including for administrators. `MERGEABLE` alone means no Git conflicts; `mergeStateStatus` distinguishes BLOCKED from CLEAN. The test never called a merge endpoint. New DS detectors stayed observational throughout.

The operator constructed two synthetic proposals through the bounded data interface. A separate Cursor Ask run reviewed both exact candidate file hashes and each applicable requirement, and inspected the verifier against its documented scope. The JSON verdict is in `independent-review.json`. It rejected A and approved B. This is an actual separate reviewer run, not a production sandbox or proof that reviewers cannot make mistakes.

The operator signed review receipts only after reading that completed review. Synchronization receipts attest actual private tracker write/readback; public files include only its digest, not its contents or identifiers. Ed25519 public keys live at the trusted base. There are no private keys here. The operator and reviewer roles remain logically separated inside this local experiment; service-account isolation belongs to the next stage.

Validation: 38 focused tests (including real Git integration) and 35 pre-existing repository tests passed. Negative fixtures cover raw styles, HTML replacement, token overrides, waivers, unregistered/incompatible extensions, mapping/copy drift, changed policy, missing/forged/stale/expired receipts and unsafe proposals. Browser inspection confirmed native BUTTON, Core/Instance attributes, registered extension class, no inline style, and computed color `rgb(22, 77, 206)` from the token chain. No console errors were observed. `preview.png` and `preview.html` show the synthetic result; no account data is saved.

## Replaying the historical evidence

Use a clean checkout of the trusted base, with both candidate commits fetched. Run the verifier module from that base against the repository containing the commits. Point `receiptDirectory` at `A/` or `B/` in this evidence directory. The exported `verifyCandidate` accepts `nowMs`; to reproduce **historical** results use `Date.parse(summary.verifiedAt)`. To assess eligibility **now**, omit `nowMs` and obtain fresh review/synchronization evidence as necessary. Expired historical receipts should fail current acceptance.

The evidence branch must not become the execution source: its purpose is to preserve reports without moving the trusted base or candidate SHA. GitHub statuses do not expire automatically. This experiment has no always-on controller and performs no automatic acceptance after the recorded checks. A later merge needs fresh verification; CLEAN is not a perpetual guarantee.
