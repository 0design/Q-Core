/**
 * One runner per step kind — the runner's copy of `lib/processes/step-runners.ts`.
 *
 *   fetch          → Fetch / Source   — reads a source (RSS · HTTP · API)
 *   llm-call       → LLM-Call         — an isolated model request
 *   approval-gate  → Human-Gate (reviewer=human) OR Agent-Gate (reviewer=agent)
 *   api-request    → API-Request      — an outgoing request; A WORKFLOW MAY END HERE
 *   fan-out        → handled by the driver, not here (it creates rows, not output)
 *
 * `schedule` is a TRIGGER, not a runner. `q-core run` performs one pass; whether it
 * is time for that pass is decided by launchd/cron, which is the honest place
 * for it — see README §Scheduling.
 *
 * Outputs, error texts and thrown messages are matched to the engine word for
 * word where they are observable, because the parity test compares them.
 */
import { requireStr, num, oneOf, str } from "./config.mjs";
import { resolveTemplate, resolveTemplateDeep, missingEnvRefs } from "./template.mjs";
import { fetchWithRetry } from "./http.mjs";
import { CoreError, hash, insist } from "./contracts.mjs";
import { deliverOnce } from "./delivery-receipts.mjs";
import { appendFileSync, existsSync, lstatSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
export { fetchWithRetry } from "./http.mjs";

/** Cap on a response body we hold in memory and write into state. */
const BODY_CAP = 64_000;

function boundedTimeoutSec(config, label) {
  const raw = str(config, "timeoutSec");
  if (raw === undefined) return 30_000;
  const seconds = Number(raw);
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > 300)
    throw new Error(`"${label}": timeoutSec must be an integer from 1 to 300.`);
  return seconds * 1000;
}

import { openRouter } from "./providers/openrouter.mjs";

/** Human label of a step for messages: `config.name`, else the kind. */
export function stepLabel(step) {
  return str(step.config, "name") ?? step.kind;
}

/** The last successful output — what a gate shows and what api-request sends by default. */
function lastOutput(ctx) {
  const vals = Object.values(ctx.priorOutputs);
  return vals.length ? vals[vals.length - 1] : null;
}

/** Template context, carrying the lane variables so every runner sees them alike. */
const tctx = (ctx) => ({
  priorOutputs: ctx.priorOutputs,
  priorStepNames: ctx.priorStepNames,
  ...(ctx.item !== undefined ? { item: ctx.item } : {}),
  ...(ctx.itemIndex != null ? { index: ctx.itemIndex } : {}),
  run: { id: ctx.runId, workflowId: ctx.templateId, costUsd: ctx.spentUsd ?? 0 },
});

/* ───────────────────────────── fetch ───────────────────────────── */

/**
 * MINIMAL RSS/Atom reader — regex, not an XML parser, and it says so.
 * It handles CDATA, <item> (RSS 2.0) and <entry> (Atom). It does NOT handle
 * nested same-name tags, namespace prefixes or exotic encodings. A feed it
 * cannot read yields `entries: []`, and the step then FAILS on empty input
 * rather than quietly reporting success over nothing.
 */
