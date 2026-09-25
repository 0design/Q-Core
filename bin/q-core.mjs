#!/usr/bin/env node
if (process.argv[2] === "auth") {
  try {
    const { hasKeychainSecret, removeKeychainSecret, setKeychainSecret } = await import("../src/secrets.mjs");
    const [operation, provider, keyRef = "OPENROUTER_API_KEY", ...extra] = process.argv.slice(3);
    if (!operation || provider !== "openrouter" || extra.length || !["set", "status", "remove"].includes(operation))
      throw new Error("Usage: q-core auth <set|status|remove> openrouter [KEY_REF]");
    if (operation === "set") {
      await setKeychainSecret({ provider, keyRef });
      process.stdout.write(JSON.stringify({ provider, keyRef, stored: true }) + "\n");
    } else if (operation === "status") {
      const stored = await hasKeychainSecret({ provider, keyRef });
      process.stdout.write(JSON.stringify({ provider, keyRef, stored }) + "\n");
    } else {
      const result = await removeKeychainSecret({ provider, keyRef });
      process.stdout.write(JSON.stringify({ provider, keyRef, ...result }) + "\n");
    }
  } catch (e) {
    process.stderr.write(`${e?.code ?? "AUTH_FAILED"}: ${e?.message ?? "Protected secret operation failed"}\n`);
    process.exitCode = 1;
  }
} else if (process.argv[2] === "content") {
  const { contentCli } = await import("./content.mjs");
  await contentCli(process.argv[3]);
} else if (process.argv[2] === "agent") {
  const { agentCli } = await import("./agent.mjs");
  await agentCli(process.argv[3]);
} else if (process.argv[2] === "install") {
  try {
    const { installPinned } = await import("../src/registry-release.mjs");
    const args = process.argv.slice(3);
    let releaseVersion;
    const at = args.indexOf("--release");
    if (at >= 0) {
      releaseVersion = args[at + 1];
      args.splice(at, 2);
    }
    const [base, catalogSha256, id, version, destination, ...extra] = args;
    if (!destination || extra.length || (at >= 0 && !releaseVersion))
      throw new Error(
        "Usage: q-core install <registry-directory-or-URL> <catalog-sha256> <id> <version> <destination> [--release <version>]",
      );
    console.log(
      JSON.stringify(
        await installPinned({ base, catalogSha256, id, version, destination, releaseVersion }),
      ),
    );
  } catch (e) {
    console.error(e?.code ? `${e.code}: ${e.message}` : e.message);
    process.exitCode = 1;
  }
} else await import("./q-workflow.mjs");
