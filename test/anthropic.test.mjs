import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRun, driveRun, RunStore } from "../src/run.mjs";
import { validateManifest } from "../src/manifest.mjs";

const API = "https://api.anthropic.com/v1/messages";
const KEY = "sk-ant-fixture-never-log-this";
const environment = { ANTHROPIC_API_KEY: KEY };
const request = (overrides = {}) => ({
  model: "claude-sonnet-5",
  messages: [{ role: "system", content: "Be concise." }, { role: "user", content: "Hello" }],
  payerScope: "local-byok", maxTokens: 100, retries: 0, delaysMs: [0], timeoutMs: 1000,
  ...overrides,
});

// Import in every test: on the previous release every test fails because the
// native provider is absent, rather than one file-level module-load failure.
async function nativeProvider() {
  const { anthropic } = await import("../src/providers/anthropic.mjs");
  assert.equal(typeof anthropic, "function");
  return anthropic;
}

function completion(overrides = {}) {
  return {
    id: "msg-fixture", type: "message", role: "assistant", model: "claude-sonnet-5",
    content: [{ type: "text", text: "Done" }], stop_reason: "end_turn",
    usage: { input_tokens: 1000, output_tokens: 100 }, ...overrides,
  };
}
const json = (body = completion(), status = 200) => ({ status, type: "application/json", chunks: [JSON.stringify(body)] });
const event = body => `event: ${body.type}\ndata: ${JSON.stringify(body)}\n\n`;
function stream({ text = "Готово", usage = { input_tokens: 1000, output_tokens: 0 }, outputTokens = 100, stop = "end_turn", complete = true } = {}) {
  const start = event({ type: "message_start", message: { id: "msg-stream", model: "claude-sonnet-5", usage } });
  const end = event({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } })
    + event({ type: "message_delta", delta: { stop_reason: stop }, usage: { output_tokens: outputTokens } })
    + (complete ? event({ type: "message_stop" }) : "");
  // Split in the middle of a frame, then emit the final events later. The
  // provider must wait for message_stop and combine incremental usage.
  const bytes = Buffer.from(start + end);
  const split = Buffer.from(start).length + 19;
  return { status: 200, type: "text/event-stream", chunks: [bytes.subarray(0, split), bytes.subarray(split)], delayMs: 3 };
}
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