export function parseFeed(xml) {
  const blocks = [...xml.matchAll(/<(item|entry)\b[\s\S]*?<\/\1>/gi)].map((m) => m[0]);
  const unwrap = (s) =>
    s
      .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
      .replace(/<[^>]+>/g, " ")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&amp;/g, "&")
      .replace(/\s+/g, " ")
      .trim();
  const tag = (block, name) => {
    const m = block.match(new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`, "i"));
    return m ? unwrap(m[1]) : "";
  };
  return blocks.map((b) => {
    const hrefAttr = b.match(/<link\b[^>]*href=["']([^"']+)["']/i)?.[1] ?? "";
    return {
      title: tag(b, "title"),
      link: hrefAttr || tag(b, "link"),
      summary: tag(b, "description") || tag(b, "summary") || tag(b, "content"),
      published: tag(b, "pubDate") || tag(b, "published") || tag(b, "updated"),
    };
  });
}

export async function runFetch(step, ctx) {
  const label = stepLabel(step);
  const url = resolveTemplate(requireStr(step.config, "url", label), tctx(ctx));
  if (!/^https?:\/\//i.test(url)) {
    throw new Error(`"${label}": url must start with http(s):// — got "${url}".`);
  }
  const format = oneOf(step.config, "format", ["text", "json", "rss"]) ?? "text";
  const timeoutMs = boundedTimeoutSec(step.config, label);

  let res;
  try {
    res = await fetchWithRetry(
      url,
      { headers: { "User-Agent": "q-core-workflow-engine/1" }, signal: ctx.signal },
      { timeoutMs, retries: 2 },
    );
  } catch (e) {
    const why = e instanceof Error && e.name === "TimeoutError" ? `timed out after ${timeoutMs} ms` : String(e instanceof Error ? e.message : e);
    throw new Error(`"${label}": GET ${url} failed before any response — ${why}`);
  }
  const maxBodyBytes = Number(step.config.maxBodyBytes ?? BODY_CAP);
  insist(Number.isInteger(maxBodyBytes) && maxBodyBytes >= 1024 && maxBodyBytes <= 2000000, 'fetch maxBodyBytes must be 1024..2000000');
  const reader = res.body?.getReader(), chunks = [];
  let bytes = 0, truncated = false;
  if (reader) for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    const remaining = maxBodyBytes - bytes;
    chunks.push(Buffer.from(value.subarray(0, remaining)));
    bytes += Math.min(value.length, remaining);
    if (value.length > remaining) { truncated = true; await reader.cancel(); break; }
  }
  const text = Buffer.concat(chunks).toString('utf8');

  if (!res.ok) {
    throw new Error(`"${label}": GET ${url} → HTTP ${res.status}. ${text.slice(0, 300)}`);
  }
  if (format === "json") {
    try {
      return { output: { status: res.status, url, json: JSON.parse(text) } };
    } catch {
      throw new Error(`"${label}": the response is not JSON (format=json). First 200 chars: ${text.slice(0, 200)}`);
    }
  }
  if (format === "rss") {
    const entries = parseFeed(text);
    const limit = num(step.config, "limit") ?? 10;
    if (entries.length === 0) {
      throw new Error(
        `"${label}": no <item>/<entry> found in ${url}. ` +
          `Either it is not RSS/Atom, or this parser could not read it (see the parseFeed limits).`,
      );
    }
    return { output: { status: res.status, url, count: entries.length, entries: entries.slice(0, limit) } };
  }
  return { output: { status: res.status, url, body: text, truncated } };
}

/* ──────────────────────────── llm-call ──────────────────────────── */

/** One model call. No canned fallback — see runLlmCall on why a mock is poison here. */
export async function chatOnce({ apiKey, keyRef = "OPENROUTER_API_KEY", secretSource = "env", model, system, user, maxTokens, temperature, timeoutMs, retries, delaysMs, signal }) {
  // `apiKey` is the legacy/default alias supplied by the CLI. A step-level
  // alias must resolve its own environment entry; silently reusing the default
  // key would charge/send as the wrong credential. Keychain resolution ignores
  // this env value and remains explicitly selected by secretSource.
  const selectedKey = keyRef === "OPENROUTER_API_KEY" ? apiKey : process.env[keyRef];
  const result = await openRouter({ model, messages: [{role:'system',content:system},{role:'user',content:user}], keyRef, secretSource, payerScope:'local-byok', maxTokens, temperature, timeoutMs, retries, delaysMs, signal }, {env:{[keyRef]:selectedKey}});
  return { ...result, usage:{...result.usage, model:result.provider.model ?? model} };
}

/** First JSON object in a reply, tolerating fences and prose around it. */
export function parseJsonObject(content) {
  const m = content.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const o = JSON.parse(m[0]);
    return o && typeof o === "object" ? o : null;
  } catch {
    return null;
  }
}

