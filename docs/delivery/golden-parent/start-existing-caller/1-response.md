Core generated this specification through the pinned caller workflow.

Approval hash: `a8b9d3a3b4728dac17168801d02abc655f06aca432ee9b95607a171bc2ba0531`

It will:

- Modify only `tags.mjs`, only `normalizeTags(input)`.
- Trim/lowercase Unicode strings, remove empty/nonstring entries, deduplicate in first-seen order, and avoid mutation.
- Preserve `projectLabel` and the user comment.
- Run `/usr/local/bin/node verify-tags.mjs`.
- Leave all other files, Git history, and index unchanged.

Run ID: `ee004554-d629-43b3-b550-040dea16c398`

Please explicitly approve this exact specification.