// Core44: data from earlier steps is data. It cannot add a request header, move a URL to another host or
// add a query parameter, add an element to a JSON list in a contract, or trip an "unresolved placeholder" check
// merely because it contains braces. Every test here is offline: local HTTP servers or a stubbed fetch.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { resolveTemplate, resolveTemplateValue, resolveUrlTemplate } from "../src/template.mjs";
import { runApiRequest, runFetch, runLlmCall } from "../src/steps.mjs";
import { runParseWeb, runVerifySources } from "../src/registry-data-steps.mjs";
import { envRefsOf } from "../src/catalog.mjs";

async function server() {
  const seen = [];
  const s = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seen.push({ url: req.url, headers: req.headers, body });
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"ok":true}');
    });
  });
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  return { base: `http://127.0.0.1:${s.address().port}`, port: s.address().port, seen, close: () => new Promise((r) => s.close(r)) };
}
const api = (config) => ({ id: "send", kind: "api-request", config: { method: "POST", body: '{"a":1}', ...config } });

// ── 1. headers ────────────────────────────────────────────────────────────────

test("headers: a step value with quotes stays inside its own header value; names come from the manifest", async () => {
  const good = await server();
  try {
    const attack = 'x","Authorization":"Bearer stolen';
    const out = await runApiRequest(api({ url: `${good.base}/hook`, headers: '{"X-Title":"{{steps.src.output.title}}"}' }), { priorOutputs: { src: { title: attack } } });
    assert.equal(out.output.status, 200);
    assert.equal(good.seen.length, 1);
    assert.equal(good.seen[0].headers.authorization, undefined, "no header was added by data");
    assert.equal(good.seen[0].headers["x-title"], attack);
    // Legitimate: env and data values in header values still resolve.
    process.env.QF_CORE44_TOKEN = "t0k";
    await runApiRequest(api({ url: `${good.base}/hook`, headers: '{"Authorization":"Bearer {{env.QF_CORE44_TOKEN}}","X-Run":"{{steps.src.output.title}}"}' }), { priorOutputs: { src: { title: "plus 1" } } });
    assert.equal(good.seen[1].headers.authorization, "Bearer t0k");
    assert.equal(good.seen[1].headers["x-run"], "plus 1");
    // An env value with a quote no longer breaks the JSON either.
    process.env.QF_CORE44_TOKEN = 'a"b';
    await runApiRequest(api({ url: `${good.base}/hook`, headers: '{"X-Q":"{{env.QF_CORE44_TOKEN}}"}' }), { priorOutputs: {} });
    assert.equal(good.seen[2].headers["x-q"], 'a"b');
    await assert.rejects(runApiRequest(api({ url: `${good.base}/hook`, headers: '["X-A"]' }), { priorOutputs: {} }), /headers" field must be a JSON object/);
    await assert.rejects(runApiRequest(api({ url: `${good.base}/hook`, headers: '{"X-A": {{steps.src.output.title}}}' }), { priorOutputs: { src: { title: "1" } } }), /headers" field must be a JSON object/);
  } finally {
    delete process.env.QF_CORE44_TOKEN;
    await good.close();
  }
});

// ── 2. url ────────────────────────────────────────────────────────────────────

test("url: data cannot add query parameters or a fragment; it is encoded as one component", async () => {
  const good = await server();
  try {
    await runApiRequest(api({ url: `${good.base}/hook?text={{steps.src.output.t}}&chat_id=1` }), { priorOutputs: { src: { t: "hi&chat_id=666#x" } } });
    const q = new URL(good.seen[0].url, good.base).searchParams;
    assert.deepEqual(q.getAll("chat_id"), ["1"]);
    assert.equal(q.get("text"), "hi&chat_id=666#x");
    // Legitimate path and query values keep their meaning after decoding.
    await runApiRequest(api({ url: `${good.base}/items/{{item.id}}?q={{item.q}}` }), { priorOutputs: {}, item: { id: "a b/c", q: "кава й чай" } });
    assert.equal(good.seen[1].url, "/items/a%20b%2Fc?q=%D0%BA%D0%B0%D0%B2%D0%B0%20%D0%B9%20%D1%87%D0%B0%D0%B9");
    assert.equal(new URL(good.seen[1].url, good.base).searchParams.get("q"), "кава й чай");
  } finally {
    await good.close();
  }
});

test("url: data cannot change the scheme, credentials or host; the request is refused, nothing is sent", async () => {
  const good = await server(), evil = await server();
  try {
    const cases = {
      "userinfo trick after the host": [`${good.base}{{steps.src.output.p}}`, `@127.0.0.1:${evil.port}/`],
      "whole host from data": ["http://{{steps.src.output.p}}/hook", `127.0.0.1:${evil.port}`],
      "host prefix from data": ["http://{{steps.src.output.p}}127.0.0.1/hook", `x@127.0.0.1:${evil.port}/`],
      "dot segment": [`${good.base}/api/{{steps.src.output.p}}/delete`, ".."],
    };
    for (const [name, [url, p]] of Object.entries(cases)) {
      await assert.rejects(runApiRequest(api({ url }), { priorOutputs: { src: { p } } }), /scheme and host must come from the manifest|cannot be used inside a URL/, name);
      await assert.rejects(runFetch({ id: "f", kind: "fetch", config: { url } }, { priorOutputs: { src: { p } } }), /scheme and host must come from the manifest|cannot be used inside a URL/, `fetch: ${name}`);
    }
    assert.equal(evil.seen.length, 0);
    assert.equal(good.seen.length, 0);
  } finally {
    await good.close();
    await evil.close();
  }
});

test("url: the environment still sets the whole URL; an empty data value is harmless", () => {
  process.env.QF_CORE44_HOOK = "https://hooks.example/abc?x=1";
  try {
    assert.equal(resolveUrlTemplate("{{env.QF_CORE44_HOOK}}", { priorOutputs: {} }), "https://hooks.example/abc?x=1");
    assert.equal(resolveUrlTemplate("{{env.QF_CORE44_MISSING:-https://d.example/feed}}", { priorOutputs: {} }), "https://d.example/feed");
    assert.equal(resolveUrlTemplate("https://api.example/bot{{env.QF_CORE44_HOOK}}/send", { priorOutputs: {} }), "https://api.example/bothttps://hooks.example/abc?x=1/send");
    assert.equal(resolveUrlTemplate("https://h.example/{{item.x}}", { priorOutputs: {}, item: { x: "" } }), "https://h.example/");
    assert.equal(resolveUrlTemplate("https://h.example/{{index}}", { priorOutputs: {}, index: 3 }), "https://h.example/3");
    // An unresolved data placeholder stays visible, as before.
    assert.equal(resolveUrlTemplate("https://h.example/{{steps.none.output}}", { priorOutputs: {} }), "https://h.example/{{steps.none.output}}");
  } finally {
    delete process.env.QF_CORE44_HOOK;
  }
});

// ── 3. JSON lists in a format contract ───────────────────────────────────────

const SRC = "https://src.example/a";
const SOURCES = { sources: [{ url: SRC, text: "Перша думка про модель. Друга думка про ціни." }] };
const verify = (config, draft, cfg) =>
  runVerifySources(
    { config: { draft: "{{steps.draft.output}}", sources: "{{steps.unique.output}}", language: "uk", ...config } },
    { priorOutputs: { unique: SOURCES, draft: { text: draft }, cfg } },
  );

test("stringList: a data value cannot add an element to fixedLinks (and so cannot allow a link)", () => {
  const draft = `- Автор називає першу думку про модель ([джерело](${SRC})).\n- Інше: [тут](https://evil.test/x).\n`;
  assert.throws(
    () => verify({ fixedLinks: '["https://t.me/xyiikc","{{steps.cfg.output.link}}"]' }, draft, { link: 'https://ok.test","https://evil.test/x' }),
    /unverified URL/,
  );
  // Legitimate: an element from data, and a whole list named by one placeholder.
  const ok = `- Автор називає першу думку про модель ([джерело](${SRC})). [Канал](https://ok.test).\n`;
  assert.deepEqual(verify({ fixedLinks: '["{{steps.cfg.output.link}}"]' }, ok, { link: "https://ok.test" }).output.fixedLinks, ["https://ok.test"]);
  assert.deepEqual(verify({ fixedLinks: "{{steps.cfg.output.links}}" }, ok, { links: ["https://ok.test"] }).output.fixedLinks, ["https://ok.test"]);
  assert.throws(() => verify({ fixedLinks: '["a", {{steps.cfg.output.link}}]' }, ok, { link: '"https://ok.test"' }), /fixedLinks must be a JSON array of nonempty strings/);
});

// ── 4. a step reference does not cross `}}` ─────────────────────────────────

test("steps pattern: {{steps.X}} without .output does not swallow the next placeholder", () => {
  const ctx = { priorOutputs: { a: { t: "A" }, b: { t: "B" } }, priorStepNames: { b: "Step b" } };
  assert.equal(resolveTemplate("{{steps.a}} and {{steps.b.output.t}}", ctx), "{{steps.a}} and B");
  assert.equal(resolveTemplate("{{steps.a.t}} | {{steps.Step b.output.t}}", ctx), "{{steps.a.t}} | B");
  assert.equal(resolveTemplateValue("{{steps.a}} {{steps.b.output}}", ctx), undefined);
  // Valid syntax is unchanged: names with spaces, dots in the path, whitespace inside the braces.
  assert.equal(resolveTemplate("{{ steps.Step b.output.t }}", ctx), "B");
  assert.equal(resolveTemplate("{{steps.a.output}}", { priorOutputs: { a: { x: { y: 1 } } } }), '{"x":{"y":1}}');
  assert.equal(resolveTemplate("{{steps.a.output.x.y}}", { priorOutputs: { a: { x: { y: 1 } } } }), "1");
});

// ── 5. `{{…}}` inside legitimate data ────────────────────────────────────────

test("llm-call input: data that contains {{…}} is sent as data, not refused", async () => {
  const original = globalThis.fetch;
  const bodies = [];
  globalThis.fetch = async (url, init) => {
    bodies.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ id: "g", model: "m", choices: [{ message: { content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } }), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const step = { id: "s", kind: "llm-call", config: { instructions: "Summarise.", input: "{{steps.article.output.text}}", retries: "0" } };
    const code = "Use {{ user.name }} in the template and {{env.OPENROUTER_API_KEY}} is just text here.";
    const out = await runLlmCall(step, { apiKey: "k", priorOutputs: { article: { text: code } } }, "anthropic/claude-sonnet-5", 50);
    assert.equal(out.output.text, "ok");
    assert.equal(JSON.parse(bodies[0].messages.at(-1).content), code);
    await assert.rejects(runLlmCall({ ...step, config: { ...step.config, input: "{{steps.missing.output}}" } }, { apiKey: "k", priorOutputs: {} }, "m", 50), /input must reference one prior step output/);
  } finally {
    globalThis.fetch = original;
  }
});

test("format contract: a heading from data that contains {{…}} is data; an unresolved contract placeholder is still refused", () => {
  const heading = "## Шаблон {{name}}";
  const draft = `## Сигнали\n\n- Перша думка про модель ([джерело](${SRC})).\n\n${heading}\n\n- Друга думка про ціни ([джерело](${SRC})).\n`;
  const out = verify({ requiredHeadings: '["## Сигнали","{{steps.cfg.output.h}}"]' }, draft, { h: heading });
  assert.ok(out.output.checks.includes("required-markdown-sections"));
  assert.throws(() => verify({ requiredHeadings: '["## Сигнали","{{steps.cfg.output.missing}}"]' }, draft, { h: heading }), /Format contract has an unresolved template placeholder/);
  assert.throws(() => verify({ requiredHeadings: '["## Сигнали","{{env.QF_CORE44_UNSET}}"]' }, draft, {}), /Format contract has an unresolved template placeholder/);
});

test("parse-web since: data with {{…}} is judged as a date, an unresolved placeholder is still refused", () => {
  const rss = `<?xml version="1.0"?><rss version="2.0"><channel><item><title>T</title><link>https://m.example/a</link><description>x</description><pubDate>Sat, 26 Sep 2026 09:00:00 +0000</pubDate></item></channel></rss>`;
  const prior = { feed: { status: 200, url: "https://m.example/feed", body: rss }, cfg: { since: "2026-09-24 (from {{template}})" } };
  const run = (since) => runParseWeb({ config: { items: "feed", since } }, { priorOutputs: prior, priorStepNames: {} });
  assert.deepEqual(run("{{steps.cfg.output.since}}").output.sources.map((s) => s.url), ["https://m.example/a"]);
  assert.throws(() => run("{{steps.cfg.output.nope}}"), /unresolved template placeholder/);
});

// ── 6. catalogue env list ────────────────────────────────────────────────────

test("catalogue needsEnv lists variables a workflow cannot run without; {{env.X:-default}} is optional by design", () => {
  const m = { steps: [
    { config: { url: "{{env.QF_A}}", body: "{{ env.QF_B }}" } },
    { config: { url: "{{env.QF_FEED:-https://d.example/feed}}", x: "{{env.QF_EMPTY_OK:-}}" }, then: [{ config: { y: "{{env.QF_C}}" } }] },
    { config: { z: "{{env.QF_BOTH:-x}} {{env.QF_BOTH}}" } },
  ] };
  assert.deepEqual(envRefsOf(m), ["QF_A", "QF_B", "QF_C", "QF_BOTH"]);
});
