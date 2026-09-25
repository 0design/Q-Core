#!/usr/bin/env node
// QF-NAMING-01 negative inventory guard (0D-372).
// Every token that contains "loop" in a tracked text file must be explained by
// a classified allowlist rule: generic control flow / programming term,
// immutable historical artifact, negative guard fixture, third-party name, or
// an explicitly transitional class (remote identity or an owned handoff).
// Default mode fails on any unclassified hit. --release additionally fails on
// transitional classes, because a release must not ship them.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const TOKEN = /[A-Za-z0-9_$.\/-]*loop[A-Za-z0-9_$.\/-]*/gi;

export function loadRules(file) {
  const doc = JSON.parse(readFileSync(file, "utf8"));
  if (doc.schema !== "qf.naming-inventory-allowlist/v1") throw Error("Unknown allowlist schema");
  const classes = doc.classes ?? {};
  return doc.rules.map((rule, index) => {
    if (!classes[rule.class]) throw Error(`rule ${index} uses an undeclared class ${rule.class}`);
    if (!rule.reason?.trim()) throw Error(`rule ${index} needs a reason`);
    return {
      ...rule,
      transitional: classes[rule.class].transitional === true,
      pathRe: new RegExp(rule.path),
      lineRe: rule.line ? new RegExp(rule.line, "i") : null,
      tokenRe: rule.token ? new RegExp(rule.token, "i") : null,
    };
  });
}

export function classifyFiles(files, rules) {
  const hits = [];
  for (const { path, source } of files) {
    if (source.includes("\u0000")) continue;
    source.split("\n").forEach((line, index) => {
      for (const match of line.matchAll(TOKEN)) {
        const token = match[0];
        const rule = rules.find((candidate) =>
          candidate.pathRe.test(path) &&
          (!candidate.lineRe || candidate.lineRe.test(line)) &&
          (!candidate.tokenRe || candidate.tokenRe.test(token)));
        hits.push({ path, line: index + 1, token, class: rule?.class ?? null, transitional: rule?.transitional ?? false });
      }
    });
  }
  return hits;
}

export function summarize(hits, { release = false } = {}) {
  const byClass = {};
  for (const hit of hits) byClass[hit.class ?? "UNCLASSIFIED"] = (byClass[hit.class ?? "UNCLASSIFIED"] ?? 0) + 1;
  const unclassified = hits.filter((hit) => !hit.class);
  const transitional = hits.filter((hit) => hit.transitional);
  const failures = release ? [...unclassified, ...transitional] : unclassified;
  return { total: hits.length, byClass, unclassified, transitional: transitional.length, passed: failures.length === 0, failures };
}

export function trackedFiles(root) {
  return execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
    .split("\u0000").filter(Boolean)
    .map((path) => {
      try { return { path, source: readFileSync(join(root, path), "utf8") }; } catch { return null; }
    })
    .filter(Boolean);
}

export function checkNamingInventory(root, allowlist, options = {}) {
  return summarize(classifyFiles(trackedFiles(root), loadRules(allowlist)), options);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const here = dirname(fileURLToPath(import.meta.url));
  const root = resolve(process.env.QF_NAMING_ROOT ?? join(here, ".."));
  const allowlist = resolve(process.env.QF_NAMING_ALLOWLIST ?? join(here, "naming-inventory.allowlist.json"));
  const result = checkNamingInventory(root, allowlist, { release: process.argv.includes("--release") });
  for (const hit of result.failures.slice(0, 50)) {
    console.error(`${hit.path}:${hit.line}: ${hit.token} [${hit.class ?? "UNCLASSIFIED"}]`);
  }
  console.log(JSON.stringify({ passed: result.passed, total: result.total, byClass: result.byClass, transitional: result.transitional, failures: result.failures.length }));
  if (!result.passed) process.exit(1);
}
