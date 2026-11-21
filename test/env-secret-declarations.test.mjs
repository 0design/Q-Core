/* Manifest `env:` declarations decide which environment values saved state keeps.
   `secret: true` is redacted, `secret: false` stays visible, undeclared values stay
   redacted as before, and a declared-public value with a credential shape (or a
   credential-like name) is still redacted. Offline: no model, no network. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateManifest, publicEnvNames, secretEnvNames } from "../src/manifest.mjs";
import { createRun } from "../src/run.mjs";
import { RunStore } from "../src/state.mjs";

const manifest = (env, url = "{{env.PUBLIC_FEED}} {{env.OPAQUE_VALUE}}") => validateManifest({
  manifest: "q-core.workflow/v1", id: "env-declarations", ...(env ? { env } : {}),
  steps: [{ id: "read", kind: "fetch", config: { url } }],
});

function saved(t, m, values, summary) {
  const dir = mkdtempSync(join(tmpdir(), "env-declarations-"));
  const previous = Object.fromEntries(Object.keys(values).map((name) => [name, process.env[name]]));
  Object.assign(process.env, values);
  t.after(() => {
    for (const [name, value] of Object.entries(previous)) if (value === undefined) delete process.env[name]; else process.env[name] = value;
    rmSync(dir, { recursive: true, force: true });
  });
  const run = createRun(m), store = new RunStore(join(dir, "workflow.yaml"));
  run.summary = summary;
  store.save(run);
  return readFileSync(store.runFile(run.runId), "utf8");
}

test("secret: false keeps the value in saved state; an undeclared value next to it stays redacted", (t) => {
  const feed = "https://feeds.example.com/public-env-704.xml", opaque = ["opaque", "undeclared", "704"].join("-");
  const file = saved(t, manifest({ PUBLIC_FEED: { secret: false } }), { PUBLIC_FEED: feed, OPAQUE_VALUE: opaque }, `${feed} ${opaque}`);
  assert.equal(file.includes(feed), true);
  assert.equal(file.includes(opaque), false);
});

test("secret: true redacts a value even when no template references it", (t) => {
  const value = ["declared", "only", "704"].join("-");
  const m = manifest({ PUBLIC_FEED: { secret: false }, DECLARED_ONLY: { secret: true } });
  assert.deepEqual(secretEnvNames(m), ["DECLARED_ONLY"]);
  const file = saved(t, m, { DECLARED_ONLY: value }, `x ${value} y`);
  assert.equal(file.includes(value), false);
});

test("a value declared secret: false that has a credential shape is still redacted", (t) => {
  // A Telegram bot token in a webhook address, assembled so the repository holds no token-shaped literal.
  const shaped = `https://hooks.example.com/${["1234567890", "A".repeat(35)].join(":")}`;
  const file = saved(t, manifest({ PUBLIC_FEED: { secret: false } }), { PUBLIC_FEED: shaped }, `sent to ${shaped}`);
  assert.equal(file.includes(shaped), false);
});

test("a child workflow that references the name without declaring it keeps it redacted", () => {
  const root = manifest({ PUBLIC_FEED: { secret: false } });
  const child = manifest(undefined, "{{env.PUBLIC_FEED}}");
  assert.deepEqual(publicEnvNames(root), ["PUBLIC_FEED"]);
  assert.deepEqual(publicEnvNames({ ...root, materialGraph: { "a.yaml": { manifest: root }, "b.yaml": { manifest: child } } }), []);
});

test("env declarations refuse typos, non-booleans and credential-like names declared public", () => {
  for (const [env, message] of [
    [{ PUBLIC_FEED: { secert: true } }, /needs "secret: true" or "secret: false"/],
    [{ PUBLIC_FEED: { secret: false, secert: true } }, /only "secret" is accepted/],
    [{ PUBLIC_FEED: { secret: "no" } }, /needs "secret: true" or "secret: false"/],
    [{ PUBLIC_FEED: true }, /needs "secret: true" or "secret: false"/],
    [{ public_feed: { secret: false } }, /UPPER_SNAKE/],
    [{ TELEGRAM_BOT_TOKEN: { secret: false } }, /reads like a credential/],
    [["PUBLIC_FEED"], /must be a mapping/],
  ]) assert.throws(() => manifest(env), message, JSON.stringify(env));
  assert.deepEqual(manifest(undefined).env, {});
});
