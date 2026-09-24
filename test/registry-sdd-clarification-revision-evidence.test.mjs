import test from "node:test";
import assert from "node:assert/strict";
import { collectEvidence } from "../scripts/sdd-registry-clarification-revision-evidence.mjs";

test("declared Registry SDD route advances revisions, rejects an old approval, and exposes the clarification gap", async () => {
  const evidence = await collectEvidence(process.cwd());
  assert.equal(evidence.route.join(" → "), "workspace-read → llm-call-cli → specification → approval-gate");
  assert.equal(evidence.revisionInvalidation.changed.revision, evidence.revisionInvalidation.first.revision + 1);
  assert.notEqual(evidence.revisionInvalidation.changed.approvalHash, evidence.revisionInvalidation.first.approvalHash);
  assert.equal(evidence.revisionInvalidation.formerApprovalRejected, true);
  assert.equal(evidence.clarification.verdict, "BLOCKED");
  assert.equal(evidence.clarification.durableQuestionAnswerRecorded, false);
  assert.match(evidence.clarification.failure, /Specification requires bounded summary, criteria and plan/);
  assert.deepEqual(evidence.effects, { providerCalls: 0, paidCalls: 0, ownerApprovals: 0, publication: false });
});
