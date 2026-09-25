import { readFileSync, writeFileSync, lstatSync, existsSync } from "node:fs";
import { resolve, join, isAbsolute } from "node:path";
import { hash, insist, CoreError } from "./contracts.mjs";
import { parseYaml } from "./yaml.mjs";
import { validateManifest } from "./manifest.mjs";
export async function readAsset(base, path) {
  insist(
    /^(catalog\.json|(?:workflows|components|demos|authors|examples)\/[a-z0-9-]+\.(?:yaml|json|txt))$/.test(
      path,
    ),
    "Unsafe registry asset path",
  );
  if (/^https?:\/\//.test(base)) {
    const url = new URL(base);
    insist(
      !url.username &&
        !url.password &&
        !url.search &&
        !url.hash &&
        (url.protocol === "https:" ||
          ["127.0.0.1", "localhost"].includes(url.hostname)),
      "Registry requires HTTPS (HTTP is localhost-only)",
    );
    const response = await fetch(`${base.replace(/\/$/, "")}/${path}`, {
      signal: AbortSignal.timeout(10000),
      redirect: "error",
    });
    insist(
      response.ok,
      `Registry HTTP ${response.status}`,
      "REGISTRY_UNAVAILABLE",
    );
    const reader = response.body.getReader();
    let size = 0;
    const chunks = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 2000000) {
        await reader.cancel();
        throw new Error("Registry asset too large");
      }
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks);
  }
  insist(isAbsolute(base), "Registry must be absolute directory or HTTPS URL");
  let p = base;
  insist(!lstatSync(p).isSymbolicLink(), "Unsafe registry directory");
  for (const part of path.split("/")) {
    p = join(p, part);
    insist(!lstatSync(p).isSymbolicLink(), "Unsafe registry symlink");
  }
  insist(lstatSync(p).size <= 2000000, "Registry asset too large");
  return readFileSync(p);
}
const RELEASE_VERSION = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const isRemote = (base) => /^https?:\/\//.test(base);
const isLocalhost = (base) => isRemote(base) && ["127.0.0.1", "localhost"].includes(new URL(base).hostname);
/** Release version named by a `.../releases/<version>` Registry base (URL or directory), or null. */
export function releaseFromBase(base) {
  const path = isRemote(base) ? new URL(base).pathname : String(base ?? "");
  const match = /\/releases\/([^/]+)\/?$/.exec(path);
  return match ? match[1] : null;
}
/** Parse catalog bytes into an object or fail with a stable code (truncated/corrupt input). */
export function parseCatalog(bytes) {
  let catalog;
  try {
    catalog = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new CoreError("CATALOG_INVALID", "Catalog is not valid UTF-8 JSON (truncated or corrupt)");
  }
  insist(catalog && typeof catalog === "object" && !Array.isArray(catalog), "Invalid catalog", "CATALOG_INVALID");
  return catalog;
}
export async function loadRelease(base, sha256, { releaseVersion } = {}) {
  insist(/^[a-f0-9]{64}$/.test(sha256), "Explicit catalog SHA256 required");
  insist(
    releaseVersion === undefined || (typeof releaseVersion === "string" && RELEASE_VERSION.test(releaseVersion)),
    "Pinned release version is malformed (lowercase letters, digits, '.', '_' and '-' only)",
    "RELEASE_MISMATCH",
  );
  const fromBase = releaseFromBase(base);
  for (const name of [releaseVersion, fromBase])
    insist(!name || !/(?:^|[.-])(?:current|latest)$/i.test(name), `Release ${name} is a mutable alias, not an exact version`, "RELEASE_MISMATCH");
  insist(
    !releaseVersion || !fromBase || fromBase === releaseVersion,
    `Pinned release ${releaseVersion} differs from the Registry release path ${fromBase}`,
    "RELEASE_MISMATCH",
  );
  const expected = releaseVersion ?? fromBase;
  insist(
    expected || !isRemote(base) || isLocalhost(base),
    "Remote Registry requires a versioned .../releases/<version> base (q-core install also accepts --release <version>)",
    "RELEASE_REQUIRED",
  );
  const bytes = await readAsset(base, "catalog.json");
  insist(
    hash(bytes) === sha256,
    "Catalog checksum mismatch",
    "CHECKSUM_MISMATCH",
  );
  const catalog = parseCatalog(bytes);
  insist(
    typeof catalog.releaseVersion === "string" && catalog.releaseVersion.trim() && Array.isArray(catalog.workflows),
    "Versioned release required",
    "CATALOG_INVALID",
  );
  insist(
    !expected || catalog.releaseVersion === expected,
    `Catalog release ${catalog.releaseVersion} does not match the pinned release ${expected}`,
    "RELEASE_MISMATCH",
  );
  insist(
    catalog.core?.manifest === "q-core.workflow/v1",
    "Incompatible manifest contract",
    "ENGINE_INCOMPATIBLE",
  );
  const pkg = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  );
  insist(
    catalog.core?.package === "q-core" && catalog.core.version === pkg.version,
    "Registry must pin installed engine version",
    "ENGINE_INCOMPATIBLE",
  );
  const seen = new Set();
  for (const section of ["workflows", "components", "demos"]) {
    insist(catalog[section] === undefined || (Array.isArray(catalog[section]) && catalog[section].length <= 1000), "Invalid registry section");
    for (const e of catalog[section] ?? []) {
      insist(e && typeof e === "object" && !Array.isArray(e), "Invalid registry entry");
      insist(e.dependencies === undefined || (Array.isArray(e.dependencies) && e.dependencies.length <= 100 &&
        e.dependencies.every(d => d && typeof d.id === "string" && /^[a-z0-9-]+$/.test(d.id) &&
          /^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(d.version ?? ""))), "Dependencies require exact identities");
      if (e.file !== undefined)
        insist(e.file === `${section}/${e.id}.${section === "workflows" ? "yaml" : "json"}`, "Registry file must match its section and identity");
      insist(
        typeof e.id === "string" && /^[a-z0-9-]+$/.test(e.id) &&
          /^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(e.version ?? ""),
        "Invalid registry identity",
      );
      insist(!seen.has(`${section}/${e.id}`), "Duplicate registry identity");
      seen.add(`${section}/${e.id}`);
      insist(typeof e.sha256 === "string" && /^[a-f0-9]{64}$/.test(e.sha256), "Missing artifact checksum");
      if (e.engine !== undefined)
        insist(e.engine?.package === catalog.core.package && e.engine?.version === catalog.core.version &&
          e.engine?.manifest === catalog.core.manifest, "Entry engine differs from release pin", "ENGINE_INCOMPATIBLE");
    }
  }
  return catalog;
}
export async function installPinned({
  base,
  catalogSha256,
  id,
  version,
  destination,
  releaseVersion,
}) {
  const catalog = await loadRelease(base, catalogSha256, { releaseVersion });
  const entry = catalog.workflows.find((e) => e.id === id && e.version === version);
  insist(entry, "Pinned workflow not found", "VERSION_NOT_FOUND");
  const resolved = [];
  const visiting = new Set();
  async function verify(e, section = "workflows") {
    const key = `${section}/${e.id}@${e.version}`;
    if (resolved.some((x) => x.key === key)) return;
    insist(!visiting.has(key), "Dependency cycle");
    visiting.add(key);
    const path = e.file ?? `${section}/${e.id}.${section === "workflows" ? "yaml" : "json"}`;
    const bytes = await readAsset(base, path);
    insist(
      hash(bytes) === e.sha256,
      `Artifact checksum mismatch: ${e.id}`,
      "CHECKSUM_MISMATCH",
    );
    for (const dep of e.dependencies ?? []) {
      const matches = [
        ...(catalog.components ?? []).map((e) => [e, "components"]),
        ...catalog.workflows.map((e) => [e, "workflows"]),
      ].filter(([x]) => x.id === dep.id && x.version === dep.version);
      insist(
        matches.length > 0,
        `Unresolved pinned dependency: ${dep.id}`,
        "VERSION_NOT_FOUND",
      );
      insist(matches.length === 1, `Ambiguous pinned dependency: ${dep.id}`, "AMBIGUOUS_DEPENDENCY");
      await verify(...matches[0]);
    }
    visiting.delete(key);
    resolved.push({ key, path, sha256: e.sha256 });
    return bytes;
  }
  const bytes = await verify(entry);
  const parsed = parseYaml(bytes.toString("utf8"));
  validateManifest(parsed);
  insist(
    parsed.id === id && parsed.version === version,
    "Manifest identity mismatch",
  );
  insist(
    !existsSync(destination) && !existsSync(destination + ".lock.json"),
    "Destination exists; refusing overwrite",
  );
  writeFileSync(destination, bytes, { flag: "wx", mode: 0o600 });
  writeFileSync(
    destination + ".lock.json",
    JSON.stringify(
      {
        protocolVersion: "qf.registry-lock/v1",
        base,
        catalogSha256,
        releaseVersion: catalog.releaseVersion,
        id,
        version,
        resolved,
      },
      null,
      2,
    ) + "\n",
    { flag: "wx", mode: 0o600 },
  );
  return {
    id,
    version,
    path: resolve(destination),
    sha256: entry.sha256,
    dependencies: resolved,
  };
}
