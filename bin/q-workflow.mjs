#!/usr/bin/env node
/**
 * q-core — run one workflow from one file. Installed as `q-core`.
 *
 *   q-core validate <manifest>          read it, check it, say what it would do
 *   q-core run <manifest>               one pass, for real
 *   q-core run <manifest> --dry-run     one pass with no side effects at all
 *   q-core run <manifest> --caller-provider <provider.json> --json
                                    start explicit CLI caller inference
  q-core reply <manifest> <runId> <reply.json> --json
                                    submit the exact pending job response
  q-core clarify <manifest> <runId> <answers.json> --json
                                    submit exact answers to a paused SDD clarification
  q-core status [<manifest>]          what the last runs did
 *   q-core approve <manifest> [runId]   continue a run parked at a human gate
 *
 * `q-core run` performs ONE PASS. It is not a scheduler and does not pretend to be
 * one: repetition is launchd or cron, on the user's machine, where they can see
 * it. README §Scheduling has the two commands.
 *
 * EXIT CODES. 0 only when the run succeeded. A run that failed exits 1 and
 * writes the reason to `.qf/last-run.json`, because "it broke" and "there was
 * nothing today" must not look the same to whatever is watching. A run parked at
 * a gate exits 2 — not a failure, not a success, and worth telling apart.
 */
import { copyFileSync, existsSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadManifest, validateManifest, ManifestError } from "../src/manifest.mjs";
import { createRun, driveRun, resumeRun, cancelWaitingRun, resumeCancelledRun, resolveKnobs } from "../src/run.mjs";
import { RunStore } from "../src/state.mjs";
import { flattenWorkflowSteps } from "../src/flatten.mjs";
import { checkForUpdate, updateNotice } from "../src/update-check.mjs";
import { buildCatalog, fetchRemoteCatalog, fetchRemoteManifest, REMOTE_CATALOG_BASE, resolveCatalogRoots } from "../src/catalog.mjs";
import { parseYaml } from "../src/yaml.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = JSON.parse(readFileSync(join(HERE, "..", "package.json"), "utf8"));

const EXIT_OK = 0;
const EXIT_FAILED = 1;
const EXIT_WAITING = 2;
const EXIT_USAGE = 64;

const c = {
  dim: (s) => (process.stdout.isTTY ? `\x1b[2m${s}\x1b[0m` : s),
  bold: (s) => (process.stdout.isTTY ? `\x1b[1m${s}\x1b[0m` : s),
};

const USAGE = `q-core ${PKG.version} — run a QFactory workflow from a YAML manifest.

  q-core catalog                     workflows, components, and demos in this build
  q-core catalog --section <name>    one section: workflows | components | demos
  q-core init <id> [dir]             copy one workflow here, ready to edit
  q-core validate <manifest>         check the manifest and print the plan
  q-core run <manifest> [--dry-run]  execute one pass
  q-core run <manifest> --caller-provider <provider.json> --json
                                    start explicit CLI caller inference
  q-core reply <manifest> <runId> <reply.json> --json
                                    submit the exact pending job response
  q-core clarify <manifest> <runId> <answers.json> --json
                                    submit exact answers to a paused SDD clarification
  q-core status [<manifest>]         show recent runs
  q-core approve <manifest> [runId]  continue a run held at a human gate
                                    (--reject to refuse it)
  q-core doctor                      check this machine before blaming the workflow

Installed as q-core. There is no qf alias — that name belongs to @q-factory/bridge.

Options
  --dry-run     resolve and order every step, perform no side effects
  --json        machine-readable output
  --section     catalog section to print (workflows, components, demos)
  --quiet       only errors

Environment
  OPENROUTER_API_KEY   only for llm-call steps that use OpenRouter (provider is not
                       cli) and for an Agent-Gate; caller inference (provider: cli)
                       needs no key. With secretSource: keychain it is read from
                       the macOS Keychain instead (q-core auth set openrouter)
  OPENROUTER_MODEL     default model when the manifest does not set one
  QCORE_WEBHOOK_URL    where catalogue workflows send their result
  TELEGRAM_BOT_TOKEN   used by workflows that publish to Telegram
  TELEGRAM_CHAT_ID     the chat those workflows publish to
  QF_NO_UPDATE_CHECK=1 turn off the version check

Exit codes
  0   success
  1   failed (the run, a check or the command)
  2   waiting: the run is paused on a human decision (approve) or on a caller
      inference reply (reply); resume it, do not start a new run
  64  usage error
  130 cancelled
`;

