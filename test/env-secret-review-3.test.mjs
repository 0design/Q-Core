/* Third review of manifest `env:` declarations: more credential-like names cannot be
   declared `secret: false`, and more addresses carrying credentials stay redacted
   even when declared public. A plain address stays visible. Offline. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateManifest } from "../src/manifest.mjs";
import { createRun } from "../src/run.mjs";
import { RunStore } from "../src/state.mjs";

const manifest = (name) => validateManifest({
  manifest: "q-core.workflow/v1", id: "env-review-3", env: { [name]: { secret: false } },
  steps: [{ id: "read", kind: "fetch", config: { url: `{{env.${name}}}` } }],
});

test("more credential-like names cannot be declared secret: false", () => {
  for (const name of ["DBPASS", "GITHUBPAT", "PASSPHRASE", "DB_PW", "PW", "JWT", "HMAC", "SIGNATURE", "OTP", "PIN",
    "CONNECTION_STRING", "CONN_STR", "MNEMONIC", "SEED_PHRASE", "CERT_PEM", "TWILIO_SID"]) {
    assert.throws(() => manifest(name), /reads like a credential/, name);
  }
  for (const name of ["QCORE_SOURCE_URL", "FEED_URL", "COMPASS_URL", "PATH_PREFIX"]) assert.equal(manifest(name).env[name].secret, false, name);
});

function savedWith(t, value) {
  const dir = mkdtempSync(join(tmpdir(), "env-review-3-")), previous = process.env.FEED_URL;
  process.env.FEED_URL = value;
  t.after(() => {
    if (previous === undefined) delete process.env.FEED_URL; else process.env.FEED_URL = previous;
    rmSync(dir, { recursive: true, force: true });
  });
  const run = createRun(manifest("FEED_URL")), store = new RunStore(join(dir, "workflow.yaml"));
  run.summary = `case ${value} end`;
  store.save(run);
  return readFileSync(store.runFile(run.runId), "utf8");
}

test("more addresses carrying credentials stay redacted when declared public", (t) => {
  const id = "review3-704";
  for (const value of [
    `admin:hunter-${id}@db.example.com:5432/prod`,
    `https://feeds.example.com/rss?pass=plain-${id}`,
    `https://feeds.example.com/rss?pw=plain-${id}`,
    `https://feeds.example.com/rss?code=plain-${id}`,
    `https://example.webhook.office.com/webhookb2/abc@def/IncomingWebhook/teams-${id}/uvw`,
    `DefaultEndpointsProtocol=https;AccountName=a;AccountKey=key-${id}==;EndpointSuffix=core.windows.net`,
    `Server=db.example.com;Database=prod;User Id=app;Password=pw-${id};`,
  ]) assert.equal(savedWith(t, value).includes(value), false, value);
});

test("a plain address declared public stays visible", (t) => {
  const value = "https://feeds.example.com/review3-plain-704.xml?author=me&page=2";
  assert.equal(savedWith(t, value).includes(value), true);
});
