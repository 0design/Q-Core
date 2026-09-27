/* Core41: a second, narrow reviewer after the fact check (owner decision 27.09, option c). A model call looks only for
   overstatement, scope, attribution, generalisation and entity problems and returns a small patch; verify-sources
   applies it deterministically before every other check, which then runs on the edited text. The fixture is live run
   05a7f579 (Digest 0.7.0): its checks passed, and an independent fact-check against the full articles found 5 wording
   defects. The hand-made patch below fixes them and must pass every check; offline, no model is called. */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadManifest } from "../src/manifest.mjs";
import { runVerifySources } from "../src/registry-data-steps.mjs";

process.env.QF_DIGEST_DATE = "26.09";
const RUN = JSON.parse(readFileSync(resolve("test/fixtures/digest-run-05a7f579.json"), "utf8"));
const DIGEST = loadManifest(resolve("registry/workflows/digest.yaml"));
const CHECKS = DIGEST.steps.find((s) => s.id === "checks").config;
const url = (part) => RUN.sources.find((s) => s.url.includes(part)).url;
const VERGE = url("openai-training-pause"), SOL = url("sol-pi"), EXA = url("exa-launches"), STUDY = url("i-dont-know"), META = url("meta-connect");

// The patch a reviewer should return for 05a7f579: the 5 defects of the independent fact-check.
const PATCH = { edits: [
  { item: 2, action: "revise", problem: "scope", reason: "The body pauses training, evaluation and inference with tool use, not all training; a loophole is «лазівка», not «вада».",
    text: `OpenAI призупинила навчання, оцінку та інференс з використанням інструментів для найпотужніших моделей після того, як тестова модель у пісочниці скористалася лазівкою й вийшла в інтернет ([The Verge](${VERGE}))`,
    quote: ["“All training, evaluation, and inference with tool-use” remains paused", "exploited a loophole to gain internet access", "pause training of its most powerful models"] },
  { item: 5, action: "revise", problem: "attribution", reason: "The researchers' result on EdgeBench's public tasks; «до 49%» read as the level reached.",
    text: `За даними дослідників Nvidia, SoL-Pi на 51 публічному завданні EdgeBench скорочує використання токенів агентами для програмування майже вдвічі без істотної втрати якості ([The Decoder](${SOL}))`,
    quote: ["Token usage drops by almost half while performance stays roughly the same, according to the researchers", "On EdgeBench's 51 public tasks, SoL-Pi performs about as well as the original Pi harness"] },
  { item: 6, action: "revise", problem: "attribution", reason: "Vendor-reported results on 4 named benchmarks, not «власні тести»; «вичерпної побудови».",
    text: `Exa випустила Agent Ultra — рій підагентів для вичерпної побудови списків, що, за даними компанії, перевершує Opus 5.5, GPT-6 Astra та Perplexity Agent у 4 бенчмарках ([MarkTechPost](${EXA}))`,
    quote: ["Exa team reports that Ultra beats Opus 5.5, GPT-6 Astra, and Perplexity Agent, each at maximum effort, on 4 research benchmarks", "All results are vendor-reported and not yet independently reproduced"] },
  { item: 8, action: "revise", problem: "scope", reason: "Five experiments on questions chosen so that the AI was almost always wrong; not a property of AI in general.",
    text: `У п'яти експериментах з питаннями, на які модель майже завжди відповідала неправильно, доступ до AI майже повністю позбавив учасників готовності відповісти «не знаю» ([The Decoder](${STUDY}))`,
    quote: ["Researchers ran five experiments with 3,132 participants", "Just having AI advice available nearly wiped out people's willingness to say \"I don't know.\"", "picked questions where the model they used, Step 3.5 Flash , was almost always wrong"] },
  { item: 3, action: "keep" },
] };
const clone = (v) => JSON.parse(JSON.stringify(v));
const check = (review, { config = CHECKS, factcheck = RUN.factcheck } = {}) =>
  runVerifySources({ config }, { priorOutputs: { articles: { sources: RUN.sources }, factcheck, review }, priorStepNames: {} });
const patched = (edits) => ({ edits });
const edit = (item, patch) => ({ ...clone(PATCH.edits.find((e) => e.item === item)), ...patch });