/**
 * Whichever of the relative and absolute path is shorter — a wall of `../` is
 * not more readable than the full path it is trying to save.
 *
 * The `./` prefix is not decoration. Under launchd the working directory is `/`,
 * so the relative form of an absolute path is the same string with its leading
 * slash shaved off — `Users/oleg/…`, which reads like a path and is not one.
 * Caught in the first scheduled run's log.
 */
function shortPath(p) {
  const abs = resolve(p);
  const cwd = process.cwd();
  /* From the filesystem root every path is "below" the cwd, so the relative form
     is the absolute one minus its leading slash — no shorter, and it reads like a
     path that is not there. Under launchd the cwd IS the root. */
  if (cwd === "/") return abs;
  const rel = relative(cwd, abs);
  if (!rel || rel.length >= abs.length) return abs;
  return rel.startsWith(".") ? rel : `./${rel}`;
}

function fail(message, code = EXIT_FAILED) {
  /* Set exitCode and throw to stop control flow while Node flushes streams. */
  process.stderr.write(`${message}\n`);
  process.exitCode = code;
  throw new ExitSignal();
}
/** Control-flow signal: the exit code has already been set. */
class ExitSignal extends Error {}

const VALUED_FLAGS = new Set(["section", "caller-provider", "approval-hash", "workspace-policy"]);

function parseArgs(argv) {
  const flags = new Set();
  const opts = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) {
      positional.push(a);
      continue;
    }
    const body = a.slice(2);
    const eq = body.indexOf("=");
    if (eq !== -1) {
      opts[body.slice(0, eq)] = body.slice(eq + 1);
      continue;
    }
    if (VALUED_FLAGS.has(body)) {
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        opts[body] = next;
        i += 1;
      } else {
        opts[body] = "";
      }
      continue;
    }
    flags.add(body);
  }
  return { command: positional[0], args: positional.slice(1), flags, opts };
}

/* ── validate ───────────────────────────────────────────────────────────── */

function describePlan(manifest) {
  const flat = flattenWorkflowSteps(manifest.steps);
  const knobs = resolveKnobs(manifest.settings);

  const lines = [];
  lines.push(`${c.bold(manifest.name)} ${c.dim(`(${manifest.id} v${manifest.version})`)}`);
  if (manifest.description) lines.push(`  ${manifest.description.trim().replace(/\n/g, "\n  ")}`);
  lines.push("");
  const triggers = manifest.triggers.length
    ? manifest.triggers.map((t) => (t.kind === "schedule" ? `schedule "${t.cron}" UTC` : t.kind)).join(" · ")
    : "none declared — this workflow only runs when you run it";
  lines.push(`  triggers   ${triggers}`);
  lines.push(`  model      ${knobs.model} ${c.dim(`(${knobs.provenance.model})`)}`);
  lines.push(
    `  budget     ${knobs.budgetUsd === null ? "no ceiling (explicitly lifted)" : `$${Number(knobs.budgetUsd).toFixed(4)} per run`} ${c.dim(`(${knobs.provenance.budget})`)}`,
  );
  if (knobs.limits) lines.push(`  limits     ${JSON.stringify(knobs.limits)} ${c.dim("(enforced by the product, not by this runner)")}`);
  if (knobs.sensitivity) lines.push(`  ${c.bold("sensitivity")} set — this runner REFUSES such a manifest; see the note below`);
  lines.push("");
  lines.push(`  ${flat.length} step(s):`);
  for (const { step, depth } of flat) {
    const pad = "    " + "  ".repeat(depth);
    const name = step.config?.name ?? step.id;
    lines.push(`${pad}${step.kind.padEnd(14)} ${name}`);
  }
  const hasHumanGate = flat.some((f) => f.step.kind === "approval-gate" && (f.step.config?.reviewer ?? "human") === "human");
  lines.push("");
  lines.push(
    hasHumanGate
      ? `  ${c.dim("this workflow stops for a human — `q-core approve` continues it")}`
      : `  ${c.dim("no human gate — this workflow runs to the end on its own")}`,
  );
  return lines.join("\n");
}

