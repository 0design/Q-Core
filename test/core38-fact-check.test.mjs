/* Core38: the Digest checks each claim against its linked source before the human gate. A fact-check model step
   returns claim records and the revised text; verify-sources checks the records deterministically (verbatim quotes
   in the source text the Core holds, numbers, one record per list item, removed claims absent) and the gate binds
   the checked text. Examples: the five errors an independent fact-check found in live run 65ef7d49 (Digest 0.5.0).
   The deterministic layer refuses error 4 (numbers) and the listed phrases of error 5 whatever the model says;
   errors 1-3 are refused only when the fact-check record admits them (a verdict, a missing or invented quote,
   removed wording left in the text). Recorded as «supported» with a genuine quote they pass: see the limit test. Offline: the fixture holds the run's selected sources (feed-item title and summary) and draft. */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadManifest } from "../src/manifest.mjs";
import { runVerifySources, numberTokens, nestedWords, nestedSentences } from "../src/registry-data-steps.mjs";

process.env.QF_DIGEST_DATE = "26.09";
const RUN = JSON.parse(readFileSync(resolve("test/fixtures/digest-run-65ef7d49.json"), "utf8"));
const url = (part) => RUN.sources.find((s) => s.url.includes(part)).url;
const V_OPENAI = url("openai-training-pause"), D_OPENAI = url("openai-pauses-its-most-capable");
const W_COURT = url("appeals-court"), D_COURT = url("pentagon-was-right");
const T_MUSE = url("meta-opens-early-access"), V_MUSE = url("meta-muse-filesystem");
const T_AKAMAI = url("akamai"), T_NSCALE = url("nscale"), V_MS = url("copilot-super-app");
const D_STUDY = url("i-dont-know"), D_NVIDIA = url("sol-pi");
const HEADER = "**Штучно-інтелектуальний дайджест під суботню каву на [ХУЇКС](https://t.me/xyiikc)і by [QFactory.io](https://QFactory.io) 🧋26.09**\n\n";

// The shipped Digest checks config, so the tests hold the workflow's own wiring, not a copy of it.
const DIGEST = loadManifest(resolve("registry/workflows/digest.yaml"));
const CHECKS = DIGEST.steps.find((s) => s.id === "checks").config;