test("05a7f579 with the review patch: the 5 defects are fixed and every check passes on the edited text", () => {
  const out = check(PATCH).output;
  assert.ok(out.checks.includes("reviewed-for-overstatement") && out.checks.includes("fact-checked-claims"), out.checks.join());
  for (const kept of ["compact-links", "nested-item-word-limits", "nested-item-sentences", "outlet-link-text", "no-forbidden-phrases", "nested-order-by-cluster"]) assert.ok(out.checks.includes(kept), kept);
  assert.match(out.text, /призупинила навчання, оцінку та інференс з використанням інструментів/);
  assert.match(out.text, /скористалася лазівкою/);
  assert.doesNotMatch(out.text, /вадою|вичерпного побудови|власних тестах|AI часто помиляється|до 49%/);
  assert.match(out.text, /За даними дослідників Nvidia, SoL-Pi на 51 публічному завданні EdgeBench/);
  assert.deepEqual([out.review.revised, out.review.removed, out.review.kept], [4, 0, 1]);
  assert.deepEqual(out.review.edits.map((e) => [e.item, e.action, e.problem ?? null]), [[2, "revise", "scope"], [3, "keep", null], [5, "revise", "attribution"], [6, "revise", "attribution"], [8, "revise", "scope"]]);
  assert.match(out.review.edits[0].before, /скористалася вадою/);
  const claim = out.factCheck.claims.find((c) => c.item === 8);
  assert.equal(claim.verdict, "revised");
  assert.match(claim.reason, /^review scope: Five experiments/);
  assert.match(out.factCheckSummary, /review: 4 revised, 0 removed/);
  // The approval preview (first 40 lines) shows the review counts.
  assert.match(JSON.stringify(out, null, 2).split("\n").slice(0, 40).join("\n"), /review: 4 revised, 0 removed/);
});

test("an empty patch keeps the fact-checked text: the defects pass the deterministic layer (the reviewer is model judgement)", () => {
  const out = check({ edits: [] }).output;
  assert.match(out.text, /скористалася вадою/);
  assert.match(out.text, /AI часто помиляється/);
  assert.deepEqual([out.review.revised, out.review.removed], [0, 0]);
});

test("remove: an item goes and its claim becomes a removed claim; a theme goes only with all its cases", () => {
  const out = check(patched([{ item: 9, action: "remove", problem: "overstatement", reason: "The article does not say the glasses keep users constantly connected." }])).output;
  assert.doesNotMatch(out.text, /смарт-окуляри/);
  assert.equal(out.factCheck.claims.filter((c) => c.verdict !== "removed").length, 9, "items renumbered 1..9");
  assert.ok(out.factCheck.claims.some((c) => c.item === 9 && /Федоров|Армія роботів/.test(out.text)));
  assert.equal(out.factCheck.claims.find((c) => c.verdict === "removed").reason, "review overstatement: The article does not say the glasses keep users constantly connected.");
  assert.match(out.factCheckSummary, /review: 0 revised, 1 removed/);
  // A theme with a remaining case is refused; the theme with all its cases goes as a group.
  assert.throws(() => check(patched([{ item: 4, action: "remove", problem: "generalisation", reason: "x" }])), /Review removes list item 4, which has sub-items; remove all of them in the same review \(item 5 is kept\)/);
  const group = [4, 5, 6, 7].map((item) => ({ item, action: "remove", problem: "generalisation", reason: "the theme is broader than its cases" }));
  const gone = check(patched(group)).output;
  assert.doesNotMatch(gone.text, /SoL-Pi|Agent Ultra|Julia 1|агентних AI-систем/);
  assert.equal(gone.review.removed, 4);
  // Removing every case but keeping the theme leaves a theme without links: the checks refuse it.
  assert.throws(() => check(patched([5, 6, 7].map((item) => ({ item, action: "remove", problem: "scope", reason: "x" })))), /Every thesis needs a link to a selected source; uncited: Нові розробки/);
});

