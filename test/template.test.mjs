/**
 * A substituted value is data, not template text. Fetched content or a model
 * answer that happens to contain `{{env.X}}` must not pull a secret into an
 * outgoing request.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveTemplate, resolveTemplateDeep } from "../src/template.mjs";

test("placeholders inside substituted values are not expanded again", () => {
  process.env.QF_TEMPLATE_TEST_SECRET = "s3cr3t";
  try {
    const ctx = {
      priorOutputs: { f: { json: { title: "hi {{env.QF_TEMPLATE_TEST_SECRET}} {{run.id}} {{item.x}}" } } },
      priorStepNames: { f: "Read data" },
      item: { x: "ITEM" },
      run: { id: "RUN" },
    };
    const literal = "hi {{env.QF_TEMPLATE_TEST_SECRET}} {{run.id}} {{item.x}}";
    assert.equal(resolveTemplate("{{steps.Read data.output.json.title}}", ctx), literal);
    assert.deepEqual(resolveTemplateDeep({ t: "{{steps.f.output.json.title}}" }, ctx), { t: literal });
    assert.equal(
      resolveTemplate("{{env.QF_TEMPLATE_TEST_SECRET}}/{{run.id}}/{{item.x}}/{{index}}", { ...ctx, index: 3 }),
      "s3cr3t/RUN/ITEM/3",
    );
  } finally {
    delete process.env.QF_TEMPLATE_TEST_SECRET;
  }
});

test("single pass keeps {{env.NAME:-default}} and run fields aligned with their groups", () => {
  delete process.env.QF_TEMPLATE_TEST_UNSET;
  process.env.QF_TEMPLATE_TEST_EMPTY = "";
  try {
    const ctx = {
      priorOutputs: { f: { t: "{{env.QF_TEMPLATE_TEST_UNSET:-leak}}" } },
      priorStepNames: {},
      run: { id: "RUN", workflowId: "WF", costUsd: 0.0000125 },
    };
    assert.equal(
      resolveTemplate("{{env.QF_TEMPLATE_TEST_UNSET:- dflt }}|{{env.QF_TEMPLATE_TEST_EMPTY:-e}}|{{run.id}}|{{run.workflowId}}|{{run.costUsd}}", ctx),
      "dflt|e|RUN|WF|0.000013",
    );
    assert.equal(resolveTemplate("{{run.costUsd}}", { ...ctx, run: { costUsd: null } }), "unknown");
    assert.equal(resolveTemplate("{{steps.f.output.t}}", ctx), "{{env.QF_TEMPLATE_TEST_UNSET:-leak}}");
  } finally {
    delete process.env.QF_TEMPLATE_TEST_EMPTY;
  }
});
