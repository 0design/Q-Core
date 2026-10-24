import { test } from "node:test";
import assert from "node:assert/strict";
import { anthropic } from "../src/providers/anthropic.mjs";

const request = overrides => ({
  model: "claude-haiku-4-5", payerScope: "local-byok",
  messages: [{ role: "user", content: "Hello" }],
  maxTokens: 100, timeoutMs: 1000, retries: 2, delaysMs: [0], ...overrides,
});
const options = { env: { ANTHROPIC_API_KEY: "sk-ant-cancellation-fixture" } };
const completion = () => Response.json({
  id: "msg-cancellation-review", model: "claude-haiku-4-5", stop_reason: "end_turn",
  content: [{ type: "text", text: "Done" }], usage: { input_tokens: 100, output_tokens: 10 },
});
const rejection = (status, cancel) => ({
  ok: false, status, headers: new Headers(),
  body: { cancel, getReader() { assert.fail("rejected bodies must not be consumed"); } },
});

// A referenced watchdog also keeps AbortSignal.timeout alive in isolated tests.
// Against the regression, this fails promptly instead of leaving a hanging test.
async function bounded(promise) {
  let watchdog;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      watchdog = setTimeout(() => reject(new Error("error-body cancellation exceeded its bound")), 750);
    })]);
  } finally { clearTimeout(watchdog); }
}

for (const [status, retries] of [[401, 2], [429, 2], [503, 0]]) {
  test(`Anthropic cancellation review: hanging ${status} error-body disposal respects the attempt deadline`, async () => {
    let calls = 0, cancellations = 0;
    await assert.rejects(bounded(anthropic(request({ timeoutMs: 25, retries }), {
      ...options,
      fetcher: async () => {
        calls++;
        return rejection(status, () => { cancellations++; return new Promise(() => {}); });
      },
    })), error => {
      assert.equal(error.code, "TIMEOUT");
      assert.equal(error.usage, undefined, "rejection headers prove that this attempt was not billed");
      return true;
    });
    assert.equal(calls, 1, "timed-out disposal must not replay a rejected POST");
    assert.equal(cancellations, 1);
  });
}

for (const status of [401, 429]) {
  test(`Anthropic cancellation review: external abort bounds hanging ${status} error-body disposal`, async () => {
    const controller = new AbortController();
    let calls = 0, abortTimer;
    try {
      await assert.rejects(bounded(anthropic(request({ signal: controller.signal }), {
        ...options,
        fetcher: async () => {
          calls++;
          return rejection(status, () => {
            abortTimer = setTimeout(() => controller.abort(), 25);
            return new Promise(() => {});
          });
        },
      })), error => {
        assert.equal(error.code, "CANCELLED");
        assert.equal(error.usage, undefined);
        return true;
      });
      assert.equal(calls, 1);
    } finally { clearTimeout(abortTimer); }
  });
}

for (const [name, cancel] of [
  ["resolved cancellation", () => Promise.resolve()],
  ["rejected cancellation", () => Promise.reject(new Error("injected disposal error"))],
  ["synchronous cancellation failure", () => { throw new Error("injected synchronous disposal error"); }],
  ["synchronous cancellation completion", () => undefined],
]) {
  test(`Anthropic cancellation review: ${name} preserves allowed rejection retries`, async () => {
    let calls = 0, cancellations = 0;
    const result = await bounded(anthropic(request(), {
      ...options,
      fetcher: async () => ++calls === 1
        ? rejection(429, () => { cancellations++; return cancel(); }) : completion(),
    }));
    assert.equal(calls, 2);
    assert.equal(cancellations, 1);
    assert.equal(result.content, "Done");
    assert.equal(result.usage.costUsd, 0.00015);
    assert.equal(result.usage.billingUnknown, undefined);
  });
}

for (const [status, expected] of [[401, "AUTH_REQUIRED"], [429, "RATE_LIMITED"], [503, "PROVIDER_ERROR"]]) {
  test(`Anthropic cancellation review: completed ${status} error-body disposal preserves final status`, async () => {
    let calls = 0, cancellations = 0;
    await assert.rejects(bounded(anthropic(request({ retries: 0 }), {
      ...options,
      fetcher: async () => {
        calls++;
        return rejection(status, () => { cancellations++; return Promise.resolve(); });
      },
    })), error => {
      assert.equal(error.code, expected);
      assert.equal(error.usage, undefined);
      return true;
    });
    assert.equal(calls, 1);
    assert.equal(cancellations, 1);
  });
}