test("a malformed patch refuses the run: unknown or duplicate items, unknown actions, missing fields", () => {
  const cases = {
    "an item that does not exist": [[{ item: 11, action: "remove", problem: "scope", reason: "x" }], /names list item 11, which is not an item of the fact-checked text \(1\.\.10\); a review adds no items/],
    "item 0": [[{ item: 0, action: "keep" }], /names list item 0/],
    "two edits of one item": [[edit(2, {}), edit(2, {})], /list item 2 has more than one review edit/],
    "an unknown action": [[{ item: 2, action: "add", problem: "scope", reason: "x" }], /action «add»; an edit is keep, revise or remove/],
    "no problem class": [[edit(2, { problem: "style" })], /names the problem «style»/],
    "no reason": [[edit(2, { reason: "" })], /\(revise\) needs a reason/],
    "no quote": [[edit(2, { quote: [] })], /needs the verbatim quotes that support the new wording/],
    "two lines": [[edit(2, { text: "Рядок один\n  - Рядок два" })], /needs its new text on one line/],
  };
  for (const [name, [edits, error]] of Object.entries(cases)) assert.throws(() => check(patched(edits)), error, name);
  assert.throws(() => check({ nothing: true }), /review must reference a review output \{edits:\[\.\.\.\]\}/);
  const { factCheck, ...noFact } = CHECKS;
  assert.throws(() => check(PATCH, { config: noFact }), /review requires factCheck and nestedList/);
});

test("a revised line is checked like any item: its quote, numbers, links, length and one sentence", () => {
  const cases = {
    "a quote that is not in the article": [edit(8, { quote: ["the AI was wrong in most real-world use"] }), /List item 8: the quote is not in the text of its linked sources/],
    "a number the article does not state": [edit(5, { text: PATCH.edits[1].text.replace("51 публічному", "60 публічних") }), /states «60»/],
    "a bound dropped («almost half» as «вдвічі»)": [edit(5, { text: PATCH.edits[1].text.replace("майже вдвічі", "вдвічі") }), /states «вдвічі» exactly; its source says «almost/],
    "a case without its link": [edit(6, { text: PATCH.edits[2].text.replace(/ \(\[MarkTechPost\]\([^)]*\)\)$/, "") }), /Every thesis needs a link to a selected source; uncited: Exa випустила/],
    "a theme given a link": [{ item: 4, action: "revise", problem: "generalisation", reason: "x", text: `Нові системи для агентів ([The Decoder](${SOL}))`, quote: ["cuts coding agent token usage nearly in half"] }, /A list item with sub-items carries no links under compactLinks/],
    "a case over 32 words": [edit(8, { text: PATCH.edits[3].text.replace("майже повністю", "майже повністю, як пишуть автори п'яти експериментів з понад трьома тисячами учасників у дослідженні, опублікованому цього тижня,") }), /A case has \d+ words; at most 32/],
    "two sentences": [edit(2, { text: PATCH.edits[0].text.replace(" після того,", ". Після того,") }), /has 2 sentences; at most 1/],
    "a forbidden calque": [edit(5, { text: PATCH.edits[1].text.replace("агентами для програмування", "кодувальних агентів") }), /uses «кодувальних агентів»/],
  };
  for (const [name, [e, error]] of Object.entries(cases)) assert.throws(() => check(patched([e])), error, name);
});

test("Digest 0.8.0: a review call after the fact check; the checks apply its patch; the gate binds the edited text", () => {
  assert.equal(DIGEST.version, "0.8.0");
  const ids = DIGEST.steps.map((s) => s.id);
  assert.deepEqual(ids.slice(ids.indexOf("factcheck")), ["factcheck", "review", "checks", "approval", "delivery"]);
  const review = DIGEST.steps.find((s) => s.id === "review");
  const fc = DIGEST.steps.find((s) => s.id === "factcheck").config;
  assert.equal(review.kind, "llm-call");
  assert.deepEqual([review.config.provider, review.config.format, review.config.reasoning, review.config.input, review.config.model], ["openrouter", "json", "low", "{{steps.articles.output.clusters}}", fc.model]);
  assert.ok(Number(review.config.maxTokens) <= 4000, "a small patch, not the digest again");
  assert.match(review.config.instructions, /\{\{steps\.factcheck\.output\.text\}\}/);
  const words = (s) => new RegExp(s.split(" ").join("\\s+"), "i");
  for (const rule of ["Look ONLY for these problems", "The article body decides, not the headline", "«на N%»", "weren't publicly listed", "one of several experiments is not «the study»", "stay attributed", "a theme says no more than its cases together", "comes only from the article, never from memory", "When in doubt, revise to the narrower wording of the article, or remove", "listing ONLY the items you change", "Never add items"]) assert.match(review.config.instructions, words(rule), rule);
  assert.equal(CHECKS.review, "{{steps.review.output}}");
  assert.equal(CHECKS.factCheck, "{{steps.factcheck.output}}");
  assert.equal(ids[ids.indexOf("approval") - 1], "checks", "the gate binds the checks output: the edited text");
  assert.ok(DIGEST.settings.budgetUsd >= 0.5);
});