async function cmdValidate(args, flags) {
  const file = args[0];
  if (!file) fail("q-core validate <manifest>", EXIT_USAGE);
  const manifest = loadManifest(file);
  if (flags.has("json")) {
    process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
    return EXIT_OK;
  }
  process.stdout.write(`✓ ${shortPath(file)} is a valid q-core.workflow/v1 manifest\n\n`);
  process.stdout.write(`${describePlan(manifest)}\n`);
  if (manifest.settings.sensitivity) {
    process.stdout.write(
      "\n  NOTE: settings.sensitivity is part of the format but not implemented by this runner.\n" +
        "  `q-core run` will refuse this manifest rather than ignore the profile.\n",
    );
  }
  return EXIT_OK;
}

/* ── run ────────────────────────────────────────────────────────────────── */

function printStep(s, quiet) {
  if (quiet) return;
  const mark = { success: "✓", planned: "·", failed: "✗", waiting_human: "⏸" }[s.status] ?? " ";
  const cost = s.costUsd ? ` $${Number(s.costUsd).toFixed(4)}` : "";
  const lane = s.itemIndex != null ? c.dim(` [item ${s.itemIndex}]`) : "";
  process.stdout.write(`  ${mark} ${s.kind.padEnd(14)} ${s.name}${lane}${c.dim(cost)}\n`);
  if (s.status === "failed" && s.errorText) process.stdout.write(`      ${s.errorText}\n`);
  /* A digest that went to a file instead of Telegram is not a delivered digest.
     The run did its work, so this is not a failure — but it must never be quiet,
     or tomorrow nobody remembers why the channel is empty. */
  if (s.output?.sink === "file" && s.output.dispatched !== false) {
    process.stdout.write(`      → delivered to ${s.output.file}\n`);
  } else if (s.output?.sink === "file") {
    process.stdout.write(
      `      ⚠ NOT SENT — ${(s.output.missingEnv ?? []).join(", ")} not set in the environment.\n` +
        `        Written to ${s.output.file} instead.\n`,
    );
  }
}

async function cmdRun(args, flags, opts) {
  const file = args[0];
  if (!file) fail("q-core run <manifest> [--dry-run]", EXIT_USAGE);
  const dryRun = flags.has("dry-run");
  const quiet = flags.has("quiet") || flags.has("json");
  const manifest = loadManifest(file);

  if (!manifest.enabled) {
    process.stdout.write(`${manifest.id} is disabled (enabled: false) — nothing to do.\n`);
    return EXIT_OK;
  }

  const store = new RunStore(file);
  const run = createRun(manifest, { trigger: dryRun ? "dry-run" : "manual" });
  const abort = new AbortController();
  const cancel = () => abort.abort();
  process.on("SIGINT", cancel);
  process.on("SIGTERM", cancel);
  const knobs = resolveKnobs(manifest.settings);
  if (opts['caller-provider']) {
    const provider = readBoundedJson(opts['caller-provider']);
    const { validateCallerInput } = await import('../src/caller-inference.mjs');
    if (provider.kind !== 'caller') fail('Expected a caller provider configuration');
    if (Object.keys(provider).some(key => !['kind', 'agent', 'model', 'payerScope'].includes(key))) fail('Caller configuration accepts kind, agent, model and payerScope only; never include credentials');
    validateCallerInput({ provider });
    run.callerProvider = provider;
  }
  run.executionKnobs = knobs;
  if (opts['workspace-policy']) {
    const { validateWorkspacePolicy } = await import('../src/registry-workspace-steps.mjs');
    run.workspacePolicy = validateWorkspacePolicy(readBoundedJson(opts['workspace-policy']));
  }

  if (!quiet) {
    process.stdout.write(`${c.bold(manifest.name)} ${c.dim(`· run ${run.runId}`)}${dryRun ? c.dim(" · DRY RUN, no side effects") : ""}\n`);
  }

  let result;
  try {
    result = await driveRun(run, {
      store,
      knobs,
      callerProvider: run.callerProvider,
      dryRun,
      apiKey: process.env.OPENROUTER_API_KEY ?? null,
      signal: abort.signal,
      onStep: (s) => printStep(s, quiet),
    });
  } catch (e) {
    /* A refusal before any step ran (a sensitivity profile, for instance). Still
       recorded: a run that never started is also something a monitor must see. */
    run.status = "failed";
    run.summary = e instanceof Error ? e.message : String(e);
    run.finishedAt = new Date().toISOString();
    store.save(run);
    store.saveLastRun(run);
    process.off("SIGINT", cancel);
    process.off("SIGTERM", cancel);
    fail(`✗ ${run.summary}`);
  }

  if (!dryRun) store.saveLastRun(result);

  if (flags.has("json")) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else if (!quiet) {
    process.stdout.write(`\n  ${result.status.toUpperCase()}: ${result.summary}\n`);
    if (result.costUsd) process.stdout.write(`  cost $${Number(result.costUsd).toFixed(4)} · ${result.tokensIn}+${result.tokensOut} tokens\n`);
    if (!dryRun) process.stdout.write(c.dim(`  state ${shortPath(join(store.dir, "runs", `${result.runId}.json`))}\n`));
    if (result.status === 'waiting_inference') process.stdout.write(`\n  Continue with: q-core reply ${file} ${result.runId} <reply.json>\n`);
    if (result.status === "waiting_human") {
      if (result.pendingClarification) process.stdout.write(`\n  Continue with: q-core clarify ${file} ${result.runId} <answers.json>\n`);
      else process.stdout.write(`\n  Continue with:  q-core approve ${file} ${result.runId}\n`);
    }
  }

  process.off("SIGINT", cancel);
  process.off("SIGTERM", cancel);
  return result.status === "success" ? EXIT_OK : result.status === "cancelled" ? 130 : ["waiting_human", "waiting_inference"].includes(result.status) ? EXIT_WAITING : EXIT_FAILED;
}

