/* Core37: a created workflow may not write files or send data before a person approves the run (E2E run 9,
   27.09: the agent took a dismissed question as consent and built a gate-free workflow around its own script).
   Also the Digest label and outlet-name leftovers of the Core36 review. */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { validateManifest, loadManifest, sideEffectOf } from "../src/manifest.mjs";
import { parseYaml } from "../src/yaml.mjs";
import { runVerifySources } from "../src/registry-data-steps.mjs";

const BIN = resolve("bin/q-core.mjs");
const doc = (steps, extra = "") => parseYaml(`manifest: q-core.workflow/v1\nid: created\nversion: 0.1.0\n${extra}steps:\n${steps}`);
const HUMAN = `  - id: approval\n    kind: approval-gate\n    config:\n      reviewer: human\n      bind: sha256\n`;
const AGENT = `  - id: judge\n    kind: approval-gate\n    config:\n      reviewer: agent\n      rubric: "looks fine"\n`;
const POST = `  - id: send\n    kind: api-request\n    config:\n      url: "https://hooks.example/x"\n`;
const FETCH = `  - id: feed\n    kind: fetch\n    config:\n      url: "https://feed.example/rss"\n`;

// The manifest E2E run 9 produced (Core35, 27.09): a decorative workspace-read, the work in the agent's own script.
const RUN9 = `manifest: q-core.workflow/v1
id: todo-scan
name: "Morning TODO/FIXME summary"
version: 1.0.0
triggers:
  - kind: schedule
    cron: "3 7 * * *"
  - kind: manual
settings:
  budgetUsd: 0
  exit:
    kind: always_done
steps:
  - id: read-tree
    kind: workspace-read
    config:
      name: "Read the working tree and pin the summary artifact + verifier by hash"
`;

test("GATE_REQUIRED negative examples: side effects with no human gate before them on the same path", () => {
  const refused = {
    "POST with no gate": FETCH + POST,
    "POST is the default method": POST,
    "PUT, PATCH and DELETE are writes too": POST.replace('url:', 'method: DELETE\n      url:'),
    "only an agent gate": FETCH + AGENT + POST,
    "the human gate comes after the side effect": FETCH + POST + HUMAN,
    "a gate inside an if branch does not guard the step after the if": `  - id: check\n    kind: if\n    config:\n      condition: "true"\n    then:\n${HUMAN.replace(/^/gm, "    ").trimEnd()}\n${POST}`,
    "a gate in one switch case does not guard another": `  - id: route\n    kind: switch\n    config:\n      on: "a"\n    cases:\n      a:\n${HUMAN.replace(/^/gm, "      ").trimEnd()}\n      b:\n${POST.replace(/^/gm, "      ").trimEnd()}\n`,
    "a side effect inside a fan-out lane with no gate": `${FETCH}  - id: each\n    kind: fan-out\n    then:\n${POST.replace(/^/gm, "    ").trimEnd()}\n`,
    "workspace-apply with no gate": `  - id: ws\n    kind: workspace-read\n  - id: proposal\n    kind: llm-call\n    config:\n      instructions: "write"\n      input: "{{steps.ws.output}}"\n  - id: apply\n    kind: workspace-apply\n    config:\n      source: "{{steps.proposal.output}}"\n`,
  };
  for (const [name, steps] of Object.entries(refused)) {
    assert.throws(() => validateManifest(doc(steps)), /GATE_REQUIRED: step "(send|apply)"/, name);
  }
  assert.throws(() => validateManifest(doc(FETCH + POST)), /add an approval-gate step with reviewer: human.*Do not move the work into your own script/s);
});

test("GATE_REQUIRED positive examples: a human gate earlier on the path, read-only steps, reviewed Registry shapes", () => {
  for (const [name, steps] of Object.entries({
    "human gate before POST": FETCH + HUMAN + POST,
    "human gate by default (no reviewer field)": FETCH + HUMAN.replace("      reviewer: human\n", "") + POST,
    "agent gate then human gate": FETCH + AGENT + HUMAN + POST,
    "GET is a read": POST.replace('url:', 'method: GET\n      url:'),
    "no side effect at all": FETCH + `  - id: sum\n    kind: llm-call\n    config:\n      instructions: "summarise"\n      input: "{{steps.feed.output}}"\n`,
    "a gate before an if guards its branches": `${HUMAN}  - id: check\n    kind: if\n    config:\n      condition: "true"\n    then:\n${POST.replace(/^/gm, "    ").trimEnd()}\n`,
    "a gate before a fan-out guards its lanes": `${FETCH}${HUMAN}  - id: each\n    kind: fan-out\n    then:\n${POST.replace(/^/gm, "    ").trimEnd()}\n`,
  })) assert.doesNotThrow(() => validateManifest(doc(steps)), name);
  assert.doesNotThrow(() => validateManifest(doc(FETCH + POST), { reviewed: true }), "reviewed Registry shape");
  assert.equal(sideEffectOf({ kind: "api-request", config: { method: "get" } }), null);
  assert.match(sideEffectOf({ kind: "workspace-apply", config: {} }), /writes project files/);
});

