import { fetchWithRetry } from "../http.mjs";
import { setTimeout as delay } from "node:timers/promises";
import { CoreError, insist } from "../contracts.mjs";
import { resolveProviderSecret } from "../secrets.mjs";
import { registerPersistenceSecret } from '../persistence.mjs';
import { anthropicModel, anthropicUsageCost, worstCaseAnthropicCallUsd } from "../cost.mjs";

const API = "https://api.anthropic.com/v1/messages";
const VERSION = "2023-06-01";
// Streaming envelopes can be much larger than their text. Bound both without
// rejecting an otherwise valid, token-by-token 32k-token response.
const MAX_RESPONSE_BYTES = 8_192_000;
const MAX_TEXT_BYTES = 512_000;
const MAX_ERROR_BYTES = 16_384;
const RETRY_DELAYS_MS = [1_500, 4_000];
const unknownUsage = () => ({ tokensIn: null, tokensOut: null, costUsd: null, billingUnknown: true });

// Carry the call's redactor through in-memory reply spreads without exposing
// the credential (or a serializable redaction field) in persisted replies.
export const ANTHROPIC_SANITIZE_OUTPUT = Symbol("anthropic.sanitizeOutput");

function safeError(code, message) { return new CoreError(code, message); }
const httpStatus = response => Number.isInteger(response?.status) && response.status >= 100 && response.status <= 599
  ? response.status : null;

/** A custom Response/reader must obey the same timeout as a native fetch body. */
async function abortable(promise, signal) {
  signal?.throwIfAborted();
  if (!signal) return promise;
  let listener;
  const aborted = new Promise((_, reject) => {
    listener = () => reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    signal.addEventListener("abort", listener, { once: true });
    if (signal.aborted) listener();
  });
  try { return await Promise.race([promise, aborted]); }
  finally { signal.removeEventListener("abort", listener); }
}

function streamFailure() {
  // A successful response can already be billed even if its stream is lost.
  // Keep the public error sanitized; the provider never replays this attempt.
  return new TypeError("fetch failed: Anthropic stream ended before message_stop");
}

