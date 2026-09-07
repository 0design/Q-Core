# Codex provider delivery — 2026-09-07

Implemented the user's requested subscription-backed Codex provider for SDD and Content-factory. This supersedes the earlier “Codex cannot be used as the inner model” limitation. Previous Claude/OpenRouter evidence remains historical and unchanged.

- Candidate: qloops@0.2.0-core.2, contract revision 2 (additive provider; qf.agent/v1 unchanged).
- Artifact: artifacts/qloops-0.2.0-core.2.tgz
- SHA256: eca09fc168d46aeba50bc1a915914082b25751fae1d926a335c06676713e59d2
- Tests: 100 passed, 0 failed. Clean package fixture install and live installed-package Codex roundtrip passed (see JSON evidence).
- Real Codex 0.153.4, requested gpt-5.4-mini, existing ChatGPT authentication: spec → approval → scoped edit → independent verifier → cached resume succeeded.
- Live intentional verifier failure returned needs_human, never success; cancellation returned cancelled, and resume returned the spec approval gate.
- Sandbox adversarial prompt produced no file. No file-change tool event was observed, so this is **not** claimed as live proof of an attempted write being denied. Tool-event rejection is covered by subprocess fixtures; the pinned read-only policy is enforced by Codex.
- Content-factory Codex integration passed local source/receipt receiver fixtures, including three deliveries, dedup and uncertain failure. No live channel publication was attempted.

## Consumer handoff

Site must repin the artifact above, request-schema hash from SHA256SUMS, and contractRevision 2; add codex to provider selection/validation and preserve local-cli payer scope. Import the public codex adapter from qloops; do not import neighboring source. The site currently pins core.1. All 11 current registry manifests pass Core validation, but consumer acceptance is pending repin and its own tests.

The package includes contracts/v1/codex-request.json and docs/codex.md with exact usage. The reviewed CLI path on this Mac is /Applications/ChatGPT.app/Contents/Resources/codex. The old /usr/local/bin/codex is rejected. No global CLI replacement, credential copying, API fallback, site edits, remote push or npm publication occurred.

## Product boundary

Uses existing ChatGPT/Codex allowance; no extra API key is required. Usage limits still apply and unknown dollar cost remains null. A scheduler can launch this workflow. The additional value is scoped approval, independent verification, bounded repair and resumable evidence; simple recurring prompts may already be served by built-in scheduling.
