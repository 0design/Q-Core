import { spawn, spawnSync } from "node:child_process";
import { access } from "node:fs/promises";
import { subprocess, scopedEnvironment } from "./subprocess.mjs";
import { CoreError, insist } from "./contracts.mjs";

const SECURITY = "/usr/bin/security";
const SERVICE = "com.qfactory.q-core.openrouter";
const KEY_REF = /^[A-Z_][A-Z0-9_]*$/;
const MAX_KEY_REF_LENGTH = 128;
const MAX_SECRET_BYTES = 8192;
export const SECRET_STORE_PLATFORMS = Object.freeze(["darwin"]);
export const SECRET_STORE_MODES = Object.freeze(["env", "keychain"]);

function ensureKeychain(platform = process.platform) {
  if (!SECRET_STORE_PLATFORMS.includes(platform))
    throw new CoreError(
      "SECRET_STORE_UNSUPPORTED",
      "The protected local secret store is supported only on macOS",
    );
}

export function keychainIdentity(provider, keyRef = "OPENROUTER_API_KEY") {
  insist(provider === "openrouter", "Only the OpenRouter secret store is supported");
  insist(
    typeof keyRef === "string" &&
      Buffer.byteLength(keyRef) <= MAX_KEY_REF_LENGTH &&
      KEY_REF.test(keyRef),
    "Invalid secret keyRef",
  );
  return Object.freeze({
    service: SERVICE,
    account: `openrouter:${keyRef}`,
  });
}

function argsFor(action, identity) {
  const common = ["-a", identity.account, "-s", identity.service];
  if (action === "get") return ["find-generic-password", ...common, "-w"];
  if (action === "status") return ["find-generic-password", ...common];
  if (action === "remove") return ["delete-generic-password", ...common];
  if (action === "set") return ["add-generic-password", "-U", ...common, "-w"];
  throw new CoreError("INVALID_REQUEST", "Unsupported secret-store operation");
}

function storeError(operation, result) {
  if (result?.code === "MISSING_EXECUTABLE")
    return new CoreError("SECRET_STORE_UNSUPPORTED", "macOS security tool is unavailable");
  if (result?.code === 44)
    return new CoreError("SECRET_MISSING", "Configured protected secret is not stored");
  return new CoreError(
    "SECRET_STORE_DENIED",
    `Protected secret ${operation} was denied or failed`,
  );
}

async function runSecurity(args, { launch = subprocess, signal, timeoutMs = 10000 } = {}) {
  try {
    return await launch(SECURITY, args, {
      env: scopedEnvironment(),
      signal,
      timeoutMs,
      maxBytes: MAX_SECRET_BYTES,
    });
  } catch (error) {
    if (error instanceof CoreError) {
      if (error.code === "MISSING_EXECUTABLE")
        throw new CoreError("SECRET_STORE_UNSUPPORTED", "macOS security tool is unavailable");
      throw error;
    }
    throw new CoreError("SECRET_STORE_DENIED", "Protected secret operation failed");
  }
}

function cleanSecret(stdout) {
  const value = String(stdout ?? "").replace(/\r?\n$/, "");
  if (!value || Buffer.byteLength(value) > MAX_SECRET_BYTES)
    throw new CoreError("SECRET_MISSING", "Protected secret is empty or too large");
  return value;
}

export async function getKeychainSecret(
  { provider = "openrouter", keyRef = "OPENROUTER_API_KEY", platform = process.platform } = {},
  options = {},
) {
  ensureKeychain(platform);
  const result = await runSecurity(argsFor("get", keychainIdentity(provider, keyRef)), options);
  if (result.code !== 0) throw storeError("retrieval", result);
  return cleanSecret(result.stdout);
}

export async function hasKeychainSecret(
  { provider = "openrouter", keyRef = "OPENROUTER_API_KEY", platform = process.platform } = {},
  options = {},
) {
  ensureKeychain(platform);
  const result = await runSecurity(argsFor("status", keychainIdentity(provider, keyRef)), options);
  if (result.code === 0) return true;
  if (result.code === 44) return false;
  throw storeError("status", result);
}

export async function removeKeychainSecret(
  { provider = "openrouter", keyRef = "OPENROUTER_API_KEY", platform = process.platform } = {},
  options = {},
) {
  ensureKeychain(platform);
  const result = await runSecurity(argsFor("remove", keychainIdentity(provider, keyRef)), options);
  if (result.code === 0 || result.code === 44) return { removed: result.code === 0 };
  throw storeError("removal", result);
}

/**
 * Set is intentionally interactive. `security` receives no secret argument
 * and stdin is inherited so its protected prompt handles entry and echo.
 */
