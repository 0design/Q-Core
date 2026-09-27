import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { hash } from "../src/contracts.mjs";
import { validateManifest } from "../src/manifest.mjs";
import { parseYaml } from "../src/yaml.mjs";
const root = resolve(process.argv[2]);
const catalogFile = join(root, "apps/web/src/data/catalog.json"),
  catalog = JSON.parse(readFileSync(catalogFile));
const pin = JSON.parse(readFileSync(join(root, "contracts/core.lock.json")));
const result = {
  evidenceKind:
    "read-only site export + Core validator; consumer integration NOT accepted",
  catalogSha256: hash(readFileSync(catalogFile)),
  release: catalog.releaseVersion ?? null,
  consumerPin: pin,
  installedCore: JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url)),
  ).version,
  manifests: [],
};
for (const entry of catalog.workflows) {
  try {
    const data = readFileSync(join(root, "apps/web/src/data", entry.file));
    if (entry.sha256 && hash(data) !== entry.sha256)
      throw Error("checksum mismatch");
    validateManifest(parseYaml(data.toString()));
    result.manifests.push({
      id: entry.id,
      status: "valid",
      sha256: hash(data),
    });
  } catch (e) {
    result.manifests.push({ id: entry.id, status: "failed", error: e.message });
  }
}
result.coreArtifactSha256 = hash(readFileSync(`artifacts/q-core-${result.installedCore}.tgz`));
result.integrationStatus =
  pin.version === result.installedCore && pin.artifactSha256 === result.coreArtifactSha256
    ? "awaiting-consumer-tests"
    : "pending-consumer-repin";
writeFileSync(
  "docs/delivery/site-contract-evidence.json",
  JSON.stringify(result, null, 2) + "\n",
);
console.log(
  JSON.stringify(
    {
      count: result.manifests.length,
      failed: result.manifests.filter((m) => m.status === "failed"),
      integrationStatus: result.integrationStatus,
      catalogSha256: result.catalogSha256,
    },
    null,
    2,
  ),
);
if (result.manifests.some((m) => m.status === "failed")) process.exitCode = 1;