// The live draft corrected the way the independent fact-check asked, in the Digest 0.6 form (owner review 27.09):
// compact links (a theme with cases carries none, its cases link the sources) and short items (one sentence each).
const ITEMS = [
  `- OpenAI призупинила найпотужніші моделі після інцидентів з агентами, а Muse від Meta відкрила користувачам свою файлову систему`,
  `  - OpenAI призупинила навчання, оцінку та інференс з доступом до інструментів для найпотужніших моделей, після того як агенти обійшли ізоляцію й злили GitHub-токен ([The Verge](${V_OPENAI}), [The Decoder](${D_OPENAI}))`,
  `  - Meta зробила файлову систему Muse ще доступнішою для користувачів ([The Verge](${V_MUSE}))`,
  `- Апеляційний суд дозволив Пентагону визнати Anthropic ризиком для ланцюга поставок, і, за словами компанії, це вже коштувало їй мільярди ([Wired](${W_COURT}), [The Decoder](${D_COURT}))`,
  `- AI-компанії продовжують вкладати мільярди в хмарні потужності й дата-центри`,
  `  - Anthropic заплатить Akamai $11,6 млрд за сім років за хмарні потужності на CPU, а Akamai дає їй частку до 5% акцій ([TechCrunch](${T_AKAMAI}))`,
  `  - Британська Nscale перед IPO у США залучила $3,36 млрд конвертованого фінансування на дата-центри для AI ([TechCrunch](${T_NSCALE}))`,
  `- Microsoft представила Copilot «super app», що об'єднує чат, кодування та агентів в одному інтерфейсі ([The Verge](${V_MS}))`,
  `- У дослідженні з понад 3000 учасників доступ до AI знизив частку відповідей «не знаю» з 44% до 3%, а правильних відповідей користувачі AI давали втричі рідше ([The Decoder](${D_STUDY}))`,
  `- Система Nvidia SoL-Pi скорочує витрати токенів агентів для програмування майже вдвічі (до 49%) без помітної втрати якості ([The Decoder](${D_NVIDIA}))`,
];
const CLAIMS = [
  // A theme without links is checked against the sources its cases link.
  { item: 1, verdict: "revised", sources: [D_OPENAI, V_MUSE], quote: ['OpenAI pauses its "most capable models" after agents exploit loopholes and leak data', "Meta's Muse would expose its filesystem to curious users"], reason: "The draft generalised that frontier models escape their limits; the sources report two incidents, and Meta's filesystem exposure is not an escape." },
  { item: 2, verdict: "revised", sources: [D_OPENAI], quote: ["OpenAI has paused tool-based training, evaluation, and inference for its most capable models", "One research model exploited a DNS loophole to reach the internet from a locked-down environment, while another deliberately leaked a GitHub token"], reason: "Only tool-based training, evaluation and inference was paused." },
  { item: 3, verdict: "revised", sources: [V_MUSE], quote: ["Meta makes the Muse filesystem even more accessible"], reason: "Meta treats the exposure as intended; not a slip under the hood." },
  { item: 4, verdict: "revised", sources: [D_COURT], quote: ["A federal appeals court has upheld the Pentagon's decision to bar Anthropic from military contracts", "Anthropic says the designation has already cost it billions"], reason: "The court did not adopt the Pentagon's argument; the cost is the designation's." },
  { verdict: "removed", text: "погодившись з аргументом Міноборони, що безпекові обмеження Anthropic можуть загрожувати операціям", reason: "The argument is Hegseth's; the source does not say the court agreed with it." },
  { item: 5, verdict: "revised", sources: [T_AKAMAI, T_NSCALE], quote: ["Anthropic has committed $11.6 billion over seven years to Akamai's cloud infrastructure", "Nscale secures $3.36B in convertible financing"], reason: "Regulatory risks and compute costs appear in no source." },
  { verdict: "removed", text: "не зважаючи на регуляторні ризики та зростання витрат на обчислення", reason: "No source mentions regulatory risks or rising compute costs." },
  { item: 6, verdict: "supported", sources: [T_AKAMAI], quote: ["Anthropic has committed $11.6 billion over seven years to Akamai's cloud infrastructure, a bet on CPUs", "Akamai is giving Anthropic a potential stake of up to 5% of its stock"] },
  { item: 7, verdict: "supported", sources: [T_NSCALE], quote: ["Ahead of US IPO, British AI neocloud Nscale secures $3.36B in convertible financing", "will fuel the company's massive AI data center buildout"] },
  { item: 8, verdict: "supported", sources: [V_MS], quote: ["Microsoft is officially unveiling it today", "bundles three AI capabilities into a single interface of chat, coding, and agents"] },
  { item: 9, verdict: "revised", sources: [D_STUDY], quote: ["A study with more than 3,000 participants shows that just having access to AI answers nearly eliminated people's willingness to say \"I don't know.\"", "it dropped from 44 to 3 percent", "were correct only about a third as often as those without it"], reason: "Three times less often, not in a third of the cases." },
  { item: 10, verdict: "revised", sources: [D_NVIDIA], quote: ["Nvidia's SoL-Pi system cuts coding agent token usage nearly in half", "SoL-Pi cuts coding agents' token usage by up to 49 percent with little change in performance"], reason: "«кодувальних агентів» is a calque; the count of runs is a secondary detail." },
];
const textOf = (items) => `${HEADER}${items.join("\n")}\n`;
const REVISED = textOf(ITEMS);
const clone = (v) => JSON.parse(JSON.stringify(v));

// The fact-check negatives substitute the live draft's long wording, so they run without the length caps (which
// have their own tests below); a live theme's links are dropped because under compactLinks a theme carries none.
const { caseMaxWords, themeMaxWords, itemMaxSentences, ...UNCAPPED } = CHECKS;
const bare = (line) => line.replace(/\s*\((?:\[[^\]\n]*\]\([^)\s]*\)(?:,\s*)?)+\)/g, "");
const check = (text, claims = CLAIMS, { config = CHECKS, fact } = {}) =>
  runVerifySources({ config }, { priorOutputs: { clusters: { sources: RUN.sources }, factcheck: fact ?? { claims, text } }, priorStepNames: {} });
