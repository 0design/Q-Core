import { fetchWithRetry } from "../http.mjs";
import { CoreError, insist } from "../contracts.mjs";
import { resolveProviderSecret } from "../secrets.mjs";
import { worstCaseCallUsd } from "../cost.mjs";
const metric = (n) =>
  typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : null;
const MAX_KEY_REF_LENGTH = 128;
export async function openRouter(
  {
    messages,
    model,
    keyRef = "OPENROUTER_API_KEY",
    payerScope,
    maxTokens,
    temperature = 0.3,
    timeoutMs = 90000,
    retries = 2,
    delaysMs,
    signal,
    secretSource,
    maxCallCostUsd,
  },
  options = {},
) {
  const {
    env = process.env,
    fetcher = fetchWithRetry,
    secretResolver = resolveProviderSecret,
  } = options;
  insist(
    Number.isInteger(retries) && retries >= 0 && retries <= 10,
    "retries must be 0..10",
  );
  insist(
    Number.isInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 2147483647,
    "Invalid timeout",
  );
  if (delaysMs !== undefined)
    insist(
      Array.isArray(delaysMs) &&
        delaysMs.length > 0 &&
        delaysMs.every((x) => Number.isInteger(x) && x >= 0 && x <= 2147483647),
      "Invalid backoff delays",
    );
  insist(
    ["local-byok", "site-funded"].includes(payerScope),
    "Explicit payerScope required",
  );
  insist(typeof model === "string" && model.trim(), "model required");
  insist(model.length < 200, "model must be shorter than 200 characters");
  insist(
    Array.isArray(messages) &&
      messages.length > 0 &&
      messages.every(
        (m) =>
          ["system", "user", "assistant"].includes(m.role) &&
          typeof m.content === "string",
      ),
    "Invalid messages",
  );
  insist(Buffer.byteLength(JSON.stringify(messages)) <= 128000, "Messages too large");
  insist(
    Number.isInteger(maxTokens) && maxTokens > 0 && maxTokens <= 32000,
    "maxTokens must be 1..32000",
  );
  insist(
    Number.isFinite(temperature) && temperature >= 0 && temperature <= 2,
    "Invalid temperature",
  );
  insist(
    typeof keyRef === "string" &&
      Buffer.byteLength(keyRef) <= MAX_KEY_REF_LENGTH &&
      /^[A-Z_][A-Z0-9_]*$/.test(keyRef),
    "Invalid keyRef",
  );
  insist(typeof secretResolver === "function", "Invalid secret resolver");
  /* Per-call money cap. Checked BEFORE the secret is read or anything is sent:
     the worst case of every billable attempt (retries included) must fit under
     the cap, and a model this Core cannot price is refused rather than guessed. */
  if (maxCallCostUsd !== undefined) {
    insist(
      typeof maxCallCostUsd === "number" && Number.isFinite(maxCallCostUsd) && maxCallCostUsd > 0 && maxCallCostUsd <= 100,
      "maxCallCostUsd must be a number in (0, 100]",
    );
    const worst = worstCaseCallUsd({
      model,
      messagesBytes: Buffer.byteLength(JSON.stringify(messages)),
      maxTokens,
      attempts: retries + 1,
    });
    if (worst === null)
      throw new CoreError(
        "COST_UNKNOWN",
        `OpenRouter model ${model} has no known price, so maxCallCostUsd cannot be enforced; the call was not made`,
      );
    if (worst > maxCallCostUsd)
      throw new CoreError(
        "COST_LIMIT",
        `OpenRouter worst-case cost $${worst.toFixed(6)} (${retries + 1} attempt(s), maxTokens ${maxTokens}) exceeds maxCallCostUsd $${maxCallCostUsd}; the call was not made`,
      );
  }
  // Omitted source remains environment-backed for all existing callers.
  // Keychain access is opt-in through an explicit provider field.
  const source = secretSource ?? "env";
  const key = await secretResolver(
    { provider: "openrouter", keyRef, secretSource: source, env, signal },
    { signal, timeoutMs },
  );
  if (typeof key !== "string" || !key.trim())
    throw new CoreError("AUTH_REQUIRED", `Missing secret reference ${keyRef}`);
  let res;
  try {
    res = await fetcher(
      "https://openrouter.ai/api/v1/chat/completions",
      {
        method: "POST",
        signal,
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          messages,
          temperature,
          max_tokens: maxTokens,
        }),
      },
      { timeoutMs, retries, delaysMs },
    );
  } catch (e) {
    if (signal?.aborted)
      throw new CoreError("CANCELLED", "OpenRouter cancelled");
    throw new CoreError(
      e.name === "TimeoutError" ? "TIMEOUT" : "NETWORK",
      "OpenRouter unreachable",
    );
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    const code = [401, 403].includes(res.status)
      ? "AUTH_REQUIRED"
      : res.status === 429
        ? "RATE_LIMITED"
        : "PROVIDER_ERROR";
    throw new CoreError(
      code,
      `OpenRouter ${res.status} — ${code === "AUTH_REQUIRED" ? "invalid or revoked key" : "request failed"}`,
    );
  }
  let json;
  try {
    if (res.body?.getReader) {
      const reader = res.body.getReader();
      let size = 0;
      const parts = [];
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 512000) {
          await reader.cancel();
          throw new Error("limit");
        }
        parts.push(Buffer.from(value));
      }
      json = JSON.parse(Buffer.concat(parts).toString("utf8"));
    } else json = await res.json();
  } catch {
    throw new CoreError(
      signal?.aborted ? "CANCELLED" : "INVALID_RESPONSE",
      "OpenRouter response body invalid, timed out or too large",
    );
  }
  /* Usage is read before the completion is judged: a billed call that then
     fails (empty, truncated, over the cap) still reports what it cost, on the
     error, so the run can record the spend instead of losing it. */
  const usage = {
    tokensIn: metric(json?.usage?.prompt_tokens),
    tokensOut: metric(json?.usage?.completion_tokens),
    costUsd: metric(json?.usage?.cost),
  };
  const billed = (code, message) => {
    const error = new CoreError(code, message);
    error.usage = usage;
    error.model = typeof json?.model === "string" ? json.model : null;
    return error;
  };
  const content = json?.choices?.[0]?.message?.content;
  if (json?.error || typeof content !== "string" || !content.trim())
    throw billed(
      "INVALID_RESPONSE",
      "OpenRouter returned an empty completion or invalid response",
    );
  if (json.choices[0].finish_reason === "length")
    throw billed("OUTPUT_LIMIT", "OpenRouter completion truncated");
  if (maxCallCostUsd !== undefined && usage.costUsd !== null && usage.costUsd > maxCallCostUsd) {
    /* The provider billed more than the pre-call bound allowed (a stale price).
       The money is spent: the error carries the reported cost so the run
       records it instead of losing it. */
    throw billed(
      "COST_LIMIT",
      `OpenRouter reported cost $${usage.costUsd} above maxCallCostUsd $${maxCallCostUsd}`,
    );
  }
  return {
    content: content.trim(),
    requestId: typeof json.id === "string" ? json.id : null,
    provider: {
      kind: "openrouter",
      version: "1",
      requestedModel: model,
      model: json.model ?? null,
      payerScope,
    },
    usage,
  };
}
