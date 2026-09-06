import { test } from "node:test";
import assert from "node:assert/strict";
import { fetchWithRetry, chatOnce } from "../src/steps.mjs";

const instant = { retries: 2, delaysMs: [0, 0], timeoutMs: 50 };

function ok(status = 200, body = '{"choices":[{"message":{"content":"hi"}}]}') {
  return new Response(body, { status, headers: { "content-type": "application/json" } });
}

function withFetch(fn, work) {
  const orig = globalThis.fetch;
  globalThis.fetch = fn;
  return work().finally(() => {
    globalThis.fetch = orig;
  });
}

test("fetchWithRetry: network fail then succeed", async () => {
  let n = 0;
  await withFetch(async () => {
    n += 1;
    if (n === 1) throw new TypeError("fetch failed");
    return ok();
  }, async () => {
    const res = await fetchWithRetry("https://example.test/rss", {}, instant);
    assert.equal(res.status, 200);
    assert.equal(n, 2);
  });
});

test("fetchWithRetry: 503 then succeed", async () => {
  let n = 0;
  await withFetch(async () => {
    n += 1;
    return n === 1 ? ok(503, "busy") : ok();
  }, async () => {
    const res = await fetchWithRetry("https://example.test/rss", {}, instant);
    assert.equal(res.status, 200);
    assert.equal(n, 2);
  });
});

test("fetchWithRetry: 401 fails immediately", async () => {
  let n = 0;
  await withFetch(async () => {
    n += 1;
    return ok(401, "nope");
  }, async () => {
    const res = await fetchWithRetry("https://example.test/rss", {}, instant);
    assert.equal(res.status, 401);
    assert.equal(n, 1);
  });
});

test("fetchWithRetry: persistent network fail exhausts retries", async () => {
  let n = 0;
  await withFetch(async () => {
    n += 1;
    throw new TypeError("fetch failed");
  }, async () => {
    await assert.rejects(
      () => fetchWithRetry("https://example.test/rss", {}, instant),
      /fetch failed/,
    );
    assert.equal(n, 3);
  });
});

test("fetchWithRetry: timeout then succeed", async () => {
  let n = 0;
  await withFetch(async () => {
    n += 1;
    if (n === 1) {
      const e = new Error("The operation was aborted due to timeout");
      e.name = "TimeoutError";
      throw e;
    }
    return ok();
  }, async () => {
    const res = await fetchWithRetry("https://example.test/rss", {}, instant);
    assert.equal(res.status, 200);
    assert.equal(n, 2);
  });
});

test("chatOnce: no network becomes explicit failure after retries", async () => {
  let n = 0;
  await withFetch(async () => {
    n += 1;
    throw new TypeError("fetch failed");
  }, async () => {
    await assert.rejects(
      () =>
        chatOnce({
          apiKey: "sk-test",
          model: "test/model",
          system: "s",
          user: "u",
          maxTokens: 16,
          retries: 2,
          delaysMs: [0, 0],
        }),
      /OpenRouter unreachable/,
    );
    assert.equal(n, 3);
  });
});
