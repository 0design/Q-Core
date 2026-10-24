import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { anthropic } from "../src/providers/anthropic.mjs";
import { createRun, driveRun, RunStore } from "../src/run.mjs";
import { validateManifest } from "../src/manifest.mjs";

// Synthetic credential only: these probes never dispatch a network request.
const KEY = "sk-ant-round2-redaction-fixture";
const PADDED_KEY = ` \t${KEY}\r\n `;
const model = "claude-sonnet-5";
const request = { model, payerScope: "local-byok", maxTokens: 100, retries: 0, timeoutMs: 1000,
  messages: [{ role: "user", content: "Hello" }] };
const unicode = value => [...value].map(char => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`).join("");
const event = value => `data: ${JSON.stringify(value)}\n\n`;
function response(text, transport) {
  const message = { id: `msg-${KEY}`, model, usage: { input_tokens: 100, output_tokens: 10 } };
  return transport === "SSE"
    ? new Response([
      event({ type: "message_start", message }),
      event({ type: "content_block_delta", delta: { type: "text_delta", text } }),
      event({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 10 } }),
      event({ type: "message_stop" }),
    ].join(""), { headers: { "content-type": "text/event-stream" } })
    : Response.json({ ...message, stop_reason: "end_turn", content: [{ type: "text", text }] });
}
const step = (id, format = "json") => ({ id, kind: "llm-call", config: {
  provider: "anthropic", model, instructions: "Return the result.", maxTokens: "100", retries: "0", format,
} });
const manifest = steps => validateManifest({ manifest: "q-core.workflow/v1", id: "redaction-review", steps });

for (const source of ["env", "resolver"]) {
  for (const transport of ["JSON", "SSE"]) {
    for (const encoding of ["literal", "mixed Unicode", "all Unicode"]) {
      test(`Anthropic redaction: ${source}, ${transport}, ${encoding} values and object keys stay sanitized on disk`, async t => {
        const directory = await mkdtemp(join(tmpdir(), "q-core-redaction-"));
        t.after(() => rm(directory, { recursive: true, force: true }));
        const store = new RunStore(join(directory, "workflow.yaml"));
        const original = JSON.parse(`{"${KEY}":{"nested":["before ${KEY} after",{"prefix-${KEY}":"${KEY} / ${KEY}"},null,true,42]},"safe":"Україна [REDACTED]","__proto__":{"safe":true}}`);
        const encodedKey = encoding === "literal" ? KEY : encoding === "mixed Unicode" ? `\\u0073${KEY.slice(1)}` : unicode(KEY);
        const text = `Result:\n\`\`\`json\n${JSON.stringify(original).split(KEY).join(encodedKey)}\n\`\`\``;
        const expected = JSON.parse('{"[REDACTED]":{"nested":["before [REDACTED] after",{"prefix-[REDACTED]":"[REDACTED] / [REDACTED]"},null,true,42]},"safe":"Україна [REDACTED]","__proto__":{"safe":true}}');
        let calls = 0, wireKey;
        const native = args => anthropic(args, {
          env: source === "env" ? { ANTHROPIC_API_KEY: PADDED_KEY } : {},
          ...(source === "resolver" ? { secretResolver: async args => {
            assert.equal(args.secretSource, "keychain");
            if (args.optional) {
              assert.equal(args.keyRef, "ANTHROPIC_WORKSPACE_ID");
              return undefined;
            }
            assert.equal(args.keyRef, "OWNER_ANTHROPIC_KEY");
            return PADDED_KEY;
          } } : {}),
          fetcher: async (_url, init) => {
            calls++;
            wireKey = init.headers["x-api-key"];
            return response(text, transport);
          },
        });
        const answer = step("answer");
        if (source === "resolver") Object.assign(answer.config, { secretSource: "keychain", keyRef: "OWNER_ANTHROPIC_KEY" });
        const m = manifest([answer]);
        const done = await driveRun(createRun(m), { settings: m.settings, store, providers: { anthropic: native } });
        assert.equal(done.status, "success", done.summary);
        assert.equal(calls, 1);
        assert.equal(wireKey, KEY, "the wire credential and redaction credential use the same normalization");
        assert.deepEqual(done.steps[0].output, expected, "safe structure and values survive recursive sanitization");
        assert.deepEqual(store.load(done.runId).steps[0].output, expected);
        assert.equal(Object.getPrototypeOf(done.steps[0].output), Object.prototype);
        assert.equal(Object.hasOwn(done.steps[0].output, "__proto__"), true, "JSON keys must remain own data properties");
        store.saveLastRun(done);
        for (const file of [store.runFile(done.runId), join(store.dir, "last-run.json")]) {
          const saved = await readFile(file, "utf8");
          assert.equal(saved.includes(KEY), false);
          assert.equal(saved.includes(unicode(KEY)), false);
        }
        assert.equal(done.steps[0].costUsd, 0.0003, "redaction preserves actual billed usage");
      });
    }
  }
}

