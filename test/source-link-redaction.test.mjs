/* Telegram Content (content-factory): the post cites its source, and the person
   approves and sends exactly that post. Known defect, kept as a todo until the
   policy is decided: every `{{env.X}}` value is protected as a credential at the
   persistence boundary, so the non-secret source address in the saved post becomes
   [REDACTED]. Credentials must stay redacted whatever the fix is.
   Offline: a local fetch stub, no paid model, no real receiver, no approval. */
import test from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadManifest } from "../src/manifest.mjs";
import { createRun, driveRun, RunStore } from "../src/run.mjs";

const SOURCE = "https://source.example.com/material-source-link-704";
const TOKEN = ["bot", "token", "source-link", "fixture-704"].join("-");
const ENV = { QCORE_SOURCE_URL: SOURCE, TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_CHAT_ID: "-100" };

async function parkedPost(t, post) {
  const dir = mkdtempSync(join(tmpdir(), "source-link-"));
  const file = join(dir, "content-factory.yaml");
  copyFileSync(fileURLToPath(new URL("../registry/workflows/content-factory.yaml", import.meta.url)), file);
  const saved = Object.fromEntries(Object.keys(ENV).map((k) => [k, process.env[k]]));
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
    rmSync(dir, { recursive: true, force: true });
  });
  Object.assign(process.env, ENV);
  globalThis.fetch = async (url, init = {}) => {
    const target = String(url);
    if (target.startsWith("https://openrouter.ai/")) {
      const request = JSON.parse(init.body);
      const content = /validation gate/.test(JSON.stringify(request.messages)) ? JSON.stringify({ pass: true, reason: "All formal rules pass." }) : post;
      return new Response(JSON.stringify({ id: "stub", model: request.model, choices: [{ message: { content } }], usage: { prompt_tokens: 10, completion_tokens: 10 } }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (target === SOURCE) return new Response(JSON.stringify({ material: "x" }), { status: 200, headers: { "content-type": "application/json" } });
    throw new Error(`unexpected request before approval: ${target}`);
  };
  const manifest = loadManifest(file), store = new RunStore(file);
  const run = await driveRun(createRun(manifest), { apiKey: "test-key", settings: manifest.settings, store });
  assert.equal(run.status, "waiting_human");
  const saved_ = store.load(run.runId);
  return { gate: saved_.steps.find((s) => s.stepId === "cf-approve"), file: readFileSync(store.runFile(run.runId), "utf8") };
}

test("the saved post keeps the link to its source, so the approved and sent text cites it",
  { todo: "persistence protects every {{env.X}} value as a credential; the source-address policy is open" }, async (t) => {
    const post = `One idea from the material. (${SOURCE})`;
    const { gate } = await parkedPost(t, post);
    assert.equal(gate.output.subject.text, post);
  });

test("a credential in the post is still redacted before it is saved", async (t) => {
  const { gate, file } = await parkedPost(t, `Leaked ${TOKEN} in a post.`);
  assert.equal(file.includes(TOKEN), false);
  assert.equal(gate.output.subject.text, "Leaked [REDACTED] in a post.");
});