function definitelyUnbilledConnectionFailure(error) {
  // A generic fetch failure, reset, socket close or timeout may occur after a
  // POST was accepted. Only connection establishment/DNS errors prove that no
  // Messages request could have reached the provider.
  const codes = new Set(["ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "ENETUNREACH", "EHOSTUNREACH", "UND_ERR_CONNECT_TIMEOUT"]);
  let cause = error;
  for (let depth = 0; cause && depth < 5; depth++, cause = cause.cause) {
    if (codes.has(cause.code)) return true;
  }
  return false;
}

function streamError(type) {
  const code = ["authentication_error", "permission_error"].includes(type) ? "AUTH_REQUIRED"
    : type === "rate_limit_error" ? "RATE_LIMITED" : "PROVIDER_ERROR";
  const error = safeError(code, `Anthropic ${code === "AUTH_REQUIRED" ? "invalid or revoked key" : "stream request failed"}`);
  if (["overloaded_error", "api_error", "rate_limit_error", "timeout_error"].includes(type)) {
    error.name = "TypeError";
    error.message = "fetch failed: Anthropic stream request failed";
  }
  return error;
}

async function readJson(res, signal) {
  let json;
  if (res.body?.getReader) {
    const reader = res.body.getReader();
    const parts = [];
    let bytes = 0;
    try {
      for (;;) {
        const { done, value } = await abortable(reader.read(), signal);
        if (done) break;
        bytes += value.byteLength;
        if (bytes > MAX_RESPONSE_BYTES) throw safeError("INVALID_RESPONSE", "Anthropic response is too large");
        parts.push(Buffer.from(value));
      }
      json = JSON.parse(Buffer.concat(parts).toString("utf8"));
    } catch (error) {
      reader.cancel().catch(() => {});
      throw error;
    } finally { try { reader.releaseLock(); } catch {} }
  } else {
    json = await abortable(res.json(), signal);
    if (Buffer.byteLength(JSON.stringify(json)) > MAX_RESPONSE_BYTES)
      throw safeError("INVALID_RESPONSE", "Anthropic response is too large");
  }
  const textBlocks = Array.isArray(json?.content) ? json.content.filter(block => block?.type === "text") : null;
  const text = textBlocks?.every(block => typeof block.text === "string")
    ? textBlocks.map(block => block.text).join("") : null;
  // The error envelope is untrusted free text. Retain only its presence; a
  // provider can echo credentials in any spelling inside its fields.
  return { id: json?.id, model: json?.model, stop: json?.stop_reason, text, usage: json?.usage, error: Boolean(json?.error) };
}

async function readStream(res, signal) {
  if (!res.body?.getReader) throw safeError("INVALID_RESPONSE", "Anthropic stream is unreadable");
  const reader = res.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let buffer = "", bytes = 0, textBytes = 0, text = "", id, model, stop, complete = false;
  const usage = {};
  let errorType;
  const appendText = (value) => {
    if (typeof value !== "string") throw safeError("INVALID_RESPONSE", "Anthropic stream contains invalid text");
    textBytes += Buffer.byteLength(value);
    if (textBytes > MAX_TEXT_BYTES) throw safeError("INVALID_RESPONSE", "Anthropic completion is too large");
    text += value;
  };
  const event = (chunk) => {
    const data = chunk.split(/\r?\n/).filter(line => line.startsWith("data:"))
      .map(line => line.slice(5).replace(/^ /, "")).join("\n");
    if (!data) return;
    let value;
    try { value = JSON.parse(data); }
    catch { throw safeError("INVALID_RESPONSE", "Anthropic stream contains invalid data"); }
    if (value?.type === "message_start") {
      id = value.message?.id;
      model = value.message?.model;
      Object.assign(usage, value.message?.usage ?? {});
    } else if (value?.type === "content_block_start" && value.content_block?.type === "text") {
      appendText(value.content_block.text ?? "");
    } else if (value?.type === "content_block_delta" && value.delta?.type === "text_delta") {
      appendText(value.delta.text);
    } else if (value?.type === "message_delta") {
      stop = value.delta?.stop_reason ?? stop;
      Object.assign(usage, value.usage ?? {});
    } else if (value?.type === "message_stop") complete = true;
    else if (value?.type === "error") {
      const type = value.error?.type;
      errorType = ["authentication_error", "permission_error", "rate_limit_error", "overloaded_error", "api_error", "timeout_error"].includes(type)
        ? type : "api_error";
    }
  };
  const drain = () => {
    let boundary;
    while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
      event(buffer.slice(0, boundary.index));
      buffer = buffer.slice(boundary.index + boundary[0].length);
    }
  };
  try {
    for (;;) {
      const { done, value } = await abortable(reader.read(), signal);
      if (value) {
        bytes += value.byteLength;
        if (bytes > MAX_RESPONSE_BYTES) throw safeError("INVALID_RESPONSE", "Anthropic response is too large");
        buffer += decoder.decode(value, { stream: true });
        drain();
      }
      if (done) break;
    }
    buffer += decoder.decode();
    drain();
    if (buffer.trim()) event(buffer);
    if (errorType) throw streamError(errorType);
    if (!complete) throw streamFailure();
    return { id, model, stop, text, usage };
  } catch (failure) {
    reader.cancel().catch(() => {});
    if (failure instanceof CoreError || failure?.name === "TimeoutError" || failure?.name === "AbortError"
      || signal?.aborted || /fetch failed/.test(failure?.message ?? "")) throw failure;
    // A connection that closes during a successful HTTP response may already
    // have been billed; its sanitized failure must terminate the call.
    throw streamFailure();
  } finally { try { reader.releaseLock(); } catch {} }
}

async function readResponse(res, { signal } = {}) {
  try {
    return (res.headers?.get("content-type") ?? "").includes("text/event-stream")
      ? await readStream(res, signal) : await readJson(res, signal);
  } catch (error) {
    if (error instanceof CoreError || error?.name === "TimeoutError" || error?.name === "AbortError"
      || signal?.aborted || /fetch failed/.test(error?.message ?? "")) throw error;
    if (error instanceof SyntaxError)
      throw safeError("INVALID_RESPONSE", "Anthropic response body invalid");
    throw new TypeError("fetch failed: Anthropic response body unreadable");
  }
}

// Inspect only a bounded 400 envelope and retain a boolean. No upstream text or
// metadata crosses this classification boundary, even for malformed bodies.
async function requiresWorkspace(res, signal) {
  let reader;
  try {
    let json;
    if (res.body?.getReader) {
      reader = res.body.getReader();
      const parts = [];
      let bytes = 0;
      for (;;) {
        const { done, value } = await abortable(reader.read(), signal);
        if (done) break;
        bytes += value.byteLength;
        if (bytes > MAX_ERROR_BYTES) return false;
        parts.push(Buffer.from(value));
      }
      json = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(parts)));
    } else {
      json = await abortable(res.json(), signal);
      if (Buffer.byteLength(JSON.stringify(json)) > MAX_ERROR_BYTES) return false;
    }
    return json?.error?.type === "invalid_request_error"
      && typeof json.error.message === "string" && /\bworkspace\b/i.test(json.error.message);
  } catch (error) {
    if (signal?.aborted) throw error;
    return false;
  } finally {
    // Cancel without awaiting an untrusted cancellation promise. The read is
    // already bounded by the attempt deadline, including on abort/oversize.
    try { Promise.resolve(reader?.cancel()).catch(() => {}); } catch {}
    try { reader?.releaseLock(); } catch {}
  }
}

