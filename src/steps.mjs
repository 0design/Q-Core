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
import { resolveTemplate, resolveTemplateDeep, resolveTemplateValue, resolveUrlTemplate, resolveJsonTemplate, missingEnvRefs } from "./template.mjs";
import { fetchWithRetry } from "./http.mjs";
import { CoreError, hash, insist } from "./contracts.mjs";
import { deliverOnce } from "./delivery-receipts.mjs";
import { assertType, safeName } from './material-io.mjs';
import { constants as fsConstants, closeSync, existsSync, fstatSync, lstatSync, realpathSync, statSync } from "node:fs";
import { assertPersistencePath, guardedWriteSync, registerPersistenceSecret, guardedOpenSync } from './persistence.mjs';
import { basename, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
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
import { anthropic, ANTHROPIC_SANITIZE_OUTPUT } from "./providers/anthropic.mjs";
import { stepCostUsd, worstCaseAnthropicCallUsd } from "./cost.mjs";

/* API call policy for a model-backed step. Every paid attempt is a
   decision of the workflow author, so the bounds are explicit and checked
   before anything is resolved or sent:
     retries         0..5, default 2 (at most retries + 1 billable attempts)
     timeoutSec      1..600, default 90 (per attempt)
     maxCallCostUsd  optional (0, 100]; worst case of all attempts must fit */
export const LLM_DEFAULT_RETRIES = 2;
export const LLM_DEFAULT_TIMEOUT_SEC = 90;
export function llmCallPolicy(config, label) {
  const raw = (key) => str(config, key);
  const policy = { retries: LLM_DEFAULT_RETRIES, timeoutMs: LLM_DEFAULT_TIMEOUT_SEC * 1000 };
  if (raw("retries") !== undefined) {
    const n = Number(raw("retries"));
    if (!/^\d+$/.test(raw("retries")) || n > 5)
      throw new CoreError("INVALID_REQUEST", `"${label}": retries must be an integer from 0 to 5 (at most retries + 1 billable attempts).`);
    policy.retries = n;
  }
  if (raw("timeoutSec") !== undefined) {
    const n = Number(raw("timeoutSec"));
    if (!/^\d+$/.test(raw("timeoutSec")) || n < 1 || n > 600)
      throw new CoreError("INVALID_REQUEST", `"${label}": timeoutSec must be an integer from 1 to 600.`);
    policy.timeoutMs = n * 1000;
  }
  if (raw("timeoutMs") !== undefined)
    throw new CoreError("INVALID_REQUEST", `"${label}": use timeoutSec (seconds, 1..600) for a model call, as for fetch and api-request.`);
  if (raw("maxCallCostUsd") !== undefined) {
    const n = Number(raw("maxCallCostUsd"));
    if (!/^\d+(\.\d+)?$/.test(raw("maxCallCostUsd")) || !(n > 0) || n > 100)
      throw new CoreError("INVALID_REQUEST", `"${label}": maxCallCostUsd must be a number greater than 0 and at most 100.`);
    policy.maxCallCostUsd = n;
  }
  return policy;
}

/* What a finished (or billed-then-failed) OpenRouter call cost: the provider's
   figure, else the table price of the model that answered, else null. */
function llmCost(usage, requestedModel, provider = "openrouter") {
  // An earlier attempt of this call may have been billed without an answer: the total is unknown.
  if (usage?.billingUnknown) return { costUsd: null, costSource: "unknown" };
  // Native Anthropic has its own first-party rates. An unpriced response must
  // never acquire an OpenRouter fallback price through a compatible model alias.
  if (provider === "anthropic") return Number.isFinite(usage?.costUsd) && usage.costUsd >= 0
    ? { costUsd: usage.costUsd, costSource: "provider" } : { costUsd: null, costSource: "unknown" };
  return stepCostUsd({ providerCostUsd: usage?.costUsd, model: usage?.model ?? requestedModel, tokensIn: usage?.tokensIn, tokensOut: usage?.tokensOut });
}

/* A billed call that failed afterwards keeps its spend on the thrown error. */
function withSpend(error, requestedModel, provider = "openrouter") {
  if (error && typeof error === "object" && error.usage) {
    const { costUsd, costSource } = llmCost({ ...error.usage, model: error.model ?? requestedModel }, requestedModel, provider);
    error.spend = { costUsd, costSource, tokensIn: error.usage.tokensIn ?? null, tokensOut: error.usage.tokensOut ?? null };
  }
  return error;
}

/** Human label of a step for messages: `config.name`, else the kind. */
export function stepLabel(step) {
  return str(step.config, "name") ?? step.kind;
}

/** The last successful output — what a gate shows and what api-request sends by default. */
function lastOutput(ctx) {
  // The runner passes the last output in execution order; a direct caller without it gets the last value.
  if (ctx.lastOutput !== undefined) return ctx.lastOutput;
  const vals = Object.values(ctx.priorOutputs);
  return vals.length ? vals[vals.length - 1] : null;
}

/** Template context, carrying the lane variables so every runner sees them alike. */
const tctx = (ctx) => ({
  priorOutputs: ctx.priorOutputs,
  inputs: ctx.inputs,
  priorStepNames: ctx.priorStepNames,
  ...(ctx.item !== undefined ? { item: ctx.item } : {}),
  ...(ctx.itemIndex != null ? { index: ctx.itemIndex } : {}),
  run: { id: ctx.runId, workflowId: ctx.templateId, costUsd: ctx.spentUsd === null ? null : ctx.spentUsd ?? 0 },
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
      // YouTube channel feeds keep the video text in <media:group><media:description>.
      summary: tag(b, "description") || tag(b, "summary") || tag(b, "content") || tag(b, "media:description"),
      published: tag(b, "pubDate") || tag(b, "published") || tag(b, "updated"),
    };
  });
}

