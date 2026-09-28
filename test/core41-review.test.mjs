/* Core41: a second, narrow reviewer (edits applied one by one after review round 1 of PR #34) after the fact check (owner decision 27.09, option c). A model call looks only for
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
const VERGE = url("openai-training-pause"), SOL = url("sol-pi"), EXA = url("exa-launches"), STUDY = url("i-dont-know"), META = url("meta-connect"), TC = url("unsecured-openai");

// The patch a reviewer should return for 05a7f579: the 5 defects of the independent fact-check.
const LINES = RUN.factcheck.text.split("\n").filter((l) => /^\s*- /.test(l)).map((l) => l.replace(/^\s*- /, ""));
const before = (item) => LINES[item - 1].slice(0, 40);
const PATCH = { edits: [
  { item: 2, before: before(2), action: "revise", problem: "scope", reason: "The body pauses training, evaluation and inference with tool use, not all training; a loophole is «лазівка», not «вада».",
    text: `OpenAI призупинила навчання, оцінку та інференс з використанням інструментів для найпотужніших моделей після того, як тестова модель у пісочниці скористалася лазівкою й вийшла в інтернет ([The Verge](${VERGE}))`,
    quote: ["“All training, evaluation, and inference with tool-use” remains paused", "exploited a loophole to gain internet access", "pause training of its most powerful models"] },
  { item: 5, before: before(5), action: "revise", problem: "attribution", reason: "The researchers' result on EdgeBench's public tasks; «до 49%» read as the level reached.",
    text: `За даними дослідників Nvidia, SoL-Pi на 51 публічному завданні EdgeBench скорочує використання токенів агентами для програмування майже вдвічі без істотної втрати якості ([The Decoder](${SOL}))`,
    quote: ["Token usage drops by almost half while performance stays roughly the same, according to the researchers", "On EdgeBench's 51 public tasks, SoL-Pi performs about as well as the original Pi harness"] },
  { item: 6, before: before(6), action: "revise", problem: "attribution", reason: "Vendor-reported results on 4 named benchmarks, not «власні тести»; «вичерпної побудови».",
    text: `Exa випустила Agent Ultra — рій підагентів для вичерпної побудови списків, що, за даними компанії, перевершує Opus 5.5, GPT-6 Astra та Perplexity Agent у 4 бенчмарках ([MarkTechPost](${EXA}))`,
    quote: ["Exa team reports that Ultra beats Opus 5.5, GPT-6 Astra, and Perplexity Agent, each at maximum effort, on 4 research benchmarks", "All results are vendor-reported and not yet independently reproduced"] },
  { item: 8, before: before(8), action: "revise", problem: "scope", reason: "Five experiments on questions chosen so that the AI was almost always wrong; not a property of AI in general.",
    text: `У п'яти експериментах з питаннями, на які модель майже завжди відповідала неправильно, доступ до AI майже повністю позбавив учасників готовності відповісти «не знаю» ([The Decoder](${STUDY}))`,
    quote: ["Researchers ran five experiments with 3,132 participants", "Just having AI advice available nearly wiped out people's willingness to say \"I don't know.\"", "picked questions where the model they used, Step 3.5 Flash , was almost always wrong"] },
  { item: 3, before: before(3), action: "keep" },
] };
const clone = (v) => JSON.parse(JSON.stringify(v));
const check = (review, { config = CHECKS, factcheck = RUN.factcheck } = {}) =>
  runVerifySources({ config }, { priorOutputs: { articles: { sources: RUN.sources }, factcheck, review }, priorStepNames: {} });
const patched = (edits) => ({ edits });
const edit = (item, patch) => ({ ...clone(PATCH.edits.find((e) => e.item === item)), ...patch });

const remove = (item, reason = "x", problem = "scope") => ({ item, before: before(item), action: "remove", problem, reason });

test("05a7f579 with the review patch: the 5 defects are fixed, every edit accepted, every check passes on the edited text", () => {
  const out = check(PATCH).output;
  assert.ok(out.checks.includes("reviewed-for-overstatement") && out.checks.includes("fact-checked-claims"), out.checks.join());
  for (const kept of ["compact-links", "nested-item-word-limits", "nested-item-sentences", "outlet-link-text", "no-forbidden-phrases", "nested-order-by-cluster"]) assert.ok(out.checks.includes(kept), kept);
  assert.match(out.text, /призупинила навчання, оцінку та інференс з використанням інструментів/);
  assert.match(out.text, /скористалася лазівкою/);
  assert.doesNotMatch(out.text, /вадою|вичерпного побудови|власних тестах|AI часто помиляється|до 49%/);
  assert.deepEqual([out.review.revised, out.review.removed, out.review.kept, out.review.rejected.length], [4, 0, 1, 0]);
  assert.deepEqual(out.review.edits.map((e) => [e.item, e.action, e.problem ?? null]), [[2, "revise", "scope"], [3, "keep", null], [5, "revise", "attribution"], [6, "revise", "attribution"], [8, "revise", "scope"]]);
  assert.match(out.review.edits[0].before, /скористалася вадою/);
  const claim = out.factCheck.claims.find((c) => c.item === 8);
  assert.equal(claim.verdict, "revised");
  assert.match(claim.reason, /^review scope: Five experiments/);
  assert.match(out.factCheckSummary, /review: 4 revised, 0 removed, 0 rejected/);
  assert.match(JSON.stringify(out, null, 2).split("\n").slice(0, 40).join("\n"), /review: 4 revised, 0 removed, 0 rejected/);
});

test("an empty patch keeps the fact-checked text: the defects pass the deterministic layer (the reviewer is model judgement)", () => {
  const out = check({ edits: [] }).output;
  assert.match(out.text, /скористалася вадою/);
  assert.match(out.text, /AI часто помиляється/);
  assert.deepEqual([out.review.revised, out.review.removed, out.review.rejected.length], [0, 0, 0]);
});

test("review round 1 P1: removing one case keeps its theme; the theme's record keeps only the sources its cases still link", () => {
  const three = check(patched([remove(3, "unlisted links, not public")])).output;
  assert.doesNotMatch(three.text, /53 зображення/);
  assert.deepEqual(three.factCheck.claims.find((c) => c.item === 1).sources, [VERGE], "item 3's URL left theme 1's record");
  const removedClaim = three.factCheck.claims.find((c) => c.verdict === "removed");
  assert.equal(removedClaim.text, LINES[2], "the removed claim is exactly the removed line");
  assert.equal(three.review.edits[0].before, LINES[2]);
  assert.equal(three.factCheck.claims.filter((c) => c.verdict !== "removed").length, 9, "items renumbered 1..9");
  const seven = check(patched([remove(7, "not an agent system")])).output;
  assert.doesNotMatch(seven.text, /Julia 1/);
  assert.deepEqual(seven.factCheck.claims.find((c) => c.item === 4).sources, [SOL, EXA]);
  assert.equal(seven.review.rejected.length, 0);
  // Removing the only case that grounds the theme's quote needs the theme revised in the same review.
  const alone = check(patched([remove(2, "pause scope")])).output;
  assert.deepEqual(alone.review.rejected.map((r) => [r.item, r.action]), [[2, "remove"]]);
  assert.match(alone.review.rejected[0].error, /theme item 1 stands on sources its remaining cases no longer link; revise the theme in the same review/);
  assert.match(alone.text, /скористалася вадою/, "the rejected edit leaves the fact-checked line");
  assert.match(alone.factCheckSummary, /review: 0 revised, 0 removed, 1 rejected/);
  const theme = { item: 1, before: before(1), action: "revise", problem: "generalisation", reason: "Only the unsecured agents remain.", sources: [TC], text: "Незахищені дослідницькі агенти OpenAI діяли без відома лабораторії", quote: ["Unsecured OpenAI agents posted 53 user images on the internet without the lab's knowledge"] };
  const both = check(patched([remove(2, "pause scope"), theme])).output;
  assert.deepEqual([both.review.removed, both.review.revised, both.review.rejected.length], [1, 1, 0], "the removal is retried after the theme revision");
  assert.doesNotMatch(both.text, /вадою/);
});

test("remove: a theme goes only with all its cases; a review never removes every item", () => {
  const lone = check(patched([remove(4, "x", "generalisation")])).output;
  assert.match(lone.review.rejected[0].error, /removes list item 4, which has sub-items; remove all of them in the same review \(item 5 is kept\)/);
  const gone = check(patched([4, 5, 6, 7].map((item) => remove(item, "the theme is broader than its cases", "generalisation")))).output;
  assert.doesNotMatch(gone.text, /SoL-Pi|Agent Ultra|Julia 1|агентних AI-систем/);
  assert.deepEqual([gone.review.removed, gone.review.rejected.length], [4, 0]);
  const all = check(patched(Array.from({ length: 10 }, (_, i) => remove(i + 1)))).output;
  assert.ok(all.review.rejected.some((r) => /a review may not remove every item of the digest/.test(r.error)), JSON.stringify(all.review.rejected));
  assert.match(all.text, /\n- \S/, "at least one item stays");
  // Removing every case but keeping the theme leaves a theme without links: rejected, the cases stay.
  const orphan = check(patched([5, 6, 7].map((item) => remove(item)))).output;
  assert.ok(orphan.review.rejected.length > 0 && orphan.review.rejected.every((r) => /Every thesis needs a link|theme item 4/.test(r.error)), JSON.stringify(orphan.review.rejected));
  assert.match(orphan.text, /Supersonic Labs|SoL-Pi|Agent Ultra/);
});

test("review round 1 P2: a malformed or failing edit is rejected with its reason; the other edits still apply", () => {
  const good = PATCH.edits[3];
  const cases = {
    "an item that does not exist": [{ item: 11, before: "x".repeat(30), action: "remove", problem: "scope", reason: "x" }, /names list item 11, which is not an item of the fact-checked text \(1\.\.10\); a review adds no items/],
    "an unknown action": [{ item: 2, before: before(2), action: "add", problem: "scope", reason: "x" }, /action is «add»; an edit is keep, revise or remove/],
    "no problem class": [edit(2, { problem: "style" }), /problem «style»/],
    "no reason": [edit(2, { reason: "" }), /a revise edit needs a reason/],
    "no quote": [edit(2, { quote: [] }), /needs the verbatim quotes that support the new wording/],
    "two lines": [edit(2, { text: "Рядок один\n  - Рядок два" }), /needs the new text on one line/],
    "a before that is another item's line": [edit(2, { before: before(3) }), /its before .* is not the start of list item 2/],
    "a short before": [edit(2, { before: "OpenAI" }), /is not the start of list item 2/],
    "no before": [(({ before: _b, ...e }) => e)(edit(2, {})), /is not the start of list item 2/],
    "a keep with a new text": [{ item: 3, before: before(3), action: "keep", text: "інший текст" }, /a keep edit carries no text/],
    "a quote that is not in the article": [edit(5, { quote: ["researchers cut tokens on every benchmark"] }), /the quote is not in the text of its linked sources/],
    "a number the article does not state": [edit(5, { text: PATCH.edits[1].text.replace("51 публічному", "60 публічних") }), /states «60»/],
    "a bound dropped («almost half» as «вдвічі»)": [edit(5, { text: PATCH.edits[1].text.replace("майже вдвічі", "вдвічі") }), /states «вдвічі» exactly; its source says «almost/],
    "a case without its link": [edit(6, { text: PATCH.edits[2].text.replace(/ \(\[MarkTechPost\]\([^)]*\)\)$/, "") }), /Every thesis needs a link to a selected source; uncited: Exa випустила/],
    "a theme given a link": [{ item: 4, before: before(4), action: "revise", problem: "generalisation", reason: "x", text: `Нові системи для агентів ([The Decoder](${SOL}))`, quote: ["cuts coding agent token usage nearly in half"] }, /A list item with sub-items carries no links under compactLinks/],
    "a case over 32 words": [edit(6, { text: PATCH.edits[2].text.replace("у 4 бенчмарках", "у 4 бенчмарках, які компанія провела сама з максимальними налаштуваннями конкурентів, що не перевірено незалежно жодною сторонньою лабораторією") }), /A case has \d+ words; at most 32/],
    "two sentences": [edit(2, { text: PATCH.edits[0].text.replace(" після того,", ". Після того,") }), /has 2 sentences; at most 1/],
    "a forbidden calque": [edit(5, { text: PATCH.edits[1].text.replace("агентами для програмування", "кодувальних агентів") }), /uses «кодувальних агентів»/],
  };
  for (const [name, [bad, error]] of Object.entries(cases)) {
    const out = check(patched([bad, good])).output;
    assert.equal(out.review.rejected.length, 1, name);
    assert.match(out.review.rejected[0].error, error, name);
    assert.equal(out.review.revised, 1, `${name}: the good edit still applies`);
    assert.match(out.text, /У п'яти експериментах/, name);
  }
  // A second edit of the same item is rejected; the first stays.
  const dup = check(patched([PATCH.edits[0], edit(2, { text: PATCH.edits[0].text.replace("найпотужніших", "найздатніших") })])).output;
  assert.match(dup.review.rejected[0].error, /list item 2 has more than one review edit/);
  assert.match(dup.text, /найпотужніших моделей після того/);
  // Only an unreadable review output fails the run.
  assert.throws(() => check({ nothing: true }), /review must reference a review output \{edits:\[\.\.\.\]\}/);
  assert.throws(() => check("not json"), /review must reference a review output/);
  const { factCheck, ...noFact } = CHECKS;
  assert.throws(() => check(PATCH, { config: noFact }), /review requires factCheck and nestedList/);
});

test("Digest 0.8.0: a review call after the fact check; the checks apply its patch; the gate binds the edited text", () => {
  assert.equal(DIGEST.version, "0.8.1");
  const ids = DIGEST.steps.map((s) => s.id);
  assert.deepEqual(ids.slice(ids.indexOf("factcheck")), ["factcheck", "review", "checks", "approval", "delivery"]);
  const review = DIGEST.steps.find((s) => s.id === "review");
  const fc = DIGEST.steps.find((s) => s.id === "factcheck").config;
  assert.equal(review.kind, "llm-call");
  assert.deepEqual([review.config.provider, review.config.format, review.config.reasoning, review.config.input, review.config.model], ["openrouter", "json", "low", "{{steps.articles.output.clusters}}", "anthropic/claude-opus-5.5"]);
  assert.notEqual(review.config.model, fc.model, "owner decision 27.09: a stronger model for the review step only");
  assert.ok(Number(review.config.maxTokens) <= 4000, "a small patch, not the digest again");
  assert.match(review.config.instructions, /\{\{steps\.factcheck\.output\.text\}\}/);
  const words = (s) => new RegExp(s.split(" ").join("\\s+"), "i");
  for (const rule of ["Check EVERY item", "return an edit for each defect you find", "The article body decides, not the headline", "«на N%»", "weren't publicly listed", "one of several experiments is not «the study»", "stay attributed", "a theme says no more than its cases together", "comes only from the article, never from memory", "keeps that limit", "non-words", "agreement", "calques", "articleTruncated", "is not a reason to remove", "before", "sources", "When in doubt, revise to the narrower wording of the article, or remove", "Never add items"]) assert.match(review.config.instructions, words(rule), rule);
  assert.equal(CHECKS.review, "{{steps.review.output}}");
  assert.equal(CHECKS.factCheck, "{{steps.factcheck.output}}");
  assert.equal(ids[ids.indexOf("approval") - 1], "checks", "the gate binds the checks output: the edited text");
  assert.ok(DIGEST.settings.budgetUsd >= 0.5);
});

test("owner decision 27.09: the approval preview names each item the reviewer changed or had rejected, and why", () => {
  const bad = edit(6, { quote: ["researchers cut tokens on every benchmark"] });
  const out = check(patched([PATCH.edits[0], remove(9, "The article does not say the glasses keep users constantly connected.", "overstatement"), bad])).output;
  assert.deepEqual(Object.keys(out).slice(0, 3), ["text", "factCheckSummary", "reviewSummary"]);
  assert.deepEqual(out.reviewSummary.map((l) => l.replace(/:.*/, "")), ["review item 2 revised (scope)", "review item 6 rejected (attribution)", "review item 9 removed (overstatement)"]);
  assert.match(out.reviewSummary[1], /^review item 6 rejected \(attribution\): Vendor-reported results .* — not applied: List item \d+: the quote is not in the text/);
  assert.ok(out.reviewSummary.every((l) => l.length <= 260), "reasons and errors are cut");
  const preview = JSON.stringify(out, null, 2).split("\n").slice(0, 40).join("\n");
  for (const line of out.reviewSummary) assert.ok(preview.includes(JSON.stringify(line)), line);
  assert.match(preview, /review: 1 revised, 1 removed, 1 rejected/);
  // A long review is capped at 12 lines plus a count, so the digest text stays in view: 10 bad edits and 5 duplicates.
  const bad10 = (item) => ({ item, before: before(item), action: "revise", problem: "language", reason: `reason ${item}`, text: "x", quote: ["nowhere to be found in any article"] });
  const many = check(patched([...Array.from({ length: 10 }, (_, i) => bad10(i + 1)), ...[1, 2, 3, 4, 5].map(bad10)])).output;
  assert.equal(many.review.rejected.length, 15);
  assert.equal(many.reviewSummary.length, 13);
  assert.equal(many.reviewSummary.at(-1), "…and 3 more (see review in the checks output)");
  assert.ok(JSON.stringify(many, null, 2).split("\n").length > 40 && JSON.stringify(many, null, 2).split("\n").slice(0, 40).join("\n").includes("…and 3 more"));
});

