# Core readiness and golden-path audit — 2026-09-10

Baseline: branch codex/qf-core-delivery, HEAD 9223f27; only inherited untracked
docs/architecture/. Implementation now ceb84ee, local core.8, contract revision 5.
No Site/shared-context/donor edits, remote push, npm mutation or publication.

**Latest owner sequence:** first stabilize all four Codex golden paths, then test
Claude Code at the end. The intermediate “without Claude now” instruction did not
remove Claude from final acceptance. Claude auth/nesting are deferred final gates,
not blockers to present Codex work. Keep 199 In Progress; do not claim Claude
support or reduce final scope. Codex is the active acceptance matrix below.

Authority: current handoff and GOLDEN-PATH.md, plus coordinator's explicit owner
clarification in this task: MVP requires both Codex and Claude Code and four entry
points. MLP retains accounts/private Registry, $10/month site generation,
Submit→GitHub PR, MCP and quality loops. Earlier local proposals to defer these
are not treated as accepted scope reductions. This report estimates Core, not the
Site implementation cost of those features.

## Evidence actually observed

- Baseline tests 123/123; after recovery fix 126/126, zero skipped, 7.71 seconds.
- core.8 clean-install: exports, manifest validation, approval-gate exit2,
  subprocess-fixture SDD execution and cached resume passed. package-evidence.json
  explicitly labels inference as fixture; it is not a fresh live Codex proof.
- Separately, fresh core.8 live Codex/gpt-5.6-luna clean-package proof passed:
  one clarification about addition behavior → recorded synthetic owner answer →
  exact specification approval → real file change → independent add(2,3) check →
  cached resume. codex-package-live.json has the same artifact SHA256 as core.8.
  The first attempt exposed a harness assumption (approve_spec immediately);
  scripts/test-package.mjs now handles up to three clarification rounds and saves
  questions/answers. This fixes the proof harness, not a hidden model failure.
  It is a local caller proof, not the four Site-prompts parent-session acceptance.
- Existing versioned live Codex evidence remains: installed SDD real change,
  independent verifier, clarification/revision and cached resume; core.7 Content
  generated three drafts with the actual Codex CLI and synthetic authored sources,
  then delivered to localhost after explicit synthetic approvals with dedup.
- New clean-installed core.8 actually invoked Claude Code 2.1.156 / model sonnet.
  Result: needs_human / AUTH_REQUIRED / configure_access, source unchanged,
  no successful inference or completed resume. claude-package-current.json.
- A guarded Claude parent session still returns UNSUPPORTED_NESTING before any
  child invocation. The new configure_caller action explains the required handoff;
  it does not implement or prove a broker, and guards are never stripped.
- Read-only Site export: 11/11 manifests valid, current consumer still core.2;
  pending-consumer-repin. This does not test prompts or an installed Site consumer.
- Existing determined installed proof uses actual file changes and subprocess
  verifiers, scripted executor. AINDF local RC readiness/composition checks and
  selected unslop native/browser CSS proof exist, not full visual acceptance.

## New four-entry acceptance matrix

All rows require the actual Site prompt/skill, pinned distribution, fresh user
agent conversation, initial folder snapshot, recorded clarifications/approvals,
real useful output, independent checks, negative case and repeat without damage.
The present scripts are supporting component proofs and do not fill these rows.

| Entry | Codex parent | Claude Code parent | Core/consumer dependency |
| --- | --- | --- | --- |
| setup: empty folder → first useful loop | Not demonstrated | Deferred final test; auth and caller guard | Public or explicitly staged pinned package + registry + Site skill; installation performed by parent |
| use: chosen SDD or Content loop → verified result | Component path only | Deferred final test | Canonical manifest routing, real editorial profile/receiver for Content |
| customize: existing project/loop → safe checked adaptation | Not demonstrated | Deferred final test | Site skill supplies intent/context; record before/after, unchanged user files and exact approval |
| create: discover/reuse/build missing components → runnable loop | Not demonstrated | Deferred final test | Real agent discovery/composition proof; manifest validation alone insufficient |

