/**
 * The YAML reader is a subset, and a subset only earns trust if its EDGES are
 * tested — the things it refuses matter as much as the things it reads. A reader
 * that silently mis-parses a manifest produces a loop that runs and is not the
 * loop that was written, which is the worst failure this package can have.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseYaml, YamlError } from "../src/yaml.mjs";

test("mappings, nesting and scalar types", () => {
  const doc = parseYaml(`
a: 1
b: 1.5
c: true
d: false
e: null
f: ~
g: plain text
h: "quoted: with colon"
i: 'single'
nested:
  x: 1
  y:
    z: deep
`);
  assert.deepEqual(doc, {
    a: 1,
    b: 1.5,
    c: true,
    d: false,
    e: null,
    f: null,
    g: "plain text",
    h: "quoted: with colon",
    i: "single",
    nested: { x: 1, y: { z: "deep" } },
  });
});

test("a quoted number stays a string — the manifest author meant text", () => {
  assert.deepEqual(parseYaml(`maxItems: "3"\nlimit: 3`), { maxItems: "3", limit: 3 });
});

test("sequences of scalars and of mappings", () => {
  const doc = parseYaml(`
tags:
  - one
  - two
steps:
  - id: a
    kind: fetch
  - id: b
    kind: llm-call
    config:
      name: X
`);
  assert.deepEqual(doc, {
    tags: ["one", "two"],
    steps: [
      { id: "a", kind: "fetch" },
      { id: "b", kind: "llm-call", config: { name: "X" } },
    ],
  });
});

test("a sequence may sit at its key's own indentation", () => {
  assert.deepEqual(parseYaml(`triggers:\n- kind: manual\n- kind: webhook`), {
    triggers: [{ kind: "manual" }, { kind: "webhook" }],
  });
});

test("block scalars: | keeps newlines, > folds them", () => {
  const doc = parseYaml(`
literal: |
  line one
  line two
folded: >
  a
  b

  c
stripped: |-
  no trailing newline
`);
  assert.equal(doc.literal, "line one\nline two\n");
  assert.equal(doc.folded, "a b\n\nc\n");
  assert.equal(doc.stripped, "no trailing newline");
});

test("a block scalar keeps the braces of a template intact", () => {
  const doc = parseYaml(`instructions: |\n  Summarise:\n  {{steps.Fetch feed.output.entries}}\n`);
  assert.match(doc.instructions, /\{\{steps\.Fetch feed\.output\.entries\}\}/);
});

test("flow collections, nested", () => {
  assert.deepEqual(parseYaml(`a: [1, 2, "three"]\nb: {x: 1, y: [2, 3]}`), {
    a: [1, 2, "three"],
    b: { x: 1, y: [2, 3] },
  });
});

test("comments are stripped, but not a # inside quotes", () => {
  assert.deepEqual(parseYaml(`# leading\na: 1 # trailing\nb: "not # a comment"`), {
    a: 1,
    b: "not # a comment",
  });
});

test("one leading --- is fine; a second document is refused", () => {
  assert.deepEqual(parseYaml(`---\na: 1`), { a: 1 });
  assert.throws(() => parseYaml(`a: 1\n---\nb: 2`), YamlError);
});

test("refuses what it cannot read, naming the line", () => {
  assert.throws(() => parseYaml(`a: &anchor 1`), (e) => e instanceof YamlError && /anchor/.test(e.message));
  assert.throws(() => parseYaml(`a: !!str 1`), (e) => e instanceof YamlError && /tag/.test(e.message));
  assert.throws(() => parseYaml(`a: 1\n\tb: 2`), (e) => e instanceof YamlError && /tab/.test(e.message));
});

test("a duplicate key is an error, not a last-one-wins surprise", () => {
  assert.throws(() => parseYaml(`a: 1\na: 2`), (e) => e instanceof YamlError && /duplicate/.test(e.message));
});

test("the error carries a line number", () => {
  try {
    parseYaml(`a: 1\nb: 2\nc: &x`);
    assert.fail("should have thrown");
  } catch (e) {
    assert.equal(e.line, 3);
  }
});
