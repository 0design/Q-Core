# Contribute to Q-Core

You can contribute a documentation fix, a bug fix, a Registry workflow or component,
or evidence from a real workflow. This guide takes you from a fork to a pull
request. You do not need access to the maintainers' internal tools.

For a small documentation fix, start directly with a PR. For a new runtime
capability or a substantial change, first [open an issue](https://github.com/0design/Q-Core/issues)
explaining the problem, expected result, and proposed scope. This helps avoid
building something the runtime cannot yet support.

## 1. Set up your fork

You need Git, a GitHub account, Node.js **20.3 or newer**, npm, and Python 3 for
Registry publication tests. The commands below use a POSIX shell (macOS/Linux
or WSL). The package currently has no dependencies; no `npm install` is needed.

1. Open [0design/Q-Core](https://github.com/0design/Q-Core) and click **Fork**.
2. Clone your fork, replacing YOUR-USERNAME below.
3. Create a branch from the current upstream main:

```sh
git clone https://github.com/YOUR-USERNAME/Q-Core.git
cd Q-Core
git remote add upstream https://github.com/0design/Q-Core.git
git fetch upstream main
git switch -c contribution/my-change upstream/main
node --version
npm --version
python3 --version
```

If you already have a clone, keep your local changes safe and use a new branch
or clean checkout. Do not reset existing work to follow these instructions.

## 2. Choose the right files

| Contribution | Where it belongs | What to include |
| --- | --- | --- |
| Documentation | The relevant Markdown page | The problem, clearer wording, and verification of commands you changed |
| Bug fix or runtime capability | `src/`, `bin/`, relevant `contracts/`, and `test/` | A reproducible case and tests covering the behavior |
| Registry workflow | `registry/workflows/<id>.yaml` and `registry/catalog.source.json` | Purpose, version, author, origin, license, exact compatible engine and dependency pins |
| Registry component | `registry/components/<id>.json` and catalog source metadata | Supported execution kind, contract, dependencies, and evidence; metadata alone does not implement an adapter |
| Demo evidence | `registry/demos/<id>.txt` and catalog source metadata | A reviewable result tied to an existing workflow template and exact versions |
| Author metadata | `registry/authors/<id>.json` | Attribution matching the catalog entry |

Read [Registry structure](../../registry/README.md),
[manifest support](../../SPEC-MANIFEST.md), and
[contribution policy](../../CONTRIBUTING.md) for the kind of change you are making.
Use existing entries of the same type as structural examples, but do not copy
another author's attribution or claim their evidence as yours.

`registry/catalog.json` is generated; edit source metadata and regenerate it
instead of editing it by hand.

Keep changes focused. Preserve unrelated files, source attribution, and license
information. Contributions ship under MIT; include only material you may share
under that license. Third-party assets and service terms remain separate.

## 3. Check your change locally

Run these from the repository root, one at a time:

```sh
node scripts/build-registry.mjs --check
npm test
python3 -m unittest discover -s test -p test_registry_publish.py
```

Success means exit status 0. These checks do not need model keys or production
credentials. They are not a substitute for running a real contributed workflow.

If you changed Registry assets or source metadata, first regenerate the catalog:

```sh
node scripts/build-registry.mjs
node scripts/build-registry.mjs --check
```

For a workflow, also validate your actual file (replace YOUR-WORKFLOW):

```sh
node bin/q-core.mjs validate registry/workflows/YOUR-WORKFLOW.yaml
```

### Check an exact downloadable Core/Registry pair

For a Registry change compatible with the pinned Core build, run the entire
block in the same terminal session:

```sh
candidate_dir=$(mktemp -d)
npm pack --ignore-scripts --pack-destination "$candidate_dir" --json > "$candidate_dir/pack.json"
core_archive=$(node -p "JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8'))[0].filename" "$candidate_dir/pack.json")
node scripts/build-registry.mjs --export "$candidate_dir/registry" --core-artifact "$candidate_dir/$core_archive"
node scripts/test-registry-export.mjs "$candidate_dir/registry"
```

This creates temporary files outside the checkout and exercises installation
and a controlled local workflow. It does not publish a release or deliver a real
digest. A catalog-only `--export` is insufficient to check downloadable Core
installation; include `--core-artifact`.

If you changed packaged Core files (including packaged documentation), their
archive bytes may no longer match the catalog's engine pin. Report that mismatch
in your PR. Do not weaken checksum checks or replace reviewed pins just to get a
green result. The maintainer coordinates the new reviewed Core/Registry pair;
mark a dependent PR as draft until its checks can pass.

### Evidence for a workflow

Describe the inputs, exact versions, actual result, and checks performed. Cover
failure/recovery and repeated execution where relevant. Distinguish a fixture,
a controlled local run, and a real external run. Leave unknown cost or token
counts unknown. Do not mark planned integrations as available, or claim a demo
is live unless its public result is actually reachable.

Never commit credentials or private drafts. Live external actions need the
appropriate access and permission; do not use a maintainer's credentials or
publish anything as part of ordinary PR checks. If delivery is uncertain,
reconcile it before retrying rather than risking duplicate side effects.

## 4. Open your pull request

Inspect the changes:

```sh
git status --short
git diff --check
git diff
```

Stage only the intended files, commit them, and push your branch to your fork:

```sh
# Replace the example paths with the files you intentionally changed.
git add path/to/changed-file path/to/another-file
git commit -m "docs: explain the change"
git push -u origin contribution/my-change
```

On GitHub, select **Compare & pull request**. Check that the base is
`0design/Q-Core:main` and the head is your fork's contribution branch. Follow the
[PR template](../../.github/PULL_REQUEST_TEMPLATE.md). Include:

- the problem and resulting behavior;
- commands you ran and their outcomes;
- exact versions/commit and evidence for behavior changes;
- any failing checks, missing access, or unverified behavior.

Use a **draft PR** when a step is incomplete or you need help. A clear failure
report is useful; do not hide it or disable checks.

## 5. Follow CI and review

Every pull request runs `validate / check`. Registry-related changes also run
`Registry / registry`, which uses a path filter. Both run without secrets and
with read-only permissions. Report your local checks in the PR as well.

For a first-time contributor, GitHub may require maintainer approval before CI
starts. Wait for that approval or mention the pending state in the PR. Do not
add secrets, broaden permissions, or alter workflows to bypass it.

The maintainer reviews the actual diff and results. Address feedback in the same
branch and rerun relevant checks. Contributors do not approve their own work on
behalf of the maintainer. Merge and release are separate: a merged change is not
necessarily published to the live catalog or installed by existing clients.

## Stuck?

Comment on your PR, or [open an issue](https://github.com/0design/Q-Core/issues)
if you could not reach the PR step. Include the step, your OS and tool versions,
what you expected, what happened, and the relevant error. Redact credentials and
private data. Suggestions that make this guide easier to follow are welcome.