export async function setKeychainSecret(
  { provider = "openrouter", keyRef = "OPENROUTER_API_KEY", platform = process.platform } = {},
  { interactive = runInteractiveSecurity, isInteractive = () => process.stdin.isTTY && process.stdout.isTTY } = {},
) {
  ensureKeychain(platform);
  if (!isInteractive())
    throw new CoreError(
      "SECRET_INTERACTION_REQUIRED",
      "Run auth set from a local interactive terminal; secret input is never accepted from a pipe",
    );
  await interactive(argsFor("set", keychainIdentity(provider, keyRef)));
  return { stored: true };
}

async function runInteractiveSecurity(args, { timeoutMs = 120000 } = {}) {
  await access(SECURITY).catch(() => {
    throw new CoreError("SECRET_STORE_UNSUPPORTED", "macOS security tool is unavailable");
  });
  return new Promise((resolve, reject) => {
    const runStty = (sttyArgs, stdio = "inherit") => spawnSync("/bin/stty", sttyArgs, {
      shell: false,
      stdio,
      encoding: "utf8",
    });
    const modeResult = runStty(["-g"], ["inherit", "pipe", "pipe"]);
    const ttyMode = String(modeResult.stdout ?? "").trim();
    if (
      modeResult.status !== 0 ||
      !ttyMode ||
      !/^[A-Za-z0-9:;=,\-]+$/.test(ttyMode)
    ) {
      reject(new CoreError("SECRET_INTERACTION_REQUIRED", "Terminal mode could not be read safely"));
      return;
    }
    if (runStty(["-echo"]).status !== 0) {
      reject(new CoreError("SECRET_INTERACTION_REQUIRED", "Terminal echo could not be disabled safely"));
      return;
    }
    const child = spawn(SECURITY, args, {
      env: scopedEnvironment(),
      shell: false,
      detached: process.platform !== "win32",
      stdio: "inherit",
    });
    let settled = false;
    let stopping = false;
    let stopError;
    let timer;
    let killTimer;
    const restore = () => runStty([ttyMode]).status === 0;
    const finishAfterClose = (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      process.removeListener("SIGINT", onInterrupt);
      process.removeListener("SIGTERM", onTerminate);
      if (!restore()) {
        reject(new CoreError("SECRET_INTERACTION_REQUIRED", "Terminal mode could not be restored safely"));
      } else if (stopError) {
        reject(stopError);
      } else if (code === 0) {
        resolve();
      } else {
        reject(new CoreError("SECRET_STORE_DENIED", "Protected secret was not stored"));
      }
    };
    const kill = (signal) => {
      try {
        if (process.platform !== "win32") process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch {}
    };
    const stop = (error) => {
      if (settled || stopping) return;
      stopping = true;
      stopError = error;
      kill("SIGTERM");
      killTimer = setTimeout(() => kill("SIGKILL"), 300);
      killTimer.unref?.();
    };
    const onInterrupt = () => stop(new CoreError("CANCELLED", "Protected secret prompt cancelled"));
    const onTerminate = () => stop(new CoreError("CANCELLED", "Protected secret prompt cancelled"));
    process.once("SIGINT", onInterrupt);
    process.once("SIGTERM", onTerminate);
    timer = setTimeout(
      () => stop(new CoreError("TIMEOUT", "Protected secret prompt timed out")),
      timeoutMs,
    );
    child.once("error", () => stop(new CoreError("SECRET_STORE_DENIED", "Protected secret prompt failed")));
    child.once("close", (code) => finishAfterClose(code));
  });
}

export async function resolveProviderSecret(
  { provider = "openrouter", keyRef = "OPENROUTER_API_KEY", secretSource = "env", env = process.env, platform = process.platform } = {},
  options = {},
) {
  insist(SECRET_STORE_MODES.includes(secretSource), "Invalid secretSource");
  keychainIdentity(provider, keyRef);
  if (secretSource === "keychain") return getKeychainSecret({ provider, keyRef, platform }, options);
  const value = env?.[keyRef];
  if (typeof value !== "string" || !value.trim())
    throw new CoreError("AUTH_REQUIRED", `Missing secret reference ${keyRef}`);
  if (Buffer.byteLength(value) > MAX_SECRET_BYTES)
    throw new CoreError("AUTH_REQUIRED", "Configured secret is too large");
  return value;
}

export const SECRET_STORE = Object.freeze({
  executable: SECURITY,
  service: SERVICE,
  maxBytes: MAX_SECRET_BYTES,
  platforms: SECRET_STORE_PLATFORMS,
  modes: SECRET_STORE_MODES,
});