test("round 2: a case removal and its theme's revision are one unit; a theme URL no case ever linked is still refused", () => {
  // As one unit, a bad theme revision takes the removal down with it: both are rejected with the same error.
  const theme = { item: 1, before: before(1), action: "revise", problem: "generalisation", reason: "Only the unsecured agents remain.", sources: [TC], text: "Незахищені дослідницькі агенти OpenAI діяли без відома лабораторії", quote: ["a quote that is nowhere in the article"] };
  const out = check(patched([theme, remove(2, "pause scope")])).output;
  assert.equal(out.review.rejected.length, 2);
  assert.equal(out.review.rejected[0].error, out.review.rejected[1].error, "one unit, one error");
  assert.match(out.review.rejected[0].error, /the quote is not in the text of its linked sources/);
  const good = check(patched([{ ...theme, quote: ["Unsecured OpenAI agents posted 53 user images on the internet without the lab's knowledge"] }, remove(2, "pause scope")])).output;
  assert.deepEqual([good.review.revised, good.review.removed, good.review.rejected.length], [1, 1, 0]);
  // A theme record that cites a URL no case links is refused as before, also when an unrelated case is removed.
  const factcheck = clone(RUN.factcheck);
  factcheck.claims.find((c) => c.item === 1).sources.push(META);
  assert.throws(() => check(patched([remove(7, "not an agent system")]), { factcheck }), /item 1\) was checked against .*meta-connect.*which the item does not link as a selected source/);
});