// The same protocol tests run against a real local HTTP server and an injected
// byte stream. The latter also exercises transport logic in sandboxes that
// forbid listen(2); the local HTTP tests remain real HTTP and report EPERM.
async function withTransport(t, mode, handler, work) {
  const calls = [];
  const route = async (url, init) => {
    assert.equal(String(url), API, "only the native Messages endpoint is used");
    const call = { method: init.method, headers: new Headers(init.headers), body: JSON.parse(init.body) };
    calls.push(call);
    return handler(calls.length, call);
  };
  if (mode === "injected stream") {
    t.mock.method(globalThis, "fetch", async (url, init) => {
      const reply = await route(url, init);
      if (reply.network) throw new TypeError(`fetch failed: ${KEY}`);
      let settled = false;
      let keepAlive;
      let cleanup = () => {};
      const body = new ReadableStream({
        start(controller) {
          const abort = () => {
            if (settled) return;
            settled = true;
            cleanup();
            controller.error(init.signal.reason);
          };
          cleanup = () => { clearTimeout(keepAlive); init.signal?.removeEventListener("abort", abort); };
          init.signal?.addEventListener("abort", abort, { once: true });
          if (init.signal?.aborted) return abort();
          if (reply.end === false) keepAlive = setTimeout(() => {}, 10_000);
          void (async () => {
            for (const chunk of reply.chunks ?? []) {
              if (reply.delayMs) await pause(reply.delayMs);
              if (settled) return;
              controller.enqueue(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
            }
            if (reply.end === false || settled) return;
            settled = true;
            cleanup();
            if (reply.drop) controller.error(new TypeError(`network stream dropped ${KEY}`));
            else controller.close();
          })();
        },
        cancel() { settled = true; cleanup(); },
      });
      return new Response(body, { status: reply.status ?? 200, headers: { "content-type": reply.type ?? "application/json" } });
    });
    return work(calls);
  }

  const failures = [];
  const server = createServer(async (req, res) => {
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const reply = await route(API, { method: req.method, headers: req.headers, body: Buffer.concat(chunks).toString("utf8") });
      assert.equal(req.url, "/v1/messages");
      if (reply.network) return req.socket.destroy();
      res.writeHead(reply.status ?? 200, { "content-type": reply.type ?? "application/json" });
      res.flushHeaders();
      for (const chunk of reply.chunks ?? []) {
        if (reply.delayMs) await pause(reply.delayMs);
        if (res.destroyed) return;
        res.write(chunk);
      }
      if (reply.drop) res.destroy();
      else if (reply.end !== false) res.end();
    } catch (error) {
      failures.push(error);
      res.destroy();
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const originalFetch = globalThis.fetch;
  const local = `http://127.0.0.1:${server.address().port}/v1/messages`;
  t.mock.method(globalThis, "fetch", (url, init) => {
    assert.equal(String(url), API);
    return originalFetch(local, init);
  });
  try {
    const result = await work(calls);
    if (failures.length) throw failures[0];
    return result;
  } finally {
    const closed = new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    server.closeAllConnections();
    await closed;
  }
}

const closeTo = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-12, `${actual} != ${expected}`);
const manifest = (steps, budgetUsd = 1) => validateManifest({
  manifest: "q-core.workflow/v1", id: "anthropic-native", settings: { budgetUsd }, steps,
});
const llm = (id, config = {}) => ({ id, kind: "llm-call", config: { provider: "anthropic", model: "claude-sonnet-5", instructions: "Say done.", retries: "0", maxTokens: "100", ...config } });

for (const mode of ["local HTTP", "injected stream"]) {
  const check = (name, fn) => test(`Anthropic ${mode}: ${name}`, async t => fn(t, await nativeProvider()));

  check("JSON completion uses native headers, separates system and records cache tokens", async (t, anthropic) => {
    await withTransport(t, mode, (_n, call) => {
      assert.equal(call.method, "POST");
      assert.equal(call.headers.get("x-api-key"), KEY);
      assert.equal(call.headers.get("anthropic-version"), "2023-06-01");
      assert.equal(call.headers.get("authorization"), null);
      assert.equal(call.body.system, "First\n\nSecond");
      assert.deepEqual(call.body.messages, [{ role: "user", content: "Hello" }]);
      assert.equal(call.body.max_tokens, 77);
      assert.equal(call.body.stream, true);
      assert.deepEqual(call.body.thinking, { type: "disabled" });
      assert.equal(Object.hasOwn(call.body, "temperature"), false);
      return json(completion({ content: [{ type: "thinking", thinking: "private" }, { type: "text", text: " Done " }], usage: { input_tokens: 1000, cache_read_input_tokens: 30, cache_creation_input_tokens: 10, output_tokens: 100 } }));
    }, async calls => {
      const result = await anthropic(request({ maxTokens: 77, messages: [{ role: "system", content: "First" }, { role: "user", content: "Hello" }, { role: "system", content: "Second" }] }), { env: environment });
      assert.equal(result.content, "Done");
      assert.equal(result.requestId, "msg-fixture");
      assert.equal(result.provider.kind, "anthropic");
      assert.equal(result.provider.requestedModel, "claude-sonnet-5");
      assert.equal(result.usage.tokensIn, 1040);
      assert.equal(result.usage.tokensOut, 100);
      closeTo(result.usage.costUsd, 0.00308);
      assert.equal(calls.length, 1);
      assert.equal(JSON.stringify(result).includes(KEY), false);
    });
  });

  check("fragmented SSE is read to message_stop and merges incremental usage", async (t, anthropic) => {
    await withTransport(t, mode, () => stream({ usage: { input_tokens: 1000, cache_read_input_tokens: 30, cache_creation_input_tokens: 10, output_tokens: 0 } }), async () => {
      const result = await anthropic(request(), { env: environment });
      assert.equal(result.content, "Готово");
      assert.equal(result.requestId, "msg-stream");
      assert.deepEqual([result.usage.tokensIn, result.usage.tokensOut], [1040, 100]);
      closeTo(result.usage.costUsd, 0.00308);
    });
  });

  for (const status of [429, 500, 503]) check(`${status} retries within the bound without inventing extra billed spend`, async (t, anthropic) => {
    await withTransport(t, mode, n => n < 3 ? json({ error: { message: KEY } }, status) : stream(), async calls => {
      const result = await anthropic(request({ retries: 2 }), { env: environment });
      assert.equal(calls.length, 3);
      assert.equal(result.content, "Готово");
      closeTo(result.usage.costUsd, 0.003);
      assert.equal(result.usage.billingUnknown, undefined);
    });
  });

  check("network failure retries and marks the whole call billing unknown", async (t, anthropic) => {
    await withTransport(t, mode, n => n === 1 ? { network: true } : json(), async calls => {
      const result = await anthropic(request({ retries: 1 }), { env: environment });
      assert.equal(calls.length, 2);
      assert.equal(result.content, "Done");
      assert.equal(result.usage.costUsd, null);
      assert.equal(result.usage.billingUnknown, true);
    });
  });

  for (const failure of ["dropped stream", "missing message_stop"]) check(`${failure} retries inside the attempt and keeps unknown billing`, async (t, anthropic) => {
    await withTransport(t, mode, n => n === 1 ? { ...stream({ complete: false }), ...(failure === "dropped stream" ? { drop: true } : {}) } : stream(), async calls => {
      const result = await anthropic(request({ retries: 1 }), { env: environment });
      assert.equal(calls.length, 2);
      assert.equal(result.content, "Готово");
      assert.equal(result.usage.costUsd, null);
      assert.equal(result.usage.billingUnknown, true);
    });
  });

  check("per-attempt timeout covers the entire body and exhausts exactly the allowed attempts", async (t, anthropic) => {
    await withTransport(t, mode, () => ({ ...stream({ complete: false }), end: false }), async calls => {
      const start = Date.now();
      await assert.rejects(anthropic(request({ retries: 1, timeoutMs: 50 }), { env: environment }), error => {
        assert.equal(error.code, "TIMEOUT");
        assert.equal(error.usage.costUsd, null);
        assert.equal(error.usage.billingUnknown, true);
        assert.equal(JSON.stringify(error).includes(KEY), false);
        return true;
      });
      assert.equal(calls.length, 2);
      assert.ok(Date.now() - start < 2000);
    });
  });

  check("body timeout can recover on the next attempt but cannot claim an exact total cost", async (t, anthropic) => {
    await withTransport(t, mode, n => n === 1 ? { ...stream({ complete: false }), end: false } : stream(), async calls => {
      const result = await anthropic(request({ retries: 1, timeoutMs: 100 }), { env: environment });
      assert.equal(calls.length, 2);
      assert.equal(result.content, "Готово");
      assert.equal(result.usage.costUsd, null);
      assert.equal(result.usage.billingUnknown, true);
    });
  });

  for (const text of ["partial answer", ""]) check(`max_tokens with ${text ? "partial" : "empty"} text raises OUTPUT_LIMIT and retains actual usage`, async (t, anthropic) => {
    await withTransport(t, mode, () => stream({ text, stop: "max_tokens" }), async calls => {
      await assert.rejects(anthropic(request({ retries: 2 }), { env: environment }), error => {
        assert.equal(error.code, "OUTPUT_LIMIT");
        closeTo(error.usage.costUsd, 0.003);
        assert.deepEqual([error.usage.tokensIn, error.usage.tokensOut], [1000, 100]);
        return true;
      });
      assert.equal(calls.length, 1, "truncation is not replayed");
    });
  });

  check("Haiku long-context pricing includes cache reads and writes at the reference threshold", async (t, anthropic) => {
    await withTransport(t, mode, () => json(completion({ model: "claude-haiku-5-5", usage: { input_tokens: 99_999, cache_read_input_tokens: 1, cache_creation_input_tokens: 1, output_tokens: 100 } })), async () => {
      const result = await anthropic(request({ model: "claude-haiku-5-5" }), { env: environment });
      assert.equal(result.usage.tokensIn, 100_001);
      closeTo(result.usage.costUsd, (100_001 * 0.50 + 100 * 2.50) / 1e6);
    });
  });

  check("custom secret source and workspace header reach only the Messages request", async (t, anthropic) => {
    let secretReads = 0;
    await withTransport(t, mode, (_n, call) => {
      assert.equal(call.headers.get("x-api-key"), KEY);
      assert.equal(call.headers.get("anthropic-workspace-id"), "workspace-fixture");
      assert.equal(JSON.stringify(call.body).includes(KEY), false);
      return json();
    }, async () => {
      const result = await anthropic(request({ keyRef: "OWNER_ANTHROPIC_KEY", secretSource: "keychain", workspaceId: "workspace-fixture" }), {
        env: {}, secretResolver: async args => {
          secretReads++;
          assert.equal(args.provider, "anthropic");
          assert.equal(args.keyRef, "OWNER_ANTHROPIC_KEY");
          assert.equal(args.secretSource, "keychain");
          return KEY;
        },
      });
      assert.equal(secretReads, 1);
      assert.equal(JSON.stringify(result).includes(KEY), false);
    });
  });

  check("provider errors redact echoed credentials and keep auth failures typed", async (t, anthropic) => {
    await withTransport(t, mode, () => json({ error: { type: "authentication_error", message: `Bad key ${KEY}` } }, 401), async calls => {
      await assert.rejects(anthropic(request({ retries: 2 }), { env: environment }), error => {
        assert.equal(error.code, "AUTH_REQUIRED");
        assert.equal(String(error.stack).includes(KEY), false);
        assert.equal(JSON.stringify(error).includes(KEY), false);
        return true;
      });
      assert.equal(calls.length, 1);
    });
  });

  check("actual cost is persisted and the run budget refuses the next paid step", async (t, anthropic) => {
    const directory = await mkdtemp(join(tmpdir(), "q-core-anthropic-"));
    try {
      await withTransport(t, mode, () => json(), async calls => {
        const m = manifest([llm("first"), llm("second")], 0.002);
        const store = new RunStore(join(directory, "workflow.yaml"));
        const done = await driveRun(createRun(m), { store, settings: m.settings, providers: { anthropic: args => anthropic(args, { env: environment }) } });
        assert.equal(done.status, "failed");
        assert.equal(calls.length, 1);
        assert.equal(done.steps[0].status, "success");
        assert.equal(done.steps[0].costSource, "provider");
        assert.equal(done.steps[0].costUsd, 0.003);
        assert.equal(done.costUsd, 0.003);
        assert.equal(done.steps[1].gateReason, "budget");
        const saved = store.load(done.runId);
        assert.deepEqual([saved.steps[0].tokensIn, saved.steps[0].tokensOut], [1000, 100]);
        assert.equal(saved.costUsd, 0.003);
        assert.equal(JSON.stringify(saved).includes(KEY), false);
        const state = await readFile(store.runFile(done.runId), "utf8");
        assert.equal(state.includes(KEY), false);
      });
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  check("a truncation fails the workflow while retaining the spent money", async (t, anthropic) => {
    await withTransport(t, mode, () => stream({ stop: "max_tokens" }), async calls => {
      const m = manifest([llm("first"), llm("second")]);
      const done = await driveRun(createRun(m), { settings: m.settings, providers: { anthropic: args => anthropic(args, { env: environment }) } });
      assert.equal(done.status, "failed");
      assert.match(done.steps[0].errorText, /truncat|maxTokens/i);
      assert.deepEqual([done.steps[0].costUsd, done.costUsd], [0.003, 0.003]);
      assert.equal(done.steps[1].status, "pending");
      assert.equal(calls.length, 1);
    });
  });

  check("a bill above the per-call cap fails but is still recorded in the run", async (t, anthropic) => {
    await withTransport(t, mode, () => json(completion({ usage: { input_tokens: 100_000, output_tokens: 100 } })), async calls => {
      const m = manifest([llm("first", { maxCallCostUsd: "0.05" })]);
      const done = await driveRun(createRun(m), { settings: m.settings, providers: { anthropic: args => anthropic(args, { env: environment }) } });
      assert.equal(done.status, "failed");
      assert.match(done.steps[0].errorText, /above maxCallCostUsd/);
      assert.deepEqual([done.steps[0].costUsd, done.costUsd], [0.201, 0.201]);
      assert.equal(calls.length, 1);
    });
  });

  check("missing answering model leaves alias cost unknown and refuses the next paid step", async (t, anthropic) => {
    await withTransport(t, mode, () => json(completion({ model: undefined })), async calls => {
      const m = manifest([llm("first", { model: "anthropic/claude-sonnet-5" }), llm("second")]);
      const done = await driveRun(createRun(m), { settings: m.settings, providers: { anthropic: args => anthropic(args, { env: environment }) } });
      assert.equal(done.steps[0].status, "success");
      assert.equal(done.steps[0].costUsd, null, "must not reprice native usage with the OpenRouter alias table");
      assert.equal(done.steps[0].costSource, "unknown");
      assert.equal(done.steps[1].gateReason, "budget");
      assert.equal(done.costUsd, null);
      assert.equal(calls.length, 1);
    });
  });

  check("billed truncation with no answering model retains unknown cost instead of repricing its alias", async (t, anthropic) => {
    await withTransport(t, mode, () => json(completion({ model: undefined, stop_reason: "max_tokens" })), async calls => {
      const m = manifest([llm("first", { model: "anthropic/claude-sonnet-5" })]);
      const done = await driveRun(createRun(m), { settings: m.settings, providers: { anthropic: args => anthropic(args, { env: environment }) } });
      assert.equal(done.status, "failed");
      assert.match(done.steps[0].errorText, /truncat|maxTokens/i);
      assert.deepEqual([done.steps[0].costUsd, done.costUsd], [null, null]);
      assert.equal(done.steps[0].costSource, "unknown");
      assert.deepEqual([done.steps[0].tokensIn, done.steps[0].tokensOut], [1000, 100]);
      assert.equal(calls.length, 1);
    });
  });
}

test("Anthropic missing env key is AUTH_REQUIRED before any request", async () => {
  const anthropic = await nativeProvider();
  let calls = 0;
  await assert.rejects(anthropic(request(), { env: {}, fetcher: async () => { calls++; throw new Error("must not send"); } }), { code: "AUTH_REQUIRED" });
  assert.equal(calls, 0);
});

test("Anthropic per-call cap refuses before reading the secret or sending, and counts retry attempts", async () => {
  const anthropic = await nativeProvider();
  let secretReads = 0, calls = 0;
  const options = { env: {}, secretResolver: async () => { secretReads++; return KEY; }, fetcher: async () => { calls++; throw new Error("must not send"); } };
  for (const overrides of [{ maxTokens: 32000, maxCallCostUsd: 0.01 }, { maxTokens: 1000, retries: 5, maxCallCostUsd: 0.05 }])
    await assert.rejects(anthropic(request(overrides), options), { code: "COST_LIMIT" });
  assert.equal(secretReads, 0);
  assert.equal(calls, 0);
});

test("Anthropic invalid length, effort, retry and timeout bounds fail before secrets", async () => {
  const anthropic = await nativeProvider();
  let secretReads = 0;
  for (const overrides of [{ maxTokens: 0 }, { maxTokens: 32001 }, { retries: 11 }, { timeoutMs: 0 }, { delaysMs: [] }, { reasoning: "unbounded" }])
    await assert.rejects(anthropic(request(overrides), { secretResolver: async () => { secretReads++; return KEY; } }), { code: "INVALID_REQUEST" });
  assert.equal(secretReads, 0);
});

test("Anthropic native and OpenRouter aliases map all four reference models and preserve thinking rules", async t => {
  const anthropic = await nativeProvider();
  const seen = [];
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    const body = JSON.parse(init.body);
    seen.push(body);
    return Response.json(completion({ model: body.model, usage: { input_tokens: 1000, output_tokens: 100 } }));
  });
  const cases = [
    ["claude-sonnet-5", undefined, "claude-sonnet-5", 0.003, "disabled"],
    ["anthropic/claude-sonnet-5", "high", "claude-sonnet-5", 0.003, "high"],
    ["claude-haiku-5-5", "off", "claude-haiku-5-5", 0.00015, "disabled"],
    ["anthropic/claude-haiku-5.5", "medium", "claude-haiku-5-5", 0.00015, "medium"],
    ["claude-opus-5-5", undefined, "claude-opus-5-5", 0.006, "low"],
    ["anthropic/claude-opus-5.5", "off", "claude-opus-5-5", 0.006, "low"],
    ["claude-haiku-4-5", "high", "claude-haiku-4-5", 0.0015, "legacy"],
    ["anthropic/claude-haiku-4.5", undefined, "claude-haiku-4-5", 0.0015, "legacy"],
  ];
  for (const [model, reasoning, native, cost, rule] of cases) {
    const result = await anthropic(request({ model, reasoning, temperature: 0.6 }), { env: environment });
    const body = seen.at(-1);
    assert.equal(body.model, native);
    closeTo(result.usage.costUsd, cost);
    if (rule === "disabled") assert.deepEqual(body.thinking, { type: "disabled" });
    else if (rule !== "legacy") assert.deepEqual(body.output_config, { effort: rule });
    if (rule === "legacy") {
      assert.equal(body.thinking, undefined);
      assert.equal(body.output_config, undefined);
      assert.equal(body.temperature, 0.6);
    } else assert.equal(Object.hasOwn(body, "temperature"), false);
  }
});

test("Anthropic a raw transport error cannot expose a credential through message, stack or serialization", async () => {
  const anthropic = await nativeProvider();
  await assert.rejects(anthropic(request(), { env: environment, fetcher: async () => { throw new TypeError(`network failed with ${KEY}`); } }), error => {
    assert.equal(error.code, "NETWORK");
    assert.equal(String(error.stack).includes(KEY), false);
    assert.equal(JSON.stringify(error).includes(KEY), false);
    return true;
  });
});

test("Anthropic a pre-aborted call never sends and reports CANCELLED", async t => {
  const anthropic = await nativeProvider();
  const controller = new AbortController();
  controller.abort(new Error(`stopped ${KEY}`));
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => { calls++; return Response.json(completion()); });
  await assert.rejects(anthropic(request({ signal: controller.signal }), { env: environment }), error => {
    assert.equal(error.code, "CANCELLED");
    assert.equal(String(error.stack).includes(KEY), false);
    return true;
  });
  assert.equal(calls, 0);
});

test("Anthropic zero run budget refuses the first paid step before dispatch", async () => {
  await nativeProvider();
  let calls = 0;
  const m = manifest([llm("first")], 0);
  const done = await driveRun(createRun(m), { settings: m.settings, providers: { anthropic: async () => { calls++; throw new Error("must not dispatch"); } } });
  assert.equal(done.status, "failed");
  assert.equal(done.steps[0].gateReason, "budget");
  assert.equal(done.costUsd, 0);
  assert.equal(calls, 0);
});

test("Anthropic redacts credentials echoed in successful content and response metadata", async t => {
  const anthropic = await nativeProvider();
  t.mock.method(globalThis, "fetch", async () => Response.json(completion({ id: `message-${KEY}`, model: `model-${KEY}`, content: [{ type: "text", text: `Response accidentally echoed ${KEY}` }] })));
  const result = await anthropic(request(), { env: environment });
  assert.equal(JSON.stringify(result).includes(KEY), false);
  assert.equal(result.usage.costUsd, null, "an unrecognized response model has no known price");
});

function envForTest(t, entries) {
  const original = new Map(Object.keys(entries).map(key => [key, process.env[key]]));
  for (const [key, value] of Object.entries(entries)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  t.after(() => {
    for (const [key, value] of original) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

test("Anthropic production manifest route uses its own key and model without an injected provider or shim", async t => {
  await nativeProvider();
  envForTest(t, { ANTHROPIC_API_KEY: KEY, ANTHROPIC_MODEL: "claude-sonnet-5", ANTHROPIC_WORKSPACE_ID: "workspace-env", OPENROUTER_API_KEY: undefined, OPENROUTER_MODEL: undefined });
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (url, init) => {
    calls++;
    assert.equal(String(url), API);
    const headers = new Headers(init.headers);
    assert.equal(headers.get("x-api-key"), KEY);
    assert.equal(headers.get("anthropic-workspace-id"), "workspace-env");
    assert.equal(headers.get("authorization"), null);
    assert.equal(JSON.parse(init.body).model, "claude-sonnet-5");
    return Response.json(completion());
  });
  const step = llm("first");
  delete step.config.model;
  const m = manifest([step]);
  const done = await driveRun(createRun(m), { settings: m.settings, apiKey: "wrong-openrouter-key" });
  assert.equal(done.status, "success", done.summary);
  assert.equal(done.steps[0].provider.kind, "anthropic");
  assert.equal(done.costUsd, 0.003);
  assert.equal(JSON.stringify(done).includes(KEY), false);
  assert.equal(calls, 1);
});

test("Anthropic missing native key never reuses the OpenRouter key", async t => {
  await nativeProvider();
  envForTest(t, { ANTHROPIC_API_KEY: undefined, OPENROUTER_API_KEY: "wrong-openrouter-key" });
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => { calls++; return Response.json(completion()); });
  const m = manifest([llm("first")]);
  const done = await driveRun(createRun(m), { settings: m.settings, apiKey: "wrong-openrouter-key" });
  assert.equal(done.status, "failed");
  assert.match(done.steps[0].errorText, /ANTHROPIC_API_KEY/);
  assert.equal(calls, 0);
});

test("Anthropic catalog requirements follow native key aliases, protected sources and mixed providers", async () => {
  await nativeProvider();
  const { describeWorkflow } = await import("../src/catalog.mjs");
  const directory = await mkdtemp(join(tmpdir(), "q-core-anthropic-catalog-"));
  const cases = [
    ["native key", [llm("native")], ["ANTHROPIC_API_KEY"]],
    ["custom native key", [llm("native", { keyRef: "OWNER_ANTHROPIC_CREDIT" })], ["OWNER_ANTHROPIC_CREDIT"]],
    ["protected native key", [llm("native", { secretSource: "keychain" })], []],
    ["protected alias", [llm("native", { secretSource: "keychain", keyRef: "OWNER_ANTHROPIC_CREDIT" })], []],
    ["mixed providers", [llm("native"), llm("openrouter", { provider: "openrouter" })], ["OPENROUTER_API_KEY", "ANTHROPIC_API_KEY"]],
  ];
  try {
    for (const [name, steps, expected] of cases) {
      const file = join(directory, "workflow.yaml");
      const document = { manifest: "q-core.workflow/v1", id: "anthropic-catalog", steps };
      await writeFile(file, Object.entries(document).map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join("\n") + "\n");
      assert.deepEqual(describeWorkflow(file).needsEnv, expected, name);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("Anthropic protected secret retrieval uses its own default service and account without exposing the key in argv", async () => {
  await nativeProvider();
  const { getKeychainSecret } = await import("../src/secrets.mjs");
  let calls = 0;
  const controller = new AbortController();
  const secret = await getKeychainSecret({ provider: "anthropic", platform: "darwin" }, {
    signal: controller.signal,
    launch: async (command, args, options) => {
      calls++;
      assert.equal(command, "/usr/bin/security");
      assert.deepEqual(args, ["find-generic-password", "-a", "anthropic:ANTHROPIC_API_KEY", "-s", "com.qfactory.q-core.anthropic", "-w"]);
      assert.equal(JSON.stringify(args).includes(KEY), false);
      assert.equal(JSON.stringify(options).includes(KEY), false);
      assert.equal(options.signal, controller.signal);
      return { code: 0, stdout: `${KEY}\n`, stderr: "" };
    },
  });
  assert.equal(secret, KEY);
  assert.equal(calls, 1);
});
