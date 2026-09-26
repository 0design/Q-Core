/* Core36: Digest as a nested list (owner review, 27.09): no section labels, up to three levels, every item linked. */
import assert from "node:assert/strict";
import test from "node:test";
import { resolve } from "node:path";
import { runVerifySources } from "../src/registry-data-steps.mjs";
import { loadManifest } from "../src/manifest.mjs";

const HEADER = "**Штучно-інтелектуальний дайджест під суботню каву на [ХУЇКС](https://t.me/xyiikc)і by [QFactory.io](https://QFactory.io) 🧋27.09**";
const A = "https://media.example/openai-pause", B = "https://blog.example/pause", C = "https://media.example/muse", D = "https://media.example/suno";
const SOURCES = { sources: [{ url: A, text: "a" }, { url: B, text: "b" }, { url: C, text: "c" }, { url: D, text: "d" }] };
const FORMAT = {
  citation: "links", forbidLocalLinks: "true", fixedLinks: '["https://t.me/xyiikc","https://QFactory.io"]',
  requiredPrefix: `${HEADER}\n\n`, nestedList: "3",
};
const verify = (text, config = FORMAT) => runVerifySources({ config: { draft: "{{steps.draft.output}}", sources: "{{steps.clusters.output}}", language: "uk", ...config } }, { priorOutputs: { clusters: SOURCES, draft: { text } }, priorStepNames: {} });

const L1 = `- Агенти виходять з-під контролю: лабораторії зупиняють навчання ([The Verge](${A}), [The Decoder](${B})).`;
const L2 = `  - Пауза OpenAI: модель обійшла пісочницю ([The Verge](${A})).`;
const L3 = `    - За словами компанії, це тимчасово ([The Decoder](${B})).`;
const SMALL = `- Лейбли знову судяться з Suno ([The Verge](${D})).`;
const GOOD = `${HEADER}\n\n${L1}\n${L2}\n${L3}\n- Muse від Meta відкрила файлову систему ([TechCrunch](${C})).\n${SMALL}\n`;

test("nestedList accepts a three-level list after the header with a source link in every item", () => {
  const out = verify(GOOD).output;
  assert.ok(out.checks.includes("nested-list-depth"));
  assert.ok(out.checks.includes("every-thesis-cites-a-selected-source"));
  assert.doesNotThrow(() => verify(`${HEADER}\n\n${L1}\n  ${L2}\n    ${L3}\n`), "4-space indentation is fine when consistent");
  assert.doesNotThrow(() => verify(`${HEADER}\n\n${L1}\n\n${SMALL}\n`), "themes without sub-items and blank lines between themes");
});

test("nestedList negative examples: section labels, headings, paragraphs, uncited items, depth 4, skipped or ragged levels", () => {
  const cases = {
    "label line «Загальна картина»": [`${HEADER}\n\nЗагальна картина\n\n${L1}\n`, /nested bullet list only/],
    "label line «Кейси» in bold": [`${HEADER}\n\n${L1}\n\n**Кейси**\n\n${SMALL}\n`, /nested bullet list only/],
    "heading ## Кейси": [`${HEADER}\n\n## Кейси\n\n${L1}\n`, /nested bullet list only/],
    "heading inside an item": [`${HEADER}\n\n- ## Кейси ([The Verge](${A}))\n`, /nested bullet list only/],
    "label as an item without a source": [`${HEADER}\n\n- **Кейси**\n${L2}\n`, /Every thesis needs a link to a selected source/],
    "level-2 item without a source": [`${HEADER}\n\n${L1}\n  - Пауза OpenAI без джерела.\n`, /Every thesis needs a link/],
    "level-3 item with only a header link": [`${HEADER}\n\n${L1}\n${L2}\n    - Коментар ([ХУЇКС](https://t.me/xyiikc)).\n`, /Every thesis needs a link/],
    "depth 4": [`${HEADER}\n\n${L1}\n${L2}\n${L3}\n      - Ще глибше ([The Verge](${A})).\n`, /deeper than 3 levels/],
    "ragged indentation": [`${HEADER}\n\n${L1}\n${L2}\n   - Три пробіли ([The Verge](${A})).\n`, /consistent 2-4 spaces/],
    "prose paragraph after the list": [`${GOOD}\nПідсумок: агенти всюди ([The Verge](${A})).\n`, /nested bullet list only/],
    "numbered list": [`${HEADER}\n\n1. Тема ([The Verge](${A})).\n`, /nested bullet list only/],
    "an item wrapped onto a second line": [`${HEADER}\n\n- Агенти виходять з-під контролю\nі лабораторії зупиняють навчання ([The Verge](${A})).\n`, /nested bullet list only/],
    "unverified link": [`${HEADER}\n\n- Тема ([Blog](https://invented.example/x)).\n`, /Every thesis needs a link|unverified URL/],
    "empty body": [`${HEADER}\n\n`, /no list after the header/],
  };
  for (const [name, [text, error]] of Object.entries(cases)) assert.throws(() => verify(text), error, name);
});

