// Safety check of a contribution pull request. It reads the files a PR changes as DATA and never runs them.
//
// Rules (a finding of severity "error" fails a contribution PR):
//   R1  shell/exec, or a step kind the engine does not support (SPEC-MANIFEST.md; the list is ENGINE_KINDS)
//   R2  a network call to a host the entry does not declare (permissions.network), or an obviously suspicious host
//   R3  a new npm dependency or changed package.json/lock; a Registry dependency that does not exist
//   R4  reading an environment variable / secret the entry does not declare, or reading secret files
//   R5  a change outside registry/workflows|components|demos|authors and registry/catalog.source.json
//   R6  an edit of generated or trusted files: .github/, and catalog.json / SHA256SUMS unless they are byte-for-byte what
//       the Registry builder produces from the reviewed sources (the existing `build-registry.mjs --check`; the workflow
//       passes its result as `catalogFresh`). SHA256SUMS holds the hash of catalog.json, so it may change only together with it.
//
// A "contribution" PR is one from a fork, or from a submission/<hash> branch (Private Submit). In any other PR the
// same rules run as advice only (exit 0), because maintainers legitimately change scripts, workflows and the catalog.
//
// Trust: the workflow runs THIS file from the pull request's BASE commit (git archive), so a PR cannot weaken the rules
// that judge it. The head is read only through `git show` / `git diff`.
import { execFileSync } from "node:child_process";
import { appendFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseYaml } from "../src/yaml.mjs";
import { ENGINE_KINDS, TRIGGER_KINDS, RESERVED_KINDS } from "../src/manifest.mjs";

export const RULES = Object.freeze({
  R1: "Shell or unsupported step",
  R2: "Network call",
  R3: "Dependencies",
  R4: "Environment and secrets",
  R5: "Change outside the contribution area",
  R6: "Generated or trusted file edited",
});

const SOURCE_CATALOG = "registry/catalog.source.json";
const CATALOG = "registry/catalog.json", SUMS = "registry/SHA256SUMS";
const ALWAYS_TRUSTED = (p) => p === "catalog.json" || p === "SHA256SUMS" || p.startsWith(".github/");
const NPM_FILES = /(^|\/)(package\.json|package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|\.npmrc|\.yarnrc(\.yml)?)$/;
const AREA = /^registry\/(workflows|components|demos|authors)\/[^\0]+$/;
const WORKFLOW_FILE = /^registry\/workflows\/[^/][^\0]*\.ya?ml$/;
const COMPONENT_FILE = /^registry\/components\/[^/][^\0]*\.(json|ya?ml)$/;

