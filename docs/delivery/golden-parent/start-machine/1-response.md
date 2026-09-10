QFactory reached its required approval checkpoint.

Please approve this exact specification for run `01770dcc-5db6-41eb-a3e9-f0f4be850dc1`:

- Create only `tags.mjs`
- Export named `normalizeTags(input)`
- Trim/lowercase strings, including Ukrainian characters
- Drop empty and nonstring entries
- Stable deduplication by first normalized occurrence
- Do not mutate input
- Run the independent verifier at `.qfactory/verify-tags.mjs`

Approval hash: `8fc38ed7a87d4b1de1a4bd4820d851cd3eba4ae62da8d16429a2921f5a8027cf`

Reply with approval of this exact specification to continue.