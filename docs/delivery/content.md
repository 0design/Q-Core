# Content Core live proof — 2026-09-10

Candidate core.7 closes the local live-inference gap: clean installed CLI → actual
Codex ChatGPT draft → source-attribution check → explicit test-harness approval →
exact-text localhost receiver receipt. Three authored synthetic sources produce
three drafts/deliveries; each replay returns no_new_sources without another send.
Evidence: content-package-live.json (exact artifact hash, outputs, text and receipts).
This is not Oleg's editorial profile, real news, Telegram/LinkedIn or owner acceptance.

Reproduce: `node scripts/live-content-package.mjs gpt-5.6-luna`. This intentionally
consumes existing Codex allowance and authorizes only the script's synthetic local
receiver. No API-key fallback or public send. CLI version/auth isolation is the
same reviewed Codex provider used by SDD.

Additional fixes: rejection now requires the current draft approval hash; old
rejections cannot cancel changed drafts. Content snapshots source/profile/provider/
receiver input before asynchronous callbacks. Optional signal is passed through
trusted generic callbacks, with cancellation checks before/after generation/checks
and before send. Deadlines also bound partial response bodies; pre-send timeout
returns needs_human/TIMEOUT/review_limits. Once sending starts, ambiguous results
still require receiver reconciliation and never trigger automatic resend.

Validation includes three new regression cases: stale rejection, pre-send/check
cancellation with detached inputs, and a real HTTP source that never finishes its
body. Existing rejected approval, missing key, receiver failure, missing receipt,
uncertain replay/overlap and receiver reconciliation tests still pass.

Remaining product gate: Linear135 is still Todo; no owner-approved source/voice
profile or authorized actual test-channel receipts have been supplied. The generic
receipt webhook is not a Telegram/LinkedIn API adapter. These remain explicit
integration requirements, not inferred from localhost success. No external post.
