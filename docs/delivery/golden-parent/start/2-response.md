The approved run is retained but blocked during Codex execution:

- Run: `47c9dd45-17ad-42a0-a917-b4b35071f532`
- No `tags.mjs` was created.
- Authentication and CLI version checks passed.
- The exact pinned Codex invocation fails before inference with:

  `failed to initialize in-process app-server client: Operation not permitted`

This is an environment permission issue while Codex tries to create PATH aliases. I will not bypass nesting or permission guards, change providers, or alter the verifier.

Smallest next action: make the configured Codex CLI able to initialize in this workspace, then tell me to resume run `47c9dd45-17ad-42a0-a917-b4b35071f532`. The original checksum-check limitation remains recorded separately.