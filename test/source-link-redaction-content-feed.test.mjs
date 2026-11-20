/* Content Feed (content-feed): the digest cites its feed, and the person approves
   and sends exactly that digest. The manifest declares the feed address
   `secret: false` and the bot token `secret: true` (`env:`), so the saved digest
   keeps the address and credentials stay redacted.
   Offline: a local fetch stub, no paid model, no real receiver, no approval. */
import test from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadManifest } from "../src/manifest.mjs";
import { createRun, driveRun, RunStore } from "../src/run.mjs";

const SOURCE = "https://feed.example.com/content-feed-source-link-704.xml";
const TOKEN = ["bot", "token", "content-feed", "fixture-704"].join("-");
const ENV = { QCORE_SOURCE_URL: SOURCE, TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_CHAT_ID: "-100" };
const RSS = `<?xml version="1.0"?><rss version="2.0"><channel><title>Feed</title>
<item><title>One item</title><link>https://feed.example.com/item-1</link><description>Summary</description></item>
</channel></rss>`;

async function parkedDigest(t, digest) {
  const dir = mkdtempSync(join(tmpdir(), "content-feed-source-link-"));
  const file = join(dir, "content-feed.yaml");
  copyFileSync(fileURLToPath(new URL("../registry/workflows/content-feed.yaml", import.meta.url)), file);
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
      return new Response(JSON.stringify({ id: "stub", model: request.model, choices: [{ message: { content: digest } }], usage: { prompt_tokens: 10, completion_tokens: 10 } }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (target === SOURCE) return new Response(RSS, { status: 200, headers: { "content-type": "application/rss+xml" } });
    throw new Error(`unexpected request before approval: ${target}`);
  };
  const manifest = loadManifest(file), store = new RunStore(file);
  const run = await driveRun(createRun(manifest), { apiKey: "test-key", settings: manifest.settings, store });
  assert.equal(run.status, "waiting_human");
  const parked = store.load(run.runId);
  return { gate: parked.steps.find((s) => s.stepId === "cf-approve"), file: readFileSync(store.runFile(run.runId), "utf8") };
}

test("the saved digest keeps its feed address, so the approved and sent text cites it", async (t) => {
  const digest = `1 item from ${SOURCE}\n— One item · https://feed.example.com/item-1`;
  const { gate } = await parkedDigest(t, digest);
  assert.equal(gate.output.subject.text, digest);
});

test("a credential in the digest is still redacted before it is saved", async (t) => {
  const { gate, file } = await parkedDigest(t, `Leaked ${TOKEN} in a digest.`);
  assert.equal(file.includes(TOKEN), false);
  assert.equal(gate.output.subject.text, "Leaked [REDACTED] in a digest.");
});