test("Anthropic redaction: normalized credentials are removed from plain text and metadata", async () => {
  const result = await anthropic(request, { env: { ANTHROPIC_API_KEY: PADDED_KEY },
    fetcher: async () => response(`Safe text: ${KEY} and ${KEY}.`, "JSON") });
  assert.equal(result.content, "Safe text: [REDACTED] and [REDACTED].");
  assert.equal(result.requestId, "msg-[REDACTED]");
  assert.equal(JSON.stringify(result).includes(KEY), false);
  assert.equal(result.provider.model, model);
  assert.equal(result.usage.costUsd, 0.0003);
});

test("Anthropic redaction: safe JSON remains intact and subsequent steps receive sanitized decoded output", async () => {
  let calls = 0;
  const native = args => anthropic(args, { env: {}, secretResolver: async args => args.optional ? undefined : KEY,
    fetcher: async (_url, init) => {
      calls++;
      assert.equal(init.body.includes(KEY), false, "decoded secrets must not feed the next request");
      return response(calls === 1 ? `{"${unicode(KEY)}":"${unicode(KEY)}","safe":[false,0,null,"ok"]}`
        : '{"result":"accepted","safe":[false,0,null,"ok"]}', "JSON");
    } });
  const m = manifest([step("first"), step("second")]);
  const done = await driveRun(createRun(m), { settings: m.settings, providers: { anthropic: native } });
  assert.equal(done.status, "success", done.summary);
  assert.equal(calls, 2);
  assert.deepEqual(done.steps[0].output, { "[REDACTED]": "[REDACTED]", safe: [false, 0, null, "ok"] });
  assert.deepEqual(done.steps[1].output, { result: "accepted", safe: [false, 0, null, "ok"] });
});

test("Anthropic redaction: empty normalized or non-string credentials fail without dispatch", async () => {
  let calls = 0;
  for (const key of [" \t\r\n", "", null, 42]) {
    await assert.rejects(anthropic(request, { env: {}, secretResolver: async () => key,
      fetcher: async () => { calls++; return response("Done", "JSON"); } }), { code: "AUTH_REQUIRED" });
  }
  assert.equal(calls, 0);
});

test("Anthropic redaction: invalid JSON failures retain spend without persisting a literal credential excerpt", async t => {
  const directory = await mkdtemp(join(tmpdir(), "q-core-redaction-invalid-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new RunStore(join(directory, "workflow.yaml"));
  const m = manifest([step("invalid")]);
  const done = await driveRun(createRun(m), { settings: m.settings, store, providers: {
    anthropic: args => anthropic(args, { env: { ANTHROPIC_API_KEY: PADDED_KEY },
      fetcher: async () => response(`Invalid JSON ${KEY}`, "JSON") }),
  } });
  assert.equal(done.status, "failed");
  assert.match(done.steps[0].errorText, /format=json/);
  assert.match(done.steps[0].errorText, /\[REDACTED\]/);
  assert.equal(done.steps[0].costUsd, 0.0003);
  assert.equal((await readFile(store.runFile(done.runId), "utf8")).includes(KEY), false);
});
