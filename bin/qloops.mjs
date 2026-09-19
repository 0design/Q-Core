#!/usr/bin/env node
if (process.argv[2] === "auth") {
  try {
    const { hasKeychainSecret, removeKeychainSecret, setKeychainSecret } = await import("../src/secrets.mjs");
    const [operation, provider, keyRef = "OPENROUTER_API_KEY", ...extra] = process.argv.slice(3);
    if (!operation || provider !== "openrouter" || extra.length || !["set", "status", "remove"].includes(operation))
      throw new Error("Usage: qloops auth <set|status|remove> openrouter [KEY_REF]");
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
    const [base, catalogSha256, id, version, destination] =
      process.argv.slice(3);
    if (!destination)
      throw new Error(
        "Usage: qloops install <registry-directory-or-URL> <catalog-sha256> <id> <version> <destination>",
      );
    console.log(
      JSON.stringify(
        await installPinned({ base, catalogSha256, id, version, destination }),
      ),
    );
  } catch (e) {
    console.error(e.message);
    process.exitCode = 1;
  }
} else await import("./qloop.mjs");
