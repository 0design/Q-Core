import test from "node:test";
import assert from "node:assert/strict";
import {
  getKeychainSecret,
  hasKeychainSecret,
  keychainIdentity,
  removeKeychainSecret,
  resolveProviderSecret,
  setKeychainSecret,
} from "../src/secrets.mjs";
import { openRouter } from "../src/providers/openrouter.mjs";
import { CoreError } from "../src/contracts.mjs";

test("Keychain identity is fixed and retrieval never puts a secret in argv", async () => {
  const identity = keychainIdentity("openrouter", "OPENROUTER_API_KEY");
  assert.deepEqual(identity, {
    service: "com.qfactory.qloops.openrouter",
    account: "openrouter:OPENROUTER_API_KEY",
  });
  let seen;
  const secret = await getKeychainSecret({ provider: "openrouter", keyRef: "OPENROUTER_API_KEY", platform: "darwin" }, {
    launch: async (command, args, options) => {
      seen = { command, args, options };
      return { code: 0, stdout: "fixture-secret\n", stderr: "" };
    },
  });
  assert.equal(secret, "fixture-secret");
  assert.equal(seen.command, "/usr/bin/security");
  assert.deepEqual(seen.args, ["find-generic-password", "-a", "openrouter:OPENROUTER_API_KEY", "-s", "com.qfactory.qloops.openrouter", "-w"]);
  assert.equal("fixture-secret" in seen.options, false);
  const controller = new AbortController();
  await getKeychainSecret({ platform: "darwin" }, {
    signal: controller.signal,
    launch: async (_command, _args, options) => {
      assert.equal(options.signal, controller.signal);
      return { code: 0, stdout: "fixture-secret\n", stderr: "" };
    },
  });
});

test("Keychain keyRef is a bounded logical alias", () => {
  assert.throws(
    () => keychainIdentity("openrouter", `QLOOPS_${"A".repeat(123)}`),
    { code: "INVALID_REQUEST" },
  );
  assert.equal(
    keychainIdentity("openrouter", `QLOOPS_${"A".repeat(121)}`).account.length > 0,
    true,
  );
});

test("Keychain status/removal do not request or expose secret values", async () => {
  const calls = [];
  const launch = async (_command, args) => {
    calls.push(args);
    return { code: args[0] === "find-generic-password" ? 44 : 0, stdout: "", stderr: "" };
  };
  assert.equal(await hasKeychainSecret({ platform: "darwin" }, { launch }), false);
  assert.deepEqual(await removeKeychainSecret({ platform: "darwin" }, { launch }), { removed: true });
  assert.deepEqual(calls[0].includes("-w"), false);
  assert.deepEqual(calls[1].includes("-w"), false);
});

test("Keychain set uses protected interactive prompt and rejects piped input", async () => {
  let args;
  const result = await setKeychainSecret({ platform: "darwin" }, {
    isInteractive: () => true,
    interactive: async (actual) => { args = actual; },
  });
  assert.deepEqual(result, { stored: true });
  assert.deepEqual(args, ["add-generic-password", "-U", "-a", "openrouter:OPENROUTER_API_KEY", "-s", "com.qfactory.qloops.openrouter", "-w"]);
  await assert.rejects(setKeychainSecret({ platform: "darwin" }, {
    isInteractive: () => false,
    interactive: async () => { throw new Error("must not prompt"); },
  }), { code: "SECRET_INTERACTION_REQUIRED" });
});

test("Secret resolver supports explicit env and keychain sources without fallback", async () => {
  assert.equal(await resolveProviderSecret({ env: { OPENROUTER_API_KEY: "fixture" } }), "fixture");
  await assert.rejects(resolveProviderSecret({ secretSource: "env", env: {} }), { code: "AUTH_REQUIRED" });
  await assert.rejects(resolveProviderSecret({ secretSource: "keychain", platform: "linux" }), { code: "SECRET_STORE_UNSUPPORTED" });
  await assert.rejects(resolveProviderSecret({ secretSource: "keychain", platform: "darwin" }, {
    launch: async () => ({ code: 44, stdout: "", stderr: "" }),
  }), { code: "SECRET_MISSING" });
  await assert.rejects(resolveProviderSecret({ secretSource: "keychain", platform: "darwin" }, {
    launch: async () => { throw new CoreError("MISSING_EXECUTABLE", "hidden"); },
  }), { code: "SECRET_STORE_UNSUPPORTED" });
});

test("OpenRouter consumes a resolved provider secret without putting it in result metadata", async () => {
  let authorization;
  let resolved;
  const result = await openRouter({
    messages: [{ role: "user", content: "hello" }],
    model: "test/model",
    payerScope: "local-byok",
    maxTokens: 16,
  }, {
    secretResolver: async (request, options) => {
      resolved = { request, options };
      return "fixture-secret";
    },
    fetcher: async (_url, init) => {
      authorization = init.headers.Authorization;
      return Response.json({ id: "id", model: "actual", choices: [{ message: { content: "ok" } }] });
    },
  });
  assert.equal(resolved.request.secretSource, "env");
  assert.equal(resolved.request.signal, undefined);
  assert.equal(resolved.options.timeoutMs, 90000);
  assert.equal(authorization, "Bearer fixture-secret");
  assert.equal(JSON.stringify(result).includes("fixture-secret"), false);
});
