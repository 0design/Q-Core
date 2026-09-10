# Fresh parent Codex proof — 2026-09-10

Five fresh sessions: the four exact Site candidate prompts, plus a fresh start
after the Site skill's machine-checksum clarification. Initial prompt bytes/hashes
are retained per directory; later inputs are explicitly synthetic test-owner
clarifications/approvals, not Oleg's editorial acceptance. CLI0.153.4, model
gpt-5.6-luna, existing ChatGPT login, workspace-write/network-enabled shell,
disabled user config/hooks/apps and ordinary policy rules retained. Each empty
workspace is isolated under qloops/.qf/golden-parent. No sibling runtime imports;
parents fetched skill/catalog/engine/documents/tarball through localhost3101 HTTP.
All parent runs used core.9/revision5, catalog2026.09.10-site.3. No fresh core.10
parent success is inferred from these records.

| Entry | Actual result | Limitation |
| --- | --- | --- |
| start, initial skill | Agent manually omitted one SHA character and stopped; assisted recheck then reached spec approval | Original unassisted failure retained, not overwritten |
| start-machine, updated skill | Programmatic checksum verification, install, task clarification and exact SDD approval passed; nested Codex startup denied before tags.mjs | Verifier bytes unchanged, no artifact, no SDD completion |
| use / Content | Installed package, discovered content-factory and its shipped request contract; fetched synthetic source; no draft or POST | Same nested local client startup denial; retained state but core.9 error lost runId in response |
| customize | Adapted webhook-relay to one read-only GET; original SHA preserved; real retained JSON independently matched; repeat passed with unchanged manifest | Parent preserved original only at shared /private/tmp/webhook-relay.yaml, not durably in the project; audit archived a copy afterward |
| create | Composed reusable two-GET loop from supported fetch steps; actual JSON independently verified; separate HTTP422 variant failed; repeat left good manifest unchanged | Simple synthetic composition only, not arbitrary custom component support; not all provenance/pin bookkeeping was persisted |

Independent checks are in independent-checks.json and copied actual artifacts.
Receiver log records zero POSTs. Content exact-text delivery remains untested in
this parent environment. Existing-project preservation was not exhaustively tested:
the starting folders were empty. No four-of-four or owner Content pass is claimed.

Self-recovered agent mistakes include default npm cache EPERM (used project-local
cache), a rejected recursive removal (used a fresh directory), a shell variable
that shadowed PATH (corrected), and reading the last-run summary instead of full
step evidence (corrected lookup without weakening semantic assertions). These
show additional steps in the real journey, not automatically a product failure.
HTTP Site preview was briefly restarted by its owner during the test; the pin
remained unchanged. Parent turns and raw events make the sequence reviewable.

## Blocking boundary and fix

Both SDD after approval and Content before drafting actually fail at the nested
Codex in-process app-server client with Operation not permitted. Version/login
checks pass. A PATH-alias warning also appears; its causal role is unproven.
No sandbox/nesting guard was disabled, no credentials copied and no provider
fallback attempted. core.10/0eec745 now maps this observed startup diagnostic to
CLI_ENVIRONMENT_DENIED / needs_human / configure_caller and retains Content runId.
128/128 runtime tests and installed package consumers pass. This diagnostic fix
does not make the denied nested environment work.

See ../caller-arrangement.md for the concrete two-phase caller-inference proposal.
Coordinator subsequently authorized implementing this as the internal mechanism
for the already requested one-prompt MVP; no claim of owner approval of individual
API fields. The existing CLI mode remains explicit and unchanged.
