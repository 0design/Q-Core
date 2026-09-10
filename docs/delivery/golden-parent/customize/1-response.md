Completed the read-only adaptation.

Changed:

- Created [webhook-relay-probe.yaml](/Users/oleg.design/PORN/projects/QFactory.io/repo/qloops/.qf/golden-parent/customize/webhook-relay-probe.yaml)
- Preserved catalog source `webhook-relay@1.0.0`, revision `e453b57`, SHA-256 `fcfef0…aba4a6`
- Removed the outbound `api-request`
- Configured GET-only access to `http://127.0.0.1:54423/data`
- Recorded source identity, version, and changes in the manifest
- Installed qloops `0.2.0-core.9` locally; contract revision `5`

Validation: manifest accepted as valid `qf.loop/v1`.

Actual run: successful, run ID `b0d18e13-eeed-45d4-82e6-f5df8aa95521`. Persisted output independently matched:

```json
{"project":"synthetic-qf","items":[1,2,3],"total":6}
```

Only one `fetch` step ran; no POST or external write occurred. No publication approval was needed.