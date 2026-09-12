# QFactory Registry

This is the source for the Website registry: 11 loops, 7 components and 2 demos in the initial migration. Core runtime and Registry share this repository, but publish independently. Registry changes do not require an npm version bump. `package.json` excludes this directory from the npm package.

Edit the relevant asset and its entry in `catalog.source.json`, then run `node scripts/build-registry.mjs`. Commit the generated catalog and checksums together. CI checks the result. Open a pull request; checks and maintainer review precede publication. Do not provide production secrets to contribution checks.

Export a versioned snapshot with `node scripts/build-registry.mjs --export /absolute/output`. Website consumers pin the catalog SHA256 and verify each asset and the exact Core version. The root legacy `catalog.json` is not this Website snapshot.

These 20 initial materials use MIT (see LICENSE). Original author and origin metadata are retained. This grant does not cover unrelated site design, fonts or third-party assets. New contributions must include appropriate authorship and licensing; the current builder accepts MIT only.

The initial snapshot is a candidate. Historical examples are not live acceptance. Publishing this source does not establish npm availability, deployment or successful user execution of the pinned Core.