test("the Registry: every workflow validates as reviewed; created from scratch, the gate-free ones are refused", () => {
  const dir = resolve("registry/workflows");
  const gateFree = [];
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".yaml"))) {
    const file = join(dir, f);
    assert.doesNotThrow(() => loadManifest(file, { reviewed: true }), f);
    try { loadManifest(file); } catch (e) { assert.match(e.message, /GATE_REQUIRED/, f); gateFree.push(f.replace(".yaml", "")); }
  }
  // Human-gated templates pass as created manifests too (they are safe to adapt).
  for (const id of ["sdd-pipeline", "digest", "content-factory", "price-watch", "podcast-summary"]) assert.ok(!gateFree.includes(id), id);
  assert.ok(gateFree.includes("webhook-relay") && gateFree.includes("strict-gate"), gateFree.join(","));
});

test("q-core install lock: an unchanged install is reviewed; an adapted copy or a forged hash is not", () => {
  const dir = mkdtempSync(join(tmpdir(), "q-core37-")), file = join(dir, "webhook-relay.yaml");
  const bytes = readFileSync(resolve("registry/workflows/webhook-relay.yaml"));
  writeFileSync(file, bytes);
  const m = parseYaml(bytes.toString());
  const lock = (sha) => writeFileSync(`${file}.lock.json`, JSON.stringify({ protocolVersion: "qf.registry-lock/v1", id: m.id, version: String(m.version), resolved: [{ key: `workflows/${m.id}@${m.version}`, sha256: sha }] }));
  assert.throws(() => loadManifest(file), /GATE_REQUIRED/, "no lock: a created manifest");
  lock(createHash("sha256").update(bytes).digest("hex"));
  assert.doesNotThrow(() => loadManifest(file), "unchanged Registry install");
  writeFileSync(file, bytes.toString() + "# adapted in chat\n");
  assert.throws(() => loadManifest(file), /GATE_REQUIRED/, "adapted copy: the lock hash no longer matches");
  lock("0".repeat(64));
  writeFileSync(file, bytes);
  assert.throws(() => loadManifest(file), /GATE_REQUIRED/, "lock hash for other bytes");
});

test("UNUSED_WORKSPACE_READ: the run-9 manifest (a decorative read, work in the agent's script) is refused", () => {
  assert.throws(() => validateManifest(parseYaml(RUN9)), /UNUSED_WORKSPACE_READ: no step uses the output of workspace-read "read-tree"/);
  assert.throws(() => validateManifest(parseYaml(RUN9), { reviewed: true }), /UNUSED_WORKSPACE_READ/, "refused in every workflow");
  // A read that a later step uses is fine; so is the Registry SDD shape as a created manifest.
  assert.doesNotThrow(() => validateManifest(doc(`  - id: ws\n    kind: workspace-read\n  - id: sum\n    kind: llm-call\n    config:\n      instructions: "summarise"\n      input: "{{steps.ws.output.files}}"\n`)));
  assert.doesNotThrow(() => loadManifest(resolve("registry/workflows/sdd-pipeline.yaml")));
  // A reference to a different step with the same prefix does not count.
  assert.throws(() => validateManifest(doc(`  - id: ws\n    kind: workspace-read\n  - id: ws-2\n    kind: fetch\n    config:\n      url: "https://x.example"\n  - id: sum\n    kind: llm-call\n    config:\n      instructions: "x"\n      input: "{{steps.ws-2.output}}"\n`)), /UNUSED_WORKSPACE_READ/);
});

test("q-core validate refuses both shapes at create time with a non-zero exit and names the fix", () => {
  const dir = mkdtempSync(join(tmpdir(), "q-core37-cli-"));
  const env = { ...process.env, QF_NO_UPDATE_CHECK: "1" };
  const run9 = join(dir, "todo-scan.yaml"); writeFileSync(run9, RUN9);
  let r = spawnSync(process.execPath, [BIN, "validate", run9], { encoding: "utf8", env });
  assert.notEqual(r.status, 0); assert.match(r.stderr + r.stdout, /UNUSED_WORKSPACE_READ/);
  const post = join(dir, "notify.yaml"); writeFileSync(post, `manifest: q-core.workflow/v1\nid: notify\nversion: 0.1.0\nsteps:\n${FETCH}${POST}`);
  r = spawnSync(process.execPath, [BIN, "validate", post], { encoding: "utf8", env });
  assert.notEqual(r.status, 0); assert.match(r.stderr + r.stdout, /GATE_REQUIRED/);
  r = spawnSync(process.execPath, [BIN, "run", post, "--dry-run"], { encoding: "utf8", env });
  assert.notEqual(r.status, 0, "run refuses too"); assert.match(r.stderr + r.stdout, /GATE_REQUIRED/);
  const gated = join(dir, "gated.yaml"); writeFileSync(gated, `manifest: q-core.workflow/v1\nid: gated\nversion: 0.1.0\nsteps:\n${FETCH}${HUMAN}${POST}`);
  r = spawnSync(process.execPath, [BIN, "validate", gated], { encoding: "utf8", env });
  assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /stops for a human/);
});

