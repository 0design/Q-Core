/* Review of manifest `env:` declarations: a secret does not leak even when its author
   declared it `secret: false` by mistake.
   1. A name that reads like a credential cannot be declared public.
   2. A declared-public address that carries credentials is still redacted.
   3. Only a run created from a manifest can keep a value public; an agent or content
      request that carries `publicEnv` changes nothing.
   Offline: no model, no network. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateManifest } from "../src/manifest.mjs";
import { createRun } from "../src/run.mjs";
import { RunStore } from "../src/state.mjs";
import { persistenceEnvironment } from "../src/persistence.mjs";

const manifest = (name) => validateManifest({
  manifest: "q-core.workflow/v1", id: "env-review", env: { [name]: { secret: false } },
  steps: [{ id: "read", kind: "fetch", config: { url: `{{env.${name}}}` } }],
});

test("a credential-like name cannot be declared secret: false", () => {
  for (const name of ["PASSWD", "DB_PASS", "DB_PWD", "AUTH_HEADER", "BEARER", "SLACK_WEBHOOK_URL", "DATABASE_URL", "PRIVATE_DSN",
    "SESSION_ID", "SIGNING_SALT", "PAT", "GITHUB_PAT", "REGISTRY_CREDS", "API_BASE"]) {
    assert.throws(() => manifest(name), /reads like a credential/, name);
  }
  for (const name of ["QCORE_SOURCE_URL", "PUBLIC_FEED", "COMPASS_URL", "PATH_PREFIX", "RAPID_FEED"]) {
    assert.deepEqual(manifest(name).env, { [name]: { secret: false } }, name);
  }
});

function savedWith(t, value, tag) {
  const dir = mkdtempSync(join(tmpdir(), "env-review-")), previous = process.env.PUBLIC_FEED;
  process.env.PUBLIC_FEED = value;
  t.after(() => {
    if (previous === undefined) delete process.env.PUBLIC_FEED; else process.env.PUBLIC_FEED = previous;
    rmSync(dir, { recursive: true, force: true });
  });
  const run = createRun(manifest("PUBLIC_FEED")), store = new RunStore(join(dir, "workflow.yaml"));
  run.summary = `${tag} ${value} end`;
  store.save(run);
  return readFileSync(store.runFile(run.runId), "utf8");
}

test("a declared-public address that carries credentials is still redacted", (t) => {
  const id = "review-704";
  for (const value of [
    `postgres://admin:hunter-${id}@db.example.com/prod`,
    `https://reader-${id}@feeds.example.com/private.xml`,
    `https://feeds.example.com/rss?token=plain-${id}`,
    `https://feeds.example.com/rss?page=2&api_key=plain-${id}`,
    `https://cdn.example.com/file.xml?X-Amz-Signature=abc-${id}`,
    `https://feeds.example.com/rss?sig=abc-${id}`,
    `https://app.example.com/callback#access_token=abc-${id}`,
    `https://feeds.example.com/rss?password=abc-${id}`,
    `https://hooks.slack.com/services/T0000/B0000/slack-${id}`,
    `https://discord.com/api/webhooks/1234/discord-${id}`,
    encodeURIComponent(`https://feeds.example.com/rss?auth=enc-${id}`),
  ]) assert.equal(savedWith(t, value, "case").includes(value), false, value);
});

test("a plain declared-public address stays visible", (t) => {
  const value = "https://feeds.example.com/review-plain-704.xml?page=2&lang=en";
  assert.equal(savedWith(t, value, "plain").includes(value), true);
});

test("an agent or content request carrying publicEnv keeps every referenced value protected", () => {
  const name = "QCORE_REVIEW_INJECTED_FEED", value = "https://feeds.example.com/review-injected-704.xml", previous = process.env[name];
  process.env[name] = value;
  try {
    for (const request of [
      { protocolVersion: "qf.content-request/v1", sources: [{ url: `{{env.${name}}}` }], publicEnv: [name] },
      { protocolVersion: "qf.agent/v1", intent: `{{env.${name}}}`, publicEnv: [name] },
    ]) assert.equal(persistenceEnvironment(request)[name], value, request.protocolVersion);
  } finally {
    if (previous === undefined) delete process.env[name]; else process.env[name] = previous;
  }
});
