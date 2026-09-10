Useful result completed.

Changed only `normalizeTags` in `tags.mjs`; it now trims, lowercases Unicode strings, removes invalid/empty values, deduplicates in first-seen order, and does not mutate input.

Validation and run evidence:

- Engine: `qloops 0.2.0-core.11`, contract revision 7.
- Artifact SHA-256 verified: `2a5a38b...b5851d6`.
- Run: `ee004554-d629-43b3-b550-040dea16c398`.
- Specification job: `ad3388eb-de91-48cd-8aa8-48198941a483`.
- File job: `3ab1adf6-75bf-45e2-b33b-c5621003bffc`.
- `verify-tags.mjs`: passed with exit code 0.
- Repeated completed run returned identical artifact/verifier evidence without another code change.

Preservation checks:

- `verify-tags.mjs` unchanged.
- README modification, staged `staged-plan.txt`, `settings.json`, `private-notes.txt`, Git HEAD, and index entries preserved.
- Only intended source change is `tags.mjs`; QFactory state/tool files are additionally present under untracked `.qf/`.

The artifact hash is `642c595605388adb5dc38e026cff5abbd59528fa9c020365a8139868040a5606`.