test("nestedList contract is strict: a depth 1..6 integer, and not mixed with section checks", () => {
  for (const bad of ["0", "7", "3.5", "three", " 3"]) assert.throws(() => verify(GOOD, { ...FORMAT, nestedList: bad }), /nestedList must be the maximum list depth/, bad);
  assert.throws(() => verify(GOOD, { ...FORMAT, requiredHeadings: '["## Кейси"]' }), /nestedList replaces requiredHeadings/);
  assert.throws(() => verify(GOOD, { ...FORMAT, nestedList: "2" }), /deeper than 2 levels/);
  // With the indentation unit fixed by the first nested item (2 spaces), jumping from level 2 to level 4 skips a level.
  assert.throws(() => verify(`${HEADER}\n\n${L1}\n${L2}\n      - Стрибок ([The Verge](${A})).\n`, { ...FORMAT, nestedList: "6" }), /skips a level/);
  // Without nestedList (and without headings) citation: links still requires the section contract.
  const { nestedList, ...flat } = FORMAT;
  assert.throws(() => verify(GOOD, flat), /require requiredHeadings \(or nestedList/);
});

test("Digest 0.5.0 asks for the nested list and checks it; no section labels, no case length", () => {
  const manifest = loadManifest(resolve("registry/workflows/digest.yaml"));
  assert.equal(manifest.version, "0.5.0");
  const draft = manifest.steps.find((s) => s.id === "draft").config;
  const checks = manifest.steps.find((s) => s.id === "checks").config;
  assert.equal(checks.nestedList, "3");
  assert.equal(checks.nestedOrder, "cluster");
  assert.equal(checks.outletLinkText, "true");
  assert.match(checks.forbiddenLabels, /Загальна картина/);
  assert.equal(checks.citation, "links");
  for (const gone of ["requiredHeadings", "sectionSentences", "sectionItems", "itemMaxWords", "oneClusterPerItem"]) assert.equal(checks[gone], undefined, gone);
  assert.match(draft.instructions, /no labels such as "Загальна картина" or "Кейси"/);
  assert.match(draft.instructions, /at\s+most three levels/);
  assert.match(draft.instructions, /Order themes by weight/);
  assert.match(draft.instructions, /outlet name as the link text/);
  assert.doesNotMatch(draft.instructions, /## Загальна картина|## Кейси|\d+\s+words/);
  assert.ok(Number(draft.maxTokens) >= 6000);
});

test("nestedOrder cluster: top-level items go from the best cluster rank down; a later theme may not hold a better rank", () => {
  const ranked = { sources: [{ url: A, text: "a", cluster: 1 }, { url: B, text: "b", cluster: 1 }, { url: C, text: "c", cluster: 2 }, { url: D, text: "d", cluster: 3 }] };
  const check = (text, extra = {}) => runVerifySources({ config: { draft: "{{steps.draft.output}}", sources: "{{steps.clusters.output}}", language: "uk", ...FORMAT, nestedOrder: "cluster", ...extra } }, { priorOutputs: { clusters: ranked, draft: { text } }, priorStepNames: {} });
  assert.ok(check(GOOD).output.checks.includes("nested-order-by-cluster"));
  // A theme counts the best rank of everything nested under it.
  assert.doesNotThrow(() => check(`${HEADER}\n\n- Тема ([TechCrunch](${C})).\n  - Пауза ([The Verge](${A})).\n${SMALL}\n`));
  assert.throws(() => check(`${HEADER}\n\n${SMALL}\n${L1}\n`), /ordered by weight \(cluster rank 1 comes after 3\)/);
  assert.throws(() => check(GOOD, { nestedOrder: "outlets" }), /nestedOrder must be "cluster"/);
  assert.throws(() => verify(GOOD, { ...FORMAT, nestedOrder: "cluster" }), /requires sources from deduplicate clusters/);
});

test("review round 1: a label item with a link, text that nests deeper, code fences, outlet link text", () => {
  const LABELS = '["Загальна картина","Кейси","Кейс","Тренд","Тренди","Висновки","Підсумок","Коментар"]';
  const strict = { ...FORMAT, forbiddenLabels: LABELS, outletLinkText: "true" };
  const refused = {
    "bold label item with a link": [`${HEADER}\n\n- **Загальна картина** ([The Verge](${A}))\n`, /opens with the section label «Загальна картина»/],
    "plain label with a colon": [`${HEADER}\n\n- Кейси: Muse відкрила файли ([TechCrunch](${C}))\n`, /section label «Кейси»/],
    "bold label with sub-items": [`${HEADER}\n\n- **Кейси** ([The Verge](${A}))\n${L2}\n`, /section label «Кейси»/],
    "label word at level 3": [`${HEADER}\n\n${L1}\n${L2}\n    - Коментар: це тимчасово ([The Decoder](${B}))\n`, /section label «Коментар»/],
    "a list marker inside the item text (renders one level deeper)": [`${HEADER}\n\n${L1}\n${L2}\n    - - Глибше ([The Verge](${A}))\n`, /may not open another list/],
    "a numbered item inside an item": [`${HEADER}\n\n- 1. Тема ([The Verge](${A}))\n`, /may not open another list/],
    "a quote inside an item": [`${HEADER}\n\n- > Тема ([The Verge](${A}))\n`, /may not open another list, a quote/],
    "a code fence inside an item": [`${HEADER}\n\n- \`\`\` ([The Verge](${A}))\n${L2}\n`, /a code block/],
    "a link that does not name its outlet": [`${HEADER}\n\n- Тема ([тут](${A}))\n`, /must name its outlet/],
  };
  for (const [name, [text, error]] of Object.entries(refused)) assert.throws(() => verify(text, strict), error, name);
  // Not labels: a theme that merely begins with a label-like word, and outlet names as the link text.
  // Test sources live on media.example and blog.example, so their outlet names are Media and Blog.
  assert.doesNotThrow(() => verify(`${HEADER}\n\n- Трендові моделі стають агентами ([Media](${A}), [The Blog](${B}))\n  - Кейсове навчання OpenAI ([media.example](${A}))\n`, strict));
  const named = GOOD.replace(/\[(The Verge|TechCrunch)\]/g, "[Media]").replace(/\[The Decoder\]/g, "[Blog]");
  assert.ok(verify(named, strict).output.checks.includes("outlet-link-text"));
  assert.throws(() => verify(GOOD, { ...strict, forbiddenLabels: '[""]' }), /forbiddenLabels must be a JSON array of nonempty strings/);
});