export async function runLlmCall(step, ctx, model, maxTokens) {
  const label = stepLabel(step);
  const instructions = resolveTemplate(requireStr(step.config, "instructions", label), tctx(ctx));
  const role = str(step.config, "role");

  const keyRef = str(step.config, "keyRef") ?? "OPENROUTER_API_KEY";
  const secretSource = str(step.config, "secretSource") ?? "env";
  const envSecret = keyRef === "OPENROUTER_API_KEY" ? ctx.apiKey : process.env[keyRef];
  if (secretSource === "env" && (typeof envSecret !== "string" || !envSecret.trim())) {
    /* NOT a mock. This output feeds the next step and possibly an outside API,
       where no "this was invented" label survives. So: failure. */
    throw new CoreError(
      "AUTH_REQUIRED",
      `"${label}": no OpenRouter key (set ${keyRef}). ` +
        `The engine will not substitute a mock inside a workflow: invented text would travel down the chain as real.`,
    );
  }

  if (!model) throw new Error("OpenRouter model is not configured; set OPENROUTER_MODEL or an explicit model override. This YAML route is not CLI caller inference.");

  const system =
    (role ? `You are the ${role} agent in an autonomous factory. ` : "") +
    instructions +
    "\n\nAnswer with the result only — no preamble, no meta-commentary.";

  const payload =
    ctx.item !== undefined ? { item: ctx.item, index: ctx.itemIndex, steps: ctx.priorOutputs } : ctx.priorOutputs;
  const user = JSON.stringify(payload, null, 2).slice(0, 60_000);

  const { content, usage } = await chatOnce({
    apiKey: ctx.apiKey,
    keyRef,
    secretSource,
    model,
    system,
    user,
    maxTokens,
    temperature: num(step.config, "temperature") ?? 0.3,
    signal: ctx.signal,
  });

  const wantJson = (oneOf(step.config, "format", ["text", "json"]) ?? "text") === "json";
  const parsed = wantJson ? parseJsonObject(content) : null;
  if (wantJson && !parsed) {
    throw new Error(`"${label}": format=json, but the model returned non-JSON. First 200: ${content.slice(0, 200)}`);
  }
  return { output: parsed ?? { text: content, model }, tokensIn: usage.tokensIn ?? 0, tokensOut: usage.tokensOut ?? 0 };
}

/* ────────────────────── approval-gate (human | agent) ────────────────────── */

/**
 * One kind, two modes. Human-Gate and Agent-Gate differ only in WHO gives the
 * verdict; the shape (anchor · rubric · escalateOn) is shared.
 *
 * Human-Gate stops the run. It is NOT a required component of a workflow — a workflow
 * that ends in `api-request` and never meets a person is a valid workflow.
 *
 * Agent-Gate is a machine check. Without a key it does NOT wave anything
 * through: a check that says "fine" because its tool was missing is worse than
 * no check, because it leaves a record of a check that never happened.
 */
