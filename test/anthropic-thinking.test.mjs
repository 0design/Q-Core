import { test } from "node:test";
import assert from "node:assert/strict";
import { ANTHROPIC_MODELS } from "../src/cost.mjs";
import { anthropic } from "../src/providers/anthropic.mjs";

// Independent request contracts: do not derive these values from the model
// capabilities or the provider's body-building implementation. The coverage
// check below requires an explicit contract when a registry entry is added.
const expectations = {
  "claude-haiku-5-5": {
    default: { thinking: { type: "disabled" } },
    off: { thinking: { type: "disabled" } },
    low: { output_config: { effort: "low" } },
    medium: { output_config: { effort: "medium" } },
    high: { output_config: { effort: "high" } },
  },
  "claude-sonnet-5": {
    default: { thinking: { type: "disabled" } },
    off: { thinking: { type: "disabled" } },
    low: { output_config: { effort: "low" } },
    medium: { output_config: { effort: "medium" } },
    high: { output_config: { effort: "high" } },
  },
  "claude-sonnet-5-5": {
    default: { thinking: { type: "between_tools" } },
    off: { thinking: { type: "between_tools" } },
    low: { output_config: { effort: "low" } },
    medium: { output_config: { effort: "medium" } },
    high: { output_config: { effort: "high" } },
  },
  "claude-opus-5-5": {
    default: { output_config: { effort: "low" } },
    off: { output_config: { effort: "low" } },
    low: { output_config: { effort: "low" } },
    medium: { output_config: { effort: "medium" } },
    high: { output_config: { effort: "high" } },
  },
  "claude-haiku-4-5": {
    default: {},
    off: {},
    low: {},
    medium: {},
    high: {},
  },
};
const reasoningCases = [
  ["default", undefined], ["off", "off"], ["low", "low"], ["medium", "medium"], ["high", "high"],
];

test("Anthropic thinking contracts cover every registered model and reasoning level", () => {
  assert.deepEqual(Object.keys(expectations).sort(), Object.keys(ANTHROPIC_MODELS).sort(),
    "every added model requires explicit request-body expectations");
  for (const [model, levels] of Object.entries(expectations)) {
    assert.deepEqual(Object.keys(levels).sort(), reasoningCases.map(([label]) => label).sort(),
      `${model}: every reasoning level and the omitted default require an expectation`);
  }
});

for (const [model, levels] of Object.entries(expectations)) {
  for (const [label, reasoning] of reasoningCases) {
    test(`Anthropic thinking contract: ${model}, reasoning ${label}`, async () => {
      const calls = [];
      const args = {
        model, messages: [{ role: "system", content: "Be concise." }, { role: "user", content: "Hello" }],
        payerScope: "local-byok", maxTokens: 77, temperature: 0.6, retries: 0, timeoutMs: 1000,
        ...(reasoning === undefined ? {} : { reasoning }),
      };
      await anthropic(args, {
        env: {}, secretResolver: async () => "fixture-thinking-only-key",
        fetcher: async (_url, init) => {
          calls.push(init.body);
          return Response.json({
            id: "msg-thinking-contract", model, content: [{ type: "text", text: "Done" }],
            stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 1 },
          });
        },
      });
      assert.equal(calls.length, 1);
      const body = JSON.parse(calls[0]);
      const expectedFields = levels[label];
      for (const field of ["thinking", "output_config"]) {
        assert.equal(Object.hasOwn(body, field), Object.hasOwn(expectedFields, field), `${field} presence`);
        assert.deepEqual(body[field], expectedFields[field], `${field} value`);
      }
      const expectedBody = {
        model, max_tokens: 77, messages: [{ role: "user", content: "Hello" }], stream: true,
        system: "Be concise.", ...expectedFields,
        ...(model === "claude-haiku-4-5" ? { temperature: 0.6 } : {}),
      };
      assert.equal(calls[0], JSON.stringify(expectedBody),
        "the full serialized request preserves the existing body, including absent fields");
      if (model === "claude-sonnet-5-5") {
        assert.notDeepEqual(body.thinking, { type: "disabled" });
        assert.equal(calls[0].includes('"type":"disabled"'), false,
          "Sonnet 5.5 must never receive the rejected disabled thinking type");
      }
    });
  }
}
