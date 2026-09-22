# Codex subscription provider

The Codex provider is available to both `qloops agent` (SDD) and `qloops content`.
It uses a **new local Codex CLI session** with the existing ChatGPT login. It does
not re-enter the parent agent's conversation.

## Run it

1. Use an absolute path to a Codex CLI version supported by the installed package.
   Read `coreCapabilities().reviewedCliVersions`, then verify `--version` and
   `login status` using that exact executable. ChatGPT login is required.
   Unsupported versions are rejected.
2. Copy `contracts/v1/codex-request.json`. Set your absolute workspace,
   executable, explicit model, allowed files and trusted verifier command.
3. Run `qloops agent request.json`. Review the returned specification and scope.
4. Add the returned `resumeRunId` and
   `approval: {"hash":"RETURNED_HASH","decision":"approve"}` to the same request.
   Run it again. Core applies only the scoped file contents and runs the verifier.
5. Repeat the approved request to resume. A completed run returns cached success
   only if artifact hashes still match. Changed scope/verifier requires new approval.

The direct text adapter is also exported:

```js
import { codex } from 'qloops';
const result = await codex({
  executable: '/absolute/path/to/codex',
  model: 'gpt-5.6-luna',
  messages: [{ role: 'user', content: 'Summarize this supplied text: ...' }],
  timeoutMs: 60000,
});
console.log(result.content);
```

For Content-factory use the same provider descriptor in a
`qf.content-request/v1` request. Draft approval and receiver receipts remain
required; selecting Codex does not authorize publication.

Imported specifications, clarification questions and explicit specification
revisions are described in [the workflow contract](../contracts/v1/specification.md).
The model in the example is an explicit selection, not an automatic fallback. An
unavailable model returns `MODEL_UNAVAILABLE` and requests `configure_provider`.
Choose a supported model explicitly for a new run.

## Execution boundary

A parent environment can deny the nested CLI's in-process app-server
initialization before inference. Version and ChatGPT login can pass while
execution still fails. qloops returns
`CLI_ENVIRONMENT_DENIED` / `needs_human` / `configure_caller` for this startup
denial and preserves run correlation. Do not remove sandbox or nesting guards,
copy credentials, or silently switch payer or provider. A supported caller
arrangement is required; the error action does not provision a broker.

The adapter checks the exact CLI version and ChatGPT authentication before
inference. It supplies bounded messages through stdin and parses bounded JSONL;
there is no shell interpolation or automatic API/model/provider fallback.
`CODEX_HOME` is preserved when set; credentials are never read or copied by
qloops. API keys and the caller's session identifiers are not passed through.

Each call uses an ephemeral session in a disposable working directory outside
the target workspace. User config and project instructions are not loaded;
hooks, plugins, apps, shell, browser and delegation features are disabled.
Approval escalation is disabled and the Codex sandbox is read-only. Existing
execpolicy rules and managed constraints are not deliberately bypassed.

Codex still exposes some model-dependent utility/apply-patch tools. This is not
a claim that its tool catalog is empty: file modifications are denied by the
read-only sandbox and any tool event makes the provider result fail. Only
returned text can reach Core's approved file executor. Run this local integration
only with a trusted CLI installation and workspace/verifier.

Missing executable, unsupported version, expired/API auth, permission/tool events,
unavailable models, malformed/incomplete output, quota failure, timeout and cancellation are typed
failures. Cancellation terminates the process group. `QLOOPS_DEPTH` and existing
Claude nesting guards are retained. No retries of failed inference are hidden
inside qloops; the pinned CLI can perform bounded internal transport retries.

## Usage

ChatGPT authentication uses subscription access; API-key authentication uses
separate API billing. This adapter requires the former. Existing allowance and
limits still apply; qloops does not promise free or unlimited inference.
[Official authentication documentation](https://learn.chatgpt.com/docs/auth).

Token usage comes from Codex's completion event. Dollar cost and actual resolved
model identity are unknown (`null`), not zero or guessed from the requested model.
`requestedModel` records the selection. Dollar-capped orchestration blocks later
calls after unknown cost; subscription users can use deadlines/repair bounds.

[Official headless/JSONL reference](https://learn.chatgpt.com/docs/non-interactive-mode).
