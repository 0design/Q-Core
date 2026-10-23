import { test } from "node:test";
import assert from "node:assert/strict";
import { anthropic } from "../src/providers/anthropic.mjs";

const KEY = "sk-ant-retry-fixture";
const request = overrides => ({
  model: "claude-haiku-4-5", payerScope: "local-byok",
  messages: [{ role: "user", content: "Hello" }],
  maxTokens: 100, timeoutMs: 1000, retries: 2, delaysMs: [0], ...overrides,
});
const options = { env: { ANTHROPIC_API_KEY: KEY } };
const completion = () => Response.json({
  id: "msg-retry-review", model: "claude-haiku-4-5", stop_reason: "end_turn",
  content: [{ type: "text", text: "Done" }], usage: { input_tokens: 100, output_tokens: 10 },
});
const event = value => `data: ${JSON.stringify(value)}\n\n`;
const frames = [
  event({ type: "message_start", message: { id: "msg-retry-review", model: "claude-haiku-4-5", usage: { input_tokens: 100, output_tokens: 0 } } }),
  event({ type: "content_block_delta", delta: { type: "text_delta", text: "Done" } }),
  event({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 10 } }),
  event({ type: "message_stop" }),
];

function streamed(chunks, { fail, hang = false, type = "text/event-stream" } = {}) {
  let index = 0, keepAlive;
  return new Response(new ReadableStream({
    pull(controller) {
      if (index < chunks.length) controller.enqueue(Buffer.from(chunks[index++]));
      else if (fail) controller.error(fail);
      else if (hang) keepAlive ??= setTimeout(() => {}, 10_000);
      else controller.close();
    },
    cancel() { clearTimeout(keepAlive); },
  }), { headers: { "content-type": type } });
}

for (const [name, first] of [
  ["dropped successful stream", () => streamed(frames.slice(0, 3), { fail: new TypeError(`socket reset ${KEY}`) })],
  ["dropped stream after message_stop", () => streamed(frames, { fail: new TypeError("terminated") })],
  ["accepted body reporting a connection error", () => streamed(frames.slice(0, 1), { fail: Object.assign(new Error("connect-like body failure"), { code: "ECONNREFUSED" }) })],
  ["missing message_stop", () => streamed(frames.slice(0, 3))],
  ["malformed accepted SSE body", () => streamed(["data: invalid JSON\n\n"])],
  ["malformed accepted JSON body", () => new Response("{invalid", { headers: { "content-type": "application/json" } })],
  ["accepted stream overload error", () => streamed([event({ type: "error", error: { type: "overloaded_error", message: KEY } })])],
  ["accepted stream rate-limit error", () => streamed([event({ type: "error", error: { type: "rate_limit_error" } })])],
  ["successful headers with a body timeout", () => streamed([], { hang: true })],
]) {
  test(`Anthropic retry review: ${name} is never replayed`, async t => {
    let calls = 0;
    t.mock.method(globalThis, "fetch", async () => ++calls === 1 ? first() : completion());
    await assert.rejects(anthropic(request({ timeoutMs: 30 }), options), error => {
      assert.equal(error.usage?.costUsd, null);
      assert.equal(error.usage?.billingUnknown, true);
      assert.equal(String(error.stack).includes(KEY), false);
      assert.equal(JSON.stringify(error).includes(KEY), false);
      return true;
    });
    assert.equal(calls, 1, "an accepted paid POST must not be replayed even when retries remain");
  });
}

for (const [name, failure] of [
  ["generic fetch rejection", () => new TypeError("fetch failed")],
  ["connection reset", () => new TypeError("fetch failed", { cause: Object.assign(new Error("reset"), { code: "ECONNRESET" }) })],
  ["socket closed", () => new TypeError("fetch failed", { cause: Object.assign(new Error("socket"), { code: "UND_ERR_SOCKET" }) })],
  ["response-header timeout", () => new DOMException("request timed out", "TimeoutError")],
]) {
  test(`Anthropic retry review: ${name} cannot prove an unbilled POST`, async t => {
    let calls = 0;
    t.mock.method(globalThis, "fetch", async () => { calls++; throw failure(); });
    await assert.rejects(anthropic(request(), options), error => {
      assert.equal(error.usage?.billingUnknown, true);
      assert.equal(error.usage?.costUsd, null);
      return true;
    });
    assert.equal(calls, 1);
  });
}

