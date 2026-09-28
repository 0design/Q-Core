/**
 * `{{steps.X.output.y}}` · `{{item.y}}` · `{{index}}` — the runner's copy of
 * `lib/processes/template.ts`. Same regexes, same lookup order, same rule that an
 * UNRESOLVED placeholder is left in place rather than blanked: a literal `{{…}}`
 * arriving at a webhook is a visible failure, an empty string is a silent one.
 *
 * The step reference is lazy up to the nearest `.output` so that a step NAME with
 * a space in it ("Fetch feed") resolves. That was a real inherited bug: the
 * original pattern could not match a space, so name-based references never worked
 * and the literal placeholder travelled into the outgoing request body.
 */

/* The reference never crosses a brace: `{{steps.X}} … {{steps.Y.output}}` must not read as one
   placeholder whose step name is "X}} … {{steps.Y". */
const TEMPLATE_RE = /\{\{\s*steps\.([^{}]+?)\.output(?:\.([^}\s]+))?\s*\}\}/g;
const ITEM_RE = /\{\{\s*(item|index)(?:\.([^}\s]+))?\s*\}\}/g;

/**
 * `{{env.NAME}}` — a value from the environment.
 *
 * A manifest is a file that lives in git. A bot token, an API key, a chat id:
 * none of them may appear in its text, or "share your workflow" turns into "share
 * your secret". Referencing the environment is the only way to write
 * `https://api.telegram.org/bot<TOKEN>/sendMessage` without putting the token in.
 *
 * UPPER_SNAKE only, so `{{env.x}}` never quietly starts meaning something else.
 * An unset variable leaves the placeholder in place — same convention as above:
 * literal braces in a URL are visible, whereas an empty string would produce a
 * request to somewhere nobody can account for afterwards.
 */
const ENV_RE = /\{\{\s*env\.([A-Z][A-Z0-9_]*)(?::-([^{}]*?))?\s*\}\}/g;

/** `{{env.NAME:-default}}` — the default applies when NAME is unset or empty. */
const envValue = (name, fallback) => {
  const value = process.env[name];
  if ((value === undefined || value === "") && fallback !== undefined) return fallback.trim();
  return value;
};

/**
 * `{{run.costUsd}}` · `{{run.id}}` · `{{run.workflowId}}` — facts about THIS run,
 * as they stand at the moment the step executes.
 *
 * `costUsd` is what the run has spent SO FAR — every step before this one. On
 * the final `api-request` that is the whole cost of the run, because an outgoing
 * request is free. This is what lets a published post carry a true "generated
 * for $0.0006" line instead of a number somebody typed in once and forgot.
 *
 * It is a running total, not a forecast: a step in the middle sees only what
 * came before it, which is the only number that is actually known there. It is
 * rendered with six decimals, and as "unknown" when any earlier step's cost is.
 */
const RUN_RE = /\{\{\s*run\.(id|workflowId|costUsd)\s*\}\}/g;


function getByPath(value, path) {
  if (!path) return value;
  let cur = value;
  for (const seg of path.split(".")) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = cur[seg];
  }
  return cur;
}

function resolveStepRef(ref, ctx) {
  if (Object.prototype.hasOwnProperty.call(ctx.priorOutputs, ref)) {
    return { id: ref, output: ctx.priorOutputs[ref] };
  }
  if (ctx.priorStepNames) {
    const lower = ref.toLowerCase();
    for (const [id, name] of Object.entries(ctx.priorStepNames)) {
      if (String(name).toLowerCase() === lower) return { id, output: ctx.priorOutputs[id] };
    }
  }
  return null;
}

