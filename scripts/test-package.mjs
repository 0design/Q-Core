import {
  mkdtempSync,
  rmSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { hash } from "../src/contracts.mjs";
const live = process.argv.includes("--live-codex");
const modelIndex = process.argv.indexOf("--model");
const liveModel = modelIndex >= 0 ? process.argv[modelIndex + 1] : null;
if (live) assert.ok(liveModel && !liveModel.startsWith("--"), "Live checks require --model MODEL");
const root = resolve("."),
  tmp = mkdtempSync(join(tmpdir(), "qloops-clean-install-"));
const exec = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, {
    cwd: tmp,
    encoding: "utf8",
    env: {
      ...process.env,
      QF_NO_UPDATE_CHECK: "1",
      QFACTORY_REGISTRY: "",
      QLOOP_CATALOG_URL: "",
    },
    ...opts,
  });
try {
  writeFileSync(join(tmp, "package.json"), JSON.stringify({name:"qloops-proof-caller",private:true,type:"module"}));
  const packed = JSON.parse(
    exec("npm", ["pack", root, "--ignore-scripts", "--json"]),
  )[0];
  const tarball = join(tmp, packed.filename);
  const sha256 = hash(readFileSync(tarball));
  exec("npm", [
    "install",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    tarball,
  ]);
  const smoke =
    "import {validateManifest,openRouter,codex,runAgent,runContent,determined,qualityCheck} from 'qloops'; if(![validateManifest,openRouter,codex,runAgent,runContent,determined,qualityCheck].every(x=>typeof x==='function'))process.exit(1); console.log('package exports OK')";
  const imports = exec(process.execPath, ["--input-type=module", "-e", smoke]);
  const manifest =
    "manifest: qloops.loop/v1\nid: clean-install\nversion: 1.0.0\nsteps:\n  - id: approval\n    kind: approval-gate\n    config: { reviewer: human }\n";
  writeFileSync(join(tmp, "clean.yaml"), manifest);
  const bin = join(tmp, "node_modules/qloops/bin/qloops.mjs");
  const validation = exec(process.execPath, [bin, "validate", "clean.yaml"]);
  let runCode = 0;
  try {
    exec(process.execPath, [bin, "run", "clean.yaml"]);
  } catch (e) {
    runCode = e.status;
  }
  assert.equal(runCode, 2);
  const request = JSON.parse(
    readFileSync(join(root, "contracts/v1/fixtures.json")),
  ).positive;
  request.workspace = tmp;
  request.allowedTools = [process.execPath];
  request.verifier.command = process.execPath;
  request.provider = {
    kind: "codex",
    model: live ? liveModel : "fixture",
    payerScope: "local-cli",
    executable: live
      ? "/Applications/ChatGPT.app/Contents/Resources/codex"
      : join(root, "test/fixtures/codex.mjs"),
  };
  request.deadlineMs = live ? 90000 : 5000;
  request.allowedPaths = ["value.mjs"];
  writeFileSync(join(tmp, "value.mjs"), "export const add=()=>0;");
  writeFileSync(
    join(tmp, "verify.mjs"),
    "import {add} from './value.mjs';if(add(2,3)!==5)process.exit(1);",
  );
  let first;
  const clarifications = [];
  try {
    exec(process.execPath, [bin, "agent", "-"], {
      input: JSON.stringify(request),
    });
  } catch (e) {
    assert.equal(e.status, 2);
    first = JSON.parse(e.stdout);
  }
  // A live model may legitimately ask questions; do not mistake the supported
  // clarification phase for a runtime failure or silently approve an unknown spec.
  for (let attempt = 0; live && first?.nextAction?.type === "clarify_spec" && attempt < 3; attempt++) {
    request.resumeRunId = first.runId;
    request.clarification = {
      hash: first.nextAction.hash,
      answers: first.nextAction.questions.map(q => ({
        id: q.id,
        answer: "Synthetic test-owner decision: implement named export add(a,b) in value.mjs using JavaScript addition for numeric inputs, including positive, negative and zero numbers. Only value.mjs may change; verify.mjs is the existing independent checker. No UI, dependencies, credentials, external calls or publication. Out-of-scope requirements must remain unresolved.",
      })),
    };
    clarifications.push({questions: first.nextAction.questions, answers: request.clarification.answers});
    try {
      const output = exec(process.execPath, [bin, "agent", "-"], {input: JSON.stringify(request)});
      first = JSON.parse(output);
    } catch (e) {
      assert.equal(e.status, 2);
      first = JSON.parse(e.stdout);
    }
  }
  assert.equal(first.nextAction.type, "approve_spec");
  delete request.clarification;
  request.resumeRunId = first.runId;
  request.approval = { hash: first.nextAction.hash, decision: "approve" };
  assert.equal(
    JSON.parse(
      exec(process.execPath, [bin, "agent", "-"], {
        input: JSON.stringify(request),
      }),
    ).status,
    "success",
  );
  mkdirSync(join(root, "docs/delivery"), { recursive: true });
  const evidence = {
    package: packed.name,
    version: packed.version,
    sha256,
    integrity: packed.integrity,
    files: packed.files.map((f) => f.path),
    checks: {
      imports: imports.trim(),
      validate: !!validation,
      legacyHumanGateExit: runCode,
      installedCodexAgent: "success",
      completedResume: JSON.parse(
        exec(process.execPath, [bin, "agent", "-"], {
          input: JSON.stringify(request),
        }),
      ).status,
    },
    clarifications,
    evidenceKind: live
      ? "clean-install + live Codex ChatGPT inference + independent verifier + cached resume"
      : "clean-install + real Codex subprocess fixture; not live inference",
  };
  writeFileSync(
    join(
      root,
      live
        ? "docs/delivery/codex-package-live.json"
        : "docs/delivery/package-evidence.json",
    ),
    JSON.stringify(evidence, null, 2) + "\n",
  );
  console.log(JSON.stringify(evidence, null, 2));
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
