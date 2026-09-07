import { hash, insist } from "./contracts.mjs";
/** Canon rules remain upstream. Adapters must report explicit per-rule coverage.
 * Passing evaluated rules cannot turn missing DS, evidence or rules into success. */
export async function qualityCheck(
  {
    kind,
    mode,
    upstream,
    artifact,
    designSystem,
    requiredRules,
    browserEvidence,
  },
  { evaluate, recipe } = {},
) {
  insist(["aindf-check", "unslop"].includes(kind), "Unknown quality adapter");
  insist(
    kind === "unslop" || ["ds-readiness", "ui-compliance"].includes(mode),
    "Unknown DS mode",
  );
  insist(
    upstream &&
      typeof upstream.version === "string" &&
      /^[a-f0-9]{64}$/.test(upstream.sha256),
    "Pinned upstream required",
  );
  insist(
    artifact &&
      /^[a-f0-9]{64}$/.test(artifact.sha256) &&
      Number.isInteger(artifact.revision),
    "Versioned artifact required",
  );
  insist(
    Array.isArray(requiredRules) &&
      requiredRules.length > 0 &&
      requiredRules.every((r) => typeof r === "string") &&
      new Set(requiredRules).size === requiredRules.length,
    "Explicit unique rule coverage required",
  );
  const base = {
    protocolVersion: "qf.quality/v1",
    kind,
    mode,
    upstream,
    artifact,
    hard: [],
    soft: [],
    coverage: [],
    recipes: [],
  };
  if (kind === "aindf-check" && !designSystem)
    return {
      ...base,
      status: "needs_human",
      reason: "Missing design system",
      coverage: requiredRules.map((rule) => ({ rule, outcome: "unknown" })),
    };
  if (typeof evaluate !== "function")
    return {
      ...base,
      status: "needs_human",
      reason: "Upstream adapter unavailable",
    };
  let report;
  try {
    report = await evaluate({
      kind,
      mode,
      upstream,
      artifact,
      designSystem,
      requiredRules,
      browserEvidence,
    });
  } catch {
    return {
      ...base,
      status: "needs_human",
      reason: "Upstream evaluation unavailable",
    };
  }
  if (
    report?.upstreamVersion !== upstream.version ||
    report?.artifactHash !== artifact.sha256 ||
    report?.revision !== artifact.revision
  )
    return {
      ...base,
      status: "needs_human",
      reason: "Stale artifact or upstream version mismatch",
    };
  for (const rule of requiredRules) {
    const matches = (report.findings ?? []).filter((f) => f.rule === rule);
    const finding = matches.length === 1 ? matches[0] : null;
    const outcome =
      finding && ["pass", "fail"].includes(finding.outcome) && finding.evidence
        ? finding.outcome
        : "unknown";
    base.coverage.push({ rule, outcome });
    if (finding)
      (finding.type === "soft" ? base.soft : base.hard).push({
        ...finding,
        outcome,
      });
    if (finding?.outcome === "fail" && recipe) {
      try {
        const r = await recipe({ rule, version: upstream.version });
        if (r?.rule === rule && r?.version === upstream.version)
          base.recipes.push(r);
        else base.recipes.push({ rule, status: "unknown" });
      } catch {
        base.recipes.push({ rule, status: "unavailable" });
      }
    }
  }
  const browserRequired = kind === "unslop" || mode === "ui-compliance";
  const browserValid =
    browserEvidence?.artifactHash === artifact.sha256 &&
    browserEvidence?.revision === artifact.revision &&
    /^[a-f0-9]{64}$/.test(browserEvidence?.sha256 ?? "");
  const unknown =
    base.coverage.some((f) => f.outcome === "unknown") ||
    (browserRequired && !browserValid);
  return {
    ...base,
    status: unknown
      ? "needs_human"
      : base.hard.some((f) => f.outcome === "fail")
        ? "failed"
        : base.soft.some((f) => f.outcome === "fail")
          ? "needs_human"
          : "success",
    browserEvidence: browserValid ? browserEvidence : null,
  };
}
