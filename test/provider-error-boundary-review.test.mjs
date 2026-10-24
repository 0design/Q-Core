import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { anthropic } from "../src/providers/anthropic.mjs";
import { openRouter } from "../src/providers/openrouter.mjs";
import { createRun, driveRun, RunStore } from "../src/run.mjs";
import { validateManifest } from "../src/manifest.mjs";

// Synthetic provider fixture only. All transports below are injected offline.
const KEY = ["review", "provider", "boundary", "credential", "fixture"].join("_");
const percent = value => [...Buffer.from(value)].map(byte => `%${byte.toString(16).padStart(2, "0")}`).join("");
const unicode = value => [...value].map(char => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`).join("");
const encodings = [
  ["hex", Buffer.from(KEY).toString("hex")],
  ["base64 with a prefix offset", Buffer.from(`x${KEY}`).toString("base64")],
  ["double percent", percent(percent(KEY))],
  ["JSON escapes", unicode(KEY)],
  ["HTML decimal entities", [...KEY].map(char => `&#${char.codePointAt(0)};`).join("")],
  ["HTML hexadecimal entities", [...KEY].map(char => `&#x${char.codePointAt(0).toString(16)};`).join("")],
  ["HTML named entities", KEY.replaceAll("_", "&lowbar;")],
  ["JSON byte array", JSON.stringify([...Buffer.from(KEY)])],
  ["JavaScript hex escapes", [...Buffer.from(KEY)].map(byte => `\\x${byte.toString(16).padStart(2, "0")}`).join("")],
  ["JavaScript braced Unicode escapes", [...KEY].map(char => `\\u{${char.codePointAt(0).toString(16)}}`).join("")],
  ["whitespace", [...KEY].join(" ")],
];
const request = provider => ({
  model: provider === "anthropic" ? "claude-sonnet-5" : "anthropic/claude-sonnet-5",
  messages: [{ role: "user", content: "Hello" }], payerScope: "local-byok",
  maxTokens: 100, retries: 0, timeoutMs: 1000,
});
const event = value => `data: ${JSON.stringify(value)}\n\n`;
const fixture = (provider, transport, payload) => {
  const fields = { id: payload, model: payload,
    error: { type: payload, code: payload, message: payload, nested: { header: payload } },
    usage: provider === "anthropic" ? { input_tokens: 1, output_tokens: 1 } : { prompt_tokens: 1, completion_tokens: 1, cost: 0.01 } };
  if (transport === "HTTP error") return Response.json(fields, { status: 401,
    statusText: "Untrusted provider description", headers: { "request-id": payload, "x-provider-error": payload } });
  if (transport === "SSE error") return new Response([
    event({ type: "message_start", message: fields }),
    event({ type: "error", error: fields.error }),
  ].join(""), { headers: { "content-type": "text/event-stream" } });
  return Response.json(fields);
};