export async function runApprovalGate(step, ctx, model, maxTokens) {
  const label = stepLabel(step);
  const reviewer = oneOf(step.config, "reviewer", ["human", "agent"]) ?? "human";
  const anchor = str(step.config, "anchor") ?? null;

  if (reviewer === "human") {
    const subject = lastOutput(ctx);
    return {
      output: {
        gate: { reviewer: "human", anchor, mode: str(step.config, "mode") ?? "approve" },
        subject,
        ...(step.config.bind === 'sha256' ? { approvalHash: hash(subject) } : {}),
      },
      waitingHuman: true,
    };
  }

  const rubric = str(step.config, "rubric");
  if (!rubric) {
    throw new Error(
      `"${label}": an Agent-Gate with no "rubric" has nothing to check against. ` +
        `Either set the criterion, or switch reviewer to human.`,
    );
  }
  const keyRef = str(step.config, "keyRef") ?? "OPENROUTER_API_KEY";
  const secretSource = str(step.config, "secretSource") ?? "env";
  const envSecret = keyRef === "OPENROUTER_API_KEY" ? ctx.apiKey : process.env[keyRef];
  if (secretSource === "env" && (typeof envSecret !== "string" || !envSecret.trim())) {
    if (keyRef === "OPENROUTER_API_KEY") {
      return {
        output: {
          gate: { reviewer: "agent", anchor, rubric },
          verdict: null,
          escalated: true,
          reason: "No OpenRouter key — the machine check did not run. The gate was handed to a human, not waved through.",
        },
        waitingHuman: true,
      };
    }
    throw new CoreError(
      "AUTH_REQUIRED",
      `"${label}": no OpenRouter key (set ${keyRef}). The machine check did not run; the gate was not waved through.`,
    );
  }

  if (!model) throw new Error("OpenRouter model is not configured; set OPENROUTER_MODEL or an explicit model override.");

  const { content, usage } = await chatOnce({
    apiKey: ctx.apiKey,
    keyRef,
    secretSource,
    model,
    system:
      "You are a strict validation gate in an autonomous factory. Judge the CANDIDATE against the RUBRIC. " +
      'Return ONLY one JSON object: {"pass": true|false, "reason": "one sentence"}. ' +
      "Default to pass=false when the rubric is not clearly satisfied.",
    user: JSON.stringify({ rubric, candidate: lastOutput(ctx) }, null, 2).slice(0, 60_000),
    maxTokens: Math.min(maxTokens, 300),
    temperature: 0,
    signal: ctx.signal,
  });

  const verdict = parseJsonObject(content);
  const pass = verdict?.pass === true;
  const reason = typeof verdict?.reason === "string" ? verdict.reason : content.slice(0, 300);
  const tokens = { tokensIn: usage.tokensIn ?? 0, tokensOut: usage.tokensOut ?? 0 };

  if (pass) {
    return { output: { gate: { reviewer: "agent", anchor, rubric }, verdict: { pass: true, reason } }, ...tokens };
  }
  const escalate = (str(step.config, "escalateOn") ?? "objection") === "objection";
  if (escalate) {
    return {
      output: { gate: { reviewer: "agent", anchor, rubric }, verdict: { pass: false, reason }, escalated: true },
      waitingHuman: true,
      ...tokens,
    };
  }
  throw new Error(`"${label}": the Agent-Gate did not pass — ${reason}`);
}

/* ────────────────────────── api-request ────────────────────────── */

/**
 * The request body. An explicit `body` wins; otherwise the last successful
 * output IN AN ENVELOPE — the receiver has to see WHICH run and WHICH workflow sent
 * this, or an inbox of digests is impossible to untangle.
 */
function buildBody(step, ctx, t) {
  const rawBody = str(step.config, "body");
  if (!rawBody) return { runId: ctx.runId, templateId: ctx.templateId, payload: lastOutput(ctx) };
  try {
    return resolveTemplateDeep(JSON.parse(rawBody), t);
  } catch {
    return resolveTemplate(rawBody, t); /* not JSON → send it as text */
  }
}

