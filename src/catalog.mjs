/**
 * The catalogue — one file that both the CLI and the website read.
 *
 * `catalog.json` is GENERATED from the manifests, never hand-written. A
 * catalogue maintained by hand drifts from the loops it describes within a
 * month, and the drift is invisible: the page keeps claiming four steps after
 * the manifest grew to six.
 *
 * WHAT IS DERIVED, and therefore cannot lie: step count, the kinds used, whether
 * a human gate is present, which environment variables the loop needs, the model
 * and the budget ceiling.
 *
 * WHAT IS MEASURED: cost per run and tokens. These come from a REAL recorded run
 * committed next to the manifest (`examples/<id>.run.json`) — not from an
 * estimate. A loop with no recorded run says `measured: null` rather than
 * guessing, because "about a cent" is exactly the kind of number a reader would
 * hold us to.
 *
 * catalogVersion 2 adds two more sections, also generated:
 *   components  — contracts in `registry/components/`
 *   demos       — named runs in `registry/demos/`, each pointing at a loop
 */
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join, basename, dirname } from "node:path";
import { loadManifest } from "./manifest.mjs";
import { flattenLoopSteps } from "./flatten.mjs";
import { resolveKnobs } from "./run.mjs";
import { loadRegistry, enrichComponent, enrichDemo } from "./registry.mjs";

/** Every `{{env.NAME}}` a manifest depends on, in first-seen order. */
export function envRefsOf(manifest) {
  const found = [];
  const walk = (steps) => {
    for (const s of steps) {
      for (const v of Object.values(s.config ?? {})) {
        for (const m of String(v).matchAll(/\{\{\s*env\.([A-Z][A-Z0-9_]*)\s*\}\}/g)) {
          if (!found.includes(m[1])) found.push(m[1]);
        }
      }
      if (s.then?.length) walk(s.then);
    }
  };
  walk(manifest.steps);
  return found;
}

/** One catalogue entry, derived from the manifest plus any recorded run. */
export function describeLoop(file, { examplesDir } = {}) {
  const m = loadManifest(file);
  const knobs = resolveKnobs(m.settings);

  /* Walk the WHOLE tree, not the flattened one. `flattenLoopSteps` deliberately
     omits the lane of a configured fan-out — its size is unknown until the
     source step has run. That is right for execution and wrong for a catalogue:
     a loop whose only model call lives inside a lane would be listed as needing
     no key, and a reader would install it and hit the failure we could have
     told them about. */
  const all = [];
  const walk = (steps) => {
    for (const s of steps) {
      all.push(s);
      if (s.then?.length) walk(s.then);
    }
  };
  walk(m.steps);

  const flat = flattenLoopSteps(m.steps);
  const kinds = [...new Set(all.map((s) => s.kind))];
  const gates = all.filter((s) => s.kind === "approval-gate");
  const lanes = all.filter((s) => s.kind === "fan-out" && String(s.config?.over ?? "").trim());

  const needsModel = kinds.includes("llm-call") || gates.some((g) => g.config?.reviewer === "agent");
  const env = envRefsOf(m);

  let measured = null;
  let proof = null;
  if (examplesDir) {
    const runFile = join(examplesDir, `${m.id}.run.json`);
    if (existsSync(runFile)) {
      try {
        const r = JSON.parse(readFileSync(runFile, "utf8"));
        measured = {
          costUsd: Number(r.costUsd ?? 0),
          tokensIn: r.tokensIn ?? 0,
          tokensOut: r.tokensOut ?? 0,
          status: r.status,
          at: String(r.startedAt ?? "").slice(0, 10),
        };
      } catch {
        /* An unreadable recording is no recording — better null than invented. */
      }
    }
    const outFile = join(examplesDir, `${m.id}.txt`);
    if (existsSync(outFile)) proof = `examples/${m.id}.txt`;
  }

  return {
    id: m.id,
    name: m.name,
    description: m.description.trim().replace(/\s+/g, " "),
    file: `loops/${basename(file)}`,
    version: m.version,
    /** Steps in the recipe as written. A fan-out lane counts once here — how
     *  many times it actually runs depends on the feed, and `fansOut` says so. */
    steps: all.length,
    /** Steps the run starts with, before any lane is expanded. */
    topLevelSteps: flat.length,
    /** True when the run's real length is decided at runtime, not by the file. */
    fansOut: lanes.length > 0,
    maxItems: lanes.length ? Number(lanes[0].config?.maxItems ?? 50) : null,
    kinds,
    /* The two facts a reader decides on: does it stop for me, and what does it
       need from me before it will run at all. */
    humanGate: gates.some((g) => (g.config?.reviewer ?? "human") === "human"),
    agentGate: gates.some((g) => g.config?.reviewer === "agent"),
    schedule: m.triggers.find((t) => t.kind === "schedule")?.cron ?? null,
    model: needsModel ? knobs.model : null,
    budgetUsd: knobs.budgetUsd,
    needsEnv: needsModel && !env.includes("OPENROUTER_API_KEY") ? ["OPENROUTER_API_KEY", ...env] : env,
    measured,
    proof,
  };
}

