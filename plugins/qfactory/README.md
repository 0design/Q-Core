# QFactory plugin — R1 review candidate

This package connects the read-only QFactory MCP and a startup skill. It does not install Q-Core or run workflows automatically. The accepted task and current server instructions govern execution.

## Install the candidate from the public repository

The candidate lives on `codex/r1-outcome-copy` in public `0design/Q-Core`, not on its default branch. Clone that branch first so both clients use the same source:

```sh
git clone --branch codex/r1-outcome-copy --single-branch https://github.com/0design/Q-Core.git qfactory-r1
cd qfactory-r1
git rev-parse HEAD
```

Claude Code (run in this checkout):

```sh
claude plugin marketplace add .
claude plugin install qfactory@qfactory
claude plugin details qfactory
```

Start a new session, then invoke `/qfactory:start` with your task.

Codex supports adding a Git marketplace directly:

```sh
codex plugin marketplace add 0design/Q-Core --ref codex/r1-outcome-copy
```

Open `/plugins`, select the added marketplace and install QFactory. Start a new chat, then invoke `@qfactory` with your task. The local client's `codex plugin add qfactory@qfactory` is an additional supported CLI install path after registering this marketplace; clients without that command should use `/plugins`. `@q` is not an advertised alias.

## Checked for this candidate

- Codex plugin validator and skill validator: PASS.
- Claude plugin and marketplace validation: PASS (marketplace description warning only).
- Clean local Codex marketplace registration and install, using an empty isolated config directory: PASS.
- Clean local Claude marketplace registration, install and component inventory: PASS (one `start` skill, one `qfactory` MCP).
- Public HTTPS Git marketplace add and plugin install at exact source `f30eeb29090103d8f3dd5aa523aaed688785da6e`: PASS in an empty isolated Codex config, with global/system Git config disabled and terminal credential prompts disabled. Downloaded checkout HEAD matched that SHA; all seven payload checksums passed.
- These checks do not prove full live workflow execution or curated publication.

## Endpoint and evidence boundary

The distributed candidate deliberately points at `https://qfactory.io/api/mcp`. It reads the production revision dynamically. At the R1 check, production was r27; a successful production invocation is **not** evidence of stage r28. To test stage, use a separately generated local variant whose MCP and fallback URLs all target `https://stage.qfactory.io`; never overwrite this production package or advertise stage as production.

Check the actual returned revision, catalog and selected workflow before installing anything. If MCP is unavailable, the skill documents HTTP fallback and requires disclosing that route. A full workflow run remains separate from plugin discovery and instruction retrieval.

This is a public Git distribution candidate, not a listing in OpenAI's or Anthropic's curated directory. Curated submission and verified publisher identity remain pending owner acceptance; no listing is claimed.

## Source and bundle verification

`git rev-parse HEAD` identifies the checkout. Compare the plugin payload with `plugins/qfactory/bundle.sha256`:

```sh
sha256sum -c plugins/qfactory/bundle.sha256
```

On macOS, use `shasum -a 256 -c plugins/qfactory/bundle.sha256`. The checksum manifest excludes itself and this README; it covers both marketplace catalogs, manifests, MCP wiring and startup skill. No credentials are bundled.

Official installation references: [Codex plugin packaging](https://developers.openai.com/plugins/build/plugins), [Claude marketplace creation and installation](https://code.claude.com/docs/en/plugin-marketplaces).
