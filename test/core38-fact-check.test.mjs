/* Core38: the Digest checks each claim against its linked source before the human gate. A fact-check model step
   returns claim records and the revised text; verify-sources checks the records deterministically (verbatim quotes
   in the source text the Core holds, numbers, one record per list item, removed claims absent) and the gate binds
   the checked text. Negative examples: the five errors an independent fact-check found in live run 65ef7d49
   (Digest 0.5.0). Offline: the fixture holds the run's selected sources (feed-item title and summary) and draft. */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadManifest } from "../src/manifest.mjs";
import { runVerifySources, numberTokens } from "../src/registry-data-steps.mjs";

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

// The live draft corrected the way the independent fact-check asked, one line per list item.
const ITEMS = [
  `- Інциденти з агентами змусили OpenAI призупинити найпотужніші моделі, а Muse від Meta показувала користувачам свою файлову систему ([The Decoder](${D_OPENAI}), [The Verge](${V_MUSE}))`,
  `  - OpenAI призупинила навчання, тестування та інференс із доступом до інструментів для своїх найпотужніших моделей: одна модель через DNS-лазівку вийшла в інтернет, інша навмисно злила GitHub-токен і двічі проігнорувала прямі вказівки дослідника ([The Verge](${V_OPENAI}), [The Decoder](${D_OPENAI}))`,
  `  - Muse від Meta показувала допитливим користувачам свою файлову систему, а Meta зробила її ще доступнішою ([The Verge](${V_MUSE}))`,
  `- Апеляційний суд дозволив Пентагону визнати Anthropic ризиком для ланцюга поставок і відсторонити її від військових контрактів; за словами Anthropic, саме це визнання вже коштувало їй мільярди ([Wired](${W_COURT}), [The Decoder](${D_COURT}))`,
  `- AI-компанії продовжують вкладати мільярди в хмарні потужності й дата-центри ([TechCrunch](${T_AKAMAI}), [TechCrunch](${T_NSCALE}))`,
  `  - Anthropic зобов'язалася сплатити Akamai $11,6 млрд протягом семи років за хмарні потужності на CPU з можливим зростанням приблизно до $20 млрд, а Akamai дає Anthropic потенційну частку до 5% своїх акцій ([TechCrunch](${T_AKAMAI}))`,
  `  - Британська Nscale перед IPO у США залучила $3,36 млрд конвертованого фінансування від Third Point, Nvidia та інших на розбудову дата-центрів під AI ([TechCrunch](${T_NSCALE}))`,
  `- Microsoft офіційно представила новий Copilot «super app», що об'єднує чат, кодування та агентів в одному інтерфейсі, а асистента Scout перейменувала на Autopilot; компанія вважає, що він буде таким же впливовим, як Office ([The Verge](${V_MS}))`,
  `- Дослідження за участю понад 3000 людей показало, що сам доступ до AI майже знищує готовність визнавати незнання: в одному експерименті частка відповідей «не знаю» впала з 44% до 3%, хоча AI майже завжди помилявся, а користувачі AI відповідали правильно втричі рідше за тих, хто його не мав ([The Decoder](${D_STUDY}))`,
  `- Система Nvidia SoL-Pi оптимізує проміжний шар між моделлю та середовищем, скорочуючи витрати токенів агентів для програмування майже вдвічі (до 49%) без помітної втрати якості; для її розробки дослідницький агент перевірив 152 підходи у понад 3000 прогонах ([The Decoder](${D_NVIDIA}))`,
];
const CLAIMS = [
  { item: 1, verdict: "revised", sources: [D_OPENAI, V_MUSE], quote: ['OpenAI pauses its "most capable models" after agents exploit loopholes and leak data', "Meta's Muse would expose its filesystem to curious users"], reason: "The draft generalised that frontier models escape their limits; the sources report two incidents, and Meta's filesystem exposure is not an escape." },
  { item: 2, verdict: "revised", sources: [D_OPENAI], quote: ["OpenAI has paused tool-based training, evaluation, and inference for its most capable models", "another deliberately leaked a GitHub token and twice ignored a researcher's direct instructions"], reason: "Only tool-based training, evaluation and inference was paused." },
  { item: 3, verdict: "revised", sources: [V_MUSE], quote: ["Meta makes the Muse filesystem even more accessible", "Meta's Muse would expose its filesystem to curious users"], reason: "Meta treats the exposure as intended; not a slip under the hood." },
  { item: 4, verdict: "revised", sources: [D_COURT], quote: ["A federal appeals court has upheld the Pentagon's decision to bar Anthropic from military contracts", "Anthropic says the designation has already cost it billions"], reason: "The court did not adopt the Pentagon's argument; the cost is the designation's." },
  { verdict: "removed", text: "погодившись з аргументом Міноборони, що безпекові обмеження Anthropic можуть загрожувати операціям", reason: "The argument is Hegseth's; the source does not say the court agreed with it." },
  { item: 5, verdict: "revised", sources: [T_AKAMAI, T_NSCALE], quote: ["Anthropic has committed $11.6 billion over seven years to Akamai's cloud infrastructure", "Nscale secures $3.36B in convertible financing"], reason: "Regulatory risks and compute costs appear in no source." },
  { verdict: "removed", text: "не зважаючи на регуляторні ризики та зростання витрат на обчислення", reason: "No source mentions regulatory risks or rising compute costs." },
  { item: 6, verdict: "supported", sources: [T_AKAMAI], quote: ["Anthropic has committed $11.6 billion over seven years to Akamai's cloud infrastructure, a bet on CPUs that could grow to about $20 billion, and in an unusual arrangement, Akamai is giving Anthropic a potential stake of up to 5% of its stock"] },
  { item: 7, verdict: "supported", sources: [T_NSCALE], quote: ["Ahead of US IPO, British AI neocloud Nscale secures $3.36B in convertible financing", "The funding, which comes from Third Point, Nvidia, and others, will fuel the company's massive AI data center buildout"] },
  { item: 8, verdict: "supported", sources: [V_MS], quote: ["Microsoft is officially unveiling it today", "bundles three AI capabilities into a single interface of chat, coding, and agents", "rebranding Scout, the AI personal assistant it unveiled at Build earlier this year, as Autopilot", "Microsoft thinks its new Copilot ‘super app’ will be as influential as Office"] },
  { item: 9, verdict: "revised", sources: [D_STUDY], quote: ["A study with more than 3,000 participants shows that just having access to AI answers nearly eliminated people's willingness to say \"I don't know.\"", "it dropped from 44 to 3 percent, even though the AI was almost always wrong", "were correct only about a third as often as those without it"], reason: "Three times less often, not in a third of the cases." },
  { item: 10, verdict: "revised", sources: [D_NVIDIA], quote: ["Nvidia's SoL-Pi system cuts coding agent token usage nearly in half", "SoL-Pi cuts coding agents' token usage by up to 49 percent with little change in performance", "A research agent tested 152 approaches across more than 3,000 runs"], reason: "«кодувальних агентів» is a calque." },
];
const textOf = (items) => `${HEADER}${items.join("\n")}\n`;
const REVISED = textOf(ITEMS);
const clone = (v) => JSON.parse(JSON.stringify(v));

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
  for (const kept of ["nested-list-depth", "nested-order-by-cluster", "no-section-labels", "outlet-link-text", "every-thesis-cites-a-selected-source"]) assert.ok(out.checks.includes(kept), kept);
  assert.equal(out.text, REVISED);
  assert.deepEqual([out.factCheck.supported, out.factCheck.revised, out.factCheck.removed], [3, 7, 2]);
  assert.equal(out.factCheck.claims.length, 12);
  assert.deepEqual(out.factCheck.claims.find((c) => c.item === 9).numbers.sort(), ["n:3", "n:3000", "n:44", "ratio:3"]);
  assert.deepEqual(out.factCheck.claims.find((c) => c.item === 6).numbers, ["n:11600000000", "n:20000000000", "n:5"]);
  assert.equal(out.factCheck.claims.at(-1).verdict, "removed");
  assert.match(out.factCheck.grounding, /feed-item title and summary/);
  assert.match(out.limitation, /full articles were not read/);
});

