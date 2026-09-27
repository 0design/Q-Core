/* Test-only stand-in for a person who ran `q-core agent|content approve` at a
   terminal: the library path with an explicit confirmation record. The JSON
   protocols never reach it, and it refuses inside an agent session. */
import { recordHumanDecision } from "../src/human-decision.mjs";

export function personDecides(kind, workspace, pending, decision = "approve") {
  return recordHumanDecision({
    kind,
    workspace,
    runId: pending.runId,
    approvalHash: pending.nextAction.approvalHash,
    decision,
    confirmation: { channel: "test-human" },
  });
}
