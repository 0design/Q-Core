import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { validateManifest, ManifestError } from "../src/manifest.mjs";
import { createRun, driveRun } from "../src/run.mjs";

const base = (steps) => validateManifest({
  manifest: "q-core.workflow/v1",
  id: "controls",
  version: "1.0.0",
  steps,
});

test("if selects one bounded branch and does not run the other", async () => {
  const manifest = base([{
    id: "choose",
    kind: "if",
    config: { condition: "true" },
    then: [{ id: "yes", kind: "approval-gate", config: { reviewer: "human" } }],
    else: [{ id: "no", kind: "approval-gate", config: { reviewer: "human" } }],
  }]);
  const run = await driveRun(createRun(manifest));
  assert.equal(run.status, "waiting_human");
  assert.equal(run.steps.some((s) => s.stepId === "yes"), true);
  assert.equal(run.steps.some((s) => s.stepId === "no"), false);
});

test("each resolves an array, records its bound and refuses oversized concurrency", async () => {
  assert.throws(() => base([{
    id: "items", kind: "each", config: { over: "{{steps.source.output.items}}", maxConcurrency: 11 },
    then: [{ id: "hold", kind: "approval-gate", config: { reviewer: "human" } }],
  }, { id: "source", kind: "approval-gate", config: { reviewer: "human" } }]), ManifestError);
  const manifest = base([
    { id: "source", kind: "approval-gate", config: { reviewer: "human" } },
    { id: "items", kind: "each", config: { over: "{{steps.source.output.items}}", maxItems: 2, maxConcurrency: 2 },
      then: [{ id: "hold", kind: "approval-gate", config: { reviewer: "human" } }] },
  ]);
  const run = createRun(manifest);
  run.steps[0].status = "success";
  run.steps[0].output = { items: ["a", "b", "c"] };
  const result = await driveRun(run);
  assert.equal(result.status, "waiting_human");
  assert.equal(result.steps.filter((s) => s.stepId === "hold").length, 2);
  assert.equal(result.steps.find((s) => s.stepId === "items").output.maxConcurrency, 2);
});

test("loop and switch require bounded declarations and own-property case lookup", async () => {
  assert.throws(() => base([{ id: "repeat", kind: "loop", config: { maxIterations: 51 }, then: [] }]), ManifestError);
  assert.throws(() => base([{ id: "route", kind: "switch", config: { on: "true" } }]), ManifestError);
  const withDefault = base([{ id: "route", kind: "switch", config: { on: "constructor" }, cases: {
    news: [{ id: "news", kind: "approval-gate", config: { reviewer: "human" } }],
  }, default: [{ id: "fallback", kind: "approval-gate", config: { reviewer: "human" } }] }]);
  const selected = await driveRun(createRun(withDefault));
  assert.equal(selected.status, "waiting_human");
  assert.equal(selected.steps.some((step) => step.stepId === "fallback"), true);
  const withoutDefault = base([{ id: "route", kind: "switch", config: { on: "toString" }, cases: {
    news: [{ id: "news", kind: "approval-gate", config: { reviewer: "human" } }],
  } }]);
  const rejected = await driveRun(createRun(withoutDefault));
  assert.equal(rejected.status, "failed");
  assert.match(rejected.summary, /no case matches/);
});

test("nested control expansion stays ordered and an oversized expansion stops the run", async () => {
  const nested = base([
    { id: "source", kind: "approval-gate", config: { reviewer: "human" } },
    { id: "choose", kind: "if", config: { condition: "true" }, then: [{
      id: "items", kind: "each", config: { over: "{{steps.source.output.items}}", maxItems: 2 },
      then: [{ id: "hold", kind: "approval-gate", config: { reviewer: "human" } }],
    }] },
  ]);
  const run = createRun(nested);
  run.steps[0].status = "success";
  run.steps[0].output = { items: ["a", "b"] };
  const result = await driveRun(run);
  assert.equal(result.status, "waiting_human");
  assert.equal(result.steps.filter((s) => s.stepId === "hold").length, 2);

  const body = Array.from({ length: 20 }, (_, i) => ({
    id: `body-${i}`, kind: "approval-gate", config: { reviewer: "human" },
  }));
  const oversized = base([
    { id: "repeat", kind: "loop", config: { maxIterations: 50 }, then: body },
    { id: "must-not-run", kind: "approval-gate", config: { reviewer: "human" } },
  ]);
  const stopped = await driveRun(createRun(oversized));
  assert.equal(stopped.status, "failed");
  assert.equal(stopped.steps.find((s) => s.stepId === "must-not-run").status, "pending");
});