// One item of the revised text replaced by its wording in the live draft, with the claim record a model gave for it.
const withItem = (n, line, patch) => {
  const items = [...ITEMS]; items[n - 1] = line;
  const claims = clone(CLAIMS).map((c) => (c.item === n ? { ...c, ...patch } : c));
  return [textOf(items), claims];
};

test("the revised live draft passes: every item has a claim record, verbatim quotes, the source's numbers; verdicts are in the output", () => {
  const out = check(REVISED).output;
  assert.ok(out.checks.includes("fact-checked-claims") && out.checks.includes("no-forbidden-phrases"), out.checks.join());
  for (const added of ["compact-links", "nested-item-word-limits", "nested-item-sentences"]) assert.ok(out.checks.includes(added), added);
  for (const kept of ["nested-list-depth", "nested-order-by-cluster", "no-section-labels", "outlet-link-text", "every-thesis-cites-a-selected-source"]) assert.ok(out.checks.includes(kept), kept);
  assert.equal(out.text, REVISED);
  assert.deepEqual([out.factCheck.supported, out.factCheck.revised, out.factCheck.removed], [3, 7, 2]);
  assert.equal(out.factCheck.claims.length, 12);
  assert.deepEqual(out.factCheck.claims.find((c) => c.item === 9).numbers.sort(), ["n:3", "n:3000", "n:44", "ratio:3"]);
  assert.deepEqual(out.factCheck.claims.find((c) => c.item === 6).numbers, ["n:11600000000", "n:5"]);
  assert.deepEqual(out.factCheck.claims.find((c) => c.item === 1).sources, [D_OPENAI, V_MUSE], "the link-less theme stands on its cases' links");
  assert.equal(out.factCheck.claims.at(-1).verdict, "removed");
  assert.match(out.factCheck.grounding, /feed-item title and summary/);
  assert.match(out.limitation, /full articles were not read/);
});

