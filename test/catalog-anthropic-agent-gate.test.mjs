import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describeWorkflow } from "../src/catalog.mjs";

const gate = (id, config = {}) => ({ id, kind: "approval-gate", config: {
  reviewer: "agent", provider: "anthropic", model: "claude-sonnet-5-5",
  rubric: "The candidate contains the required evidence.", ...config,
} });

for (const [name, steps, expected] of [
  ["native default env reference", [gate("judge")], ["ANTHROPIC_API_KEY"]],
  ["native aliased env reference", [gate("judge", { keyRef: "OWNER_ANTHROPIC_CREDIT" })], ["OWNER_ANTHROPIC_CREDIT"]],
  ["native keychain reference", [gate("judge", { secretSource: "keychain" })], []],
  ["native aliased keychain reference", [gate("judge", { secretSource: "keychain", keyRef: "OWNER_ANTHROPIC_CREDIT" })], []],
  ["mixed native and OpenRouter agent gates", [gate("judge"), gate("router", { provider: "openrouter" })],
    ["OPENROUTER_API_KEY", "ANTHROPIC_API_KEY"]],
  ["mixed native gate and default OpenRouter call", [gate("judge"), { id: "writer", kind: "llm-call", config: { instructions: "Draft a candidate." } }],
    ["OPENROUTER_API_KEY", "ANTHROPIC_API_KEY"]],
  ["native keychain gate with default OpenRouter agent gate", [gate("judge", { secretSource: "keychain" }), gate("router", { provider: undefined })],
    ["OPENROUTER_API_KEY"]],
  ["explicit human gate", [gate("judge", { reviewer: "human" })], []],
  ["default human gate", [{ id: "review", kind: "approval-gate", config: { provider: "anthropic" } }], []],
]) {
  test(`catalog agent-gate requirements: ${name}`, async t => {
    const directory = await mkdtemp(join(tmpdir(), "q-core-native-gate-catalog-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const file = join(directory, "workflow.yaml");
    const manifest = { manifest: "q-core.workflow/v1", id: "native-gate-catalog", steps };
    await writeFile(file, Object.entries(manifest).map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join("\n") + "\n");
    assert.deepEqual(describeWorkflow(file).needsEnv, expected);
  });
}
