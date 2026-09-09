# Core requirement audit — 2026-09-10

Previous continuation was concrete progress (native quality fixes, proofs, package,
commits and Linear changes). This continuation also made progress: registry graph
validation and installed-package download/validate/run proof. The full goal is not
complete; there is no claim of three consecutive blocked/no-progress turns.

Scope remains CORE-PROMPT.md + handoff README/CONTRACT + current Linear Core tasks
and runtime portions of shared tasks. Site/OD/donor files are not writable.

| Requirement / issue | Inspected authoritative evidence | Current conclusion |
| --- | --- | --- |
| Baseline, inherited edits, independent repo (99) | Git commits, inherited.sha256/patch, package-evidence.json | Local preservation/install complete; new packages separately hashed |
| HTTP reliability (100) | HTTP tests in full 123-test run; real localhost requests | Implemented; provider-specific live proof is separate |
| Provider/executor/verifier/policy contracts (38) | contracts/v1 schemas/docs, public exports, caller tests, SHA256SUMS | Core revision4 candidate ready; Site still explicitly pins revision2/core.2 |
| OpenRouter reusable adapter (147) | src/providers/openrouter.mjs, caller/transport tests; provider-availability.json | Local implementation; no process key or repository .env. Live OpenRouter acceptance missing |
| CLI provider (199) | codex-sdd-live.json, codex-package-live.json, codex-negative-live.json, specification-live.json | Authenticated Codex proof exists; old unavailable model explicitly replaced in new proof, never automatic fallback |
| Spec input/clarify/revise (137) | e364d7c/dba7437, spec tests, installed core.3 live proof | Implemented and locally verified; consumer integration remains review |
| Policy stops/scope/approval (160) | specification.test.mjs, agent/codex/workspace tests; live stale approval/failed verifier/cancel evidence | Tested local behavior, no deployment authorization; final consumer acceptance pending |
| SDD real change/resume (138) | real Codex installed-package spec→approval→file→6 assertions→cached resume | Local core path verified; shared final acceptance belongs to coordinator |
| Pinned registry download/init/run (75) | registry-package.json, 123 tests; exact Site export with retained core.2; current-engine mismatch; synthetic current pin | Local capability verified. Public Site registry route HTTP404; 74 confirms provisioning/licenses still pending |
| Old npm versions (101) | legacy-package-evidence.json plus refreshed legacy-metadata-current.json | Immutable historical artifacts still lack deprecated metadata. Mutation awaits separate release authorization |
| Content-factory runtime (104) | content runner/state/receipt tests, core.7 clean-installed live Codex draft + three actual localhost receipts | Reusable path implemented. Owner sources/voice acceptance135 still Todo; real test-channel receipts/config absent. Fixtures do not replace owner digest |
| determined/A2D (105/106) | installed determined-package.json, adversarial tests, shipped successor contract | Real local execute/fail/repair/pass demonstrated. Canonical integration and public donor instruction updates remain owner work |
| AINDF two modes (143) | native installed quality-package.json, real checksum/DS checks | Readiness and native composition good/bad verified. Released framework unavailable (npm E404); full rendered UI/unknown coverage not accepted |
| unslop canon/browser/recipes (39) | native pinned metadata/detection, actual browser CSS receipts, unknown/stale tests | Selected source-rule good/bad + browser proof ready. Full canon/taste and MCP recipe112 remain pending; 112 blocked by111/108 |
| Package/consumer handoff | artifacts/core.7, package-evidence.json, site-contract-evidence.json, revision.json | Exact installable package/hash, 11/11 Site manifest compatibility; this is not consumer repin approval |
| Archify requested earlier | preserved untracked docs/architecture/ and earlier browser proofs | Existing output preserved; no rewrite or deletion during Core work |

No npm publication, deprecation mutation, remote push, public registry creation,
production deployment, owner-channel post or donor edits were performed. These
require the external input/ownership/release steps listed above. Do not mark shared
issues Done from Core-only proofs. No unrelated credentials are searched for.

The remaining acceptance audit should confirm all owned live and negative cases
against their exact artifacts and resolve any concrete uncovered local runtime
work before concluding the goal is at an external impasse. In particular, do not
substitute broad “tests pass” for owner Content, OpenRouter or AINDF/recipe evidence.

Content continuation verifies the previously fixture-only model path with real
Codex; exact text/approval and three local receipts are recorded. No new local
implementation gap was found in the explicitly owned requirements after this
check. Remaining end-to-end acceptance still depends on the named owner/upstream/
release/consumer inputs. This is a progress turn, not yet a blocked-threshold claim.