/** Reply files contain bounded inference output, never credentials. */
function readBoundedJson(file) {
  if (statSync(file).size > 128000) fail('JSON input exceeds 128000 bytes');
  return JSON.parse(readFileSync(file, 'utf8'));
}
async function cmdReply(args) {
  const [file, runId, replyFile] = args;
  if (!file || !runId || !replyFile) fail('q-core reply <manifest> <runId> <reply.json>', EXIT_USAGE);
  const store = new RunStore(file);
  const run = store.load(runId);
  if (!run || run.status !== 'waiting_inference' || !run.pendingInference) fail('Run is not waiting for CLI inference');
  if (!run.executionKnobs || !run.callerProvider) fail('Run has no persisted caller configuration');
  const result = await driveRun(run, { store, knobs: run.executionKnobs, callerProvider: run.callerProvider, inferenceReply: readBoundedJson(replyFile) });
  store.saveLastRun(result);
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  return result.status === 'success' ? EXIT_OK : ['waiting_inference', 'waiting_human'].includes(result.status) ? EXIT_WAITING : EXIT_FAILED;
}

async function cmdClarify(args) {
  const [file, runId, answersFile] = args;
  if (!file || !runId || !answersFile) fail('q-core clarify <manifest> <runId> <answers.json>', EXIT_USAGE);
  const store = new RunStore(file), run = store.load(runId);
  if (!run || run.status !== 'waiting_human' || !run.pendingClarification) fail('Run is not waiting for SDD clarification answers');
  if (!run.executionKnobs || !run.callerProvider) fail('Run has no persisted caller configuration');
  const result = await driveRun(run, { store, knobs: run.executionKnobs, callerProvider: run.callerProvider, clarification: readBoundedJson(answersFile) });
  store.saveLastRun(result);
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  return result.status === 'success' ? EXIT_OK : ['waiting_inference', 'waiting_human'].includes(result.status) ? EXIT_WAITING : EXIT_FAILED;
}

async function cmdPaused(args, action) {
  const [file, runId] = args;
  if (!file || !runId) fail(`q-core ${action} <manifest> <runId>`, EXIT_USAGE);
  const store = new RunStore(file), run = store.load(runId);
  if (!run) fail('Unknown run');
  const opts = { store, knobs: run.executionKnobs, callerProvider: run.callerProvider };
  const result = action === 'cancel' ? cancelWaitingRun(run, opts) : await resumeCancelledRun(run, opts);
  store.saveLastRun(result); process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  return result.status === 'cancelled' ? 130 : result.status === 'success' ? 0 : 2;
}

/* ── status ─────────────────────────────────────────────────────────────── */