test("each plus nested if reaches HTTP in item order and preserves the following sibling", async (t) => {
  const received = [];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    received.push({ path: req.url, body: body ? JSON.parse(body) : null });
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: true }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/item`;
  const manifest = base([
    { id: "source", kind: "approval-gate", config: { reviewer: "human" } },
    { id: "items", kind: "each", config: { over: "{{steps.source.output.items}}", maxItems: 3 }, then: [{
      id: "route", kind: "if", config: { condition: "{{item.send}}" }, then: [{
        id: "send", kind: "api-request", config: { url, body: '{"item":"{{item.name}}"}' },
      }],
    }] },
    { id: "done", kind: "api-request", config: { url, body: '{"item":"done"}' } },
  ]);
  const run = createRun(manifest);
  run.steps[0].status = "success";
  run.steps[0].output = { items: [{ name: "a", send: true }, { name: "b", send: true }, { name: "c", send: true }] };
  const result = await driveRun(run);
  assert.equal(result.status, "success");
  assert.deepEqual(received.map((entry) => entry.body), [{ item: "a" }, { item: "b" }, { item: "c" }, { item: "done" }]);
  assert.deepEqual(received.map((entry) => entry.path), ["/item", "/item", "/item", "/item"]);
});

test("loop executes exactly its declared bounded iterations", async (t) => {
  let calls = 0;
  const server = createServer((req, res) => { calls += 1; res.end("ok"); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/loop`;
  const manifest = base([{ id: "repeat", kind: "loop", config: { maxIterations: 3 }, then: [
    { id: "call", kind: "api-request", config: { url, method: "GET" } },
  ] }]);
  const result = await driveRun(createRun(manifest));
  assert.equal(result.status, "success");
  assert.equal(calls, 3);
});

test("shared insertion allocator keeps nested fan-out rows before the trailing sibling", async (t) => {
  const received = [];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    received.push(body ? JSON.parse(body).item : null);
    res.end("ok");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/nested`;
  const manifest = base([
    { id: "source", kind: "approval-gate", config: { reviewer: "human" } },
    { id: "items", kind: "each", config: { over: "{{steps.source.output.items}}" }, then: [{
      id: "fan", kind: "fan-out", config: { over: "{{item.sub}}", maxItems: 2 }, then: [{
        id: "send", kind: "api-request", config: { url, body: '{"item":"{{item}}"}' },
      }],
    }] },
    { id: "done", kind: "api-request", config: { url, body: '{"item":"done"}' } },
  ]);
  const run = createRun(manifest);
  run.steps[0].status = "success";
  run.steps[0].output = { items: [{ sub: ["x", "y"] }] };
  const result = await driveRun(run);
  assert.equal(result.status, "success");
  assert.deepEqual(received, ["x", "y", "done"]);
});

test("driver cancellation reaches an in-flight HTTP step and records cancelled", async (t) => {
  const server = createServer(() => {});
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.closeAllConnections() || server.close(resolve)));
  const manifest = base([{ id: "fetch", kind: "fetch", config: { url: `http://127.0.0.1:${server.address().port}/hang` } }]);
  const run = createRun(manifest);
  const abort = new AbortController();
  const pending = driveRun(run, { signal: abort.signal });
  setTimeout(() => abort.abort(), 20);
  const result = await pending;
  assert.equal(result.status, "cancelled");
  assert.equal(result.steps[0].errorText, "Run cancelled.");
});

test("nested expansions honor the total 10,000-row bound before insertion", async () => {
  const manifest = base([{
    id: "outer", kind: "loop", config: { maxIterations: 20 }, then: [{
      id: "middle", kind: "loop", config: { maxIterations: 20 }, then: [{
        id: "inner", kind: "loop", config: { maxIterations: 30 }, then: [
          { id: "leaf", kind: "approval-gate", config: { reviewer: "human" } },
        ],
      }],
    }],
  }, { id: "trailing", kind: "approval-gate", config: { reviewer: "human" } }]);
  const result = await driveRun(createRun(manifest), { dryRun: true });
  assert.equal(result.status, "failed");
  assert.match(result.summary, /expanded run row limit 10000/);
  assert.ok(result.steps.length <= 10000);
  assert.equal(result.steps.find((step) => step.stepId === "trailing").status, "pending");
});
