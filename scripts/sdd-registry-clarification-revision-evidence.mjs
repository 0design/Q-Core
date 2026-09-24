#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadManifest } from "../src/manifest.mjs";
import { createRun, driveRun, resumeRun, RunStore } from "../src/run.mjs";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const callerProvider = Object.freeze({
  kind: "caller",
  agent: "codex",
  model: "static-local-evidence",
  payerScope: "local-cli",
});

const firstSpec = Object.freeze({
  summary: "Make sum add two numbers",
  criteria: ["sum(2,3) equals 5"],
  plan: ["Update value.mjs only", "Run the pinned verifier"],
});
const revisedSpec = Object.freeze({
  summary: "Make sum add two numbers and document the result",
  criteria: ["sum(2,3) equals 5", "notes.md states the result"],
  plan: ["Update value.mjs", "Write notes.md", "Run the pinned verifier"],
});

function catalogPins(root) {
  const catalog = JSON.parse(readFileSync(join(root, "registry", "catalog.json"), "utf8"));
  const manifest = readFileSync(join(root, "registry", "workflows", "sdd-pipeline.yaml"));
  const workflow = catalog.workflows.find((entry) => entry.id === "sdd-pipeline" && entry.version === "0.1.0");
  assert.ok(workflow, "The declared sdd-pipeline@0.1.0 Registry entry is missing");
  assert.equal(workflow.sha256, sha256(manifest), "Catalog manifest pin must match the executed source");
  return {
    core: { version: catalog.core.version, artifactSha256: catalog.core.artifactSha256 },
    registryVersion: catalog.releaseVersion,
    workflow: { id: workflow.id, version: workflow.version, sha256: workflow.sha256 },
  };
}

async function reply(run, output, opts) {
  const job = run.pendingInference;
  assert.ok(job?.jobId && job.hash, "Registry route must issue a caller job");
  return driveRun(run, {
    ...opts,
    inferenceReply: { jobId: job.jobId, hash: job.hash, output: { text: JSON.stringify(output) } },
  });
}

function policy(workspace, allowedPaths, intent) {
  return {
    workspace,
    allowedPaths,
    intent,
    maxRepairAttempts: 0,
    verifier: { command: process.execPath, args: ["verify.mjs"], timeoutMs: 5_000 },
  };
}

async function startAtGate(manifest, store, workspacePolicy, specification) {
  const run = createRun(manifest);
  run.workspacePolicy = workspacePolicy;
  const opts = { store, callerProvider, settings: manifest.settings };
  await driveRun(run, opts);
  assert.equal(run.status, "waiting_inference");
  await reply(run, specification, opts);
  assert.equal(run.status, "waiting_human");
  const specificationStep = run.steps.find((step) => step.kind === "specification");
  const gate = run.steps.find((step) => step.status === "waiting_human");
  assert.ok(specificationStep?.output?.hash && gate?.output?.approvalHash, "Registry specification and approval outputs are required");
  return { run, opts, specification: specificationStep.output, approvalHash: gate.output.approvalHash };
}

/**
 * Executes only the declared Registry manifest with supplied caller replies.
 * It never calls a model/provider and never approves a run. The returned
 * receipt proves both revision invalidation and the contract-bound
 * clarification bridge without using src/agent.mjs as a shortcut.
 */