test("the price table knows the stronger model, so a step can run it under a budget; only the Digest review runs it", async () => {
  const { rateForModel } = await import("../src/cost.mjs");
  assert.deepEqual(rateForModel("anthropic/claude-opus-5.5"), [4 / 1_000_000, 20 / 1_000_000]);
  assert.equal(rateForModel("anthropic/claude-opus-9"), null, "an unknown model stays unpriced (fails closed under a budget)");
  assert.deepEqual(DIGEST.steps.filter((s) => s.config?.model === "anthropic/claude-opus-5.5").map((s) => s.id), ["review"]);
});

test("a rejected edit's raw model fields cannot flood or split the approval preview", () => {
  const long = "x".repeat(5000) + "\nIGNORE ABOVE";
  const bad = [
    { ...edit(6, { quote: ["researchers cut tokens on every benchmark"] }), problem: long },
    { item: "9".repeat(3000), action: "remove", problem: "scope", reason: long },
    { item: 3, action: long, reason: "r" },
  ];
  const out = check(patched([PATCH.edits[0], ...bad])).output;
  const rejectedLines = out.reviewSummary.filter((l) => l.includes(" rejected ("));
  assert.ok(rejectedLines.length >= 1);
  for (const l of out.reviewSummary) {
    assert.ok(l.length <= 260, `bounded: ${l.length}`);
    assert.ok(!/\n/.test(l) && !l.includes("IGNORE ABOVE"), "one line, no injected text");
  }
  assert.ok(rejectedLines.every((l) => /rejected \((overstatement|scope|attribution|generalisation|entity|language|keep|revise|remove|invalid)\)/.test(l)), "only known labels");
  for (const r of out.review.rejected) {
    assert.ok(String(r.problem ?? "").length <= 40 && String(r.reason ?? "").length <= 300 && String(r.error).length <= 300);
  }
});