async function cmdStatus(args, flags) {
  const file = args[0] ?? findManifestNearby();
  if (!file) fail("q-core status <manifest> — or run it from a directory holding one", EXIT_USAGE);
  const store = new RunStore(file);
  const last = store.lastRun();
  const runs = store.listRuns(10);

  if (flags.has("json")) {
    process.stdout.write(`${JSON.stringify({ last, runs }, null, 2)}\n`);
    return last?.status === "success" || last == null ? EXIT_OK : last?.status === "cancelled" ? 130 : EXIT_FAILED;
  }

  if (!runs.length) {
    process.stdout.write(`no runs recorded in ${shortPath(store.dir)}\n`);
    return EXIT_OK;
  }
  process.stdout.write(`${c.bold("last runs")} ${c.dim(shortPath(store.dir))}\n\n`);
  for (const r of runs) {
    const mark = { success: "✓", failed: "✗", cancelled: "■", waiting_human: "⏸", running: "…" }[r.status] ?? " ";
    const when = String(r.startedAt).replace("T", " ").slice(0, 19);
    process.stdout.write(`  ${mark} ${when}  ${r.status.padEnd(14)} ${r.summary ?? ""}\n`);
    if (r.status === "waiting_human") process.stdout.write(c.dim(`      q-core approve ${file} ${r.runId}\n`));
  }
  if (last?.status === "failed") {
    process.stdout.write(`\n  ${c.bold("last run FAILED")}: ${last.reason ?? last.summary}\n`);
  }
  return last?.status === "cancelled" ? 130 : last?.status === "failed" ? EXIT_FAILED : EXIT_OK;
}

function findManifestNearby() {
  try {
    const y = readdirSync(process.cwd()).filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"));
    return y.length === 1 ? y[0] : null;
  } catch {
    return null;
  }
}

/* ── approve ────────────────────────────────────────────────────────────── */

async function cmdApprove(args, flags, opts) {
  const file = args[0];
  if (!file) fail("q-core approve <manifest> [runId] [--reject]", EXIT_USAGE);
  const store = new RunStore(file);
  const runId = args[1] ?? store.listRuns(50).find((r) => r.status === "waiting_human")?.runId;
  if (!runId) fail("no run is waiting on a human here.");
  const run = store.load(runId);
  if (!run) fail(`run ${runId} not found under ${store.runsDir}`);

  const manifest = loadManifest(file);
  const decision = flags.has("reject") ? "reject" : "approve";
  const result = await resumeRun(run, {
    decision,
    approvalHash: opts['approval-hash'],
    store,
    knobs: run.executionKnobs ?? resolveKnobs(manifest.settings),
    callerProvider: run.callerProvider,
    apiKey: process.env.OPENROUTER_API_KEY ?? null,
    onStep: (s) => printStep(s, flags.has("quiet") || flags.has("json")),
  });
  store.saveLastRun(result);
  if (flags.has('json')) process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  else process.stdout.write(`\n  ${result.status.toUpperCase()}: ${result.summary}\n`);
  return result.status === "success" ? EXIT_OK : ["waiting_human", "waiting_inference"].includes(result.status) ? EXIT_WAITING : EXIT_FAILED;
}

/* ── catalog · init ─────────────────────────────────────────────────────── */

const CATALOG_ROOTS = resolveCatalogRoots({ here: HERE });
const WORKFLOWS_DIR = CATALOG_ROOTS.workflowsDir;
const REGISTRY_DIR = CATALOG_ROOTS.registryDir;
const EXAMPLES_DIR = join(HERE, "..", "examples");

const CATALOG_SECTIONS = new Set(["workflows", "components", "demos"]);

function printWorkflows(workflows) {
  process.stdout.write(`${c.bold(`${workflows.length} workflows ship with q-core ${PKG.version}`)}\n\n`);
  for (const l of workflows) {
    const cost = !l.measured ? "not measured yet" : l.measured.costUsd === null ? "cost unknown" : `$${l.measured.costUsd.toFixed(4)}/run`;
    const shape = l.fansOut ? `${l.steps} steps, a lane per item (max ${l.maxItems})` : `${l.steps} steps`;
    process.stdout.write(`  ${c.bold(l.id)} ${c.dim(`· ${shape} · ${cost}`)}\n`);
    process.stdout.write(`    ${l.description}\n`);
    const needs = l.needsEnv.length ? l.needsEnv.join(", ") : "nothing";
    process.stdout.write(c.dim(`    needs: ${needs}${l.humanGate ? " · stops for you" : " · runs on its own"}\n\n`));
  }
}

function printComponents(components) {
  process.stdout.write(`${c.bold(`${components.length} components`)}\n\n`);
  for (const comp of components) {
    if (comp.status === "planned" && comp.launch === "forbidden") {
      process.stdout.write(`  ${c.bold(comp.id)} ${c.dim("· planned · launch forbidden")}\n`);
      process.stdout.write(`    ${comp.description}\n`);
      process.stdout.write(c.dim(`    unavailable: ${comp.reason}\n\n`));
      continue;
    }
    const used = comp.usedBy?.length ? `used by ${comp.usedBy.length} workflow(s)` : "used by none yet";
    process.stdout.write(`  ${c.bold(comp.id)} ${c.dim(`· ${comp.kind} · ${used}`)}\n`);
    process.stdout.write(`    ${comp.description}\n\n`);
  }
}