const SHELL_STEP_NAMES = /^(shell|exec|execute|bash|sh|zsh|cmd|command|run|script|spawn|process|subprocess|powershell|terminal|eval)$/i;
const SHELL_KEYS = /^(shell|exec|execute|command|cmd|script|entrypoint|argv|powershell|bash|spawn)$/i;
// High-confidence shell text only: prose that merely mentions a tool is not flagged.
const SHELL_TEXT = [
  [/\b(curl|wget)\b[^\n|;]*\|\s*(sudo\s+)?(ba|z|da|k)?sh\b/i, "downloads and pipes straight into a shell"],
  [/\b(ba|z|da|k)?sh\s+-c\b/i, "starts a shell with -c"],
  [/\/dev\/(tcp|udp)\//, "opens a raw network socket from a shell"],
  [/\b(nc|ncat|netcat)\b[^\n]*\s-e\b/i, "starts a reverse shell"],
  [/\bchild_process\b|\bos\.system\s*\(|\bsubprocess\.(run|call|Popen)\b|\bexecSync\s*\(|\bspawnSync\s*\(/, "calls a process-spawning API"],
  [/\beval\s*\(|\bnew Function\s*\(/, "evaluates text as code"],
  [/powershell(\.exe)?\s+(-\w+\s+)*-(enc|encodedcommand)\b/i, "runs an encoded PowerShell command"],
  [/\brm\s+-rf?\s+(\/|~|\$HOME)(\s|$)/, "deletes a home or root directory"],
];
const SECRET_TEXT = [
  [/\bprocess\.env\b|\bos\.environ\b|\bENV\[|\$ENV\{/, "reads the whole process environment"],
  [/\b(printenv|env\s*\|)\b|\bset\s*\|\s*(grep|curl)/, "dumps the environment"],
  [/~\/\.ssh|\bid_(rsa|ed25519|ecdsa)\b|\.aws\/credentials|\/etc\/(passwd|shadow)|\.netrc|\.npmrc|\.git-credentials|\bkeychain-db\b/i, "reads a credentials file"],
  [/security\s+find-(generic|internet)-password/i, "reads the macOS Keychain directly"],
  [/\$\{?[A-Z][A-Z0-9_]*(KEY|TOKEN|SECRET|PASSWORD|PASSWD)\}?\b/, "expands a shell variable that looks like a secret"],
];
const SUSPICIOUS_HOSTS = [
  ["URL shortener", ["bit.ly", "t.co", "tinyurl.com", "goo.gl", "is.gd", "ow.ly", "buff.ly", "rebrand.ly", "cutt.ly", "shorturl.at", "t.ly", "rb.gy", "tiny.cc", "v.gd", "s.id", "lnkd.in", "adf.ly", "bl.ink", "short.io"]],
  ["paste site", ["pastebin.com", "paste.ee", "hastebin.com", "dpaste.org", "dpaste.com", "0bin.net", "privatebin.net", "rentry.co", "rentry.org", "ix.io", "termbin.com", "controlc.com", "justpaste.it", "paste.rs", "ghostbin.com", "pastie.io", "paste.mozilla.org", "gist.githubusercontent.com", "transfer.sh", "file.io", "0x0.st"]],
  ["request-capture or tunnel host", ["webhook.site", "requestbin.com", "requestbin.net", "pipedream.net", "ngrok.io", "ngrok-free.app", "ngrok.app", "trycloudflare.com", "loca.lt", "serveo.net", "interact.sh", "oast.fun", "oast.pro", "oast.live", "oast.site", "burpcollaborator.net", "canarytokens.com", "beeceptor.com", "hookbin.com"]],
];
const URL_KEY = /(^|[_.-])(url|uri|urls|endpoint|baseurl|webhook|feed|feeds|host|hosts|server|origin)$/i;
const ENV_REF = /\{\{\s*env\.([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\s*\}\}/g;

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const asList = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === "string") : []);

export function hostProblem(host) {
  const h = host.toLowerCase().replace(/\.$/, "");
  if (/^\[.*\]$/.test(h) || h.includes(":")) return "a raw IPv6 address";
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h) || /^(0x[0-9a-f]+|\d+)$/i.test(h) || /^(0x[0-9a-f]+\.){1,3}0x[0-9a-f]+$/i.test(h)) return "a raw IP address";
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal") || h.endsWith(".lan") || h.endsWith(".home.arpa") || h === "metadata.google.internal") return "a local or private-network name";
  for (const [label, hosts] of SUSPICIOUS_HOSTS) if (hosts.some((d) => h === d || h.endsWith(`.${d}`))) return `a ${label} (${hosts.find((d) => h === d || h.endsWith(`.${d}`))})`;
  return null;
}

function declaredHost(host, declared) {
  const h = host.toLowerCase();
  return declared.some((d) => {
    const x = d.toLowerCase();
    return x.startsWith("*.") ? h.endsWith(x.slice(1)) && h.length > x.length - 1 : h === x;
  });
}

/** Hosts a URL-like value would call. `{{env.X:-https://default}}` contributes its default; a bare `{{env.X}}` is operator config. */
export function hostsOf(value) {
  const text = String(value).replace(ENV_REF, (_, _n, dflt) => (dflt === undefined ? "" : dflt)).replace(/\{\{[^}]*\}\}/g, "");
  const out = [];
  for (const m of text.matchAll(/\b([a-zA-Z][a-zA-Z0-9+.-]*):\/\/([^/\s?#"'<>]*)/g)) {
    const scheme = m[1].toLowerCase();
    let authority = m[2];
    const credentials = authority.includes("@");
    if (credentials) authority = authority.slice(authority.lastIndexOf("@") + 1);
    const host = authority.startsWith("[") ? authority.slice(0, authority.indexOf("]") + 1) : authority.replace(/:\d*$/, "");
    out.push({ scheme, host, credentials });
  }
  return out;
}

function stepsOf(doc) {
  const out = [];
  (function walk(list, path) {
    (Array.isArray(list) ? list : []).forEach((s, i) => {
      if (!isObject(s)) return;
      out.push({ step: s, path: `${path}[${i}]` });
      walk(s.then, `${path}[${i}].then`);
      walk(s.else, `${path}[${i}].else`);
      walk(s.default, `${path}[${i}].default`);
      for (const [k, b] of Object.entries(isObject(s.cases) ? s.cases : {})) walk(b, `${path}[${i}].cases.${k}`);
    });
  })(doc.steps, "steps");
  return out;
}

function* strings(value, path = "") {
  if (typeof value === "string") yield [path, value];
  else if (Array.isArray(value)) for (const [i, v] of value.entries()) yield* strings(v, `${path}[${i}]`);
  else if (isObject(value)) for (const [k, v] of Object.entries(value)) yield* strings(v, path ? `${path}.${k}` : k);
}

const label = (step, path) => (step?.id ? `step "${step.id}"` : path);

/** One material file → findings. `entry` is its catalog.source.json entry (or null). */
function scanMaterial({ file, doc, entry, add }) {
  const declaredEnv = new Set([...asList(entry?.needsEnv), ...asList(entry?.permissions?.environment)]);
  const declaredHosts = asList(entry?.permissions?.network);
  const execDeclared = entry?.permissions?.execution === "explicit-local-scope";
  const noEntry = entry ? "" : " (this file has no entry in registry/catalog.source.json, so nothing is declared)";
  const unit = [];
  if (Array.isArray(doc.steps)) {
    for (const t of Array.isArray(doc.triggers) ? doc.triggers : []) if (isObject(t) && typeof t.kind === "string") unit.push({ where: `trigger "${t.kind}"`, step: null, trigger: t });
    for (const { step, path } of stepsOf(doc)) unit.push({ where: label(step, path), step, trigger: null });
  } else unit.push({ where: "the component descriptor", step: null, trigger: null, component: true });

  const seen = new Set();
  const once = (key, fn) => { if (!seen.has(key)) { seen.add(key); fn(); } };

  for (const u of unit) {
    const { step, trigger } = u;
    if (step) {
      const kind = String(step.kind ?? "");
      if (RESERVED_KINDS[kind]) add("R1", file, u.where, `uses the reserved step kind "${kind}", which the engine does not implement.`, "Only the step kinds in SPEC-MANIFEST.md run. A reserved kind would be rejected or, worse, handled by something else.", "Replace it with a supported step kind.");
      else if (SHELL_STEP_NAMES.test(kind)) add("R1", file, u.where, `uses the step kind "${kind}", which looks like running a shell command.`, "Q-Core workflows cannot run shell commands. A shell step on a user's machine runs with that user's rights.", "Use only supported step kinds (fetch, llm-call, api-request, approval-gate, and the others in SPEC-MANIFEST.md).");
      else if (!ENGINE_KINDS.includes(kind)) add("R1", file, u.where, `uses the step kind "${kind}", which is not in the supported list.`, "An unknown kind is either a typo or an attempt to reach code the engine does not define.", `Use one of: ${ENGINE_KINDS.join(", ")}.`);
      const cfg = isObject(step.config) ? step.config : {};
      for (const key of Object.keys(cfg)) if (SHELL_KEYS.test(key)) add("R1", file, `${u.where}, field "${key}"`, `has a "${key}" field, which looks like a command to run.`, "Step settings that carry commands, scripts or arguments are how a shell call hides inside an otherwise normal step.", "Remove the field. If a local program is really needed, a maintainer must review that separately.");
      const localScope = (kind === "llm-call" || kind === "approval-gate") && cfg.provider === "cli" || ["workspace-apply", "workspace-read", "determined", "specification"].includes(kind);
      if (localScope && !execDeclared) add("R1", file, u.where, `uses "${kind}"${cfg.provider === "cli" ? " with provider: cli" : ""}, which starts a local agent or reads/writes local files, but the entry does not declare permissions.execution: "explicit-local-scope".${noEntry}`, "Steps that touch the user's machine must say so in the catalog entry, so the user sees it before installing.", 'Add "permissions": {"execution": "explicit-local-scope"} to the entry in registry/catalog.source.json.');
      if (cfg.secretSource === "keychain" || cfg.keyRef) {
        const ref = String(cfg.keyRef ?? "OPENROUTER_API_KEY");
        // The engine's own standard key (OPENROUTER_API_KEY, from the Keychain) is not a surprise; any other alias must be declared.
        if (ref !== "OPENROUTER_API_KEY" && !declaredEnv.has(ref)) add("R4", file, u.where, `reads the secret "${ref}" (${cfg.secretSource === "keychain" ? "Keychain" : "keyRef"}), which the entry does not declare.${noEntry}`, "A secret the entry does not list is a secret the user was not told about.", `List "${ref}" in the entry's needsEnv or permissions.environment.`);
      }
      const implicit = (kind === "llm-call" || (kind === "approval-gate" && cfg.reviewer === "agent")) && cfg.provider !== "cli" && cfg.secretSource !== "keychain" && !cfg.keyRef;
      if (implicit && !declaredEnv.has("OPENROUTER_API_KEY")) add("R4", file, u.where, `calls a model through OpenRouter, which reads OPENROUTER_API_KEY, but the entry does not declare it.${noEntry}`, "A secret the entry does not list is a secret the user was not told about.", 'List "OPENROUTER_API_KEY" in the entry\'s needsEnv.');
      for (const [key, value] of Object.entries(cfg)) {
        if (typeof value !== "string") continue;
        const urlish = URL_KEY.test(key) || (kind === "fetch" || kind === "api-request") && key === "url";
        if (!urlish) continue;
        for (const h of hostsOf(value)) {
          const where = `${u.where}, field "${key}"`;
          if (h.scheme === "file") continue;
          if (!["http", "https"].includes(h.scheme)) { once(`s|${where}|${h.scheme}`, () => add("R2", file, where, `uses the "${h.scheme}:" address scheme.`, "Only http, https and local file addresses are expected; other schemes reach services the reviewer will not expect.", "Use an https address.")); continue; }
          if (h.credentials) once(`c|${where}`, () => add("R2", file, where, `has a user name or password inside the address (${h.host}).`, "Credentials in a URL end up in logs and in the manifest that goes to git.", "Move the secret into an environment variable and a header."));
          const bad = hostProblem(h.host);
          if (bad) once(`b|${h.host}`, () => add("R2", file, where, `calls ${h.host}, ${bad}.`, "Raw IP addresses, shorteners, paste sites and request-capture hosts are the usual places stolen data is sent or hidden instructions are fetched from. Declaring the host does not make it acceptable.", "Use a normal public host that a reader can recognise, or remove the call."));
          else if (!declaredHost(h.host, declaredHosts)) once(`d|${h.host}`, () => add("R2", file, where, `calls ${h.host}, which the entry does not declare.${noEntry}`, "A reviewer needs the full list of places a workflow talks to before approving it.", `Add "${h.host}" to permissions.network of the entry in registry/catalog.source.json, if the call is intended.`));
        }
      }
    }
    void trigger;
  }
  if (Array.isArray(doc.steps)) {
    for (const t of Array.isArray(doc.triggers) ? doc.triggers : []) if (isObject(t) && typeof t.kind === "string" && !TRIGGER_KINDS.includes(t.kind)) add("R1", file, `trigger "${t.kind}"`, `uses the trigger kind "${t.kind}", which is not supported.`, "Only the trigger kinds in SPEC-MANIFEST.md exist.", `Use one of: ${TRIGGER_KINDS.join(", ")}.`);
  } else {
    // Component descriptor: only URL-valued defaults/examples are network targets; everything else is documentation.
    (function walk(v, key) {
      if (typeof v === "string") {
        if (/^(url|uri|endpoint|baseUrl|default|example|value)$/.test(key) && /^[a-z][a-z0-9+.-]*:\/\//i.test(v)) for (const h of hostsOf(v)) {
          if (h.scheme === "file") continue;
          const bad = hostProblem(h.host);
          if (bad) once(`cb|${h.host}`, () => add("R2", file, `field "${key}"`, `names ${h.host}, ${bad}.`, "Raw IP addresses, shorteners, paste sites and request-capture hosts are the usual places data is sent or fetched from.", "Use a normal public host or remove it."));
          else if (!declaredHost(h.host, declaredHosts)) once(`cd|${h.host}`, () => add("R2", file, `field "${key}"`, `names ${h.host}, which the entry does not declare.${noEntry}`, "A reviewer needs the full list of places a component talks to.", `Add "${h.host}" to permissions.network of its catalog entry.`));
        }
      } else if (Array.isArray(v)) v.forEach((x) => walk(x, key));
      else if (isObject(v)) for (const [k, x] of Object.entries(v)) walk(x, k);
    })(doc, "");
  }

  // Text-level checks over every string in the file: environment references, secret reads, shell text.
  const prose = (path) => !Array.isArray(doc.steps) && /(^|\.)(description|notes|summary|brief|name|title|label)(\[\d+\])?$/.test(path);
  for (const [path, text] of strings(doc)) {
    for (const m of prose(path) ? [] : text.matchAll(ENV_REF)) {
      const name = m[1];
      if (!/^[A-Z][A-Z0-9_]*$/.test(name)) once(`en|${name}`, () => add("R4", file, path, `reads the environment variable "${name}", which is not UPPER_SNAKE_CASE.`, "The engine only resolves UPPER_SNAKE names; anything else is a mistake or an evasion attempt.", "Rename it to UPPER_SNAKE_CASE and declare it."));
      else if (!declaredEnv.has(name)) once(`ed|${name}`, () => add("R4", file, path, `reads the environment variable ${name}, which the entry does not declare.${noEntry}`, "An environment variable the entry does not list can hold a secret the user was never told this workflow uses.", `List ${name} in the entry's needsEnv (or permissions.environment) in registry/catalog.source.json.`));
    }
    for (const [re, what] of SECRET_TEXT) if (re.test(text)) once(`st|${path}|${what}`, () => add("R4", file, path, `${what}.`, "Reading files or variables outside the declared environment references is how credentials are collected.", "Remove it. Use a declared {{env.NAME}} reference for anything a workflow needs."));
    for (const [re, what] of SHELL_TEXT) if (re.test(text)) once(`sh|${path}|${what}`, () => add("R1", file, path, `contains text that ${what}.`, "Q-Core workflows never run shell commands, so text like this is either dead weight or a payload waiting for another tool.", "Remove it."));
  }
}

const parseJson = (text, add, file) => { try { return JSON.parse(text); } catch (e) { add("R0", file, "file", `is not valid JSON (${e.message}).`, "The Registry cannot read it.", "Fix the syntax."); return null; } };

/**
 * @param {{mode:"contribution"|"maintainer", changes:{path:string,status:string,mode?:string}[],
 *          head:(p:string)=>string|null, base:(p:string)=>string|null}} input
 */
export function checkContribution({ mode = "contribution", changes, head, base, catalogFresh = false }) {
  const findings = [];
  const add = (rule, file, where, what, why, fix, severity = "error") => findings.push({ rule, severity, file, where, what, why, fix });

  // R5/R6/R3 on paths.
  for (const c of changes) {
    const p = c.path;
    if (c.mode === "120000" || c.mode === "160000") { add("R5", p, "file", `is a ${c.mode === "120000" ? "symbolic link" : "submodule"}.`, "Links and submodules can point outside the reviewed files.", "Remove it."); continue; }
    const catalogChanged = changes.some((x) => x.path === CATALOG);
    if (ALWAYS_TRUSTED(p) || p === CATALOG && !catalogFresh || p === SUMS && !(catalogFresh && catalogChanged)) {
      const ci = p.startsWith(".github/");
      const stale = p === CATALOG || p === SUMS;
      add("R6", p, "file", ci ? "is a CI workflow or repository configuration and was changed in a contribution." : stale ? `was changed but is not exactly what the Registry builder produces from the reviewed sources${p === SUMS && !catalogChanged ? " (it may only change together with catalog.json)" : ""}, or that could not be verified.` : "is generated by the Registry builder and was changed in a contribution.",
        ci ? "Changing CI could switch off the checks that judge this very pull request." : "A stale or hand-edited copy hides what is really published. The file is accepted only when it matches a fresh build byte for byte.",
        ci ? "Remove the change. Maintainers change CI." : stale ? "Regenerate it with `node scripts/build-registry.mjs --export registry --core-artifact <archive>` after your last edit, as the contribution guide describes, or remove the change and a maintainer regenerates it." : "Remove the change. A maintainer regenerates this file after review.");
    }
    else if (p === CATALOG || p === SUMS) continue;
    else if (NPM_FILES.test(p)) add("R3", p, "file", "changes npm packaging (package.json, a lock file or npm settings).", "Q-Core ships with zero dependencies on purpose. A new package runs its own code on every user's machine.", "Remove the change. If a dependency is truly needed, open an issue first.");
    else if (!(AREA.test(p) && !p.split("/").includes("..")) && p !== SOURCE_CATALOG) add("R5", p, "file", "is outside the contribution area.", "A contribution may only change registry/workflows, registry/components, registry/demos, registry/authors and registry/catalog.source.json.", "Remove the change from this pull request.");
  }

  // Catalog entries before/after.
  const parseCat = (text) => { if (text == null) return null; try { return JSON.parse(text); } catch { return null; } };
  const headCat = parseCat(head(SOURCE_CATALOG)), baseCat = parseCat(base(SOURCE_CATALOG));
  if (changes.some((c) => c.path === SOURCE_CATALOG && c.status !== "D") && !headCat) add("R0", SOURCE_CATALOG, "file", "is not valid JSON.", "The Registry cannot be built from it.", "Fix the syntax.");
  const entriesOf = (cat) => new Map([...(cat?.workflows ?? []).map((e) => [`workflow:${e.id}`, e]), ...(cat?.components ?? []).map((e) => [`component:${e.id}`, e])]);
  const headEntries = entriesOf(headCat), baseEntries = entriesOf(baseCat);
  const known = new Set([...ENGINE_KINDS, ...TRIGGER_KINDS, ...[...headEntries.values(), ...baseEntries.values()].map((e) => e.id)]);
  for (const [key, e] of headEntries) {
    const before = baseEntries.get(key);
    if (before && JSON.stringify(before) === JSON.stringify(e)) continue;
    for (const dep of [...(Array.isArray(e.dependencies) ? e.dependencies : []), ...(Array.isArray(e.builtinDependencies) ? e.builtinDependencies : [])]) {
      if (!known.has(dep?.id)) add("R3", SOURCE_CATALOG, `entry ${e.id}`, `depends on "${dep?.id}", which is neither a Registry component nor an engine step.`, "A dependency that does not exist in the Registry cannot be reviewed or pinned.", "Remove it, or contribute that component in the same pull request.");
    }
    for (const h of asList(e.permissions?.network)) {
      const bad = hostProblem(h.replace(/^\*\./, ""));
      if (h === "*" || /^\*\.[^.]*$/.test(h)) add("R2", SOURCE_CATALOG, `entry ${e.id}`, `declares the host pattern "${h}", which allows almost any address.`, "A declaration is only useful if it names real hosts.", "Name each host.");
      else if (bad) add("R2", SOURCE_CATALOG, `entry ${e.id}`, `declares ${h}, ${bad}.`, "Declaring a suspicious host does not make it acceptable.", "Remove it.");
    }
    if (before && mode === "contribution") add("R5", SOURCE_CATALOG, `entry ${e.id}`, "changes an entry that already exists in the Registry.", "Updating someone else's entry changes what users install without a new version.", "Contribute a new version instead, or ask a maintainer.", "warn");
  }

  // Content of changed material files.
  const entryFor = (file, kind) => {
    if (kind === "workflow") for (const e of headEntries.values()) { if (e.file && `registry/${e.file}` === file) return e; }
    const id = file.replace(/^registry\/(workflows|components)\//, "").replace(/\.[^.]+$/, "");
    return headEntries.get(`${kind}:${id}`) ?? null;
  };
  for (const c of changes) {
    if (c.status === "D") continue;
    const text = head(c.path);
    if (text == null) continue;
    if (WORKFLOW_FILE.test(c.path)) {
      let doc;
      try { doc = parseYaml(text); } catch (e) { add("R0", c.path, "file", `cannot be read as YAML (${e.message}).`, "The Registry cannot validate it.", "Fix the syntax."); continue; }
      if (!isObject(doc)) { add("R0", c.path, "file", "is not a workflow document.", "The Registry cannot validate it.", "Fix the file."); continue; }
      scanMaterial({ file: c.path, doc, entry: entryFor(c.path, "workflow"), add });
    } else if (COMPONENT_FILE.test(c.path)) {
      let doc;
      if (c.path.endsWith(".json")) doc = parseJson(text, add, c.path);
      else { try { doc = parseYaml(text); } catch (e) { add("R0", c.path, "file", `cannot be read as YAML (${e.message}).`, "The Registry cannot validate it.", "Fix the syntax."); continue; } }
      if (isObject(doc)) scanMaterial({ file: c.path, doc, entry: entryFor(c.path, "component"), add });
    }
  }

  const errors = findings.filter((f) => f.severity === "error");
  const ok = mode !== "contribution" || errors.length === 0;
  return { ok, mode, findings, errors: errors.length, warnings: findings.length - errors.length };
}

export function renderSummary(result) {
  const { mode, findings, errors, warnings } = result;
  const head = mode === "contribution"
    ? errors ? `## Contribution safety check: FAILED (${errors} problem${errors === 1 ? "" : "s"})` : "## Contribution safety check: passed"
    : "## Contribution safety check: advice only (this is not a contribution pull request)";
  const lines = [head, ""];
  if (mode === "contribution" && errors) lines.push("This pull request cannot be accepted yet. Each item says what looks wrong, why it matters, and what to change. A maintainer decides after the problems are fixed.", "");
  else if (mode === "contribution") lines.push(`No suspicious calls, dependencies or out-of-area changes were found.${warnings ? ` ${warnings} note${warnings === 1 ? "" : "s"} below.` : ""} This does not replace the maintainer's review.`, "");
  else lines.push("Maintainer pull requests are not blocked by this check. Findings are shown so the reviewer sees them.", "");
  findings.forEach((f, i) => {
    lines.push(`### ${i + 1}. ${f.severity === "warn" ? "Note: " : ""}${RULES[f.rule] ?? "Unreadable file"} (${f.rule})`, `- File: \`${f.file}\` (${f.where})`, `- What: ${f.where === "file" ? "The file" : `In ${f.where}, the file`} ${f.what}`, `- Why it matters: ${f.why}`, `- How to fix: ${f.fix}`, "");
  });
  return lines.join("\n");
}

export const changesFromMaps = (baseMap, headMap) => {
  const out = [];
  for (const p of new Set([...Object.keys(baseMap), ...Object.keys(headMap)])) {
    if (!(p in baseMap)) out.push({ path: p, status: "A" });
    else if (!(p in headMap)) out.push({ path: p, status: "D" });
    else if (baseMap[p] !== headMap[p]) out.push({ path: p, status: "M" });
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
};

function git(repo, args) { return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }); }

function main(argv) {
  const arg = (n, d) => { const i = argv.indexOf(n); return i < 0 ? d : argv[i + 1]; };
  const repo = arg("--repo", process.cwd()), baseSha = arg("--base"), headSha = arg("--head");
  if (!/^[a-f0-9]{40}$/.test(baseSha ?? "") || !/^[a-f0-9]{40}$/.test(headSha ?? "")) throw Error("--base and --head must be full commit SHAs");
  let mode = arg("--mode", "auto");
  if (mode === "auto") {
    const fork = process.env.QCORE_PR_HEAD_REPO && process.env.QCORE_PR_HEAD_REPO !== process.env.QCORE_REPOSITORY;
    mode = fork || /^submission\//.test(process.env.QCORE_PR_HEAD_REF ?? "") ? "contribution" : "maintainer";
  }
  // Raw diff so symlink and submodule modes are visible; renames are split into delete + add.
  const raw = git(repo, ["diff", "--raw", "--no-renames", "-z", `${baseSha}...${headSha}`]).split("\0").filter(Boolean);
  const changes = [];
  for (let i = 0; i < raw.length; i += 2) {
    const [, newMode, , , status] = raw[i].slice(1).split(/[ \t]/);
    changes.push({ path: raw[i + 1], status: status[0], mode: newMode });
  }
  const show = (sha) => (p) => { try { return git(repo, ["show", `${sha}:${p}`]); } catch { return null; } };
  const catalogFresh = ["yes", "true", "1"].includes(arg("--catalog-fresh", process.env.QCORE_CATALOG_FRESH ?? "no"));
  const result = checkContribution({ mode, changes, head: show(headSha), base: show(baseSha), catalogFresh });
  const summary = renderSummary(result);
  console.log(summary);
  for (const f of result.findings) if (f.severity === "error") console.log(`::error file=${f.file},title=${RULES[f.rule] ?? "Unreadable file"}::${f.where}: ${f.what}`.replace(/\n/g, " "));
  const out = arg("--summary", process.env.GITHUB_STEP_SUMMARY);
  if (out) appendFileSync(out, `${summary}\n`);
  if (!result.ok) process.exitCode = 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) main(process.argv.slice(2));
