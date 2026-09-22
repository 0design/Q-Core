# Migrate from A2D to `determined`

`determined` is the supported qloops successor for the execute → evidence →
verify → bounded-repair mechanics previously associated with A2D. It is a
library export for a trusted host, not a replacement SaaS or a renamed command.

Historical identifiers remain historical:

| Historical surface | Successor surface | Automatic compatibility |
| --- | --- | --- |
| npm package `a2done` | package `qloops` | No package alias |
| binary `a2d` | import `determined` from `qloops` | No `qloops a2d` command |
| MCP server/tool ID `a2d` | host callbacks around `determined` | No MCP alias or bridge |
| `.a2d` saved state | host-owned versioned `history` | No state import or rename |
| prior approval or completion claim | newly approved plan and fresh evidence | Never transferred |

Do not delete, rewrite, or import old `.a2d` data as part of migration.

## Supported migration

1. **Inventory the old plan without executing it.** Record each completion
   criterion, its verifier, allowed change scope, repair limit, and any human
   decision. Keep the source reference with the migration record.
2. **Create explicit `determined` criteria.** Every item needs a unique `id` and
   a plan-time `verifier` descriptor with a nonempty `type`. Do not convert an
   unknown check into a passing check. Human criteria use `type: "human"` and
   therefore remain `unknown` until handled outside this reducer.
3. **Implement the trusted host callbacks.** The host supplies `execute`,
   `getArtifact`, and `verify` exactly as documented in
   [`contracts/v1/determined.md`](../contracts/v1/determined.md). Keep trusted
   verifiers outside writable scope and hash the real artifact.
4. **Request a new approval.** Present the migrated criteria, verifier pins,
   allowed changes, limits, and host behavior to the authorized reviewer. An A2D
   approval does not authorize the qloops run.
5. **Run and regenerate evidence.** Accept success only when every criterion
   passes against one current artifact snapshot. Missing, stale, human, or
   exhausted evidence returns `needs_human`.
6. **Persist the new result under the host's qloops identity.** Store `planHash`
   and versioned `history`. Do not write qloops results into `.a2d` or infer a
   continuation from old donor state.

The installed package ships `examples/determined-caller.mjs`, which demonstrates
the supported integration with a real file artifact and independent Node verifier
subprocesses. Its executor is scripted test code; it is not model inference or a
migration utility.

## Required acceptance checks

A migrated caller is ready for review only when all of these are true:

- importing `determined` from the exact installed `qloops` package succeeds;
- the approved criteria and verifier descriptors produce the expected `planHash`;
- passing evidence names the exact artifact hash and revision;
- stale evidence, missing callbacks, human criteria, and an exhausted repair
  limit end in `needs_human`;
- `qloops a2d` is rejected and no `a2d` binary or MCP alias is exposed;
- `.a2d` state, old approvals, and old completion evidence are not imported;

Migration records belong to the host and are not runtime dependencies.
