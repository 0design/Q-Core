/* Test-only simulation of a person typing the one-time code at `q-core approve`:
   the real confirmHumanDecision with a fake terminal that echoes the code back.
   Each call yields a fresh record that resumeRun accepts once. */
import { confirmHumanDecision } from "../src/human-confirmation.mjs";

export function typedAtTerminal(decision = "approve") {
  const code = "K7PQ3X";
  return confirmHumanDecision({ decision }, {
    env: {}, stdinIsTTY: true, stdoutIsTTY: true, code,
    openTerminal: () => ({ write() {}, readLine: () => code, close() {} }),
  });
}
