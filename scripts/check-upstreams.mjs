import { resolve, join } from "node:path";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import {
  loadAindf,
  loadUnslop,
  upstreamDigest,
} from "../src/upstream-adapters.mjs";
import { hash } from "../src/contracts.mjs";
const [aindfRoot, dsPath, unslopRoot] = process.argv.slice(2);
if (!unslopRoot)
  throw Error(
    "Usage: check-upstreams <installed-aindf> <synthetic-ds> <oleg-unslop>",
  );
const aPin = {
  root: resolve(aindfRoot),
  packageVersion: "0.5.0-rc.1",
  sha256: upstreamDigest(aindfRoot, ["cli", "schemas", "package.json"]),
};
const a = await loadAindf(aPin);
const artifact = { revision: 1, sha256: hash("synthetic-composition") };
const common = {
  upstream: { version: a.frameworkVersion },
  artifact,
  designSystem: { path: resolve(dsPath) },
};
const readiness = await a.evaluate({
  ...common,
  mode: "ds-readiness",
  requiredRules: ["AINDF-AgentReady"],
});
const valid = await a.evaluate({
  ...common,
  mode: "ui-compliance",
  requiredRules: ["composition-contract"],
  designSystem: { ...common.designSystem, sections: [{ component: "hero" }] },
});
const invalid = await a.evaluate({
  ...common,
  mode: "ui-compliance",
  requiredRules: ["composition-contract"],
  designSystem: {
    ...common.designSystem,
    sections: [{ component: "missing-component" }],
  },
});
const uPin = {
  root: resolve(unslopRoot),
  packageVersion: "0.1.0",
  sha256: upstreamDigest(unslopRoot, ["scripts", "references", "package.json"]),
};
const u = await loadUnslop(uPin);
mkdirSync(".qf/quality-fixtures", { recursive: true });
const unslop = [];
for (const [name, css] of [
  ["good", "button { color: var(--ink); }"],
  ["bad", "button { color: #ff0000; }"],
]) {
  const path = resolve(".qf/quality-fixtures/" + name + ".css");
  writeFileSync(path, css);
  unslop.push({
    name,
    ...(await u.evaluate({
      artifact: { path, revision: 1, sha256: hash(css) },
      requiredRules: ["B-1"],
      upstream: { version: "0.1.0" },
    })),
  });
}
const report = {
  evidenceKind:
    "real upstream execution on synthetic inputs; not browser/live acceptance",
  aindf: {
    pin: aPin,
    frameworkVersion: a.frameworkVersion,
    readiness,
    valid,
    invalid,
  },
  unslop: { pin: uPin, results: unslop },
};
writeFileSync(
  "docs/delivery/upstream-evidence.json",
  JSON.stringify(report, null, 2) + "\n",
);
console.log(
  JSON.stringify(
    {
      readiness: readiness.findings,
      valid: valid.findings,
      invalid: invalid.findings,
      unslop: unslop.map((x) => ({ name: x.name, findings: x.findings })),
    },
    null,
    2,
  ),
);