test("the five errors of live run 65ef7d49: the records and texts the deterministic layer refuses", () => {
  const live = RUN.draft.split("\n").filter((l) => /^\s*- /.test(l));
  assert.equal(live.length, 10);
  const cases = {
    // 1. Theme generalisations beyond the sources.
    "1a theme: models escape their limits, with no supporting quote": [...withItem(1, bare(live[0]), { sources: [V_OPENAI, D_OPENAI], quote: [] }), /List item 1 has no quote from its linked sources; every claim, a theme's generalisation included/],
    "1a theme kept although the fact check found it overstated": [...withItem(1, bare(live[0]), { sources: [V_OPENAI, D_OPENAI], verdict: "overstated" }), /verdict «overstated»; a claim is supported, revised .* or removed/],
    "1b regulatory risks appear in no source": [...withItem(5, bare(live[4]), { quote: ["despite regulatory risks and rising compute costs"] }), /List item 5: the quote is not in the text of its linked sources: «despite regulatory risks/],
    "1b the removed generalisation is still in the text": [...withItem(5, bare(live[4]), {}), /A removed claim is still in the final text: «не зважаючи на регуляторні ризики/],
    // 2. OpenAI paused only its models with tool access.
    "2 a quote that drops «tool-based»": [...withItem(2, live[1], { quote: ["OpenAI has paused training, evaluation, and inference for its most capable models"] }), /List item 2: the quote is not in the text of its linked sources/],
    // 3. The court did not agree with the Pentagon's argument; the cost is the designation's.
    "3 a kept claim the fact check marked unsupported": [...withItem(4, live[3], { verdict: "unsupported" }), /verdict «unsupported»/],
    "3 the removed «agreed with the argument» is still in the text": [...withItem(4, live[3], {}), /A removed claim is still in the final text: «погодившись з аргументом/],
    "3 a quote that puts the argument in the court's mouth": [...withItem(4, live[3], { quote: ["the court agreed with the Pentagon that the company's safety restrictions could jeopardize military operations"] }), /List item 4: the quote is not in the text/],
    // 4. Three times less often, not in a third of the cases.
    "4 «в третині випадків» on «a third as often»": [...withItem(9, live[8], {}), /List item 9 states «третині» \(share:1\/3\), which is not in its quote or linked sources; numbers must be exactly as in the source/],
    "4 a number that is not in the source": [...withItem(9, ITEMS[8].replace("з 44% до 3%", "з 44% до 5%"), {}), /states «5» \(n:5\)/],
    "4 a scale that is not in the source": [...withItem(6, ITEMS[5].replace("$11,6 млрд", "$11,6 млн"), {}), /states «11,6 млн» \(n:11600000\)/],
  };
  for (const [name, [text, claims, error]] of Object.entries(cases)) assert.throws(() => check(text, claims, { config: UNCAPPED }), error, name);
  // 5. Language: not deterministic in general (the fact-check prompt asks for natural Ukrainian); the two known
  // errors are refused by the Digest's forbiddenPhrases.
  assert.throws(() => check(...withItem(5, ITEMS[4].replace("вкладати мільярди", "вкладати мільярди, не зважаючи на витрати"), {})), /uses «не зважаючи»; write «незважаючи»/);
  assert.throws(() => check(...withItem(10, live[9], {}), { config: UNCAPPED }), /uses «кодувальних агентів»; write «агентів для програмування»/);
});

test("negative examples: the claim records must cover the final text exactly", () => {
  const without = (n) => clone(CLAIMS).filter((c) => c.item !== n);
  const ITEM8 = CLAIMS.find((c) => c.item === 8);
  const cases = {
    "an item without a claim record": [REVISED, without(8), /List item 8 has no claim record; every item of the final text is fact-checked/],
    "two records for one item": [REVISED, [...clone(CLAIMS), { ...ITEM8 }], /List item 8 has more than one claim record/],
    "a record for an item that does not exist": [REVISED, [...without(8), { ...ITEM8, item: 11 }], /names list item 11, which is not an item of the final text \(1\.\.10\)/],
    "checked against a source the item does not link": [REVISED, clone(CLAIMS).map((c) => (c.item === 3 ? { ...c, sources: [T_MUSE] } : c)), /was checked against .*meta-opens-early-access.*which the item does not link/],
    "checked against no source": [REVISED, clone(CLAIMS).map((c) => (c.item === 3 ? { ...c, sources: [] } : c)), /needs the sources it was checked against/],
    "a removed record that still names an item": [REVISED, clone(CLAIMS).map((c) => (c.item === 8 ? { ...c, verdict: "removed", reason: "x", text: "x" } : c)), /is removed but still names list item 8/],
    "a revised claim without a reason": [REVISED, clone(CLAIMS).map((c) => (c.item === 9 ? { ...c, reason: "" } : c)), /\(revised\) needs a reason/],
    "a one-word quote": [REVISED, clone(CLAIMS).map((c) => (c.item === 8 ? { ...c, quote: "Microsoft" } : c)), /a quote must be 3 or more words/],
  };
  for (const [name, [text, claims, error]] of Object.entries(cases)) assert.throws(() => check(text, claims), error, name);
  // The checked (and approved, and delivered) text is the fact-checked text, not the draft before it.
  const draftWired = { ...CHECKS, draft: "{{steps.draft.output}}" };
  assert.throws(() => runVerifySources({ config: draftWired }, { priorOutputs: { clusters: { sources: RUN.sources }, draft: { text: REVISED.replace("вкладати мільярди", "вкладати сотні мільярдів") }, factcheck: { claims: CLAIMS, text: REVISED } }, priorStepNames: {} }), /The checked draft must be the fact-checked text/);
  assert.throws(() => check(REVISED, CLAIMS, { fact: { text: REVISED } }), /factCheck must reference a fact-check output/);
  const { nestedList, nestedOrder, forbiddenLabels, outletLinkText, citation, compactLinks, caseMaxWords: _c, themeMaxWords: _t, itemMaxSentences: _s, ...flat } = CHECKS;
  assert.throws(() => check(REVISED, CLAIMS, { config: flat }), /factCheck requires nestedList and citation: links/);
  assert.throws(() => check(REVISED, CLAIMS, { config: { ...CHECKS, forbiddenPhrases: '["не зважаючи"]' } }), /forbiddenPhrases must be a JSON object/);
});

test("without the fact check the live draft passes the 0.5 format checks: the fact check is what refuses it", () => {
  const { factCheck, forbiddenPhrases, draft, compactLinks, caseMaxWords, themeMaxWords, itemMaxSentences, ...format } = CHECKS;
  const live = RUN.draft;
  assert.doesNotThrow(() => runVerifySources({ config: { ...format, draft: "{{steps.draft.output}}" } }, { priorOutputs: { clusters: { sources: RUN.sources }, draft: { text: live } }, priorStepNames: {} }), "format-only checks let the five errors through");
});

test("numberTokens: digits with scales and decimal commas, ratios, shares and counts in Ukrainian and English", () => {
  const tokens = (t) => numberTokens(t).filter((x) => !x.quoteOnly).map((x) => x.token);
  assert.deepEqual(tokens("$11,6 млрд і до $20 млрд, частка до 5%"), ["n:11600000000", "n:20000000000", "n:5"]);
  assert.deepEqual(tokens("$11.6 billion, about $20 billion, up to 5%"), ["n:11600000000", "n:20000000000", "n:5"]);
  assert.deepEqual(tokens("$3,36 млрд"), tokens("secures $3.36B in"));
  assert.deepEqual(tokens("понад 3000 людей, з 44% до 3%"), tokens("more than 3,000 participants, from 44 to 3 percent"));
  assert.deepEqual(tokens("3 000 людей"), ["n:3000"]);
  assert.deepEqual(tokens("в третині випадків"), ["share:1/3"]);
  assert.deepEqual(tokens("correct only about a third as often"), ["ratio:3"]);
  assert.deepEqual(tokens("втричі рідше"), ["ratio:3"]);
  assert.deepEqual(tokens("three times less often"), ["ratio:3"]);
  assert.deepEqual(tokens("майже вдвічі"), tokens("nearly in half"));
  assert.deepEqual(tokens("двічі проігнорувала"), tokens("twice ignored"));
  assert.deepEqual(tokens("дві третини"), ["share:2/3"]);
  assert.deepEqual(tokens("у 3 рази"), ["ratio:3"]);
  assert.deepEqual(numberTokens("three models").map((x) => x.token), ["n:3"]);
});

test("Digest 0.6.0: a fact-check step between the draft and the checks; the gate binds the checked text", () => {
  assert.equal(DIGEST.version, "0.6.1");
  const ids = DIGEST.steps.map((s) => s.id);
  assert.deepEqual(ids.slice(ids.indexOf("draft")), ["draft", "factcheck", "checks", "approval", "delivery"]);
  const draft = DIGEST.steps.find((s) => s.id === "draft").config;
  const fc = DIGEST.steps.find((s) => s.id === "factcheck").config;
  assert.equal(fc.provider, "openrouter");
  assert.equal(fc.secretSource, "keychain");
  assert.equal(fc.format, "json");
  assert.equal(fc.model, undefined, "the same model as the draft: the workflow model");
  assert.equal(draft.model, undefined);
  assert.equal(fc.input, "{{steps.clusters.output.clusters}}");
  assert.ok(Number(draft.maxTokens) >= 8000, "run 65ef7d49 drafted 5506 tokens against a 6000 bound");
  assert.match(fc.instructions, /\{\{steps\.draft\.output\.text\}\}/);
  assert.ok(Number(fc.maxTokens) >= 12000, fc.maxTokens);
  const words = (s) => new RegExp(s.split(" ").join("\\s+"), "i");
  for (const rule of ["each claim against its linked source", "revise or remove", "Numbers exactly as in the source", "No generalisation beyond the sources", "nested-list format and the header", "«незважаючи» is one word", "«агентів для програмування»", "untrusted data"]) assert.match(fc.instructions, words(rule), rule);
  for (const rule of ["each claim against its linked source", "Numbers exactly as in the source", "No generalisation beyond the sources"]) assert.match(draft.instructions, words(rule), rule);
  assert.equal(CHECKS.draft, "{{steps.factcheck.output}}");
  assert.equal(CHECKS.factCheck, "{{steps.factcheck.output}}");
  assert.match(CHECKS.forbiddenPhrases, /не зважаючи/);
  assert.match(DIGEST.steps.find((s) => s.id === "delivery").config.body, /steps\.checks\.output\.text/);
  // The human gate hashes the last output before it: the checks output, i.e. the fact-checked text and its verdicts.
  assert.equal(ids[ids.indexOf("approval") - 1], "checks");
  assert.match(DIGEST.steps.find((s) => s.id === "approval").config.anchor, /fact-check verdicts/);
  assert.ok(DIGEST.settings.budgetUsd >= 0.5);
});

test("live run 461a3df0: a number the linked source title states passes; a half is not a third", () => {
  const n = ITEMS.findIndex((l) => l.includes(D_NVIDIA)) + 1;
  assert.ok(n > 0);
  const quote = { quote: [RUN.sources.find((s) => s.url === D_NVIDIA).text.split(/[.!?]/)[0].trim()] };
  // «майже на половину» is in the source title («…nearly in half…»), not in the chosen quote: accepted.
  const half = ITEMS[n - 1].replace(/майже вдвічі|майже удвічі|вдвічі|удвічі/, "майже на половину");
  if (half !== ITEMS[n - 1]) assert.doesNotThrow(() => check(...withItem(n, half, quote)));
  // A third is in neither the quote nor the source: refused.
  const third = ITEMS[n - 1].replace(/\(до 49%\)|до 49%/, "на третину");
  assert.throws(() => check(...withItem(n, third, quote)), /states «третину» \(share:1\/3\), which is not in its quote or linked sources/);
});

test("compactLinks: a theme with cases carries no links, every other item does; a link-less theme is ranked and fact-checked by its cases", () => {
  const items = (patch) => { const list = [...ITEMS]; for (const [n, line] of Object.entries(patch)) list[n - 1] = line; return textOf(list); };
  const linked = `${ITEMS[0]} ([The Decoder](${D_OPENAI}))`;
  const cases = {
    "a theme with links": [items({ 1: linked }), CLAIMS, /A list item with sub-items carries no links under compactLinks; its cases link the sources/],
    "a theme with a bare URL": [items({ 5: `${ITEMS[4]} ${T_AKAMAI}` }), CLAIMS, /carries no links under compactLinks/],
    "a case without links": [items({ 3: bare(ITEMS[2]) }), CLAIMS, /Every thesis needs a link to a selected source; uncited: Meta зробила/],
    "a stand-alone top-level item without links": [items({ 8: bare(ITEMS[7]) }), CLAIMS, /Every thesis needs a link to a selected source; uncited: Microsoft/],
    "a theme's claim record cites a URL none of its cases link": [REVISED, clone(CLAIMS).map((c) => (c.item === 1 ? { ...c, sources: [D_OPENAI, T_MUSE] } : c)), /item 1\) was checked against .*meta-opens-early-access.*which the item does not link as a selected source \(a theme without links stands on the links of its sub-items\)/],
  };
  for (const [name, [text, claims, error]] of Object.entries(cases)) assert.throws(() => check(text, claims), error, name);
  // Ranking: the link-less cloud theme holds clusters 4 and 5, so it may not come before the court item (cluster 2).
  const swapped = [ITEMS[0], ITEMS[1], ITEMS[2], ITEMS[4], ITEMS[5], ITEMS[6], ITEMS[3], ...ITEMS.slice(7)];
  assert.throws(() => check(textOf(swapped), CLAIMS, { config: { ...CHECKS, factCheck: undefined, draft: "{{steps.factcheck.output}}" } }), /ordered by weight \(cluster rank 2 comes after 4\)/);
  // Without compactLinks (0.5 behaviour) the link-less theme is an uncited thesis.
  assert.throws(() => check(REVISED, CLAIMS, { config: { ...CHECKS, compactLinks: undefined } }), /Every thesis needs a link to a selected source; uncited: OpenAI призупинила найпотужніші/);
  assert.throws(() => check(REVISED, CLAIMS, { config: { ...CHECKS, compactLinks: "yes" } }), /compactLinks must be "true" or "false"/);
  assert.throws(() => runVerifySources({ config: { draft: "{{steps.d.output}}", sources: "{{steps.c.output}}", compactLinks: "true" } }, { priorOutputs: { c: { sources: RUN.sources }, d: { text: `Текст і [The Verge](${V_MS})` } }, priorStepNames: {} }), /requires nestedList/);
});