function stringify(v) {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function lookupItemVar(name, path, ctx) {
  if (name === "index") return ctx.index;
  if (!("item" in ctx)) return undefined;
  return getByPath(ctx.item, path);
}

/* ONE pass over the manifest text. Substituted values are never re-scanned: a
   fetched feed or a model answer containing `{{env.TELEGRAM_BOT_TOKEN}}` must
   arrive as that literal text, not as the secret it names. */
const ANY_RE = new RegExp(
  [TEMPLATE_RE, ITEM_RE, ENV_RE, RUN_RE].map((re) => `(?:${re.source})`).join("|"),
  "g",
);

/**
 * The one substitution pass. `data` values (steps, item, index, run) pass through
 * `opts.data` when given, env values never do: the environment is the operator's
 * configuration, step outputs and items are content from outside. `opts.unresolved`
 * collects the placeholders of the TEMPLATE that were left in place, so a caller can
 * refuse them without mistaking `{{…}}` inside substituted data for its own.
 */
function substitute(text, ctx, opts = {}) {
  const data = opts.data ?? ((v) => v);
  const keep = (match) => {
    opts.unresolved?.push(match);
    return match;
  };
  return String(text).replace(ANY_RE, (match, ref, path, itemName, itemPath, envName, envFallback, runField) => {
    if (ref !== undefined) {
      const resolved = resolveStepRef(ref, ctx);
      if (!resolved) return keep(match);
      const v = getByPath(resolved.output, path);
      return v === undefined ? keep(match) : data(stringify(v));
    }
    if (itemName !== undefined) {
      const v = lookupItemVar(itemName, itemPath, ctx);
      return v === undefined ? keep(match) : data(stringify(v));
    }
    if (envName !== undefined) return envValue(envName, envFallback) ?? keep(match);
    const v = ctx.run?.[runField];
    /* An unknown spend is said out loud, never rendered as $0: a post must not
       carry a cost line that the run could not measure. */
    if (runField === "costUsd" && v === null) return data("unknown");
    if (v === undefined || v === null) return keep(match);
    return data(runField === "costUsd" ? Number(v).toFixed(6) : String(v));
  });
}

/** Resolve every placeholder in `text` to a STRING. */
export function resolveTemplate(text, ctx) {
  return substitute(text, ctx);
}

/**
 * Resolve, and report which placeholders of the template itself stayed unresolved.
 * A check such as "no unresolved placeholder in a format contract" must look at
 * this list, not search the result for `{{`: legitimate data (code in an article,
 * a template quoted in a post) may contain braces and is not a manifest error.
 */
export function resolveTemplateReport(text, ctx) {
  const unresolved = [];
  return { text: substitute(text, ctx, { unresolved }), unresolved };
}

/* A value from data inside a URL: percent-encoded as ONE component, so it can
   never add a query parameter, a fragment, a path segment or a user/host part.
   A whole segment of "." or ".." would still be normalised away by the URL
   parser (it treats %2E the same way), so such a value is refused. */
function urlComponent(value) {
  if (value === "." || value === "..") {
    throw new Error(`a substituted value "${value}" cannot be used inside a URL`);
  }
  return encodeURIComponent(value);
}

const authority = (href) => {
  try {
    const u = new URL(href);
    return `${u.protocol}//${u.username}:${u.password}@${u.host}`;
  } catch {
    return null;
  }
};

/**
 * Resolve a `url` field. Scheme, credentials, host and port come from the manifest
 * and the environment only. Values from data (steps, item, index, run) are
 * percent-encoded as a single component and may therefore change only the path,
 * query or fragment text they are placed in; a template that lets data decide the
 * host (`https://{{item.host}}/…`) is refused rather than sent.
 * The environment is inserted verbatim: `{{env.QCORE_WEBHOOK_URL}}` as the whole
 * URL is the operator's own configuration.
 */
export function resolveUrlTemplate(text, ctx) {
  let usedData = false;
  const url = substitute(text, ctx, {
    data: (v) => {
      usedData = true;
      return urlComponent(v);
    },
  });
  if (!usedData) return url;
  /* The same template with every data value empty: whatever authority it names is
     the one the manifest and environment chose. Data must not move it. */
  const skeleton = substitute(text, ctx, { data: () => "" });
  const chosen = authority(skeleton);
  if (chosen === null || chosen !== authority(url)) {
    throw new Error("the URL scheme and host must come from the manifest or the environment, not from step data");
  }
  return url;
}

/**
 * A JSON field (headers, a list of strings) whose STRING values may carry
 * placeholders. The manifest text is parsed first and only then are its string
 * values resolved, so a substituted value can never close a string, add a key
 * or add an element. Object keys are never resolved.
 * Throws SyntaxError when the manifest text itself is not JSON.
 */
export function resolveJsonTemplate(raw, ctx, opts = {}) {
  const walk = (value) => {
    if (typeof value === "string") return substitute(value, ctx, opts);
    if (Array.isArray(value)) return value.map(walk);
    if (value && typeof value === "object") {
      const out = {};
      for (const [k, v] of Object.entries(value)) out[k] = walk(v);
      return out;
    }
    return value;
  };
  return walk(JSON.parse(String(raw)));
}

/** The `{{env.X}}` names that are NOT set. Empty means every reference resolved. */
export function missingEnvRefs(text) {
  const out = new Set();
  for (const m of String(text).matchAll(ENV_RE)) {
    const value = envValue(m[1], m[2]);
    if (value === undefined || value === "") out.add(m[1]);
  }
  return [...out];
}

/**
 * Resolve to a VALUE, not a string — fan-out needs the real array, not its JSON
 * text. Works only when the string is EXACTLY one placeholder; "List: {{…}}"
 * returns undefined rather than guessing what the mixed text was meant to be.
 */
export function resolveTemplateValue(text, ctx) {
  const one = String(text).trim();
  const step = one.match(/^\{\{\s*steps\.([^{}]+?)\.output(?:\.([^}\s]+))?\s*\}\}$/);
  if (step) {
    const resolved = resolveStepRef(step[1], ctx);
    if (!resolved) return undefined;
    return getByPath(resolved.output, step[2]);
  }
  const item = one.match(/^\{\{\s*(item|index)(?:\.([^}\s]+))?\s*\}\}$/);
  if (item) return lookupItemVar(item[1], item[2], ctx);
  return undefined;
}

/** Walk any JSON value, resolving templates in every string node. */
export function resolveTemplateDeep(value, ctx) {
  if (typeof value === "string") return resolveTemplate(value, ctx);
  if (Array.isArray(value)) return value.map((v) => resolveTemplateDeep(v, ctx));
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = resolveTemplateDeep(v, ctx);
    return out;
  }
  return value;
}