/* A url field: data from steps and items is percent-encoded and cannot change the scheme or host. */
function urlOf(raw, t, label) {
  try {
    return resolveUrlTemplate(raw, t);
  } catch (e) {
    throw new Error(`"${label}": ${e instanceof Error ? e.message : String(e)}`);
  }
}

export async function runFetch(step, ctx) {
  const label = stepLabel(step);
  const rawUrl = requireStr(step.config, "url", label);
  let url;
  if (step.config.urlInput !== undefined) {
    // Explicit opt-in: only an exact entry of the operator's bound input array
    // may supply a whole URL. Model/step data retains the normal authority guard.
    const allowed = safeName(step.config.urlInput) && Object.hasOwn(ctx.inputs ?? {}, step.config.urlInput) ? ctx.inputs[step.config.urlInput] : undefined;
    insist(ctx.invocationId === 'root' && /^\{\{\s*item\s*\}\}$/.test(rawUrl) && Array.isArray(allowed)
      && Number.isInteger(ctx.itemIndex) && Object.hasOwn(allowed, ctx.itemIndex)
      && typeof ctx.item === 'string' && allowed[ctx.itemIndex] === ctx.item,
    'fetch urlInput requires {{item}} matching the indexed root operator input array');
    url = ctx.item;
    assertType(url, { type: 'string', format: 'http-url' }, 'fetch urlInput');
  } else url = urlOf(rawUrl, tctx(ctx), label);
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
export async function chatOnce({ apiKey, provider = "openrouter", providers, keyRef = provider === "anthropic" ? "ANTHROPIC_API_KEY" : "OPENROUTER_API_KEY", secretSource = "env", workspaceId, workspaceRef, model, system, user, maxTokens, temperature, timeoutMs, retries, delaysMs, signal, maxCallCostUsd, reasoning }) {
  insist(["openrouter", "anthropic"].includes(provider), "Unknown API provider; no fallback is allowed");
  // `apiKey` is the legacy/default alias supplied by the CLI. A step-level
  // alias must resolve its own environment entry; silently reusing the default
  // key would charge/send as the wrong credential. Keychain resolution ignores
  // this env value and remains explicitly selected by secretSource.
  const selectedKey = keyRef === "OPENROUTER_API_KEY" ? apiKey : process.env[keyRef];
  registerPersistenceSecret(selectedKey);
  const request = { model, messages: [{role:'system',content:system},{role:'user',content:user}], keyRef, secretSource, payerScope:'local-byok', maxTokens, temperature, timeoutMs, retries, delaysMs, signal, maxCallCostUsd, ...(reasoning === undefined ? {} : { reasoning }) };
  const result = provider === "anthropic"
    ? await (providers?.anthropic ?? anthropic)({ ...request, workspaceId, workspaceRef })
    : await openRouter(request, {env:{[keyRef]:selectedKey}});
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

/** Agent gates accept only a complete JSON verdict, optionally fenced. */
function parseAgentVerdict(content) {
  if (typeof content !== "string") return null;
  let json = content.trim();
  if (json.startsWith("```")) {
    const fence = /^```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n```$/i.exec(json);
    if (!fence) return null;
    json = fence[1];
  }
  try {
    const verdict = JSON.parse(json);
    if (!verdict || Array.isArray(verdict) || typeof verdict !== "object"
      || !Object.hasOwn(verdict, "pass") || typeof verdict.pass !== "boolean") return null;

    // JSON.parse validates the grammar but silently overwrites duplicate keys.
    // Scan complete string/structure tokens in the original JSON so escaped
    // spellings of the same key are also rejected, at every object depth.
    const tokens = json.match(/"(?:\\[\s\S]|[^"\\])*"|[{}[\]:,]/g) ?? [];
    const scopes = [];
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i];
      if (token === "{") scopes.push(new Set());
      else if (token === "[") scopes.push(null);
      else if (token === "}" || token === "]") scopes.pop();
      else if (token.startsWith('"') && tokens[i + 1] === ":") {
        const key = JSON.parse(token), keys = scopes.at(-1);
        if (keys.has(key)) return null;
        keys.add(key);
      }
    }
    return verdict;
  } catch {
    return null;
  }
}

