#!/usr/bin/env node
import fs from "node:fs";

const summaryPath = process.argv[2] || ".qf/last-run.json";
const summary = JSON.parse(fs.readFileSync(summaryPath, "utf8"));
const evidencePath = summary.steps
  ? summaryPath
  : `.qf/runs/${summary.runId}.json`;
const evidence = summary.steps
  ? summary
  : JSON.parse(fs.readFileSync(evidencePath, "utf8"));

if (evidence.status !== "success") {
  throw new Error(`expected successful loop evidence, got status=${evidence.status}`);
}

const outputs = evidence.steps || evidence.stepResults || evidence.outputs;
if (!outputs || typeof outputs !== "object") {
  throw new Error("run evidence has no step outputs to verify");
}

function outputFor(id) {
  const value = outputs[id] ?? outputs.find?.((step) => step.stepId === id);
  if (!value) throw new Error(`missing retained output for step ${id}`);
  return value.output ?? value;
}

const health = outputFor("health");
const data = outputFor("data");

if (health.status !== 200) throw new Error(`health HTTP status was ${health.status}`);
if (health.json?.status !== "ready") {
  throw new Error(`health JSON status was ${JSON.stringify(health.json?.status)}`);
}
if (data.status !== 200) throw new Error(`data HTTP status was ${data.status}`);
if (data.json?.total !== 6) {
  throw new Error(`data JSON total was ${JSON.stringify(data.json?.total)}`);
}

console.log(JSON.stringify({
  checked: true,
  health: { httpStatus: health.status, status: health.json.status },
  data: { httpStatus: data.status, total: data.json.total },
  evidence: evidencePath,
}));
