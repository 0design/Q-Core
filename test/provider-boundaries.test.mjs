import test from "node:test";
import assert from "node:assert/strict";
import { claude } from "../src/providers/claude.mjs";
import { openRouter } from "../src/providers/openrouter.mjs";
import { codex } from "../src/providers/codex.mjs";
import { subprocess } from "../src/subprocess.mjs";

test("Claude bounds direct input and shares one deadline across version probe and inference", async (t) => {
  let fakeNow = 1000;
  t.mock.method(Date, "now", () => fakeNow);
  const calls = [];
  const launch = async (_command, _args, options) => {
    calls.push(options.timeoutMs);
    if (calls.length === 1) {
      fakeNow += 20;
      return { code: 0, stdout: "2.1.156 (Claude Code)", stderr: "" };
    }
    return {
      code: 0,
      stdout: JSON.stringify({ subtype: "success", result: "ok" }),
      stderr: "",
    };
  };
  const result = await claude({
    executable: "/fixture/claude",
    model: "sonnet",
    messages: [{ role: "user", content: "hello" }],
    cwd: "/fixture",
    timeoutMs: 100,
  }, { launch });
  assert.equal(result.content, "ok");
  assert.equal(calls.length, 2);
  assert.deepEqual(calls, [100, 80]);
  await assert.rejects(claude({
    executable: "/fixture/claude",
    model: "sonnet",
    messages: [{ role: "user", content: "x".repeat(128001) }],
    cwd: "/fixture",
  }, { launch: async () => { throw new Error("must not launch"); } }), { code: "INVALID_REQUEST" });
  let authCalls = 0;
  await assert.rejects(claude({
    executable: "/fixture/claude",
    model: "sonnet",
    messages: [{ role: "user", content: "hello" }],
    cwd: "/fixture",
  }, { launch: async () => ++authCalls === 1
    ? { code: 0, stdout: "2.1.156 (Claude Code)", stderr: "" }
    : { code: 1, stdout: "not JSON", stderr: "401 OAuth token expired" } }), { code: "AUTH_REQUIRED" });
});

test("Codex accepts each reviewed CLI version and records the probed version", async () => {
  for (const version of ["0.153.4", "0.154.0-alpha.6.2"]) {
    let calls = 0;
    const result = await codex({
      executable: "/fixture/codex",
      model: "fixture",
      messages: [{ role: "user", content: "hello" }],
      runId: "version-test",
      timeoutMs: 1000,
    }, {
      launch: async () => {
        calls++;
        if (calls === 1) return { code: 0, stdout: `codex-cli ${version}`, stderr: "" };
        if (calls === 2) return { code: 0, stdout: "Logged in using ChatGPT", stderr: "" };
        return { code: 0, stdout: [
          { type: "thread.started", thread_id: "thread" },
          { type: "turn.started" },
          { type: "item.completed", item: { type: "agent_message", text: "ok" } },
          { type: "turn.completed", usage: {} },
        ].map(JSON.stringify).join("\n"), stderr: "" };
      },
    });
    assert.equal(result.provider.version, version);
    assert.equal(calls, 3);
  }
});

test("OpenRouter treats malformed key values and invalid metrics as unknown/failure", async () => {
  const request = {
    messages: [{ role: "user", content: "hello" }],
    model: "test/model",
    payerScope: "local-byok",
    maxTokens: 16,
  };
  let calls = 0;
  await assert.rejects(openRouter(request, {
    env: { OPENROUTER_API_KEY: 42 },
    fetcher: async () => { calls++; return Response.json({}); },
  }), { code: "AUTH_REQUIRED" });
  assert.equal(calls, 0);
  const result = await openRouter(request, {
    env: { OPENROUTER_API_KEY: "fixture" },
    fetcher: async () => Response.json({
      id: "id",
      model: "actual",
      choices: [{ message: { content: "ok" } }],
      usage: { prompt_tokens: -1, completion_tokens: "unknown", cost: Infinity },
    }),
  });
  assert.deepEqual(result.usage, { tokensIn: null, tokensOut: null, costUsd: null });
});

test("subprocess rejects invalid input and output bounds before launch", async () => {
  const run = (options) => subprocess(process.execPath, ["-e", ""], options);
  for (const options of [
    { input: 42 },
    { maxBytes: 0 },
    { maxBytes: NaN },
    { maxBytes: Infinity },
  ]) {
    assert.throws(() => run({ ...options, timeoutMs: 1000 }), { code: "INVALID_REQUEST" });
  }
});