SDD's qf.agent/v1 runner accepts the documented SDD identities; it is not a generic
arbitrary-loop agent compiler. Creation/customization must demonstrate the actual
manifest/runner route chosen by the Site skill. No setup/use/customize/create CLI
commands are invented. A single initial prompt can include clarification and
approval in the same conversation; automated test approval is not owner acceptance.

## Changes completed independently in this audit

AUTH_REQUIRED, missing/rejected CLI, denied permissions and unsupported nesting
now yield actionable instructions to the calling conversation. SDD missing CLI
and recoverable Content access errors now return needs_human/exit2. Tests prove
auth recovery resumes the same SDD run but still requires explicit approval,
missing binary leaves source untouched, the nesting guard launches no child,
and Content missing provider/receiver auth sends nothing before recovery.
Contract revision 5 documents the result/status migration. Consumers must repin.

## Owner inputs versus engineering work

| Owner input / decision | Why needed | Work that remains with agents |
| --- | --- | --- |
| Restore Claude Code login locally | Current live adapter reports AUTH_REQUIRED | Repeat installed live SDD, negative/resume and real Claude parent acceptance |
| Approve actual sources/editorial profile and provide permitted test receiver configuration locally | Synthetic sources/localhost are not the owner's digest | Prepare profile, implement/configure channel bridge as needed, obtain three per-text approvals and real receipts |
| OpenRouter key and authorized test budget, or explicit deferral of that acceptance criterion | No live OpenRouter proof | Run bounded integration proof; do not substitute Codex silently |
| unslop hosting/access decision 111 and upstream provenance work 108 | Recipe MCP112 is an upstream dependency | Upstream agent builds service; Core integrates exact pinned contract |
| Separate final release decision | Handoff forbids npm/push/public registry/deploy without it | Finish integration and give exact artifact/provenance/release checklist before asking to publish |

No owner coding task is needed for Site repin, prompts, a supported Claude caller
design, golden-path runs, AINDF coverage or delivery documentation. Those are
engineering/coordination tasks. Login alone does not solve the Claude parent guard.
No unrelated secret store was searched and no credentials were recorded.

## Conditional planning range, not a release promise

- Active Codex stabilization/acceptance stage: about 1–3 working days once Site's
  compatible four-entry prompts/skill and the real Content test inputs are ready.
  Start this work without waiting for Claude authentication or caller design.
- Core MVP RC: about 3–6 working days after required access and a supported caller
  approach are available: caller/Claude compatibility 1–3 days, four-entry
  integration and negatives 1–2 days, real Content integration roughly 0.5–1 day.
  Upstream surprises can exceed this estimate; the ranges overlap and are not an
  exact sum. Waiting for owner inputs, public provisioning or upstream work is extra.
- Whole MVP: provisional 4–8 working days of coordinated work after dependencies;
  coordinator must combine this with Site's estimate. September 14 is at risk.
- Core MLP: another 4–8 working days after MVP and usable AINDF/MCP upstreams for
  quality coverage, canonical integration, repairs and evidence. AINDF rendered
  coverage is not already solved. This excludes Site accounts/billing/private
  Registry/composer/Submit/MCP implementation and any upstream release duration.
  September 23 full MLP is at risk; no whole-project date is justified by Core alone.

## Reproduce and consume

From qloops: npm test; npm run test:package;
node scripts/live-claude-package.mjs sonnet --approve-synthetic.
The last command currently exits2 and records the actual access blocker. It only
approves its newly created synthetic arithmetic task when a specification exists.
After authentication, it can prove change/three assertions/cached resume; it still
does not launch a Claude parent session or count as the one-prompt golden path.

Install artifacts/qloops-0.2.0-core.8.tgz with --ignore-scripts, pin its SHA256 from
revision.json and contract revision5. Handle configure_access/configure_provider/
configure_caller/review_permissions in the same user conversation; do not treat
needs_human as success. Keep old evidence with its original package identity.
