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
const call = (response, overrides, options) => anthropic(request(overrides), {
  env: { ANTHROPIC_API_KEY: ` \t${KEY}\r\n ` }, fetcher: async () => response, ...options,
});
const assertPrivate = error => {
  const diagnostic = `${error.stack}\n${JSON.stringify(error)}`;
  for (const value of [KEY, WORKSPACE, unicode(KEY), unicode(WORKSPACE)])
    assert.equal(diagnostic.includes(value), false, "credentials and workspace IDs must not reach diagnostics");
};

for (const [status, code, generic, type] of [
  [400, "PROVIDER_ERROR", "request failed", "invalid_request_error"],
  [401, "AUTH_REQUIRED", "invalid or revoked key", "authentication_error"],
  [403, "AUTH_REQUIRED", "invalid or revoked key", "permission_error"],
  [429, "RATE_LIMITED", "request failed", "rate_limit_error"],
  [500, "PROVIDER_ERROR", "request failed", "api_error"],
]) {
  test(`Anthropic error detail: JSON ${status} retains safe error type and message`, async () => {
    await assert.rejects(call(Response.json({ type: "error", error: { type, message: "Use thinking between_tools." } }, { status })), error => {
      assert.equal(error.code, code);
      assert.equal(error.status, status);
      assert.equal(error.message, `Anthropic ${status} — ${generic}: ${type}: Use thinking between_tools.`);
      assert.equal(error.usage, undefined, "an HTTP rejection remains unbilled");
      assertPrivate(error);
      return true;
    });
  });
}

for (const encoding of ["literal", "mixed Unicode", "all Unicode"]) {
  test(`Anthropic error detail: ${encoding} credentials in both fields are redacted after JSON decoding`, async () => {
    const envelope = JSON.stringify({ error: {
      type: `invalid_request_error ${KEY} ${WORKSPACE}`,
      message: `Rejected ${KEY} in ${WORKSPACE}; ${KEY} / ${WORKSPACE}.`,
    } });
    const encode = value => encoding === "literal" ? value
      : encoding === "mixed Unicode" ? `\\u${value.charCodeAt(0).toString(16).padStart(4, "0")}${value.slice(1)}` : unicode(value);
    const body = envelope.split(KEY).join(encode(KEY)).split(WORKSPACE).join(encode(WORKSPACE));
    await assert.rejects(call(new Response(body, { status: 400, headers: { "content-type": "application/json" } })), error => {
      assert.equal(error.message, "Anthropic 400 — request failed: invalid_request_error [REDACTED] [REDACTED]: Rejected [REDACTED] in [REDACTED]; [REDACTED] / [REDACTED].");
      assertPrivate(error);
      return true;
    });
  });
}

test("Anthropic error detail: environment workspace ID is redacted", async () => {
  await assert.rejects(call(Response.json({ error: { type: "invalid_request_error", message: `${WORKSPACE} ${KEY}` } }, { status: 400 }),
    { workspaceId: undefined }, { env: { ANTHROPIC_API_KEY: KEY, ANTHROPIC_WORKSPACE_ID: ` ${WORKSPACE} ` } }), error => {
    assert.equal(error.message, "Anthropic 400 — request failed: invalid_request_error: [REDACTED] [REDACTED]");
    assertPrivate(error);
    return true;
  });
});

test("Anthropic error detail: the diagnostic is a single line", async () => {
  await assert.rejects(call(Response.json({ error: { type: "invalid\r\nrequest\u2028error", message: "first\rsecond\nthird\u2028fourth\u2029last" } }, { status: 400 })), error => {
    assert.match(error.message, /invalid request error: first second third fourth last$/);
    assert.doesNotMatch(error.message, /[\r\n\u2028\u2029]/);
    return true;
  });
});

for (const longField of ["type", "message"]) {
  test(`Anthropic error detail: long ${longField} is capped after redaction`, async () => {
    const errorFields = { type: "invalid_request_error", message: "Rejected." };
    errorFields[longField] = `${KEY} ${WORKSPACE} ${"x".repeat(1000)}`;
    await assert.rejects(call(Response.json({ error: errorFields }, { status: 400 })), error => {
      assert.equal(error.message.length, 300, "the full diagnostic, including its prefix, has a 300-character cap");
      assert.match(error.message, /^Anthropic 400 — request failed: /);
      assert.match(error.message, /\[REDACTED\]/);
      assertPrivate(error);
      return true;
    });
  });
}

test("Anthropic error detail: redaction precedes truncation when a credential crosses the cap", async () => {
  const prefix = "Anthropic 400 — request failed: invalid_request_error: ";
  const filler = "x".repeat(285 - prefix.length);
  await assert.rejects(call(Response.json({ error: { type: "invalid_request_error", message: `${filler}${KEY}${"z".repeat(1000)}` } }, { status: 400 })), error => {
    assert.equal(error.message.length, 300);
    assert.match(error.message, /\[REDACTED\]/);
    assert.equal(error.message.includes(KEY.slice(0, 10)), false, "truncation must not leave a partial credential echo");
    assertPrivate(error);
    return true;
  });
});

test("Anthropic error detail: headers, envelope metadata and request content are never copied", async () => {
  const excluded = ["private-status-text", "private-response-header", "private-request-id", "private-envelope-content", "private-nested-error", "private-system-content", "private-user-content"];
  const response = Response.json({ request_id: excluded[2], content: excluded[3], error: {
    type: "invalid_request_error", message: "Safe error message.", request: excluded[4],
  } }, { status: 400, statusText: excluded[0], headers: { "x-private-header": excluded[1] } });
  await assert.rejects(call(response), error => {
    assert.equal(error.message, "Anthropic 400 — request failed: invalid_request_error: Safe error message.");
    const diagnostic = `${error.stack}\n${JSON.stringify(error)}`;
    for (const value of excluded) assert.equal(diagnostic.includes(value), false);
    assertPrivate(error);
    return true;
  });
});

for (const content of ["private-system-content", "private-user-content"]) {
  test(`Anthropic error detail: an echoed ${content.startsWith("private-system") ? "system" : "user"} message drops the detail`, async () => {
    await assert.rejects(call(Response.json({ error: { type: "invalid_request_error", message: `Rejected request: ${content}` } }, { status: 400 })), error => {
      assert.equal(error.message, "Anthropic 400 — request failed");
      assert.equal(`${error.stack}\n${JSON.stringify(error)}`.includes(content), false);
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

for (const [index, errorValue] of [null, {}, { type: 42, message: [KEY, WORKSPACE] }, { type: { message: KEY }, message: { detail: WORKSPACE } }].entries()) {
  test(`Anthropic error detail: non-string or absent error fields are not serialized (case ${index + 1})`, async () => {
    await assert.rejects(call(Response.json({ error: errorValue }, { status: 400 })), error => {
      assert.equal(error.message, "Anthropic 400 — request failed");
      assertPrivate(error);
      return true;
    });
  });
}