for (const code of ["ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "ENETUNREACH", "EHOSTUNREACH", "UND_ERR_CONNECT_TIMEOUT"]) {
  test(`Anthropic retry review: proven ${code} connect failure retries to a priced success`, async t => {
    let calls = 0;
    t.mock.method(globalThis, "fetch", async () => {
      if (++calls === 1) throw new TypeError("fetch failed", { cause: Object.assign(new Error("connect failed"), { code }) });
      return completion();
    });
    const result = await anthropic(request(), options);
    assert.equal(calls, 2);
    assert.equal(result.content, "Done");
    assert.equal(result.usage.costUsd, 0.00015);
    assert.equal(result.usage.billingUnknown, undefined);
  });
}

test("Anthropic retry review: proven unbilled failures still respect the retry bound", async t => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    throw new TypeError("fetch failed", { cause: Object.assign(new Error("connect failed"), { code: "ECONNREFUSED" }) });
  });
  await assert.rejects(anthropic(request(), options), error => {
    assert.equal(error.code, "NETWORK");
    assert.equal(error.usage, undefined, "connect failures must not invent unknown billed spend");
    return true;
  });
  assert.equal(calls, 3);
});

for (const status of [429, 500, 503, 599]) {
  test(`Anthropic retry review: ${status} rejection retries without reading its body`, async t => {
    let calls = 0, cancelled = 0, reads = 0;
    t.mock.method(globalThis, "fetch", async () => {
      if (++calls > 2) return completion();
      return {
        ok: false, status, headers: new Headers(),
        body: { async cancel() { cancelled++; }, getReader() { reads++; throw new Error("must not read rejection body"); } },
      };
    });
    const result = await anthropic(request(), options);
    assert.equal(calls, 3);
    assert.equal(cancelled, 2);
    assert.equal(reads, 0);
    assert.equal(result.usage.costUsd, 0.00015);
    assert.equal(result.usage.billingUnknown, undefined);
  });
}

test("Anthropic retry review: nonretryable rejection stays unbilled and is sent once", async t => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => { calls++; return new Response("not authorized", { status: 401 }); });
  await assert.rejects(anthropic(request(), options), error => {
    assert.equal(error.code, "AUTH_REQUIRED");
    assert.equal(error.usage, undefined);
    return true;
  });
  assert.equal(calls, 1);
});

test("Anthropic retry review: an injected retry-capable fetcher is limited to one attempt per invocation", async () => {
  let calls = 0;
  const result = await anthropic(request(), {
    ...options,
    fetcher: async (_url, _init, policy) => {
      calls++;
      assert.equal(policy.retries, 0);
      return completion();
    },
  });
  assert.equal(calls, 1);
  assert.equal(result.content, "Done");
  assert.equal(result.usage.costUsd, 0.00015);
});

test("Anthropic retry review: injected direct Response failures use the same no-replay boundary", async () => {
  let calls = 0;
  await assert.rejects(anthropic(request(), {
    ...options,
    fetcher: async () => { calls++; return streamed(frames.slice(0, 3)); },
  }), error => error.usage?.billingUnknown === true);
  assert.equal(calls, 1);
});

test("Anthropic retry review: an injected header timeout cannot hang or replay the paid POST", async () => {
  let calls = 0;
  const keepAlive = setTimeout(() => {}, 1000);
  try {
    await assert.rejects(anthropic(request({ timeoutMs: 25 }), {
      ...options,
      fetcher: async () => { calls++; return new Promise(() => {}); },
    }), error => {
      assert.equal(error.code, "TIMEOUT");
      assert.equal(error.usage?.billingUnknown, true);
      return true;
    });
    assert.equal(calls, 1);
  } finally { clearTimeout(keepAlive); }
});