function printDemos(demos) {
  process.stdout.write(`${c.bold(`${demos.length} demos`)}\n\n`);
  for (const d of demos) {
    if (d.status === "planned" && d.launch === "forbidden") {
      process.stdout.write(`  ${c.bold(d.id)} ${c.dim("· planned · launch forbidden")}\n`);
      process.stdout.write(`    ${d.description}\n`);
      process.stdout.write(c.dim(`    unavailable: ${d.reason}\n\n`));
      continue;
    }
    const live = d.live ? "live" : "not live";
    const proof = d.proof ? `proof ${d.proof}` : "no proof";
    process.stdout.write(`  ${c.bold(d.id)} ${c.dim(`· ${d.name} · ${proof} · ${live}`)}\n`);
    process.stdout.write(`    ${d.description}\n\n`);
  }
}

async function cmdCatalog(args, flags, opts = {}) {
  const local = buildCatalog(WORKFLOWS_DIR, { examplesDir: EXAMPLES_DIR, registryDir: REGISTRY_DIR });
  let cat = local;
  /* `--remote` shows what has been published since this build shipped. Off by
     default: a listing command must not need the network to answer. */
  if (flags.has("remote")) {
    const r = await fetchRemoteCatalog();
    if (!r) fail(`could not reach the published catalogue at ${REMOTE_CATALOG_BASE}`);
    const extra = r.workflows.filter((l) => !local.workflows.some((k) => k.id === l.id));
    cat = { ...r, workflows: r.workflows };
    if (!flags.has("json")) {
      process.stdout.write(c.dim(`published catalogue · ${extra.length} workflow(s) newer than this build\n\n`));
    }
  }
  const section = opts.section;
  if (section != null && section !== "") {
    if (!CATALOG_SECTIONS.has(section)) {
      fail(`unknown catalog section "${section}". Use workflows, components, or demos.`, EXIT_USAGE);
    }
  } else if (section === "") {
    fail("q-core catalog --section workflows|components|demos", EXIT_USAGE);
  }
  if (flags.has("json")) {
    const payload = section ? { catalogVersion: cat.catalogVersion, [section]: cat[section] ?? [] } : cat;
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return EXIT_OK;
  }
  const show = (name) => !section || section === name;
  if (show("workflows")) printWorkflows(cat.workflows ?? []);
  if (show("components")) printComponents(cat.components ?? []);
  if (show("demos")) printDemos(cat.demos ?? []);
  if (show("workflows")) process.stdout.write(c.dim(`  q-core init <id>   copies one here\n`));
  return EXIT_OK;
}