/* Digest leftovers of the Core36 review (0.5.0): label variants and publisher names. */
const HEADER = "**Штучно-інтелектуальний дайджест під суботню каву на [ХУЇКС](https://t.me/xyiikc)і by [QFactory.io](https://QFactory.io) 🧋27.09**";
const G = "https://blog.google/technology/ai/gemini-agents/", BBC = "https://www.bbc.co.uk/news/technology-1", EL = "https://electrek.co/2026/09/26/byd/", V = "https://www.theverge.com/ai/1";
const SOURCES = { sources: [{ url: G, text: "g" }, { url: BBC, text: "b" }, { url: EL, text: "e" }, { url: V, text: "v" }] };
const LABELS = '["Загальна картина","Кейси","Кейс","Тренд","Тренди","Висновки","Підсумок","Коментар"]';
const FORMAT = { citation: "links", forbidLocalLinks: "true", fixedLinks: '["https://t.me/xyiikc","https://QFactory.io"]', requiredPrefix: `${HEADER}\n\n`, nestedList: "3", forbiddenLabels: LABELS, outletLinkText: "true" };
const verify = (text) => runVerifySources({ config: { draft: "{{steps.draft.output}}", sources: "{{steps.clusters.output}}", language: "uk", ...FORMAT } }, { priorOutputs: { clusters: SOURCES, draft: { text } }, priorStepNames: {} });
const item = (text) => `${HEADER}\n\n- ${text}\n`;

test("forbiddenLabels negative examples: quoted, emoji, HTML and escaped-HTML label variants are refused", () => {
  const refused = {
    "guillemets and colon": "«Кейси»: Google відкрила агентів ([Google](" + G + "))",
    "curly quotes": "“Тренд”: агенти всюди ([The Verge](" + V + "))",
    "emoji before the label": "📌 Кейси: BYD знижує ціни ([Electrek](" + EL + "))",
    "emoji and bold": "🔥 **Тренди** — агенти ([The Verge](" + V + "))",
    "HTML bold": "<b>Кейси</b>: BBC про агентів ([BBC](" + BBC + "))",
    "escaped HTML bold": "&lt;b&gt;Кейси&lt;/b&gt;: BBC про агентів ([BBC](" + BBC + "))",
    "double-escaped HTML": "&amp;lt;b&amp;gt;Висновки&amp;lt;/b&amp;gt;: ([BBC](" + BBC + "))",
    "numeric entity quote": "&#171;Підсумок&#187; — ([BBC](" + BBC + "))",
    "label as the link text": "[Кейси](" + V + "): агенти ([The Verge](" + V + "))",
    "label, emoji, then colon": "Кейси 📌: BYD ([Electrek](" + EL + "))",
    "strikethrough and underscores": "~~_Коментар_~~: ([The Verge](" + V + "))",
  };
  for (const [name, text] of Object.entries(refused)) assert.throws(() => verify(item(text)), /opens with the section label/, name);
  // Not labels: themes that merely start with label-like words, or mention a label later.
  for (const text of [
    "Трендові моделі стають агентами ([The Verge](" + V + "))",
    "Кейсове навчання в Google ([Google](" + G + "))",
    "📌 Google відкрила агентів: кейси вже є ([Google](" + G + "))",
  ]) assert.doesNotThrow(() => verify(item(text)), text);
});

test("outletLinkText: blog.google, bbc.co.uk and electrek.co accept their publisher names; wrong names still fail", () => {
  const ok = [
    ["Google", G], ["Google Blog", G], ["The Keyword (Google)", G], ["BBC", BBC], ["BBC News", BBC], ["Electrek", EL], ["The Verge", V],
  ];
  for (const [name, url] of ok) assert.doesNotThrow(() => verify(item(`Агенти ([${name}](${url}))`)), `${name} for ${url}`);
  const bad = [
    ["Blog", G, "a generic prefix is not the publisher"], ["Co", BBC, "a generic second level is not the publisher"], ["UK", BBC, "a country code is not the publisher"],
    ["The Verge", BBC, "another outlet"], ["тут", EL, "not a name"], ["co", EL, "a TLD"], ["news", BBC, "a generic word"],
  ];
  for (const [name, url, why] of bad) assert.throws(() => verify(item(`Агенти ([${name}](${url}))`)), /must name its outlet/, `${name} for ${url}: ${why}`);
});
