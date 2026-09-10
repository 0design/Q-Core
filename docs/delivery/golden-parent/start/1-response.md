QFactory accepted the request and paused for its required explicit specification approval.

Run ID: `47c9dd45-17ad-42a0-a917-b4b35071f532`  
Approval hash: `e23a2b201df2a37784b9fee5ec58774439ac7a530831d0e600e9f801f6e737c8`

Exact approved scope:

- Create only `tags.mjs`.
- Export named `normalizeTags(input)`.
- Trim/lowercase strings, including Ukrainian text.
- Drop empty and non-string entries.
- Deduplicate after normalization, preserving first occurrence order.
- Do not mutate input.
- Verify with the independent test covering ordinary, Ukrainian, duplicate, empty, non-string, frozen-input, and invalid-input cases.
- Provider: authenticated Codex, model `gpt-5.6-luna`.
- Verifier: local `/usr/local/bin/node verify-normalize-tags.mjs`.

Reply with explicit approval, for example: `Approve this exact specification.`