async function cmdInit(args, flags) {
  const id = args[0];
  const cat = buildCatalog(WORKFLOWS_DIR, { examplesDir: EXAMPLES_DIR, registryDir: REGISTRY_DIR });
  if (!id) {
    fail(`q-core init <id>\n\nAvailable: ${cat.workflows.map((l) => l.id).join(", ")}`, EXIT_USAGE);
  }

  let entry = cat.workflows.find((l) => l.id === id);
  let remote = null;

  const planned = [...(cat.components ?? []), ...(cat.demos ?? [])]
    .find((candidate) => candidate.id === id && candidate.status === "planned" && candidate.launch === "forbidden");
  if (planned) {
    fail(`${id} is planned in this registry and cannot be initialized or run: ${planned.reason}`, EXIT_USAGE);
  }

  /* ── NOT IN THIS BUILD? LOOK IT UP IN THE PUBLISHED CATALOGUE ─────────────
     The package ships a snapshot of the catalogue as of its release; the
     published one keeps growing. Without this, "q-core init <something-new>"
     would tell a person the workflow does not exist when it plainly does on the
     site they just read it on. */
  if (!entry && !flags.has("offline")) {
    const rcat = await fetchRemoteCatalog();
    const rentry = rcat?.workflows.find((l) => l.id === id);
    if (rentry) {
      const got = await fetchRemoteManifest(rentry).catch((e) => {
        fail(`"${id}" is in the published catalogue, but it could not be downloaded — ${e.message}`);
      });
      /* VALIDATE BEFORE IT TOUCHES DISK. A manifest is not executable, but it
         directs network calls and model spending; bytes from a host do not get
         written here on the strength of having arrived. */
      try {
        validateManifest(parseYaml(got.text));
      } catch (e) {
        fail(`"${id}" downloaded from ${got.url}, but it is not a valid manifest — ${e.message}\n` +
             `Nothing was written.`);
      }
      entry = rentry;
      remote = got;
    }
  }

  if (!entry) {
    const hint = flags.has("offline") ? " (--offline: the published catalogue was not consulted)" : "";
    fail(`no workflow "${id}"${hint}.\n\nIn this build: ${cat.workflows.map((l) => l.id).join(", ")}`, EXIT_USAGE);
  }

  const dest = resolve(args[1] ?? process.cwd(), `${id}.yaml`);
  /* Never overwrite. The file being copied over is, by definition, the one the
     person already edited — the manifest IS their work, not scaffolding. */
  if (existsSync(dest)) fail(`${shortPath(dest)} already exists — not overwriting it.`);
  if (remote) writeFileSync(dest, remote.text, "utf8");
  else copyFileSync(join(WORKFLOWS_DIR, basename(entry.file)), dest);

  process.stdout.write(`${c.bold(entry.name)}\n  → ${shortPath(dest)}\n`);
  if (remote) {
    /* Where a file came from is not a detail when the file will spend money. */
    process.stdout.write(c.dim(`  downloaded from ${remote.url}\n  read it before you run it — a workflow makes requests and calls models on your key.\n`));
  }
  process.stdout.write("\n");
  if (entry.needsEnv.length) {
    const missing = entry.needsEnv.filter((v) => !process.env[v]);
    process.stdout.write(`  needs: ${entry.needsEnv.join(", ")}\n`);
    if (missing.length) {
      process.stdout.write(`  ${c.bold("not set here:")} ${missing.join(", ")}\n`);
      /* Two different consequences, and conflating them would be a lie: without a
         model key the step FAILS; without a receiver the result is still produced
         and lands in .qf/out/. */
      if (missing.includes("OPENROUTER_API_KEY")) {
        process.stdout.write(c.dim(`  Without OPENROUTER_API_KEY the model step fails — it will not invent text.\n`));
      }
      const sinks = missing.filter((v) => v !== "OPENROUTER_API_KEY");
      if (sinks.length) {
        process.stdout.write(c.dim(`  Without ${sinks.join(", ")} the workflow still runs; the result goes to .qf/out/ and says so.\n`));
      }
    }
  }
  process.stdout.write(`\n  Next:  q-core run ${shortPath(dest)} --dry-run\n`);
  return EXIT_OK;
}

/* ── doctor ─────────────────────────────────────────────────────────────── */

