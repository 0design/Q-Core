import test from "node:test";
import assert from "node:assert/strict";
import { determined } from "../src/determined.mjs";
import { hash } from "../src/contracts.mjs";

test("fresh determined evidence succeeds while old evidence cannot transfer", async () => {
  const criterion = { id: "current-result", verifier: { type: "test", command: "current-result" } };
  const artifact = { revision: 1, sha256: hash("current") };
  const accepted = await determined({ criteria: [criterion] }, {
    execute: async () => {},
    getArtifact: async () => artifact,
    verify: async ({ artifact: current }) => ({
      outcome: "pass",
      artifactHash: current.sha256,
      revision: current.revision,
    }),
  });
  assert.equal(accepted.status, "success");

  const stale = await determined({ criteria: [criterion] }, {
    execute: async () => {},
    getArtifact: async () => artifact,
    verify: async () => ({
      outcome: "pass",
      artifactHash: hash("old-result"),
      revision: 0,
    }),
  });
  assert.equal(stale.status, "needs_human");
  assert.match(stale.reason, /stale|human/i);
});
