/* Core36: Digest as a nested list (owner review 0D-415, 27.09): no section labels, up to three levels, every item linked. */
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
  assert.equal(checks.citation, "links");
  for (const gone of ["requiredHeadings", "sectionSentences", "sectionItems", "itemMaxWords", "oneClusterPerItem"]) assert.equal(checks[gone], undefined, gone);
  assert.match(draft.instructions, /no labels such as "Загальна картина" or "Кейси"/);
  assert.match(draft.instructions, /at\s+most three levels/);
  assert.match(draft.instructions, /Order themes by weight/);
  assert.match(draft.instructions, /outlet name as the link text/);
  assert.doesNotMatch(draft.instructions, /## Загальна картина|## Кейси|\d+\s+words/);
  assert.ok(Number(draft.maxTokens) >= 4000);
});
