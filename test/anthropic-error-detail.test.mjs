import { test } from "node:test";
import assert from "node:assert/strict";
import { anthropic } from "../src/providers/anthropic.mjs";

// Synthetic fixtures only; every response and fetcher is injected.
const KEY = "sk-ant-error-detail-fixture";
const WORKSPACE = "workspace-error-detail-fixture";
const request = overrides => ({
  model: "claude-sonnet-5-5", payerScope: "local-byok", maxTokens: 100,
  timeoutMs: 1000, retries: 0, workspaceId: ` ${WORKSPACE} `,
  messages: [{ role: "system", content: "private-system-content" },
    { role: "user", content: "private-user-content" }], ...overrides,
});
const unicode = value => [...value].map(char => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`).join("");
const nulInterleaved = value => [...value].join("\u0000");
const call = (response, overrides, options) => anthropic(request(overrides), {
  env: { ANTHROPIC_API_KEY: ` \t${KEY}\r\n ` }, fetcher: async () => response, ...options,
});
const assertPrivate = error => {
  const diagnostic = `${error.stack}\n${JSON.stringify(error)}`;
  const forbidden = [KEY, WORKSPACE, unicode(KEY), unicode(WORKSPACE), nulInterleaved(KEY), nulInterleaved(WORKSPACE),
    KEY.slice(0, 14), WORKSPACE.slice(0, 20), "private-system", "private-user"];
  for (const value of forbidden) {
    assert.equal(diagnostic.includes(value), false, "credentials, workspace IDs and request fragments must not reach diagnostics");
    assert.equal(diagnostic.includes(JSON.stringify(value).slice(1, -1)), false,
      "serialized diagnostics must not expose escaped private values");
  }
};

for (const [status, code, generic, type] of [
  [400, "PROVIDER_ERROR", "request failed", "invalid_request_error"],
  [401, "AUTH_REQUIRED", "invalid or revoked key", "authentication_error"],
  [403, "AUTH_REQUIRED", "invalid or revoked key", "permission_error"],
  [429, "RATE_LIMITED", "request failed", "rate_limit_error"],
  [500, "PROVIDER_ERROR", "request failed", "api_error"],
]) {
  test(`Anthropic error detail: JSON ${status} retains only the safe error type`, async () => {
    await assert.rejects(call(Response.json({ type: "error", error: { type, message: "Use thinking between_tools." } }, { status })), error => {
      assert.equal(error.code, code);
      assert.equal(error.status, status);
      assert.equal(error.message, `Anthropic ${status} — ${generic}: ${type}`);
      assert.equal(error.usage, undefined, "an HTTP rejection remains unbilled");
      assert.equal(`${error.stack}\n${JSON.stringify(error)}`.includes("Use thinking between_tools."), false,
        "even benign API message text must not reach diagnostics");
      assertPrivate(error);
      return true;
    });
  });
}

for (const type of ["a", `a${"_".repeat(63)}`]) {
  test(`Anthropic error detail: a ${type.length}-character safe type needs no message field`, async () => {
    await assert.rejects(call(Response.json({ error: { type } }, { status: 400 })), error => {
      assert.equal(error.message, `Anthropic 400 — request failed: ${type}`);
      assertPrivate(error);
      return true;
    });
  });
}

test("Anthropic error detail: an API message containing the environment workspace ID is omitted", async () => {
  await assert.rejects(call(Response.json({ error: { type: "invalid_request_error", message: `${WORKSPACE} ${KEY}` } }, { status: 400 }),
    { workspaceId: undefined }, { env: { ANTHROPIC_API_KEY: KEY, ANTHROPIC_WORKSPACE_ID: ` ${WORKSPACE} ` } }), error => {
    assert.equal(error.message, "Anthropic 400 — request failed: invalid_request_error");
    assertPrivate(error);
    return true;
  });
});

for (const [name, message] of [
  ["literal credentials", `Rejected ${KEY} in ${WORKSPACE}.`],
  ["Unicode-escaped credentials", `${unicode(KEY)} ${unicode(WORKSPACE)}`],
  ["NUL-interleaved credentials", `${nulInterleaved(KEY)} ${nulInterleaved(WORKSPACE)}`],
  ["partial credentials and request fragments", `${KEY.slice(0, 14)} ${WORKSPACE.slice(0, 20)} private-system private-user`],
  ["line breaks", "first\rsecond\nthird\u2028fourth\u2029last"],
  ["long text", `${"x".repeat(240)}${KEY}${WORKSPACE}${"z".repeat(1000)}`],
  ["non-string text", { detail: KEY, workspace: WORKSPACE }],
]) {
  test(`Anthropic error detail: API message with ${name} never enters diagnostics`, async () => {
    await assert.rejects(call(Response.json({ error: { type: "invalid_request_error", message } }, { status: 400 })), error => {
      assert.equal(error.message, "Anthropic 400 — request failed: invalid_request_error");
      const diagnostic = `${error.stack}\n${JSON.stringify(error)}`;
      assert.equal(diagnostic.includes(typeof message === "string" ? message : JSON.stringify(message)), false);
      assertPrivate(error);
      return true;
    });
  });
}

for (const [name, value] of [["key", KEY], ["workspace ID", WORKSPACE]]) {
  for (const encoding of ["literal", "mixed Unicode", "all Unicode", "NUL-interleaved"]) {
    test(`Anthropic error detail: a type containing ${encoding} ${name} stays generic`, async () => {
      const type = encoding === "NUL-interleaved" ? nulInterleaved(value) : `invalid_request_error_${value}`;
      assert.ok(type.length <= 64, "these fixtures must exercise forbidden characters independently of the length limit");
      let body = JSON.stringify({ error: { type, message: "Use thinking between_tools." } });
      if (encoding === "mixed Unicode") body = body.replace(value,
        `\\u${value.charCodeAt(0).toString(16).padStart(4, "0")}${value.slice(1)}`);
      if (encoding === "all Unicode") body = body.replace(value, unicode(value));
      assert.equal(JSON.parse(body).error.type, type, "Unicode escapes must decode before type validation");
      await assert.rejects(call(new Response(body, { status: 400, headers: { "content-type": "application/json" } })), error => {
        assert.equal(error.message, "Anthropic 400 — request failed");
        assert.equal(error.usage, undefined);
        assertPrivate(error);
        return true;
      });
    });
  }
}

for (const [name, type] of [
  ["empty", ""], ["spaces", "invalid request error"], ["leading space", " api_error"], ["trailing space", "api_error "],
  ["newline", "invalid\nrequest_error"], ["trailing newline", "api_error\n"],
  ["carriage return", "api_error\r"], ["U+2028", "invalid\u2028request_error"], ["trailing U+2028", "api_error\u2028"],
  ["uppercase", "Invalid_request_error"], ["65 characters", "a".repeat(65)],
  ["number", 42], ["null", null], ["boolean", true], ["array", [KEY, WORKSPACE]],
  ["object", { message: KEY, workspace: WORKSPACE }], ["missing", undefined],
]) {
  test(`Anthropic error detail: ${name} type keeps the generic diagnostic`, async () => {
    await assert.rejects(call(Response.json({ error: { type, message: "Use thinking between_tools." } }, { status: 400 })), error => {
      assert.equal(error.message, "Anthropic 400 — request failed");
      assert.equal(error.usage, undefined);
      assertPrivate(error);
      return true;
    });
  });
}

test("Anthropic error detail: headers, envelope metadata and request content are never copied", async () => {
  const excluded = ["private-status-text", "private-response-header", "private-request-id", "private-envelope-content", "private-nested-error", "private-system-content", "private-user-content"];
  const response = Response.json({ request_id: excluded[2], content: excluded[3], error: {
    type: "invalid_request_error", message: "Safe error message.", request: excluded[4],
  } }, { status: 400, statusText: excluded[0], headers: { "x-private-header": excluded[1] } });
  await assert.rejects(call(response), error => {
    assert.equal(error.message, "Anthropic 400 — request failed: invalid_request_error");
    const diagnostic = `${error.stack}\n${JSON.stringify(error)}`;
    for (const value of [...excluded, "Safe error message."]) assert.equal(diagnostic.includes(value), false);
    assertPrivate(error);
    return true;
  });
});

for (const content of ["private-system-content", "private-user-content"]) {
  test(`Anthropic error detail: an echoed ${content.startsWith("private-system") ? "system" : "user"} message is omitted`, async () => {
    await assert.rejects(call(Response.json({ error: { type: "invalid_request_error", message: `Rejected request: ${content}` } }, { status: 400 })), error => {
      assert.equal(error.message, "Anthropic 400 — request failed: invalid_request_error");
      assert.equal(`${error.stack}\n${JSON.stringify(error)}`.includes(content), false);
      assertPrivate(error);
      return true;
    });
  });
}

for (const cancellation of ["attempt timeout", "caller abort"]) {
  test(`Anthropic error detail: a hanging final JSON reader obeys ${cancellation}`, async () => {
    let calls = 0, reads = 0, cancelled = 0, abortTimer, watchdogTimer;
    const controller = new AbortController();
    const response = {
      ok: false, status: 400, headers: new Headers({ "content-type": "application/json" }),
      body: {
        getReader: () => ({
          read() { reads++; return new Promise(() => {}); },
          async cancel() { cancelled++; },
          releaseLock() {},
        }),
        async cancel() { cancelled++; },
      },
    };
    if (cancellation === "caller abort") abortTimer = setTimeout(() => controller.abort(new Error(`${KEY} ${WORKSPACE}`)), 25);
    // AbortSignal.timeout is unref'ed. This watchdog both keeps the test live
    // and fails a regression promptly instead of leaving an unresolved test.
    const watchdog = new Promise((_, reject) => {
      watchdogTimer = setTimeout(() => reject(new Error("final JSON reader did not stop")), 1000);
    });
    try {
      await assert.rejects(Promise.race([call(response, {
        timeoutMs: cancellation === "attempt timeout" ? 25 : 1000,
        ...(cancellation === "caller abort" ? { signal: controller.signal } : {}),
      }, { fetcher: async () => { calls++; return response; } }), watchdog]), error => {
        assert.equal(error.code, cancellation === "attempt timeout" ? "TIMEOUT" : "CANCELLED");
        assert.equal(error.usage, undefined, "a rejected HTTP request is not billed when reading its diagnostic fails");
        assertPrivate(error);
        return true;
      });
      assert.equal(calls, 1);
      assert.equal(reads, 1);
      assert.equal(cancelled, 1);
    } finally {
      clearTimeout(abortTimer);
      clearTimeout(watchdogTimer);
    }
  });
}

for (const [name, body, contentType] of [
  ["plain text", `${KEY} ${WORKSPACE} private-error-body`, "text/plain"],
  ["HTML", `<html>${KEY} ${WORKSPACE}</html>`, "text/html"],
  ["JSON under a non-JSON content-type", JSON.stringify({ error: { type: "api_error", message: `${KEY} ${WORKSPACE}` } }), "text/plain"],
  ["JSON under text/plain with a JSON-looking parameter", JSON.stringify({ error: { type: "api_error", message: "x" } }), 'text/plain; note="application/json"'],
  ["JSON under a media type that only contains json", JSON.stringify({ error: { type: "api_error", message: "x" } }), "application/jsonp"],
  ["malformed JSON", `{"error":{"message":"${KEY} ${WORKSPACE}"`, "application/json"],
]) {
  test(`Anthropic error detail: ${name} keeps the generic diagnostic`, async () => {
    await assert.rejects(call(new Response(body, { status: 400, headers: { "content-type": contentType } })), error => {
      assert.equal(error.code, "PROVIDER_ERROR");
      assert.equal(error.status, 400);
      assert.equal(error.message, "Anthropic 400 — request failed");
      assertPrivate(error);
      return true;
    });
  });
}

for (const [index, errorValue] of [null, undefined, {}, KEY, [WORKSPACE]].entries()) {
  test(`Anthropic error detail: an absent or invalid error envelope is not serialized (case ${index + 1})`, async () => {
    await assert.rejects(call(Response.json({ error: errorValue }, { status: 400 })), error => {
      assert.equal(error.message, "Anthropic 400 — request failed");
      assertPrivate(error);
      return true;
    });
  });
}