/**
 * Where the published catalogue lives. Overridable, because a team will want
 * its own — point it at any host serving a `catalog.json` and the manifests it
 * names.
 */
export const REMOTE_CATALOG_BASE =
  process.env.QLOOP_CATALOG_URL?.replace(/\/+$/, "") ??
  "https://raw.githubusercontent.com/0leg-design/qloop/main";

const REMOTE_TIMEOUT_MS = 6000;

/**
 * Fetch the published catalogue.
 *
 * Returns null on ANY failure — offline, 404, garbage body. A missing remote
 * catalogue is not an error condition for the CLI: the loops that ship in the
 * package still work, and `init` falls back to saying which ids it does have.
 */
export async function fetchRemoteCatalog(base = REMOTE_CATALOG_BASE) {
  try {
    const res = await fetch(`${base}/catalog.json`, { signal: AbortSignal.timeout(REMOTE_TIMEOUT_MS) });
    if (!res.ok) return null;
    const cat = await res.json();
    /* v2 has components and demos. A v1 remote is still a catalogue if it has
       loops — the extra sections are optional so an older host keeps working. */
    if (!Array.isArray(cat?.loops)) return null;
    return {
      ...cat,
      components: Array.isArray(cat.components) ? cat.components : [],
      demos: Array.isArray(cat.demos) ? cat.demos : [],
    };
  } catch {
    return null;
  }
}

/**
 * Fetch ONE manifest from the published catalogue, as TEXT.
 *
 * Deliberately does not write anything and does not parse: the caller validates
 * before the bytes ever reach disk. A manifest is not executable, but it does
 * direct network calls and model spending, so what arrives from a host is
 * checked against the schema — and shown to the person — before it is kept.
 */
export async function fetchRemoteManifest(entry, base = REMOTE_CATALOG_BASE) {
  const url = `${base}/${String(entry.file).replace(/^\/+/, "")}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(REMOTE_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  return { text: await res.text(), url };
}

/** Overlay from QFactory.io content/registry, else bundled loops/ (may be absent). */
export function resolveCatalogRoots({ env = process.env, here } = {}) {
  const overlay = env.QFACTORY_REGISTRY;
  if (overlay) {
    return { loopsDir: join(overlay, "loops"), registryDir: overlay };
  }
  return {
    loopsDir: join(here, "..", "loops"),
    registryDir: join(here, "..", "registry"),
  };
}

/** Build the whole catalogue from loops/ plus registry/{components,demos}/. */
export function buildCatalog(loopsDir, { examplesDir, version = 2, registryDir } = {}) {
  const files = existsSync(loopsDir)
    ? readdirSync(loopsDir).filter((f) => f.endsWith(".yaml") || f.endsWith(".yml")).sort()
    : [];
  const loops = files.map((f) => describeLoop(join(loopsDir, f), { examplesDir }));
  const registry = loadRegistry(registryDir ?? join(dirname(loopsDir), "registry"));
  return {
    catalogVersion: version,
    loops,
    components: registry.components.map((c) => enrichComponent(c, loops)),
    demos: registry.demos.map((d) => enrichDemo(d, loops)),
  };
}
