import { hash, insist } from "./contracts.mjs";
/** A2D plan-time verifier mechanics: no completion-time replacement, AND of all
 * criteria, human remains human. Original provenance: docs/delivery/upstreams.md.
 * Host callbacks own execution/persistence; this reducer never evaluates code. */
export async function determined(
  { criteria, maxRepairAttempts = 0, signal },
  { execute, verify, getArtifact } = {},
) {
  insist(
    Array.isArray(criteria) &&
      criteria.length > 0 &&
      criteria.every((c) => typeof c.id === "string" && c.verifier),
    "Every criterion needs a plan-time verifier",
  );
  insist(
    new Set(criteria.map((c) => c.id)).size === criteria.length,
    "Duplicate criterion IDs",
  );
  insist(
    Number.isInteger(maxRepairAttempts) &&
      maxRepairAttempts >= 0 &&
      maxRepairAttempts <= 5,
    "Invalid repair limit",
  );
  const plan = structuredClone(criteria),
    planHash = hash(plan),
    history = [];
  for (let attempt = 0; attempt <= maxRepairAttempts; attempt++) {
    if (signal?.aborted) return { status: "cancelled", planHash, history };
    await execute({
      attempt,
      criteria: structuredClone(plan),
      previous: history.at(-1) ?? null,
      signal,
    });
    const artifact = await getArtifact();
    insist(
      /^[a-f0-9]{64}$/.test(artifact.sha256) &&
        Number.isInteger(artifact.revision),
      "Versioned artifact required",
    );
    const outcomes = [];
    for (const criterion of plan) {
      if (signal?.aborted) return { status: "cancelled", planHash, history };
      const evidence =
        criterion.verifier.type === "human"
          ? { outcome: "unknown" }
          : await verify({
              criterion: structuredClone(criterion),
              artifact: structuredClone(artifact),
              signal,
            });
      const current = await getArtifact();
      const fresh =
        evidence?.artifactHash === artifact.sha256 &&
        evidence?.revision === artifact.revision &&
        hash(current) === hash(artifact);
      outcomes.push({
        criterionId: criterion.id,
        outcome:
          fresh && ["pass", "fail"].includes(evidence?.outcome)
            ? evidence.outcome
            : "unknown",
        artifactHash: artifact.sha256,
        revision: artifact.revision,
        verifier: criterion.verifier,
      });
    }
    history.push({ attempt, artifact, outcomes });
    if (outcomes.every((e) => e.outcome === "pass"))
      return { status: "success", planHash, history };
    if (outcomes.some((e) => e.outcome === "unknown"))
      return {
        status: "needs_human",
        planHash,
        history,
        reason: "Missing, stale or human verification",
      };
  }
  return {
    status: "needs_human",
    planHash,
    history,
    reason: "Repair limit reached",
  };
}