const INVALID_AGENT_VERDICT = "Invalid agent verdict — expected one unambiguous JSON object with a boolean pass.";

export async function runLlmCall(step, ctx, model, maxTokens) {
  const label = stepLabel(step);
  const instructions = resolveTemplate(requireStr(step.config, "instructions", label), tctx(ctx));
  const role = str(step.config, "role");

  const policy = llmCallPolicy(step.config, label);
  const provider = str(step.config, "provider") ?? "openrouter";
  insist(["openrouter", "anthropic"].includes(provider), "Unknown API provider; no fallback is allowed");
  const keyRef = str(step.config, "keyRef") ?? (provider === "anthropic" ? "ANTHROPIC_API_KEY" : "OPENROUTER_API_KEY");
  const secretSource = str(step.config, "secretSource") ?? "env";
  const envSecret = keyRef === "OPENROUTER_API_KEY" ? ctx.apiKey : process.env[keyRef];
  if (provider === "openrouter" && secretSource === "env" && (typeof envSecret !== "string" || !envSecret.trim())) {
    /* NOT a mock. This output feeds the next step and possibly an outside API,
       where no "this was invented" label survives. So: failure. */
    throw new CoreError(
      "AUTH_REQUIRED",
      `"${label}": no OpenRouter key (set ${keyRef}). ` +
        `The engine will not substitute a mock inside a workflow: invented text would travel down the chain as real.`,
    );
  }

  if (!model) throw new Error(`${provider === "anthropic" ? "Anthropic" : "OpenRouter"} model is not configured; set ${provider === "anthropic" ? "ANTHROPIC_MODEL" : "OPENROUTER_MODEL"} or an explicit model override. This YAML route is not CLI caller inference.`);

  const system =
    (role ? `You are the ${role} agent in an autonomous factory. ` : "") +
    instructions +
    "\n\nAnswer with the result only — no preamble, no meta-commentary.";

  // input: one step-output reference bounds what the model sees (as for provider: cli); otherwise every prior output.
  let payload =
    ctx.item !== undefined ? { item: ctx.item, index: ctx.itemIndex, steps: ctx.priorOutputs } : ctx.priorOutputs;
  if (step.config.input != null) {
    payload = resolveTemplateValue(step.config.input, tctx(ctx));
    /* Only an unresolved REFERENCE is an error. The referenced value is data: an
       article or a model answer may legitimately contain `{{…}}`. */
    if (payload === undefined)
      throw new CoreError("INVALID_REQUEST", `"${label}": input must reference one prior step output, for example "{{steps.unique.output}}".`);
  }
  const user = JSON.stringify(payload, null, 2).slice(0, 60_000);

  if (provider === 'anthropic' && ctx.reserveAnthropicCost) {
    const messagesBytes = Buffer.byteLength(JSON.stringify([{ role: 'system', content: system }, { role: 'user', content: user }]));
    ctx.reserveAnthropicCost(worstCaseAnthropicCallUsd({ model, messagesBytes, maxTokens, attempts: policy.retries + 1 }));
  }

  let reply, cutOff = null;
  try {
    reply = await chatOnce({
      apiKey: ctx.apiKey,
      provider,
      providers: ctx.providers,
      workspaceId: str(step.config, "workspaceId"),
      workspaceRef: str(step.config, "workspaceRef"),
      keyRef,
      secretSource,
      model,
      system,
      user,
      maxTokens,
      temperature: num(step.config, "temperature") ?? 0.3,
      ...(step.config.reasoning == null ? {} : { reasoning: String(step.config.reasoning) }),
      signal: ctx.signal,
      retries: policy.retries,
      timeoutMs: policy.timeoutMs,
      maxCallCostUsd: policy.maxCallCostUsd,
    });
  } catch (error) {
    throw withSpend(error, model, provider);
  }
  const { content, usage } = reply;
  const { costUsd, costSource } = llmCost(usage, model, provider);

  const wantJson = (oneOf(step.config, "format", ["text", "json"]) ?? "text") === "json";
  const parsed = wantJson ? parseJsonObject(content) : null;
  if (wantJson && !parsed) {
    const error = new Error(`"${label}": format=json, but the model returned non-JSON. First 200: ${content.slice(0, 200)}`);
    error.spend = { costUsd, costSource, tokensIn: usage.tokensIn, tokensOut: usage.tokensOut };
    throw error;
  }
  // JSON.parse can turn Unicode escapes back into a credential, including in
  // object keys. Sanitize the decoded native output before it reaches state or
  // a later step; the provider keeps its normalized credential in the closure.
  const output = parsed ?? { text: content, model };
  return { output: provider === "anthropic" && reply[ANTHROPIC_SANITIZE_OUTPUT]
    ? reply[ANTHROPIC_SANITIZE_OUTPUT](output) : output,
    tokensIn: usage.tokensIn ?? 0, tokensOut: usage.tokensOut ?? 0, costUsd, costSource, ...(provider === "anthropic" ? { provider: reply.provider } : {}) };
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

  // The runner passes the subject it binds (for a human gate, the content past any earlier gate);
  // a direct caller without it gets the last output.
  const subject = ctx.gateSubject !== undefined ? ctx.gateSubject : lastOutput(ctx);
  const bound = () => ({ subject, ...(step.config.bind === 'sha256' ? { approvalHash: hash(subject) } : {}) });
  if (reviewer === "human") {
    return {
      output: {
        gate: { reviewer: "human", anchor, mode: str(step.config, "mode") ?? "approve" },
        ...bound(),
        ...(ctx.gateReviews?.length ? { reviews: ctx.gateReviews } : {}),
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
  const policy = llmCallPolicy(step.config, label);
  const provider = str(step.config, "provider") ?? "openrouter";
  insist(["openrouter", "anthropic"].includes(provider), "Unknown API provider; no fallback is allowed");
  const keyRef = str(step.config, "keyRef") ?? (provider === "anthropic" ? "ANTHROPIC_API_KEY" : "OPENROUTER_API_KEY");
  const secretSource = str(step.config, "secretSource") ?? "env";
  const envSecret = keyRef === "OPENROUTER_API_KEY" ? ctx.apiKey : process.env[keyRef];
  const missingAnthropicKey = () => ({
    output: {
      gate: { reviewer: "agent", anchor, rubric },
      verdict: null,
      escalated: true,
      reason: "No Anthropic key — the machine check did not run. The gate was handed to a human, not waved through.",
      ...bound(),
    },
    waitingHuman: true,
  });
  if (provider === "openrouter" && secretSource === "env" && (typeof envSecret !== "string" || !envSecret.trim())) {
    if (keyRef === "OPENROUTER_API_KEY") {
      return {
        output: {
          gate: { reviewer: "agent", anchor, rubric },
          verdict: null,
          escalated: true,
          reason: "No OpenRouter key — the machine check did not run. The gate was handed to a human, not waved through.",
          ...bound(),
        },
        waitingHuman: true,
      };
    }
    throw new CoreError(
      "AUTH_REQUIRED",
      `"${label}": no OpenRouter key (set ${keyRef}). The machine check did not run; the gate was not waved through.`,
    );
  }

  if (!model) throw new Error(`${provider === "anthropic" ? "Anthropic" : "OpenRouter"} model is not configured; set ${provider === "anthropic" ? "ANTHROPIC_MODEL" : "OPENROUTER_MODEL"} or an explicit model override.`);

  const system =
    "You are a strict validation gate in an autonomous factory. Judge the CANDIDATE against the RUBRIC. " +
    'Return ONLY one JSON object: {"pass": true|false, "reason": "one sentence"}. ' +
    "Default to pass=false when the rubric is not clearly satisfied.";
  const user = JSON.stringify({ rubric, candidate: subject }, null, 2).slice(0, 60_000);
  const gateMaxTokens = maxTokens;
  if (provider === "anthropic" && ctx.reserveAnthropicCost) {
    const messagesBytes = Buffer.byteLength(JSON.stringify([{ role: "system", content: system }, { role: "user", content: user }]));
    ctx.reserveAnthropicCost(worstCaseAnthropicCallUsd({ model, messagesBytes, maxTokens: gateMaxTokens, attempts: policy.retries + 1 }));
  }

  let reply, cutOff = null;
  try {
    reply = await chatOnce({
    apiKey: ctx.apiKey,
    provider,
    providers: ctx.providers,
    workspaceId: str(step.config, "workspaceId"),
    keyRef,
    secretSource,
    model,
    retries: policy.retries,
    timeoutMs: policy.timeoutMs,
    maxCallCostUsd: policy.maxCallCostUsd,
    system,
    user,
    maxTokens: gateMaxTokens,
    temperature: 0,
    ...(provider !== "anthropic" || step.config.reasoning == null ? {} : { reasoning: String(step.config.reasoning) }),
    signal: ctx.signal,
    });
  } catch (error) {
    // Only missing credentials before dispatch hand the gate to a human.
    // A rejected HTTP request (including 401/403) remains a provider failure.
    if (provider === "anthropic" && error?.status === undefined && !error?.usage
      && ["AUTH_REQUIRED", "SECRET_MISSING"].includes(error?.code)) return missingAnthropicKey();
    // An answer cut off at maxTokens is no verdict, the same as an unreadable one: it goes the way
    // of a failed check (to a person by default), with its billed usage kept. Other failures stay failures.
    // A cut-off answer is checked against the per-call cost cap first (the providers report the cut-off
    // before the cap): over it, or of unknown cost under a cap, it still fails.
    const cost = error?.usage?.costUsd;
    if (error?.code !== "OUTPUT_LIMIT" || !error.usage || (policy.maxCallCostUsd !== undefined
      && (!Number.isFinite(cost) || cost > policy.maxCallCostUsd))) throw withSpend(error, model, provider);
    cutOff = { content: null, usage: { ...error.usage, model: error.model ?? model } };
  }
  const { content, usage } = cutOff ?? reply;

  const verdict = cutOff ? null : parseAgentVerdict(content);
  const pass = verdict?.pass === true;
  const rawReason = cutOff ? `The agent's answer was cut off at maxTokens ${gateMaxTokens} — no verdict. Raise maxTokens on the gate if this repeats.`
    : !verdict ? INVALID_AGENT_VERDICT
    : typeof verdict.reason === "string" ? verdict.reason
    : provider === "anthropic" ? "No reason provided." : content.slice(0, 300);
  const reason = provider === "anthropic" && reply?.[ANTHROPIC_SANITIZE_OUTPUT]
    ? reply[ANTHROPIC_SANITIZE_OUTPUT](rawReason) : rawReason;
  const tokens = { tokensIn: usage.tokensIn ?? 0, tokensOut: usage.tokensOut ?? 0, ...llmCost(usage, model, provider),
    ...(provider === "anthropic" && !cutOff ? { provider: reply.provider } : {}) };

  if (pass) {
    return { output: { gate: { reviewer: "agent", anchor, rubric }, verdict: { pass: true, reason } }, ...tokens };
  }
  const escalate = (str(step.config, "escalateOn") ?? "objection") === "objection";
  if (escalate) {
    return {
      output: { gate: { reviewer: "agent", anchor, rubric }, verdict: { pass: false, reason }, escalated: true, ...bound() },
      waitingHuman: true,
      ...tokens,
    };
  }
  const refused = new Error(`"${label}": the Agent-Gate did not pass — ${reason}`);
  refused.spend = { costUsd: tokens.costUsd, costSource: tokens.costSource, tokensIn: usage.tokensIn, tokensOut: usage.tokensOut };
  throw refused;
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

/** Read-only preview using the same body builder as delivery. */
export function previewApiRequest(step, ctx) {
  const t = tctx(ctx), rawUrl = requireStr(step.config, 'url', stepLabel(step));
  const missing = missingEnvRefs(rawUrl);
  insist(!missing.length || !str(step.config, 'receiptKey'), 'Idempotent delivery requires an explicit destination; no file fallback');
  const url = missing.length ? rawUrl : urlOf(rawUrl, t, stepLabel(step));
  const payload = buildBody(step, ctx, t);
  const file = /^file:/i.test(url);
  const method = file ? 'APPEND' : (oneOf(step.config, 'method', ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']) ?? 'POST');
  return {
    destination: missing.length ? ctx.sinkFile : file ? pathToFileURL(checkFileDestination(url)).href : url,
    method: missing.length ? 'WRITE' : method,
    body: missing.length ? (typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2))
      : method === 'GET' ? null : file ? JSON.stringify(payload) + '\n'
        : typeof payload === 'string' ? payload : JSON.stringify(payload),
  };
}

/** A safe local delivery file: absolute file:/// URL, .jsonl name, an existing folder, and not an existing
 *  directory or symlink. Returns the canonical path (used for duplicate receipts). */
export function checkFileDestination(url) {
  if (!/^file:\/\/\//i.test(url)) throw new Error(`a file destination must be an absolute file:/// URL — got "${url}"`);
  let path;
  try { path = fileURLToPath(url.replace(/^file:/i, "file:")); } catch { throw new Error(`a file destination must be an absolute file:/// URL — got "${url}"`); }
  if (!path.endsWith(".jsonl")) throw new Error(`a file destination must end with .jsonl — got "${path}"`);
  const folder = dirname(path);
  if (!existsSync(folder) || !statSync(folder).isDirectory()) throw new Error(`the folder of the file destination does not exist: ${folder}`);
  // The canonical folder (symlinks resolved, e.g. /tmp -> /private/tmp) names the destination for receipts, so one
  // file has one duplicate key however its URL is spelled; the file itself is never followed if it is a symlink.
  const target = join(realpathSync(folder), basename(path));
  if (existsSync(target) || (() => { try { return lstatSync(target).isSymbolicLink(); } catch { return false; } })())
    if (!lstatSync(target).isFile() || lstatSync(target).isSymbolicLink()) throw new Error(`the file destination must be a regular file: ${target}`);
  return target;
}

export async function runApiRequest(step, ctx) {
  const label = stepLabel(step);
  const t = tctx(ctx);

  const rawUrl = requireStr(step.config, "url", label);

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
  /* Resolved only after the file-sink check: a URL with an unset env reference is never
     sent, whatever data it would also carry. */
  const url = urlOf(rawUrl, t, label);

  /* A local file destination: file:///absolute/path.jsonl appends one JSON value per line. Same receipt and
     duplicate rules as HTTP; the folder must exist and must not be reached through a symlink. */
  if (/^file:/i.test(url)) {
    const path = checkFileDestination(url);
    assertPersistencePath(path);
    const payload = buildBody(step, ctx, t);
    const line = JSON.stringify(payload);
    const sendFile = async () => {
      assertPersistencePath(path);
      const fd = guardedOpenSync(path, fsConstants.O_RDWR | fsConstants.O_APPEND | fsConstants.O_CREAT | fsConstants.O_NOFOLLOW, 0o600);
      try {
        insist(fstatSync(fd).isFile(), `"${label}": the file destination must be a regular file`);
        guardedWriteSync(fd, `${line}\n`);
      } finally { closeSync(fd); }
      return { output: { dispatched: true, sink: "file", url: pathToFileURL(path).href, file: path } };
    };
    if (!receiptKey) return sendFile();
    return deliverOnce({ store: ctx.runStore, destination: { url: pathToFileURL(path).href, method: "APPEND" }, key: resolveTemplate(receiptKey, t), payloadHash: hash(line) }, sendFile);
  }

  if (!/^https?:\/\//i.test(url)) {
    throw new Error(`"${label}": url must start with http(s):// or be a file:/// destination — template resolution produced "${url}".`);
  }
  const method = oneOf(step.config, "method", ["GET", "POST", "PUT", "PATCH", "DELETE"]) ?? "POST";

  const headers = { "Content-Type": "application/json" };
  const rawHeaders = str(step.config, "headers");
  if (rawHeaders) {
    /* Parsed BEFORE substitution: header names come from the manifest only, and a
       value from data stays inside its own header value. */
    let parsed;
    try {
      parsed = resolveJsonTemplate(rawHeaders, t);
    } catch {
      parsed = null;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
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