test("negative examples: the five errors of live run 65ef7d49, each in a form the validator refuses", () => {
  const live = RUN.draft.split("\n").filter((l) => /^\s*- /.test(l));
  assert.equal(live.length, 10);
  const cases = {
    // 1. Theme generalisations beyond the sources.
    "1a theme: models escape their limits, with no supporting quote": [...withItem(1, live[0], { sources: [V_OPENAI, D_OPENAI], quote: [] }), /List item 1 has no quote from its linked sources; every claim, a theme's generalisation included/],
    "1a theme kept although the fact check found it overstated": [...withItem(1, live[0], { sources: [V_OPENAI, D_OPENAI], verdict: "overstated" }), /verdict «overstated»; a claim is supported, revised .* or removed/],
    "1b regulatory risks appear in no source": [...withItem(5, live[4], { quote: ["despite regulatory risks and rising compute costs"] }), /List item 5: the quote is not in the text of its linked sources: «despite regulatory risks/],
    "1b the removed generalisation is still in the text": [...withItem(5, live[4], {}), /A removed claim is still in the final text: «не зважаючи на регуляторні ризики/],
    // 2. OpenAI paused only its models with tool access.
    "2 a quote that drops «tool-based»": [...withItem(2, live[1], { quote: ["OpenAI has paused training, evaluation, and inference for its most capable models"] }), /List item 2: the quote is not in the text of its linked sources/],
    // 3. The court did not agree with the Pentagon's argument; the cost is the designation's.
    "3 a kept claim the fact check marked unsupported": [...withItem(4, live[3], { verdict: "unsupported" }), /verdict «unsupported»/],
    "3 the removed «agreed with the argument» is still in the text": [...withItem(4, live[3], {}), /A removed claim is still in the final text: «погодившись з аргументом/],
    "3 a quote that puts the argument in the court's mouth": [...withItem(4, live[3], { quote: ["the court agreed with the Pentagon that the company's safety restrictions could jeopardize military operations"] }), /List item 4: the quote is not in the text/],
    // 4. Three times less often, not in a third of the cases.
    "4 «в третині випадків» on «a third as often»": [...withItem(9, live[8], {}), /List item 9 states «третині» \(share:1\/3\), which is not in its quote; numbers must be exactly as in the source/],
    "4 a number that is not in the source": [...withItem(9, ITEMS[8].replace("з 44% до 3%", "з 44% до 5%"), {}), /states «5» \(n:5\)/],
    "4 a scale that is not in the source": [...withItem(6, ITEMS[5].replace("$11,6 млрд", "$11,6 млн"), {}), /states «11,6 млн» \(n:11600000\)/],
  };
  for (const [name, [text, claims, error]] of Object.entries(cases)) assert.throws(() => check(text, claims), error, name);
  // 5. Language: not deterministic in general (the fact-check prompt asks for natural Ukrainian); the two known
  // errors are refused by the Digest's forbiddenPhrases.
  assert.throws(() => check(...withItem(5, ITEMS[4].replace("вкладати мільярди", "вкладати мільярди, не зважаючи на витрати"), {})), /uses «не зважаючи»; write «незважаючи»/);
  assert.throws(() => check(...withItem(10, live[9], {})), /uses «кодувальних агентів»; write «агентів для програмування»/);
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
  assert.throws(() => runVerifySources({ config: draftWired }, { priorOutputs: { clusters: { sources: RUN.sources }, draft: { text: RUN.draft }, factcheck: { claims: CLAIMS, text: REVISED } }, priorStepNames: {} }), /The checked draft must be the fact-checked text/);
  assert.throws(() => check(REVISED, CLAIMS, { fact: { text: REVISED } }), /factCheck must reference a fact-check output/);
  const { nestedList, nestedOrder, forbiddenLabels, outletLinkText, citation, ...flat } = CHECKS;
  assert.throws(() => check(REVISED, CLAIMS, { config: flat }), /factCheck requires nestedList and citation: links/);
  assert.throws(() => check(REVISED, CLAIMS, { config: { ...CHECKS, forbiddenPhrases: '["не зважаючи"]' } }), /forbiddenPhrases must be a JSON object/);
});

test("without the fact check the live draft passes the format checks: the fact check is what refuses it", () => {
  const { factCheck, forbiddenPhrases, draft, ...format } = CHECKS;
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
  assert.equal(DIGEST.version, "0.6.0");
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
