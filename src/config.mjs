/**
 * Step-config coercion — the runner's copy of `lib/processes/config.ts`.
 *
 * It is a copy on purpose, and it must stay a literal one. This package has no
 * build step and no imports from the app; the app has no imports from here. The
 * parity test (test/parity.test.mjs) is what keeps the two honest — if these
 * rules drift, a manifest starts meaning two different things depending on where
 * it runs, which is the exact failure a standalone runner is most likely to have.
 *
 * `config` values are ALWAYS strings, here as in the database: the loop builder
 * stores numbers and booleans as text, so `timeoutSec: 30` in YAML is normalised
 * to "30" by the manifest loader before any of this is reached.
 */

/** Trimmed non-empty string, or undefined. An empty field means "not filled in". */
export function str(cfg, key) {
  const v = cfg?.[key];
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  return t === "" ? undefined : t;
}

/** Required string, or a throw that names the step and the field. */
export function requireStr(cfg, key, stepLabel) {
  const v = str(cfg, key);
  if (v === undefined) {
    throw new Error(`"${stepLabel}": the "${key}" field is empty — this step cannot run.`);
  }
  return v;
}

/** Finite number or undefined. "abc", "", "NaN" → undefined, never 0. */
export function num(cfg, key) {
  const v = str(cfg, key);
  if (v === undefined) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/** Boolean from text. Anything unrecognised → undefined, never a silent false. */
export function bool(cfg, key) {
  const v = str(cfg, key)?.toLowerCase();
  if (v === undefined) return undefined;
  if (["true", "1", "yes", "on"].includes(v)) return true;
  if (["false", "0", "no", "off"].includes(v)) return false;
  return undefined;
}

/** Value from an allow-list, or undefined — so a typo cannot fall into a default. */
export function oneOf(cfg, key, allowed) {
  const v = str(cfg, key);
  return v !== undefined && allowed.includes(v) ? v : undefined;
}
