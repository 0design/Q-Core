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