for (const provider of ["anthropic", "openrouter"]) {
  const implementation = provider === "anthropic" ? anthropic : openRouter;
  const transports = provider === "anthropic" ? ["HTTP error", "JSON error", "SSE error"] : ["HTTP error", "JSON error"];
  for (const transport of transports) for (const [encoding, payload] of encodings) {
    test(`${provider} error boundary: ${transport} drops ${encoding} echoes before persistence`, async t => {
      const args = request(provider);
      // Assert the provider boundary itself, before the persistence guard can
      // conceal a forwarded envelope by replacing a recognized spelling.
      await assert.rejects(implementation(args, {
        env: {}, secretResolver: async () => KEY,
        fetcher: async () => fixture(provider, transport, payload),
      }), error => {
        const exposed = JSON.stringify({ message: error.message, stack: error.stack, ...error });
        assert.equal(exposed.includes(KEY), false);
        assert.equal(exposed.includes(payload), false);
        assert.equal(exposed.includes(JSON.stringify(payload).slice(1, -1)), false);
        assert.equal(exposed.includes("REDACTED"), false, "untrusted diagnostics are absent, not spelling-filtered");
        assert.equal(Object.hasOwn(error, "cause"), false);
        assert.equal(Object.keys(error).includes("model"), false);
        assert.equal(error.requestId, undefined, "provider request IDs from error envelopes are dropped");
        if (transport === "HTTP error") assert.equal(error.status, 401);
        return true;
      });

      const directory = await mkdtemp(join(tmpdir(), "q-core-provider-error-"));
      t.after(() => rm(directory, { recursive: true, force: true }));
      const store = new RunStore(join(directory, "workflow.yaml"));
      const manifest = validateManifest({ manifest: "q-core.workflow/v1", id: "provider-error-boundary",
        settings: { budgetUsd: null }, steps: [{ id: "answer", kind: "llm-call", config: {
          provider, model: args.model, instructions: "Say hello.", maxTokens: "100", retries: "0",
        } }] });
      let calls = 0;
      const native = call => implementation(call, { env: {}, secretResolver: async () => KEY,
        fetcher: async () => { calls++; return fixture(provider, transport, payload); } });
      if (provider === "openrouter") t.mock.method(globalThis, "fetch", async () => {
        calls++;
        return fixture(provider, transport, payload);
      });
      const done = await driveRun(createRun(manifest), { settings: manifest.settings, store, apiKey: KEY,
        providers: { anthropic: native } });
      assert.equal(done.status, "failed");
      assert.equal(calls, 1);
      assert.equal(done.steps[0].output, null);
      store.saveLastRun(done);
      for (const file of [store.runFile(done.runId), join(store.dir, "last-run.json")]) {
        const saved = await readFile(file, "utf8");
        assert.equal(saved.includes(KEY), false);
        assert.equal(saved.includes(payload), false);
        assert.equal(saved.includes(JSON.stringify(payload).slice(1, -1)), false);
        assert.equal(saved.includes("REDACTED"), false, "persisted failures never contained provider free text");
      }
    });
  }

  test(`${provider} error boundary: rejected response bodies and headers are not read`, async () => {
    let cancellations = 0;
    await assert.rejects(implementation(request(provider), { env: {}, secretResolver: async () => KEY,
      fetcher: async () => ({ ok: false, status: 401,
        get headers() { assert.fail("error headers must not enter diagnostics"); },
        json() { assert.fail("error body must not be parsed"); },
        body: { cancel() { cancellations++; }, getReader() { assert.fail("error body must not be read"); } },
      }),
    }), { code: "AUTH_REQUIRED", status: 401 });
    assert.equal(cancellations, 1);
  });

  for (const phase of ["secret resolver", "transport", "body reader", "error-body disposal"]) {
    test(`${provider} error boundary: ${phase} cannot expose unrestricted thrown diagnostics`, async () => {
      const payload = `${Buffer.from(KEY).toString("hex")} forbidden-upstream-message`;
      const failure = Object.assign(new Error(payload), { code: payload, headers: { secret: payload } });
      await assert.rejects(implementation(request(provider), {
        env: {}, secretResolver: async () => { if (phase === "secret resolver") throw failure; return KEY; },
        fetcher: async () => {
          if (phase === "transport") throw failure;
          return phase === "body reader" ? { ok: true, status: 200, headers: new Headers(),
            body: { getReader() { throw failure; } } }
            : { ok: false, status: 401, body: { cancel() { throw failure; } } };
        },
      }), error => {
        assert.notEqual(error, failure);
        assert.equal(JSON.stringify({ message: error.message, stack: error.stack, ...error }).includes(payload), false);
        assert.equal(error.code.includes("forbidden"), false);
        return true;
      });
    });
  }

  test(`${provider} error boundary: nonnumeric status is never copied into a failure`, async () => {
    const payload = Buffer.from(KEY).toString("hex");
    await assert.rejects(implementation(request(provider), { env: {}, secretResolver: async () => KEY,
      fetcher: async () => ({ ok: false, status: payload, body: { cancel() {} } }),
    }), error => {
      assert.equal(JSON.stringify({ message: error.message, ...error }).includes(payload), false);
      assert.equal(error.status, undefined);
      return true;
    });
  });
}

test("OpenRouter error boundary: safe internal rate lookup preserves actual-model billing fallback", async () => {
  for (const model of ["openai/gpt-4o-mini", "unknown-provider-model"]) {
    await assert.rejects(openRouter(request("openrouter"), { env: {}, secretResolver: async () => KEY,
      fetcher: async () => Response.json({ model, choices: [{ finish_reason: "length", message: { content: "partial" } }],
        usage: { prompt_tokens: 1, completion_tokens: 1 } }),
    }), error => {
      assert.equal(error.code, "OUTPUT_LIMIT");
      assert.equal(error.model, model === "openai/gpt-4o-mini" ? model : "");
      assert.equal(JSON.stringify(error).includes(model), false);
      assert.equal(error.usage.costUsd, null);
      return true;
    });
  }
});
