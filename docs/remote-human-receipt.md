# Signed remote human-decision evidence (candidate)

This module verifies a decision signed by an independently trusted human-review
service. It is a protocol utility, not an enabled approval transport.

It does **not** enroll a provider, contact Telegram, resume a human gate, install
a scheduler or authorize delivery. The existing terminal gate and agent-session
guard are unchanged. The module has no private-key/signing API.

## Request and receipt

A trusted host creates a request with `createRemoteApprovalRequest`. It binds the
run, gate, current subject hash, manifest hash, reviewer identity and provider
public-key fingerprint. A random request ID and 256-bit nonce distinguish
requests. The default lifetime is 15 minutes; the maximum is 24 hours.

The review service signs a canonical JSON body using Ed25519. Its receipt binds
every request field except `issuedAt`, adds a fresh receipt ID, an explicit
`approve` or `reject` decision and the decision timestamp. The complete envelope
is `{body,signature}`; signature is canonical standard base64. Object keys are
sorted, with no extra whitespace, using the same canonical JSON function as the
engine. Duplicate keys, extra fields and non-canonical encodings are refused.
All request/receipt fields are bounded strings or safe integer timestamps.
Review identity is a Telegram user ID encoded as a decimal string; no username
or display name is treated as identity.

`verifyRemoteApprovalReceipt` also requires the current trusted gate bindings,
the enrolled public key, the current time and a bounded snapshot of consumed
receipt IDs. It refuses a changed subject/manifest/reviewer, a different key,
tampering, an expired or future decision and a known replay. It returns frozen
verification evidence with `authorizationApplied:false`, deliberately without
the `channel` confirmation field accepted by the existing gate API.

The evidence proves a signature from the pinned provider. It does not
independently prove who clicked a Telegram button. That assertion must be
established by the enrolled provider's authenticated callback handling.

## Required integration before any live use

1. A person enrolls the trusted provider key and exact reviewer through the
   existing human-only setup boundary. A workflow or model must not supply or
   replace its own verification authority.
2. Persist the challenge before requesting review. Retry the same challenge
   idempotently; never generate a second notification on uncertain delivery.
3. The provider verifies the exact chat, user, card, subject and action. An edit
   creates a new subject/challenge and requires another human decision.
4. Persist receipt consumption atomically with the waiting gate transition
   **before** any effect. The snapshot check in this module is not an atomic
   replay ledger and must not be used as one.
5. Preserve the agent-session boundary. Source/report freshness, STOP and
   account/target permissions are rechecked by the publishing adapter.
6. Add the native host/transport, durable reconciliation and installed-consumer
   tests before proposing an accepted Registry entry or runtime release.

The module is not connected to `resumeRun` and its output is not a terminal
confirmation record. Do not forge a confirmation, clear agent markers, invoke
an approval command from an agent, or edit unsigned gate state to simulate this
integration.

## Verification

`node --test test/remote-human-receipt.test.mjs` uses locally generated
cryptographic fixtures. These are not real people, enrolled production keys,
Telegram callbacks, live approvals or delivery receipts. No external account
or service is contacted.
# Native enrollment and durable consumption candidate

`src/remote-human-host.mjs` adds a **separate, unpublished native candidate** on
top of the stateless verifier. It does not change `q-core approve`, remove agent
markers, upgrade installed Cores, or register an accepted Registry component.

- A person in their own terminal can use `q-core remote-human enroll <manifest>
  <policy-file>`. The policy contains only `publicKey` (public Ed25519 PEM),
  `endpoint` (canonical HTTPS, no credentials/query/fragment), literal Telegram
  `reviewerId` and `chatId`, and the exact current `manifestHash`. The existing
  one-time-code terminal confirmation displays these bindings. No private key or
  Telegram token is generated, accepted or stored by Core.
- `q-core remote-human request <manifest> <runId>` persists a challenge before
  any notification. It requires an enabled, flat host-created workflow with one
  sha256 human gate, matching enrolled manifest bytes and runtime step/settings
  snapshots. Nested/control-flow workflows and other approval formats are
  refused in this first candidate. Repeating a current request returns the same
  challenge without rewriting it; expiry creates a new challenge. Both paths
  validate the entire saved request against current bindings before reuse or
  rotation; corrupt state is refused rather than returned or silently replaced.
- `consumeRemoteHumanDecision(manifest, runId, receiptJson)` is a native library
  entry point for a separately operated human host. It refuses agent sessions.
  Under the workspace lock it reloads enrollment/run, verifies the exact current
  run snapshot and signed receipt, and replaces **one run file** containing both
  the terminal challenge and gate transition. Consumption is by challenge state,
  so another valid receipt ID for that challenge is also refused after restart.
  It returns `authorizationApplied: true, effectExecuted: false` after commit.
  It never calls `driveRun`, performs a network request or publishes.

Authority persistence refuses secret redaction, uses an exclusive private temp,
flushes the file, renames it and flushes its parent directory. Unsupported flushes
fail closed. A failure after rename can mean the transaction is already visible:
the future host must reload and reconcile, never assume rollback or execute from
an in-memory modified run. Stale workspace locks require inspection; this module
does not remove them. Existing ordinary `RunStore` persistence is unchanged.

Remaining integration: authenticated Telegram delivery/card callback and signing
provider, a human-host execution lease and poll/recovery loop, approval-service
adapter, current-source/STOP preflight at the effect boundary, compatible Registry
release and live account E2Es. The enrolled public key delegates callback identity
verification to its provider; a signature alone does not prove a particular chat
message was seen or approved. The current receipt protocol does not itself attest
a Telegram card ID or transport delivery. Unsigned local state is not protected
against a deliberately malicious process with the same OS user privileges.

Tests create new temporary workflows and ephemeral signing keys, use a simulated
terminal in an explicitly isolated fixture process, and send only to loopback or a
temporary local receipt file. They verify gate consumption, reject, replay with
two receipt IDs, source/config/provider changes, expiry, agent refusal, symlinks,
locks, persistence refusal and file/directory flush failure boundaries. An explicit
fixture driver after commit produces one local receipt and no duplicate on reload.
These are controlled tests, not the user's enrollment, decision or a live host.
