import { guardedWriteFileSync } from './persistence.mjs';
import { readFileSync, lstatSync, existsSync, mkdirSync, realpathSync } from "node:fs";
import { resolve, join, isAbsolute, dirname, basename, posix } from "node:path";
import { hash, insist, CoreError } from "./contracts.mjs";
import { parseYaml } from "./yaml.mjs";
import { validateManifest } from "./manifest.mjs";
import { MAX_CALL_DEPTH, MAX_MATERIALS } from './material-graph.mjs';
export async function readAsset(base, path) {
  insist(
    /^(catalog\.json|(?:workflows|components|demos|authors|examples)\/(?:[a-z0-9-]+\/)*[a-z0-9-]+\.(?:yaml|json|txt))$/.test(
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
        insist(e.file === `${section}/${e.id}.${section === "workflows" ? "yaml" : "json"}` || (section === 'components' && e.file === `components/${e.id}.yaml`), "Registry file must match its section and identity");
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
  const catalogVerified = new Set();
  const materialFiles = new Map();
  async function verifyMaterial(path, expected, ancestors = [], depth = 0) {
    insist(depth <= MAX_CALL_DEPTH, 'Nested material depth exceeded');
    insist(!ancestors.includes(path), 'Nested material dependency cycle');
    const bytes = materialFiles.get(path)?.bytes ?? await readAsset(base, path);
    insist(hash(bytes) === expected.sha256, `Artifact checksum mismatch: ${path}`, 'CHECKSUM_MISMATCH');
    const manifest = validateManifest(parseYaml(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
    insist(manifest.id === expected.id && manifest.version === expected.version && manifest.manifest === `q-core.${expected.kind}/v1`, `Nested material identity mismatch: ${path}`);
    if (materialFiles.has(path)) return bytes;
    if (!materialFiles.has(path)) {
      insist(materialFiles.size < MAX_MATERIALS, 'Nested material count exceeded');
      materialFiles.set(path, { bytes, manifest });
    }
    for (const ref of Object.values(manifest.dependencies)) await verifyMaterial(posix.join(posix.dirname(path), ref.path), ref, [...ancestors, path], depth + 1);
    const key = `${expected.kind === 'component' ? 'components' : 'workflows'}/${manifest.id}@${manifest.version}`;
    if (!resolved.some(record => record.path === path)) resolved.push({ key, path, sha256: expected.sha256 });
    return bytes;
  }
  async function verify(e, section = "workflows") {
    const key = `${section}/${e.id}@${e.version}`;
    insist(!visiting.has(key), "Dependency cycle");
    if (catalogVerified.has(key)) return;
    visiting.add(key);
    const path = e.file ?? `${section}/${e.id}.${section === "workflows" ? "yaml" : "json"}`;
    const bytes = await readAsset(base, path);
    insist(
      hash(bytes) === e.sha256,
      `Artifact checksum mismatch: ${e.id}`,
      "CHECKSUM_MISMATCH",
    );
    if (path.endsWith('.yaml')) await verifyMaterial(path, { id: e.id, version: e.version, sha256: e.sha256, kind: section === 'components' ? 'component' : 'workflow' });
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
    catalogVerified.add(key);
    if (!resolved.some(record => record.path === path)) resolved.push({ key, path, sha256: e.sha256 });
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
  const entryPath = entry.file ?? `workflows/${entry.id}.yaml`;
  const heights = new Map();
  const height = path => {
    if (heights.has(path)) return heights.get(path);
    const count = Math.max(0, ...Object.values(materialFiles.get(path).manifest.dependencies).map(ref => 1 + height(posix.join(posix.dirname(path), ref.path))));
    heights.set(path, count); return count;
  };
  insist(height(entryPath) <= MAX_CALL_DEPTH, 'Nested material depth exceeded');
  const installRoot = realpathSync(dirname(resolve(destination)));
  const targets = new Map([[join(installRoot, basename(destination)), bytes]]);
  const collected = new Set();
  const collect = path => {
    if (collected.has(path)) return;
    collected.add(path);
    const node = materialFiles.get(path);
    for (const ref of Object.values(node.manifest.dependencies)) {
      const childPath = posix.join(posix.dirname(path), ref.path);
      const relativePath = posix.relative(posix.dirname(entryPath), childPath);
      insist(!relativePath.startsWith('../') && !posix.isAbsolute(relativePath), 'Nested install path escapes destination');
      const target = join(installRoot, relativePath), childBytes = materialFiles.get(childPath).bytes;
      insist(!targets.has(target) || targets.get(target).equals(childBytes), 'Nested install path collision');
      targets.set(target, childBytes); collect(childPath);
    }
  };
  collect(entryPath);
  for (const target of targets.keys()) {
    insist(!existsSync(target), 'Dependency destination exists; refusing overwrite');
    let current = dirname(target);
    while (current !== installRoot) { if (existsSync(current)) insist(lstatSync(current).isDirectory() && !lstatSync(current).isSymbolicLink(), 'Unsafe dependency destination directory'); current = dirname(current); }
  }
  // Pinned material and its lock must preserve the bytes verified above.
  for (const [target, body] of targets) { mkdirSync(dirname(target), { recursive: true }); guardedWriteFileSync(target, body, { flag: 'wx', mode: 0o600, failOnRedaction: true }); }
  guardedWriteFileSync(
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
    { flag: "wx", mode: 0o600, failOnRedaction: true },
  );
  return {
    id,
    version,
    path: resolve(destination),
    sha256: entry.sha256,
    dependencies: resolved,
  };
}
