# Core capabilities introspection

`coreCapabilities()` is a synchronous, read-only API for consumers of the
installed `q-core` package. It reads the installed `package.json`, the shipped
contract metadata in `contracts/v1/version.json`, and the provider/secret-store
exports. It does not use the network, launch a model or CLI, resolve a secret,
or return authentication values.

The returned object has this execution contract:

| Field | Meaning |
| --- | --- |
| `schema` | Introspection shape: `qf.capabilities/v1`. |
| `packageVersion` | Actual installed package version. |
| `manifestProtocol`, `agentProtocol`, `contentProtocol` | Protocol namespaces supported by this Core package. |
| `contractRevision` | Revision from the single machine-readable contract metadata file. |
| `providerKinds` | Provider kinds accepted by Core request validation. |
| `reviewedCliVersions` | Reviewed local CLI versions keyed by provider. |
| `secretStore.platforms`, `secretStore.modes` | Supported protected-store platforms and secret source modes. |

The API reports local package support only. It does not assert hosted MCP
instructions, deployment, authentication, or registry availability. Consumers
must compare the installed `packageVersion` and `contractRevision` with their
own pinned compatibility record before using the corresponding contract.
