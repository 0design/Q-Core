import { fetchWithRetry } from "../http.mjs";
import { CoreError, insist } from "../contracts.mjs";
import { resolveProviderSecret } from "../secrets.mjs";
import { anthropicModel, anthropicUsdForModelTokens, worstCaseAnthropicCallUsd } from "../cost.mjs";

const API = "https://api.anthropic.com/v1/messages";
const VERSION = "2023-06-01";
// Streaming envelopes can be much larger than their text. Bound both without
// rejecting an otherwise valid, token-by-token 32k-token response.
const MAX_RESPONSE_BYTES = 8_192_000;
const MAX_TEXT_BYTES = 512_000;
const metric = (n) => typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : null;
const unknownUsage = () => ({ tokensIn: null, tokensOut: null, costUsd: null, billingUnknown: true });

function safeError(code, message) { return new CoreError(code, message); }

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
  // This deliberately matches the shared HTTP retry policy. Neither an
  // upstream error message nor a fetch error (which can contain headers) leaks.
  return new TypeError("fetch failed: Anthropic stream ended before message_stop");
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
  return { id: json?.id, model: json?.model, stop: json?.stop_reason, text, usage: json?.usage, error: json?.error };
}

async function readStream(res, signal) {
  if (!res.body?.getReader) throw safeError("INVALID_RESPONSE", "Anthropic stream is unreadable");
  const reader = res.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let buffer = "", bytes = 0, textBytes = 0, text = "", id, model, stop, complete = false;
  const usage = {};
  let error;
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
    else if (value?.type === "error") error = value.error ?? { type: "api_error" };
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
    if (error) throw streamError(error.type);
    if (!complete) throw streamFailure();
    return { id, model, stop, text, usage };
  } catch (failure) {
    reader.cancel().catch(() => {});
    if (failure instanceof CoreError || failure?.name === "TimeoutError" || failure?.name === "AbortError"
      || signal?.aborted || /fetch failed/.test(failure?.message ?? "")) throw failure;
    // A connection that closes during a successful HTTP response may already
    // have been billed, and must be retried inside the attempt timeout.
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

export async function anthropic({
  messages, model, keyRef = "ANTHROPIC_API_KEY", payerScope, maxTokens, temperature = 0.3,
  timeoutMs = 90_000, retries = 2, delaysMs, signal, secretSource, maxCallCostUsd,
  reasoning, workspaceId,
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
  insist(typeof secretResolver === "function", "Invalid secret resolver");
  const envWorkspace = typeof env?.ANTHROPIC_WORKSPACE_ID === "string"
    ? env.ANTHROPIC_WORKSPACE_ID.trim() || undefined : env?.ANTHROPIC_WORKSPACE_ID;
  const workspace = workspaceId ?? envWorkspace;
  insist(workspace === undefined || (typeof workspace === "string" && workspace.trim()
    && workspace.length <= 200 && !/[\u0000-\u001f\u007f]/.test(workspace)), "Invalid Anthropic workspaceId");
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
  const redact = value => typeof value === "string" ? value.split(key).join("[REDACTED]") : value;
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
  let unknownBilling = false, parsed;
  const failed = (code, message) => {
    const error = safeError(code, message);
    if (unknownBilling) error.usage = unknownUsage();
    return error;
  };
  let response;
  try {
    response = await fetcher(endpoint, {
      method: "POST", signal,
      headers: { "x-api-key": key, "anthropic-version": VERSION, "Content-Type": "application/json",
        ...(workspace ? { "anthropic-workspace-id": workspace.trim() } : {}) },
      body: JSON.stringify(body),
    }, {
      timeoutMs, retries, delaysMs,
      onAttemptError: () => { unknownBilling = true; },
      readResponse: async (res, context) => { parsed = await readResponse(res, context); },
    });
    // A small injected fetcher may return a Response directly. Its body still
    // gets a bounded read; production fetchWithRetry consumes it per attempt.
    if (response.ok && parsed === undefined) {
      const timeout = AbortSignal.timeout(timeoutMs);
      parsed = await readResponse(response, { signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
    }
  } catch (error) {
    unknownBilling = true;
    if (signal?.aborted) throw failed("CANCELLED", "Anthropic cancelled");
    if (["INVALID_RESPONSE", "AUTH_REQUIRED", "RATE_LIMITED", "PROVIDER_ERROR"].includes(error?.code))
      throw failed(error.code, `Anthropic ${error.code === "INVALID_RESPONSE" ? "response body invalid or too large" : "request failed"}`);
    throw failed(error?.name === "TimeoutError" ? "TIMEOUT" : "NETWORK", "Anthropic unreachable");
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    const code = [401, 403].includes(response.status) ? "AUTH_REQUIRED"
      : response.status === 429 ? "RATE_LIMITED" : "PROVIDER_ERROR";
    throw failed(code, `Anthropic ${response.status} — ${code === "AUTH_REQUIRED" ? "invalid or revoked key" : "request failed"}`);
  }
  const counts = parsed?.usage;
  const regular = metric(counts?.input_tokens);
  const cacheRead = counts?.cache_read_input_tokens === undefined ? 0 : metric(counts.cache_read_input_tokens);
  const cacheWrite = counts?.cache_creation_input_tokens === undefined ? 0 : metric(counts.cache_creation_input_tokens);
  const tokensIn = regular === null || cacheRead === null || cacheWrite === null ? null : regular + cacheRead + cacheWrite;
  const tokensOut = metric(counts?.output_tokens);
  // Price only the model that actually answered, never silently substitute the
  // requested model if an upstream response names a different/unknown model.
  const answeredModel = typeof parsed?.model === "string" ? redact(parsed.model) : null;
  const usage = { tokensIn, tokensOut, costUsd: unknownBilling ? null : anthropicUsdForModelTokens(answeredModel, tokensIn, tokensOut),
    ...(unknownBilling ? { billingUnknown: true } : {}) };
  const billed = (code, message) => {
    const error = safeError(code, message);
    error.usage = usage;
    error.model = answeredModel;
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
    provider: { kind: "anthropic", version: "1", requestedModel: model, model: answeredModel, payerScope }, usage,
  };
}