async function cmdDoctor(args, flags) {
  /* Three levels, not two. An unset optional variable is NOT a fault — calling
     it one trains the reader to ignore the whole report, which is how a doctor
     command becomes decoration. Only `fail` counts towards the exit code. */
  const checks = [];
  const add = (level, label, detail) => checks.push({ level, label, detail });

  const major = Number(process.versions.node.split(".")[0]);
  add(major >= 20 ? "ok" : "fail", `Node ${process.versions.node}`, major >= 20 ? "" : "q-core needs Node 20 or newer");
  add("ok", `q-core ${PKG.version}`, shortPath(join(HERE, "q-core.mjs")));

  /* Names only, never values. A doctor command that prints a token into a
     terminal — and then into a screenshot in a bug report — is a leak. */
  const ENV_NOTES = {
    OPENROUTER_API_KEY: "no model calls will run without it — the step fails rather than inventing text",
    QCORE_WEBHOOK_URL: "catalogue workflows will write to .qf/out/ instead of sending",
    TELEGRAM_BOT_TOKEN: "Telegram workflows will write to .qf/out/ instead of sending",
    TELEGRAM_CHAT_ID: "Telegram workflows will write to .qf/out/ instead of sending",
  };
  for (const [v, why] of Object.entries(ENV_NOTES)) {
    add(process.env[v] ? "ok" : "warn", v, process.env[v] ? "set" : `not set — ${why}`);
  }

  const envFile = join(homedir(), ".qf", "env");
  if (existsSync(envFile)) {
    const mode = (statSync(envFile).mode & 0o777).toString(8);
    add(mode === "600" ? "ok" : "fail", `~/.qf/env (${mode})`, mode === "600" ? "" : "holds secrets — chmod 600 it");
  } else {
    add("warn", "~/.qf/env", "absent — only needed by a scheduled job");
  }

  try {
    const probe = join(process.cwd(), `.q-core-write-probe-${process.pid}`);
    writeFileSync(probe, "");
    unlinkSync(probe);
    add("ok", "write access here", process.cwd());
  } catch {
    add("fail", "write access here", `cannot write in ${process.cwd()} — .qf/ state has nowhere to go`);
  }

  if (!flags.has("offline")) {
    const t0 = Date.now();
    try {
      const res = await fetch("https://openrouter.ai/api/v1/models", { signal: AbortSignal.timeout(4000) });
      add(res.ok ? "ok" : "warn", "openrouter.ai reachable", `HTTP ${res.status} in ${Date.now() - t0} ms`);
    } catch (e) {
      add("warn", "openrouter.ai", `unreachable: ${e instanceof Error ? e.message : e} — only matters for llm-call steps`);
    }
  }

  if (flags.has("json")) {
    process.stdout.write(`${JSON.stringify(checks, null, 2)}\n`);
  } else {
    process.stdout.write(`${c.bold("q-core doctor")}\n\n`);
    for (const ch of checks) {
      const mark = { ok: "✓", warn: "·", fail: "✗" }[ch.level];
      process.stdout.write(`  ${mark} ${ch.label}${ch.detail ? c.dim(`  ${ch.detail}`) : ""}\n`);
    }
    const bad = checks.filter((ch) => ch.level === "fail");
    const warn = checks.filter((ch) => ch.level === "warn");
    process.stdout.write(
      bad.length
        ? `\n  ${bad.length} thing(s) in the way.\n`
        : `\n  Nothing in the way.${warn.length ? c.dim(` ${warn.length} optional thing(s) not set — see the dots.`) : ""}\n`,
    );
  }
  return checks.some((ch) => ch.level === "fail") ? EXIT_FAILED : EXIT_OK;
}

/* ── entry ──────────────────────────────────────────────────────────────── */

const { command, args, flags, opts } = parseArgs(process.argv.slice(2));

const commands = {
  catalog: cmdCatalog,
  init: cmdInit,
  validate: cmdValidate,
  run: cmdRun,
  reply: cmdReply,
  clarify: cmdClarify,
  cancel: args => cmdPaused(args, 'cancel'),
  resume: args => cmdPaused(args, 'resume'),
  status: cmdStatus,
  approve: cmdApprove,
  doctor: cmdDoctor,
};

/** Keep dispatch inside main so help/version return before command lookup. */
async function main() {
  if (flags.has("version")) {
    process.stdout.write(`${PKG.version}\n`);
    return EXIT_OK;
  }
  /* Explicit help succeeds; a missing command is a usage error. */
  if (!command || flags.has("help") || command === "help") {
    process.stdout.write(USAGE);
    return flags.has("help") || command === "help" ? EXIT_OK : EXIT_USAGE;
  }

  const handler = commands[command];
  if (!handler) fail(`unknown command "${command}".\n\n${USAGE}`, EXIT_USAGE);

  const code = await handler(args, flags, opts);
  /* The version check runs AFTER the work, never before it, and never during a
     --quiet or --json run whose output something else is parsing. */
  if (!flags.has("quiet") && !flags.has("json")) {
    const notice = updateNotice(await checkForUpdate(PKG.version));
    if (notice) process.stdout.write(c.dim(notice));
  }
  return code;
}

/** renamedFormatHint: the retired manifest namespace was renamed, not versioned; say so instead of "older or newer". */
function renamedFormatHint(message) {
  return message.includes("declares qloops.loop/")
    ? "The manifest format was renamed: qloops.loop/* is now q-core.workflow/v1. Change the first line to\n" +
        "  `manifest: q-core.workflow/v1` and check the workflow against the current Registry; there is no\n" +
        "  silent compatibility with the old name.\n"
    : "";
}

/** Set exitCode and let Node flush pipe output; process.exit() can truncate JSON. */
try {
  process.exitCode = await main();
} catch (e) {
  if (e instanceof ExitSignal) {
    /* fail() has already reported the error and set the exit code. */
  } else if (e instanceof ManifestError) {
    const hint = renamedFormatHint(e.message);
    process.stderr.write(hint ? `✗ ${hint}` : `✗ ${e.message}\n`);
    process.exitCode = EXIT_FAILED;
  } else {
    process.stderr.write(`✗ ${e instanceof Error ? e.message : String(e)}\n`);
    process.exitCode = EXIT_FAILED;
  }
}
