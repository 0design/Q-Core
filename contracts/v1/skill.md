# Pinned skill execution — qf.skill/v1

`loadSkill({file,sha256})` reads an explicitly approved authored bundle contract.
`runSkill({skill,workspace,allowedPaths,maxRepairAttempts?,approval?,signal?},
{propose?})` executes and independently checks every required criterion through
`determined`. It does not infer complete criteria from arbitrary prose, claim
that a model is deterministic, or install a skill into a particular agent.

A bundle JSON has schema `qf.skill/v1`, id/version, instructions `{file,sha256}`,
and a nonempty unique `criteria` list. Each criterion has id, rule and verifier:

- `{type:"node",file,sha256,args,timeoutMs}`: a pinned, trusted, self-contained
  Node script independent from writable artifacts. Arguments are literal,
  cwd is the allowed workspace; 0 means pass, nonzero fail. Maximum 30 seconds
  and 16KB output. External script dependencies are not automatically pinned.
- `{type:"human"}`: an explicitly unmeasurable criterion; cannot auto-pass.

Relative bundle files cannot escape their root or use symlinks. Contract bytes,
instructions and verifier bytes are pinned and rechecked around execution and
verification. An omitted/unsupported verifier is rejected; callers cannot delete
criteria or substitute their own passing report after a failure.

`propose` receives a detached skill, criteria, current scoped files, attempt,
previous outcomes and AbortSignal. It returns only `{files:[{path,content}]}`.
Core validates and applies this proposal under a workspace lock, then hashes
actual artifacts. The caller does not supply verifier results. Omitting `propose`
verifies existing files, allowing review without repeating generation.

Only explicit allowedPaths may be changed through proposals; bundle/checker files
cannot be writable artifacts. The callback and Node verifier remain trusted local
code, not an OS sandbox. Callback deadlines/cancellation need a cooperative caller;
this wrapper cannot kill an arbitrary JavaScript promise. No credentials/provider
fallback, network model request, or automatic external publication is introduced.

Every machine criterion must pass on the same artifact snapshot. Failed rules
permit at most maxRepairAttempts (0–5); unknown/stale evidence or exhausted repairs
return needs_human. Proposed `accepted` or evidence fields are refused. Results
include accepted, status, skill version/hash, planHash, artifact hash/revision and
per-criterion attempt history. The host owns durable storage and crash recovery.

Subjective criteria produce nextAction `review_skill_artifact` with a binding hash
covering the skill contract, workspace/scope and exact artifact bytes. A trusted
human-facing host may send `{decision:"approve"|"reject",hash}`. Silence is not
approval. Reverify with no proposer after the explicit response. Changed artifact
or contract invalidates the prior decision. This API authenticates the binding,
not a person's identity; the integration must obtain and preserve real consent.

Run `node examples/skill-caller.mjs` from an installed package for a controlled
fault-injection example. It deliberately omits Risks, repairs it, and exercises
synthetic explicit review and stale-review rejection. The example uses real
subprocess checks on authored files, but does not call a model or obtain a real
human decision. This API does not add a Registry step kind or hosted fresh-chat
orchestration.