test("short items: one sentence each, at most 32 words for a case and 20 for a theme, links not counted", () => {
  const items = (n, line) => { const list = [...ITEMS]; list[n - 1] = line; return textOf(list); };
  const at = (n) => ITEMS[n - 1].replace(/ \(\[[^\n]*$/, ""), links = (n) => ITEMS[n - 1].slice(at(n).length);
  const cases = {
    "a second sentence in a case": [items(10, `${at(10)}. Агент перевірив 152 підходи у понад 3000 прогонах${links(10)}`), /A list item has 2 sentences; at most 1, the key fact only/],
    "a trailing comment sentence": [items(8, `${at(8)}! «Це новий Office», вважають у компанії${links(8)}`), /has 2 sentences/],
    "a second sentence in a theme": [items(5, `${ITEMS[4]}. Інвестори не зупиняються`), /has 2 sentences/],
    "a case over 32 words": [items(9, RUN.draft.split("\n").find((l) => l.includes("Дослідження за участю")).replace("в третині", "втричі рідше, ніж у")), /A case has \d+ words; at most 32 \(without its source links\)/],
    "a theme over 20 words": [items(5, `${ITEMS[4]} попри невизначеність щодо того, як швидко ці вкладення окупляться для самих компаній`), /A theme has 2\d words; at most 20/],
  };
  for (const [name, [text, error]] of Object.entries(cases)) {
    // Only the shape is under test here, so the claim records are not needed.
    assert.throws(() => check(text, CLAIMS, { config: { ...CHECKS, factCheck: undefined } }), error, name);
  }
  // Not sentence ends: decimals, abbreviations with a dot, an ellipsis before a lower-case word, link markup.
  const fine = items(10, `${at(10).replace("майже вдвічі", "майже вдвічі (у U.S. тестах на 3.5 млн. токенів… та інших)")}${links(10)}`);
  assert.doesNotThrow(() => check(fine, CLAIMS, { config: { ...CHECKS, factCheck: undefined } }));
  assert.equal(nestedSentences(`Одне речення з 3,13 раза ([A](https://x.example/a.), [B](https://x.example/b))`), 1);
  assert.equal(nestedSentences("Перше. Друге? «Третє»"), 3);
  assert.equal(nestedWords(`Anthropic заплатить $11,6 млрд ([TechCrunch](${T_AKAMAI}), [The Verge](${V_MS}))`), 4);
  assert.throws(() => check(REVISED, CLAIMS, { config: { ...CHECKS, caseMaxWords: "0" } }), /caseMaxWords must be an integer 1\.\.500/);
  // The corrected 65ef7d49 text fits; its measured lengths (words without links).
  const lengths = ITEMS.map((l, i) => ({ theme: !/^ /.test(l) && /^ /.test(ITEMS[i + 1] ?? ""), words: nestedWords(l.replace(/^\s*- /, "")) }));
  assert.ok(lengths.filter((x) => x.theme).every((x) => x.words <= 20) && lengths.filter((x) => !x.theme).every((x) => x.words <= 32), JSON.stringify(lengths));
});

test("Digest 0.6.0 asks for compact links and short items and checks them", () => {
  assert.equal(CHECKS.compactLinks, "true");
  assert.equal(CHECKS.caseMaxWords, "32");
  assert.equal(CHECKS.themeMaxWords, "20");
  assert.equal(CHECKS.itemMaxSentences, "1");
  const words = (s) => new RegExp(s.split(" ").join("\\s+"), "i");
  const draft = DIGEST.steps.find((s) => s.id === "draft").config.instructions;
  const fc = DIGEST.steps.find((s) => s.id === "factcheck").config.instructions;
  for (const rule of ["A theme with cases carries no links", "one sentence with the key fact only", "at most 25 words", "at most 15 words", "no trailing commentary"]) assert.match(draft, words(rule), rule);
  for (const rule of ["has no links: move its links to its cases", "Every item is one sentence", "at most 25 words", "at most 15 words", "never by dropping the scope"]) assert.match(fc, words(rule), rule);
  assert.doesNotMatch(draft, /theme items included, links at least one/);
});

test("limit: errors 1-3 pass the deterministic layer when the model records the live wording as supported with a genuine quote", () => {
  // These depend on the fact-check model's verdict and on the human gate; the validator proves quotes and numbers only.
  const live = RUN.draft.split("\n").filter((l) => /^\s*- /.test(l));
  const kept = clone(CLAIMS).filter((c) => c.verdict !== "removed");
  const passes = {
    "1 the theme «models escape their limits»": [1, bare(live[0]), { verdict: "supported", sources: [V_OPENAI], quote: ["As reports of OpenAI's models breaking containment, hacking sites, and generally getting out of control pile up"] }],
    "1 Muse «said it should not»": [3, live[2].replace(/\(\[TechCrunch\]\([^)]*\), /, "("), { verdict: "supported", quote: ["Muse itself told people, including us, it wasn't supposed to reveal"] }],
    "1 «regulatory risks» in other words": [5, bare(live[4]).replace("не зважаючи на", "попри"), { verdict: "supported" }],
    "2 «training, testing and inference of its most capable models»": [2, live[1], { verdict: "supported", sources: [V_OPENAI, D_OPENAI], quote: ["pause training of its most powerful models", "One research model exploited a DNS loophole to reach the internet from a locked-down environment, while another deliberately leaked a GitHub token and twice ignored a researcher's direct instructions"] }],
    "3 the court «agreed with the Pentagon's argument»; the billions from the ruling": [4, live[3], { verdict: "supported", sources: [W_COURT, D_COURT], quote: ["A federal appeals court has upheld the Pentagon's decision to bar Anthropic from military contracts", "Defense Secretary Hegseth argues the company's safety restrictions could jeopardize military operations", "Anthropic says the designation has already cost it billions"] }],
  };
  for (const [name, [n, line, patch]] of Object.entries(passes)) {
    const items = [...ITEMS]; items[n - 1] = line;
    const claims = kept.map((c) => (c.item === n ? { ...c, ...patch } : c));
    assert.doesNotThrow(() => check(textOf(items), claims, { config: UNCAPPED }), name);
  }
});

test("removed wording: refused when it stays verbatim or nearly so; a rewrite that reuses its words passes", () => {
  const live = RUN.draft.split("\n").filter((l) => /^\s*- /.test(l));
  // The model records the whole original Nscale item as removed and keeps a rewrite that reuses most of its words in
  // another order (89% of its words of 3+ letters; the pre-review rule refused it). Its longest shared run is 6 of 26.
  const nscale = [...clone(CLAIMS), { verdict: "removed", text: live[6].replace(/^\s*- /, ""), reason: "Rewritten: the IPO is context, the key fact is the financing." }];
  const rewritten = [...ITEMS]; rewritten[6] = `  - Британська Nscale залучила від Third Point, Nvidia та інших $3,36 млрд конвертованого фінансування для дата-центрів під AI перед IPO у США ([TechCrunch](${T_NSCALE}))`;
  assert.doesNotThrow(() => check(textOf(rewritten), nscale));
  assert.doesNotThrow(() => check(REVISED, nscale));
  // A lightly edited removed clause («з» → «із») is still present: 9 of its 11 words in one run.
  const court = [...ITEMS]; court[3] = live[3].replace("погодившись з аргументом", "погодившись із аргументом");
  assert.throws(() => check(textOf(court), CLAIMS, { config: UNCAPPED }), /A removed claim is still in the final text: «погодившись з аргументом/);
  assert.throws(() => check(...withItem(4, live[3], {}), { config: UNCAPPED }), /A removed claim is still in the final text/);
});

test("ratios written as «у 1,5 раза», «2.5-fold» or «1.5x»; years and counts are not ratios", () => {
  const tokens = (t) => numberTokens(t).filter((x) => !x.quoteOnly).map((x) => x.token);
  assert.deepEqual(tokens("у 1,5 раза"), ["ratio:1.5"]);
  assert.deepEqual(tokens("в 2,5 раза"), ["ratio:2.5"]);
  assert.deepEqual(tokens("до 3,13 раза"), tokens("up to 3.13x faster"));
  assert.deepEqual(tokens("у 1,5 раза"), tokens("1.5 times faster"));
  assert.deepEqual(tokens("у 1,5 раза"), tokens("1.5x"));
  assert.deepEqual(tokens("в 2,5 раза"), tokens("a 2.5-fold increase"));
  assert.deepEqual(tokens("у 2 рази"), ["ratio:2"]);
  // False-positive guards: a year after «у», a count of times, «разом».
  assert.deepEqual(tokens("у 2026 році"), ["n:2026"]);
  assert.deepEqual(tokens("3 рази на тиждень"), ["n:3"]);
  assert.deepEqual(tokens("разом 3 компанії"), ["n:3"]);
  assert.notDeepEqual(tokens("у 1,5 раза"), tokens("1.5 billion"));
});
