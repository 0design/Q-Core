import { readFileSync, readdirSync, lstatSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { hash, insist } from "./contracts.mjs";
/** Hash executable/rule files without copying canon. Ignore install artifacts. */
export function upstreamDigest(root, folders) {
  const records = [];
  function walk(p, rel) {
    const stat = lstatSync(p);
    insist(!stat.isSymbolicLink(), "Upstream symlink refused");
    if (stat.isDirectory()) {
      for (const f of readdirSync(p).sort()) walk(join(p, f), `${rel}/${f}`);
    } else {
      insist(stat.size < 5000000, "Upstream file too large");
      records.push([rel, hash(readFileSync(p))]);
    }
  }
  for (const folder of folders) {
    insist(
      !folder.includes("..") && !folder.startsWith("/"),
      "Invalid upstream folder",
    );
    walk(join(root, folder), folder);
  }
  return hash(records);
}
export async function loadAindf({ root, sha256, packageVersion }) {
  insist(
    upstreamDigest(root, ["cli", "schemas", "package.json"]) === sha256,
    "AINDF upstream checksum mismatch",
  );
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  insist(
    pkg.name === "aindf" && pkg.version === packageVersion,
    "AINDF package identity mismatch",
  );
  const load = (p) => import(pathToFileURL(resolve(root, p)).href);
  const [{ loadDS }, { validateModel }, { buildTools }, { AINDF_VERSION }] =
    await Promise.all([
      load("cli/src/lib/validator/load.js"),
      load("cli/src/lib/validator/index.js"),
      load("cli/src/lib/mcp/tools.js"),
      load("cli/src/lib/version.js"),
    ]);
  return {
    packageVersion,
    frameworkVersion: AINDF_VERSION,
    async evaluate({ mode, artifact, designSystem, requiredRules, upstream }) {
      insist(
        upstream.version === AINDF_VERSION,
        "Framework version differs from requested pin",
      );
      const model = loadDS(designSystem.path);
      let findings = [];
      if (mode === "ds-readiness") {
        const report = validateModel(model);
        findings = requiredRules.map((rule) => {
          const level = report.levels[rule];
          return {
            rule,
            type: "hard",
            outcome: level ? (level.pass ? "pass" : "fail") : "unknown",
            evidence: level ? { reportHash: hash(report), level } : null,
          };
        });
      } else {
        const tools = buildTools(model);
        const sections = designSystem.sections;
        if (!Array.isArray(sections) || !sections.length)
          return {
            upstreamVersion: AINDF_VERSION,
            artifactHash: artifact.sha256,
            revision: artifact.revision,
            findings: [],
          };
        const result = tools.validateComposition.run(
          { sections },
          { verbose: true },
        );
        findings = requiredRules.map((rule) => ({
          rule,
          type: "hard",
          outcome:
            rule === "composition-contract"
              ? result.ok
                ? "pass"
                : "fail"
              : "unknown",
          evidence:
            rule === "composition-contract"
              ? { reportHash: hash(result), findings: result.findings }
              : null,
        }));
      }
      return {
        upstreamVersion: AINDF_VERSION,
        artifactHash: artifact.sha256,
        revision: artifact.revision,
        findings,
      };
    },
  };
}
export async function loadUnslop({ root, sha256, packageVersion }) {
  insist(
    upstreamDigest(root, ["scripts", "references", "package.json"]) === sha256,
    "Unslop upstream checksum mismatch",
  );
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  insist(
    pkg.name === "unslop" && pkg.version === packageVersion,
    "Unslop package identity mismatch",
  );
  const { detect } = await import(
    pathToFileURL(resolve(root, "scripts/detect.mjs")).href
  );
  return {
    async evaluate({ artifact, requiredRules, upstream }) {
      insist(upstream.version === packageVersion, "Canon version mismatch");
      insist(
        hash(readFileSync(artifact.path)) === artifact.sha256,
        "Artifact hash mismatch",
      );
      const findings = [];
      for (const rule of requiredRules) {
        try {
          const result = detect(artifact.path, { rules: [rule] });
          findings.push({
            rule,
            type: "hard",
            outcome:
              result.scanned > 0 && result.rulesRun > 0
                ? result.findings.some((f) => f.severity === "red")
                  ? "fail"
                  : "pass"
                : "unknown",
            evidence: { reportHash: hash(result), findings: result.findings },
          });
        } catch {
          findings.push({
            rule,
            type: "hard",
            outcome: "unknown",
            evidence: null,
          });
        }
      }
      return {
        upstreamVersion: packageVersion,
        artifactHash: artifact.sha256,
        revision: artifact.revision,
        findings,
      };
    },
  };
}
