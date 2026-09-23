import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = path => readFileSync(join(root, path), "utf8");

test("the classifier policy is trusted base code and PR code is only diff data", () => {
  const workflow = read(".github/workflows/contribution-funnel.yml");
  const classifyJob = workflow.slice(workflow.indexOf("  classify:"), workflow.indexOf("  registry:"));

  assert.match(workflow, /^  pull_request_target:\n/m);
  assert.doesNotMatch(workflow, /^  pull_request:\n/m);
  assert.match(workflow, /permissions:\n  contents: read/);
  assert.match(classifyJob, /ref: \$\{\{ github\.event\.pull_request\.base\.sha \}\}/);
  assert.match(classifyJob, /persist-credentials: false/);
  assert.match(classifyJob, /git fetch --no-tags --depth=1 origin "\$PR_HEAD_SHA:\$PR_HEAD_REF"/);
  assert.match(classifyJob, /node scripts\/classify-contribution\.mjs --base "\$BASE_SHA" --head "\$PR_HEAD_REF"/);
  assert.doesNotMatch(classifyJob, /ref: \$\{\{ github\.event\.pull_request\.head\.sha \}\}/);
});

test("a PR replacement classifier cannot choose its funnel", () => {
  const repo = mkdtempSync(join(tmpdir(), "qf-contribution-policy-"));
  const sourceClassifier = join(root, "scripts/classify-contribution.mjs");
  try {
    const git = args => execFileSync("git", args, { cwd: repo, encoding: "utf8" });
    git(["init", "--quiet"]);
    git(["config", "user.email", "test@example.invalid"]);
    git(["config", "user.name", "policy test"]);
    mkdirSync(join(repo, "scripts"));
    writeFileSync(join(repo, "scripts/classify-contribution.mjs"), readFileSync(sourceClassifier));
    writeFileSync(join(repo, "registry-entry.json"), "{}\n");
    git(["add", "."]);
    git(["commit", "--quiet", "-m", "base"]);
    const base = git(["rev-parse", "HEAD"]).trim();

    writeFileSync(join(repo, "scripts/classify-contribution.mjs"), "console.log('registry');\n");
    writeFileSync(join(repo, "src.txt"), "Core change\n");
    git(["add", "."]);
    git(["commit", "--quiet", "-m", "malicious PR head"]);
    const head = git(["rev-parse", "HEAD"]).trim();

    const result = execFileSync(
      process.execPath,
      [sourceClassifier, "--base", base, "--head", head, "--funnel-only"],
      { cwd: repo, encoding: "utf8" },
    ).trim();
    assert.equal(result, "core");
  } finally {
    rmSync(repo, { force: true, recursive: true });
  }
});

test("legacy workflows do not create an unclassified PR funnel", () => {
  for (const file of [".github/workflows/registry.yml", ".github/workflows/validate.yml"]) {
    assert.doesNotMatch(read(file), /^  pull_request:\n/m, file);
  }
});
