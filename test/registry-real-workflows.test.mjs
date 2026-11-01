// Registry workflows that send data: a person approves the exact thing that is sent, before it is sent.
// Offline: every network call is answered by a local stub of globalThis.fetch (no paid model, no real receiver).
// The human decision itself is never simulated through resumeRun; the post-approval body is resolved from the
// gate's own output with the same template functions the api-request step uses.
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { loadManifest } from "../src/manifest.mjs";
import { loadWorkflow } from "../src/workflow-policy.mjs";
import { createRun, driveRun } from "../src/run.mjs";
import { resolveTemplateDeep } from "../src/template.mjs";

const file = (id) => fileURLToPath(new URL(`../registry/workflows/${id}.yaml`, import.meta.url));
const SENDING = ["content-feed", "feed-fanout", "release-watch", "webhook-relay", "json-digest", "brand-mentions", "price-watch", "content-factory"];

const RSS = `<?xml version="1.0"?><rss version="2.0"><channel><title>Feed</title>
<item><title>First headline</title><link>https://news.example.com/1</link><description>One</description></item>
<item><title>Second headline</title><link>https://news.example.com/2</link><description>Two</description></item>
</channel></rss>`;

function stubNetwork({ model = () => "Model text", source = RSS, contentType = "application/rss+xml" } = {}) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const target = String(url);
    calls.push({ url: target, method: init.method ?? "GET", body: init.body });
    if (target.startsWith("https://openrouter.ai/")) {
      const request = JSON.parse(init.body);
      const content = model(request);
      return new Response(JSON.stringify({ id: "stub", model: request.model, choices: [{ message: { content } }], usage: { prompt_tokens: 10, completion_tokens: 10 } }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (target.startsWith("https://source.example.com/") || target.startsWith("https://open.er-api.com/")) {
      return new Response(source, { status: 200, headers: { "content-type": contentType } });
    }
    return new Response("ok", { status: 200 });
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

const ENV = { QCORE_SOURCE_URL: "https://source.example.com/feed", QCORE_WEBHOOK_URL: "https://receiver.example.com/hook", TELEGRAM_BOT_TOKEN: "test-token", TELEGRAM_CHAT_ID: "-100", OPENROUTER_MODEL: "openai/gpt-4o-mini" };
async function runUntilStop(id, network, inputs = {}) {
  const saved = {};
  for (const [k, v] of Object.entries(ENV)) { saved[k] = process.env[k]; process.env[k] = v; }
  try {
    const manifest = loadManifest(file(id));
    return await driveRun(createRun(manifest, { inputs }), { apiKey: "test-key", settings: manifest.settings });
  } finally {
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
    network.restore();
  }
}
const sends = (calls) => calls.filter((c) => !c.url.startsWith("https://openrouter.ai/") && !c.url.startsWith("https://source.example.com/") && !c.url.startsWith("https://open.er-api.com/"));
const gateRow = (run) => run.steps.find((s) => s.status === "waiting_human");
function contextAfter(run) {
  const priorOutputs = {}, priorStepNames = {};
  for (const s of run.steps) if ((s.status === "success" || s.status === "waiting_human") && s.output != null) { priorOutputs[s.stepId] = s.output; priorStepNames[s.stepId] = s.name; }
  return { priorOutputs, priorStepNames, inputs: run.inputs ?? {}, run: { id: run.runId, workflowId: run.templateId, costUsd: 0 } };
}
function bodyAfterApproval(run, sendStepId) {
  const step = run.steps.find((s) => s.stepId === sendStepId) ?? loadManifest(file(run.templateId)).steps.find((s) => s.id === sendStepId);
  const ctx = contextAfter(run);
  const gate = gateRow(run);
  if (!step.config.body) return { runId: run.runId, templateId: run.templateId, payload: gate.output };
  return resolveTemplateDeep(JSON.parse(step.config.body), { ...ctx, item: gate.item, index: gate.itemIndex });
}

test("every sending Registry workflow passes the created-workflow policy: a human gate before each send", () => {
  for (const id of SENDING) assert.doesNotThrow(() => loadWorkflow(file(id)), id);
});

for (const [id, sendId] of [["content-feed", "cf-send"], ["release-watch", "rw-send"], ["brand-mentions", "bm-send"]]) {
  test(`${id}: nothing is sent before the gate, and the sent text is exactly the approved text`, async () => {
    const network = stubNetwork({ model: () => "Exact approved text" });
    const run = await runUntilStop(id, network, id === "brand-mentions" ? { brand: "Acme" } : {});
    assert.equal(run.status, "waiting_human");
    assert.equal(sends(network.calls).length, 0, "no outgoing request before the person decides");
    const gate = gateRow(run);
    assert.equal(gate.output.subject.text, "Exact approved text");
    assert.match(gate.output.approvalHash, /^[a-f0-9]{64}$/, "the approval is bound to the exact subject");
    const body = bodyAfterApproval(run, sendId);
    assert.equal(body.text, "Exact approved text");
  });
}

test("brand-mentions: the brand is an explicit input that reaches the model, and a run without it is refused", async () => {
  const seen = [];
  const network = stubNetwork({ model: (request) => { seen.push(JSON.stringify(request.messages)); return "No mentions today."; } });
  await runUntilStop("brand-mentions", network, { brand: "Acme Robotics" });
  assert.ok(seen.some((m) => m.includes("The brand is: Acme Robotics")), "the model is told which brand to look for");
  assert.throws(() => createRun(loadManifest(file("brand-mentions")), { inputs: {} }), /inputs\.brand: required input is missing/);
  assert.deepEqual(loadManifest(file("brand-mentions")).triggers.map((t) => t.kind), ["manual"], "no schedule that would run without a brand");
});

test("json-digest: the person approves the exact JSON and the titles reach the receiver as a JSON array", async () => {
  const shaped = { count: 2, titles: ["First headline", "Second headline"] };
  const network = stubNetwork({ model: () => JSON.stringify(shaped) });
  const run = await runUntilStop("json-digest", network);
  assert.equal(run.status, "waiting_human");
  assert.equal(sends(network.calls).length, 0);
  assert.deepEqual(gateRow(run).output.subject, shaped);
  const envelope = bodyAfterApproval(run, "jd-send");
  assert.deepEqual(envelope.payload.subject.titles, shaped.titles, "titles are an array, not text inside a string");
  assert.equal(envelope.payload.approvalHash, gateRow(run).output.approvalHash);
});

test("webhook-relay: the person approves the fetched JSON and it is forwarded as JSON", async () => {
  const data = { status: "green", items: [1, 2, 3] };
  const network = stubNetwork({ source: JSON.stringify(data), contentType: "application/json" });
  const run = await runUntilStop("webhook-relay", network);
  assert.equal(run.status, "waiting_human");
  assert.equal(sends(network.calls).length, 0);
  const envelope = bodyAfterApproval(run, "wr-send");
  assert.deepEqual(envelope.payload.subject.json, data, "the data stays JSON");
  assert.equal(typeof envelope.payload.subject.json.items, "object");
});

test("feed-fanout: each item's sentence is approved inside its lane before that item is sent", async () => {
  const network = stubNetwork({ model: () => "One sentence." });
  const run = await runUntilStop("feed-fanout", network);
  assert.equal(run.status, "waiting_human");
  assert.equal(sends(network.calls).length, 0);
  const gate = gateRow(run);
  assert.equal(gate.stepId, "ff-approve");
  assert.equal(gate.output.subject.text, "One sentence.");
  const body = bodyAfterApproval(run, "ff-send");
  assert.equal(body.take, "One sentence.");
  assert.equal(body.title, "First headline");
});

test("price-watch: an ordinary day stops quietly at the check; nobody is asked and nothing is sent", async () => {
  const network = stubNetwork({ source: JSON.stringify({ rates: { UAH: 41.2 } }), contentType: "application/json",
    model: () => JSON.stringify({ pass: false, reason: "USD/UAH is 41.2, below the 42.0 threshold" }) });
  const run = await runUntilStop("price-watch", network);
  assert.notEqual(run.status, "waiting_human", "an ordinary day does not wake a person");
  const check = run.steps.find((s) => s.stepId === "pw-judge");
  assert.equal(check.status, "failed");
  assert.match(check.errorText, /did not pass — USD\/UAH is 41\.2/, "the run ends at the check with the rate in the reason");
  assert.equal(run.steps.some((s) => s.status === "waiting_human"), false);
  assert.equal(run.steps.find((s) => s.stepId === "pw-confirm")?.status ?? "pending", "pending");
  assert.equal(sends(network.calls).length, 0);
});

test("price-watch: above the threshold the person sees the rate and approves exactly the alert that is sent", async () => {
  const reason = "USD/UAH is 42.35, above the 42.0 threshold";
  const network = stubNetwork({ source: JSON.stringify({ rates: { UAH: 42.35 } }), contentType: "application/json",
    model: () => JSON.stringify({ pass: true, reason }) });
  const run = await runUntilStop("price-watch", network);
  assert.equal(run.status, "waiting_human");
  assert.equal(gateRow(run).stepId, "pw-confirm");
  assert.equal(gateRow(run).output.subject.verdict.reason, reason);
  assert.equal(sends(network.calls).length, 0);
  assert.equal(bodyAfterApproval(run, "pw-send").text, `Rate alert — ${reason}`);
});

test("content-factory: publishing waits for the person; nothing goes to Telegram before the decision", async () => {
  const network = stubNetwork({ source: JSON.stringify({ material: "x" }), contentType: "application/json",
    model: (request) => /validation gate/.test(JSON.stringify(request.messages)) ? JSON.stringify({ pass: true, reason: "ok" }) : "Post text" });
  const run = await runUntilStop("content-factory", network);
  assert.equal(run.status, "waiting_human");
  assert.equal(gateRow(run).stepId, "cf-approve");
  assert.equal(sends(network.calls).length, 0);
  assert.equal(loadManifest(file("content-factory")).settings.model, "anthropic/claude-sonnet-5");
});