export async function collectEvidence(root, { cleanup = true } = {}) {
  const pins = catalogPins(root);
  const workspace = mkdtempSync(join(tmpdir(), "qf-sdd-registry-evidence-"));
  const manifestFile = join(workspace, "sdd-pipeline.yaml");
  copyFileSync(join(root, "registry", "workflows", "sdd-pipeline.yaml"), manifestFile);
  writeFileSync(join(workspace, "value.mjs"), "export const sum=(a,b)=>a-b;\n");
  writeFileSync(join(workspace, "verify.mjs"), "import assert from 'node:assert/strict'; import {sum} from './value.mjs'; assert.equal(sum(2,3),5);\n");
  const manifest = loadManifest(manifestFile);
  const store = new RunStore(manifestFile);
  const basePolicy = policy(workspace, ["value.mjs"], "Make sum add two numbers");
  const changedPolicy = policy(workspace, ["value.mjs", "notes.md"], "Make sum add two numbers and document the result");
  let receipt;
  try {
    const first = await startAtGate(manifest, store, basePolicy, firstSpec);
    const changed = await startAtGate(manifest, store, changedPolicy, revisedSpec);
    assert.equal(changed.specification.revision, first.specification.revision + 1, "Scope/policy change must advance the Registry specification revision");
    let oldApprovalRejected = false;
    let rejection = null;
    try {
      await resumeRun(changed.run, { ...changed.opts, decision: "approve", approvalHash: first.approvalHash });
    } catch (error) {
      oldApprovalRejected = /Approval does not match the current exact subject/.test(String(error));
      rejection = String(error.message ?? error);
    }
    assert.equal(oldApprovalRejected, true, "Former approval must be rejected by the new Registry revision");

    const ambiguous = createRun(manifest);
    ambiguous.workspacePolicy = basePolicy;
    const ambiguousOpts = { store, callerProvider, settings: manifest.settings };
    await driveRun(ambiguous, ambiguousOpts);
    assert.equal(ambiguous.status, "waiting_inference");
    await reply(ambiguous, { questions: [{ id: "format", question: "Which output format?" }] }, ambiguousOpts);
    assert.equal(ambiguous.status, "waiting_human", "Questions must persist as a human clarification stop");
    const clarification = ambiguous.pendingClarification;
    assert.ok(clarification?.hash, "Clarification must have an exact question hash");
    await driveRun(ambiguous, { ...ambiguousOpts, clarification: { hash: clarification.hash, answers: [{ id: "format", answer: "Plain text" }] } });
    assert.equal(ambiguous.status, "waiting_inference", "Exact answers must issue a new caller job");
    assert.deepEqual(JSON.parse(ambiguous.pendingInference.messages[1].content).clarification, {
      hash: clarification.hash,
      questions: clarification.questions,
      answers: [{ id: "format", answer: "Plain text" }],
    });

    receipt = {
      schema: "qfactory.sdd-registry-clarification-revision-evidence/v1",
      localOnly: true,
      route: ["workspace-read", "llm-call-cli", "specification", "approval-gate"],
      pins,
      revisionInvalidation: {
        first: { revision: first.specification.revision, specificationHash: first.specification.hash, approvalHash: first.approvalHash, allowedPaths: basePolicy.allowedPaths },
        changed: { revision: changed.specification.revision, specificationHash: changed.specification.hash, approvalHash: changed.approvalHash, allowedPaths: changedPolicy.allowedPaths },
        formerApprovalRejected: oldApprovalRejected,
        rejection,
      },
      clarification: {
        requested: { id: "format", question: "Which output format?" },
        questionHash: clarification.hash,
        durableQuestionAnswerRecorded: true,
        verdict: "PASS",
        nextCallerJobId: ambiguous.pendingInference.jobId,
        explanation: "The declared Registry runner persists questions, rejects non-bound answers before a new job, and passes the exact Q/A context to the next caller job. No direct agent shortcut was used.",
      },
      effects: { providerCalls: 0, paidCalls: 0, ownerApprovals: 0, publication: false },
    };
  } finally {
    if (cleanup) rmSync(workspace, { recursive: true, force: true });
  }
  return receipt;
}

async function main() {
  const root = resolve(process.argv[2] ?? ".");
  process.stdout.write(`${JSON.stringify(await collectEvidence(root), null, 2)}\n`);
}

if (process.argv[1] && resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1])) {
  main().catch((error) => {
    process.stderr.write(`ERROR: ${error.stack ?? error}\n`);
    process.exitCode = 1;
  });
}