export async function runApiRequest(step, ctx) {
  const label = stepLabel(step);
  const t = tctx(ctx);

  const rawUrl = requireStr(step.config, "url", label);
  const url = resolveTemplate(rawUrl, t);

  /* ── THE ONE DELIBERATE DIVERGENCE FROM THE ENGINE ─────────────────────────
     A URL that still references an UNSET environment variable is not sent. The
     engine would post to a literal-braces URL and collect a 404; here the
     payload goes to `.qf/out/` instead and the CLI says so loudly.

     Why the difference is allowed to exist: the whole point of running locally
     is that you can prove a workflow end-to-end before you have the credentials for
     its real receiver. Firing a request at a URL with `{{env.TELEGRAM_BOT_TOKEN}}`
     in it proves nothing and looks, in a log, exactly like a broken workflow.

     Why it is safe: it can only trigger on a reference that DOES NOT RESOLVE, so
     no run that would have succeeded behaves differently. It is documented in
     SPEC-MANIFEST.md §Divergences and in the README, not left to be discovered.
     ───────────────────────────────────────────────────────────────────────── */
  const missing = missingEnvRefs(rawUrl);
  const receiptKey = str(step.config, "receiptKey");
  if (receiptKey) insist(missing.length === 0, 'Idempotent delivery requires an explicit destination; no file fallback');
  if (missing.length && ctx.fileSink) {
    const payload = buildBody(step, ctx, t);
    const file = ctx.fileSink(typeof payload === "string" ? payload : JSON.stringify(payload, null, 2));
    return {
      output: {
        dispatched: false,
        sink: "file",
        file,
        missingEnv: missing,
        note: `Not sent: ${missing.join(", ")} ${missing.length > 1 ? "are" : "is"} not set. The payload was written to the file sink instead.`,
      },
    };
  }

  /* A local file destination: file:///absolute/path appends one delivery per line (JSON Lines).
     Same receipt and duplicate rules as HTTP; the directory must already exist. */
  if (/^file:\/\//i.test(url)) {
    let path;
    try { path = fileURLToPath(url); } catch { throw new Error(`"${label}": a file destination must be an absolute file:/// URL — got "${url}".`); }
    if (!existsSync(dirname(path)) || !statSync(dirname(path)).isDirectory()) throw new Error(`"${label}": the folder of the file destination does not exist: ${dirname(path)}`);
    if (existsSync(path)) insist(lstatSync(path).isFile() && !lstatSync(path).isSymbolicLink(), `"${label}": the file destination must be a regular file`);
    const payload = buildBody(step, ctx, t);
    const line = typeof payload === "string" ? payload : JSON.stringify(payload);
    const sendFile = async () => {
      appendFileSync(path, `${line.replace(/\n/g, "\\n")}\n`, { mode: 0o600 });
      return { output: { dispatched: true, sink: "file", url, file: path } };
    };
    if (!receiptKey) return sendFile();
    return deliverOnce({ store: ctx.runStore, destination: { url, method: "APPEND" }, key: resolveTemplate(receiptKey, t), payloadHash: hash(line) }, sendFile);
  }

  if (!/^https?:\/\//i.test(url)) {
    throw new Error(`"${label}": url must start with http(s):// or be a file:/// destination — template resolution produced "${url}".`);
  }
  const method = oneOf(step.config, "method", ["GET", "POST", "PUT", "PATCH", "DELETE"]) ?? "POST";

  const headers = { "Content-Type": "application/json" };
  const rawHeaders = str(step.config, "headers");
  if (rawHeaders) {
    let parsed;
    try {
      parsed = JSON.parse(resolveTemplate(rawHeaders, t));
    } catch {
      throw new Error(`"${label}": the "headers" field must be a JSON object. Got: ${rawHeaders.slice(0, 120)}`);
    }
    for (const [k, v] of Object.entries(parsed)) if (typeof v === "string") headers[k] = v;
  }

  const payload = buildBody(step, ctx, t);
  const bodyString = typeof payload === "string" ? payload : JSON.stringify(payload);
  const send = async () => {
  let status = 0;
  let responseText = "";
  try {
    const init = { method, headers, signal: ctx.signal };
    if (method !== "GET") init.body = bodyString;
    const res = await fetchWithRetry(url, init, {
      timeoutMs: boundedTimeoutSec(step.config, label),
      retries: receiptKey ? 0 : 2,
    });
    status = res.status;
    responseText = (await res.text()).slice(0, 4000);
  } catch (e) {
    throw new Error(`"${label}": ${method} ${url} failed before any response: ${e instanceof Error ? e.message : String(e)}`);
  }

  const expect = oneOf(step.config, "expect", ["2xx", "any"]) ?? "2xx";
  if (expect === "2xx" && (status < 200 || status >= 300)) {
    throw new Error(`"${label}": ${method} ${url} → HTTP ${status}. ${responseText.slice(0, 500)}`);
  }
  return { output: { dispatched: true, method, url, status, response: responseText } };
  };
  if (!receiptKey) return send();
  return deliverOnce({ store: ctx.runStore, destination: { url, method }, key: resolveTemplate(receiptKey, t), payloadHash: hash(bodyString) }, send);
}
