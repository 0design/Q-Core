> Revalidated 2026-09-10: actual source digests and native installed-package checks
> are in quality-package.json. npm aindf remains E404; unslop 0D-112 remains
> Backlog with upstream blockers. Browser checks now work on synthetic local UI:
> browser/ contains actual captures/receipts. This supersedes the old blanket
> browser-access blocker. AINDF rendered-composition and full canon/recipe
> acceptance are still separate. Core now refuses absent DS input, unsupported
> rule/file coverage, checksum drift, and preserves native severity.

# Upstream provenance and limits — 2026-09-07

AINDF inspected read-only at projects/oss/aindf/repo, HEAD
f9724b570d8997a01ddda648d9b6823ba1e3b27d. Package identifies itself as
`aindf@0.5.0-rc.1`; executable framework version is `0.3.0-rc.1`.
`npm view aindf version` returns 404. This is not proof of a released framework.
Adapter pins both identities plus executable/schema SHA256. Readiness calls the
upstream validator; UI composition calls upstream `validateComposition`.
Composition coverage is ONLY composition-contract: arbitrary rendered DOM, visual
quality and browser evidence need separate verifiers. Missing coverage stays unknown.
No AINDF code or schema is copied or rebuilt. Released-upstream acceptance pending.

Oleg's unslop inspected at projects/oss/unslop, HEAD
5185abfad2935ba0b8ee50b2e1e07446ad880db8, package version 0.1.0.
It exposes detect(path,{rules}), scanned count, rulesRun and findings.
The npm name `unslop@0.1.7` belongs to github.com/unslop/unslop, a different
repository: do NOT install it as Oleg's canon. Our adapter loads an explicitly
pinned caller-installed upstream directory, verifies scripts/references/package
hashes and never copies the canon. Unknown rule remains unknown.
Recipes are an explicit injected transport callback; no fictional MCP server.
Upstream 0D-112 remains a dependency. Browser/subjective acceptance stays pending.

A2D source inspected read-only at QFactory.io/context/_archive/a2d-disk/repo:
packages/core/src/core/engine.ts, verifiers/types.ts, plus extraction/MANIFEST.md.
`determined` preserves its plan-time verifier binding, AND completion, human
escalation, bounded continuation, and refusal of replacement completion evidence.
New Core orchestration additionally requires matching artifact hash/revision.
The implementation is a small independent reducer, not a donor code copy or a
resurrected service. Donor hooks, MCP server, shell-string execution, pricing and
hosted tiers are not inherited. Original code/history remains untouched.
Historical names stay in donor evidence. Current loop names: determined, unslop.
