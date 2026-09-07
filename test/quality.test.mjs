import test from "node:test";
import assert from "node:assert/strict";
import { hash } from "../src/contracts.mjs";
import { qualityCheck } from "../src/quality.mjs";
import { determined } from "../src/determined.mjs";
const artifact = { revision: 1, sha256: hash("artifact") },
  upstream = { version: "fixture-1", sha256: hash("canon") };
const request = {
  kind: "aindf-check",
  mode: "ds-readiness",
  upstream,
  artifact,
  designSystem: { id: "synthetic" },
  requiredRules: ["rule-1"],
  browserEvidence: {
    artifactHash: artifact.sha256,
    revision: 1,
    sha256: hash("browser-fixture"),
  },
};
const report = (outcome) => ({
  evaluate: async () => ({
    upstreamVersion: upstream.version,
    artifactHash: artifact.sha256,
    revision: 1,
    findings: [
      { rule: "rule-1", type: "hard", outcome, evidence: { fixture: true } },
    ],
  }),
});
for (const mode of ["ds-readiness", "ui-compliance"])
  test(`aindf ${mode}: good/bad/unknown/missing DS`, async () => {
    assert.equal(
      (await qualityCheck({ ...request, mode }, report("pass"))).status,
      "success",
    );
    assert.equal(
      (await qualityCheck({ ...request, mode }, report("fail"))).status,
      "failed",
    );
    assert.equal(
      (await qualityCheck({ ...request, mode }, report("unknown"))).status,
      "needs_human",
    );
    assert.equal(
      (
        await qualityCheck(
          { ...request, mode, designSystem: null },
          report("pass"),
        )
      ).status,
      "needs_human",
    );
  });
test("unslop hard/soft/browser coverage, stale canon and unavailable recipes", async () => {
  const r = { ...request, kind: "unslop" };
  assert.equal((await qualityCheck(r, report("fail"))).status, "failed");
  assert.equal(
    (await qualityCheck({ ...r, browserEvidence: null }, report("pass")))
      .status,
    "needs_human",
  );
  assert.equal(
    (
      await qualityCheck(
        { ...r, upstream: { ...upstream, version: "wrong" } },
        report("pass"),
      )
    ).status,
    "needs_human",
  );
  const result = await qualityCheck(r, {
    ...report("fail"),
    recipe: async () => {
      throw Error("offline");
    },
  });
  assert.equal(result.recipes[0].status, "unavailable");
});
test("determined repairs real criterion, rejects stale evidence, human not done", async () => {
  let value = 0;
  const callbacks = {
    execute: async () => {
      value++;
    },
    getArtifact: async () => ({ revision: value, sha256: hash(String(value)) }),
    verify: async ({ artifact }) => ({
      outcome: value === 2 ? "pass" : "fail",
      artifactHash: artifact.sha256,
      revision: artifact.revision,
    }),
  };
  const r = {
    criteria: [{ id: "two", verifier: { type: "synthetic" } }],
    maxRepairAttempts: 1,
  };
  assert.equal((await determined(r, callbacks)).status, "success");
  assert.equal(
    (
      await determined(r, {
        ...callbacks,
        verify: async () => ({
          outcome: "pass",
          artifactHash: hash("old"),
          revision: 0,
        }),
      })
    ).status,
    "needs_human",
  );
  assert.equal(
    (
      await determined(
        { ...r, criteria: [{ id: "human", verifier: { type: "human" } }] },
        callbacks,
      )
    ).status,
    "needs_human",
  );
});