export async function anthropic({
  messages, model, keyRef = "ANTHROPIC_API_KEY", payerScope, maxTokens, temperature = 0.3,
  timeoutMs = 90_000, retries = 2, delaysMs, signal, secretSource, maxCallCostUsd,
  reasoning, workspaceId, workspaceRef = "ANTHROPIC_WORKSPACE_ID",
}, options = {}) {
  const { env = process.env, fetcher = fetchWithRetry, secretResolver = resolveProviderSecret, endpoint = API } = options;
  insist(Number.isInteger(retries) && retries >= 0 && retries <= 10, "retries must be 0..10");
  insist(Number.isInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 2147483647, "Invalid timeout");
  if (delaysMs !== undefined) insist(Array.isArray(delaysMs) && delaysMs.length > 0
    && delaysMs.every(value => Number.isInteger(value) && value >= 0 && value <= 2147483647), "Invalid backoff delays");
  insist(["local-byok", "site-funded"].includes(payerScope), "Explicit payerScope required");
  insist(typeof model === "string" && model.trim() && model.length < 200, "model required, shorter than 200 characters");
  insist(Array.isArray(messages) && messages.length > 0 && messages.every(message => message
    && ["system", "user", "assistant"].includes(message.role) && typeof message.content === "string"), "Invalid messages");
  const messagesBytes = Buffer.byteLength(JSON.stringify(messages));
  insist(messagesBytes <= 128000, "Messages too large");
  insist(messages.some(message => message.role !== "system"), "Anthropic requires a user or assistant message");
  insist(reasoning === undefined || ["off", "low", "medium", "high"].includes(reasoning), 'reasoning must be "off", "low", "medium" or "high"');
  insist(Number.isInteger(maxTokens) && maxTokens > 0 && maxTokens <= 32000, "maxTokens must be 1..32000");
  insist(Number.isFinite(temperature) && temperature >= 0 && temperature <= 2, "Invalid temperature");
  insist(typeof keyRef === "string" && Buffer.byteLength(keyRef) <= 128 && /^[A-Z_][A-Z0-9_]*$/.test(keyRef), "Invalid keyRef");
  insist(typeof workspaceRef === "string" && Buffer.byteLength(workspaceRef) <= 128 && /^[A-Z_][A-Z0-9_]*$/.test(workspaceRef), "Invalid workspaceRef");
  insist(typeof secretResolver === "function", "Invalid secret resolver");
  const entry = anthropicModel(model);
  if (maxCallCostUsd !== undefined) {
    insist(typeof maxCallCostUsd === "number" && Number.isFinite(maxCallCostUsd) && maxCallCostUsd > 0 && maxCallCostUsd <= 100,
      "maxCallCostUsd must be a number in (0, 100]");
    const worst = worstCaseAnthropicCallUsd({ model, messagesBytes, maxTokens, attempts: retries + 1 });
    if (worst === null) throw safeError("COST_UNKNOWN", "Anthropic model has no known price, so maxCallCostUsd cannot be enforced; the call was not made");
    if (worst > maxCallCostUsd) throw safeError("COST_LIMIT",
      `Anthropic worst-case cost $${worst.toFixed(6)} (${retries + 1} attempt(s), maxTokens ${maxTokens}) exceeds maxCallCostUsd $${maxCallCostUsd}; the call was not made`);
  }
  insist(entry, "Unsupported Anthropic model");
  let key;
  try {
    key = await secretResolver({ provider: "anthropic", keyRef, secretSource: secretSource ?? "env", env, signal }, { signal, timeoutMs });
  } catch (error) {
    if (signal?.aborted) throw safeError("CANCELLED", "Anthropic cancelled");
    const code = ["AUTH_REQUIRED", "SECRET_MISSING", "SECRET_STORE_UNSUPPORTED", "SECRET_STORE_DENIED", "INVALID_REQUEST", "TIMEOUT", "CANCELLED"].includes(error?.code)
      ? error.code : "AUTH_REQUIRED";
    throw safeError(code, code === "AUTH_REQUIRED" ? `Missing or unavailable secret reference ${keyRef}` : "Anthropic secret retrieval failed");
  }
  if (typeof key !== "string" || !key.trim()) throw safeError("AUTH_REQUIRED", `Missing secret reference ${keyRef}`);
  registerPersistenceSecret(key);
  key = key.trim();
  let workspace = workspaceId;
  if (workspace === undefined || workspace === null) {
    try {
      workspace = await secretResolver({ provider: "anthropic", keyRef: workspaceRef,
        secretSource: secretSource ?? "env", env, signal, optional: true }, { signal, timeoutMs });
    } catch (error) {
      if (signal?.aborted) throw safeError("CANCELLED", "Anthropic cancelled");
      const code = ["AUTH_REQUIRED", "SECRET_MISSING", "SECRET_STORE_UNSUPPORTED", "SECRET_STORE_DENIED", "INVALID_REQUEST", "TIMEOUT", "CANCELLED"].includes(error?.code)
        ? error.code : "AUTH_REQUIRED";
      throw safeError(code, "Anthropic workspace reference retrieval failed");
    }
  }
  registerPersistenceSecret(workspace);
  if (typeof workspace === "string") workspace = workspace.trim() || undefined;
  insist(workspace === undefined || (typeof workspace === "string"
    && workspace.length <= 200 && !/[\u0000-\u001f\u007f]/.test(workspace)), "Invalid Anthropic workspace reference value");
  const protectedValues = [...new Set([key, workspace].filter(Boolean))].sort((a, b) => b.length - a.length);
  const redact = value => {
    if (typeof value === "string") return protectedValues.reduce((text, secret) => text.split(secret).join("[REDACTED]"), value);
    if (Array.isArray(value)) return value.map(redact);
    if (value && typeof value === "object")
      return Object.fromEntries(Object.entries(value).map(([name, child]) => [redact(name), redact(child)]));
    return value;
  };
  const system = messages.filter(message => message.role === "system").map(message => message.content).join("\n\n");
  const body = {
    model: entry.id, max_tokens: maxTokens,
    messages: messages.filter(message => message.role !== "system").map(({ role, content }) => ({ role, content })),
    stream: true, ...(system ? { system } : {}),
  };
  if (!entry.legacy) {
    if (reasoning && reasoning !== "off") body.output_config = { effort: reasoning };
    else if (entry.canDisable) body.thinking = { type: "disabled" };
    else body.output_config = { effort: "low" };
  }
  if (entry.sampling) body.temperature = temperature;
  let unknownBilling = false, parsed, workspaceRequired = false;
  const failed = (code, message, response) => {
    const error = safeError(code, message);
    if (httpStatus(response) !== null) error.status = httpStatus(response);
    if (unknownBilling) error.usage = unknownUsage();
    return error;
  };
  let response;
  try {
    for (let attempt = 0; attempt <= retries; attempt++) {
      signal?.throwIfAborted();
      const timeout = AbortSignal.timeout(timeoutMs);
      const attemptSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
      let accepted = false;
      parsed = undefined;
      try {
        response = await abortable(fetcher(endpoint, {
          method: "POST", signal: attemptSignal,
          headers: { "x-api-key": key, "anthropic-version": VERSION, "Content-Type": "application/json",
            ...(workspace ? { "anthropic-workspace-id": workspace.trim() } : {}) },
          body: JSON.stringify(body),
        }, {
          // Shared HTTP retries can replay a billed POST. Keep each invocation
          // to one attempt and enforce the native provider's narrower policy.
          timeoutMs, retries: 0, delaysMs,
          readResponse: async res => {
            if (!res.ok) return;
            accepted = true;
            parsed = await readResponse(res, { signal: attemptSignal });
          },
        }), attemptSignal);
        // Small injected fetchers may return a Response directly; the same
        // acceptance boundary and entire-attempt deadline still apply.
        if (response.ok && parsed === undefined) {
          accepted = true;
          parsed = await readResponse(response, { signal: attemptSignal });
        }
      } catch (error) {
        const unbilled = !accepted && definitelyUnbilledConnectionFailure(error);
        if (!unbilled) unknownBilling = true;
        if (signal?.aborted || !unbilled || attempt === retries) throw error;
        response = undefined;
      }
      if (response) {
        const rejected = response.status === 429 || (response.status >= 500 && response.status <= 599);
        if (!response.ok) {
          if (response.status === 400) workspaceRequired = await requiresWorkspace(response, attemptSignal);
          // Cancellation is transport work too: injected bodies may hang,
          // reject, throw synchronously, or return no promise. Keep disposal
          // inside this attempt's deadline and the caller's abort signal.
          await abortable(Promise.resolve().then(() => response.body?.cancel()).catch(() => {}), attemptSignal);
        }
        if (!rejected || attempt === retries) break;
        // Rejection headers are unbilled. Do not consume an error body before
        // discarding it and retrying the Messages request.
        response = undefined;
      }
      const delays = delaysMs ?? RETRY_DELAYS_MS;
      await delay(delays[Math.min(attempt, delays.length - 1)], undefined, { signal });
    }
  } catch (error) {
    if (signal?.aborted) throw failed("CANCELLED", "Anthropic cancelled");
    if (["INVALID_RESPONSE", "AUTH_REQUIRED", "RATE_LIMITED", "PROVIDER_ERROR"].includes(error?.code))
      throw failed(error.code, `Anthropic ${error.code === "INVALID_RESPONSE" ? "response body invalid or too large" : "request failed"}`);
    throw failed(error?.name === "TimeoutError" ? "TIMEOUT" : "NETWORK", "Anthropic unreachable");
  }
  if (!response.ok) {
    const status = httpStatus(response);
    if (workspaceRequired) throw failed("ANTHROPIC_WORKSPACE_REQUIRED", "Anthropic: вкажіть workspaceRef", response);
    const code = [401, 403].includes(status) ? "AUTH_REQUIRED"
      : status === 429 ? "RATE_LIMITED" : "PROVIDER_ERROR";
    // Do not copy statusText, headers, request IDs or any error-body field.
    // Unknown response metadata is discarded, rather than spelling-filtered.
    throw failed(code, `Anthropic${status === null ? "" : ` ${status}`} — ${code === "AUTH_REQUIRED" ? "invalid or revoked key" : "request failed"}`, response);
  }
  // Price only the model that actually answered, never silently substitute the
  // requested model if an upstream response names a different/unknown model.
  const answeredModel = typeof parsed?.model === "string" ? redact(parsed.model) : null;
  const pricedUsage = anthropicUsageCost(answeredModel, parsed?.usage);
  const usage = { ...pricedUsage, ...(unknownBilling ? { costUsd: null } : {}),
    ...(unknownBilling ? { billingUnknown: true } : {}) };
  const billed = (code, message) => {
    const error = safeError(code, message);
    error.usage = usage;
    // Native usage is already priced. An arbitrary response model must never
    // hitch a ride on a failure that callers may serialize or log.
    error.status = httpStatus(response);
    return error;
  };
  if (parsed?.stop === "max_tokens") throw billed("OUTPUT_LIMIT", "Anthropic completion truncated");
  if (parsed?.error || parsed?.stop === "refusal" || typeof parsed?.text !== "string" || !parsed.text.trim()
    || Buffer.byteLength(parsed.text) > MAX_TEXT_BYTES)
    throw billed("INVALID_RESPONSE", "Anthropic returned an empty completion or invalid response");
  if (maxCallCostUsd !== undefined && usage.costUsd !== null && usage.costUsd > maxCallCostUsd)
    throw billed("COST_LIMIT", `Anthropic usage cost $${usage.costUsd} above maxCallCostUsd $${maxCallCostUsd}`);
  return {
    content: redact(parsed.text.trim()), requestId: typeof parsed.id === "string" ? redact(parsed.id) : null,
    provider: { kind: "anthropic", version: "1", requestedModel: redact(model), model: answeredModel, payerScope }, usage,
    [ANTHROPIC_SANITIZE_OUTPUT]: redact,
  };
}
