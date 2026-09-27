/* Core40: the Digest fact check grounds on the article behind each selected source, not only on its feed summary
   (owner decision 27.09, «автозвірка в R1»). parse-web articles reads each page once (public http(s) only, bounded,
   static text); verify-sources factCheck accepts quotes and numbers from the article and keeps an article's
   approximation («about 160»). Negative examples from live run 97688656 (Digest 0.6.1, Registry25), whose checks
   passed while an independent fact-check against the articles found 8 defects. Offline: fetch is stubbed; one test
   uses a local server to show that no request reaches a private address. Article excerpts are short, with their URL. */
import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { loadManifest } from "../src/manifest.mjs";
import { runParseWeb, runVerifySources, articleTextOf, isLocalHost } from "../src/registry-data-steps.mjs";

const IT = "https://the-decoder.com/two-thirds-of-it-leaders-report-ai-results-but-few-would-interrupt-the-ceos-vacation-over-them/";
const TC = "https://techcrunch.com/2026/09/25/unsecured-openai-agents-posted-53-user-images-on-the-internet-without-the-labs-knowledge/";
const EXA = "https://www.marktechpost.com/2026/09/26/exa-launches-agent-ultra-a-subagent-swarm-deep-research-api-built-for-exhaustive-list-building/";
// Feed items as the Core held them in run 97688656 (title and summary), with their cluster ranks.
const FEED = {
  [IT]: { title: "Two-thirds of IT leaders report AI results, but few would interrupt the CEO's vacation over them", text: "Speaking to 160 IT vice presidents in Las Vegas, tech entrepreneur Azeem Azhar asked who had measurable AI results. Two-thirds raised their hands. Then he asked who had results good enough to interrupt the CEO's summer vacation. Only eight did.", cluster: 1 },
  [TC]: { title: "Unsecured OpenAI agents posted 53 user images on the internet without the lab’s knowledge", text: "AI agents operating in OpenAI's research environment posted user images on public image-hosting sites without the lab's knowledge.", cluster: 2 },
  [EXA]: { title: "Exa Launches Agent Ultra: A Subagent Swarm Deep Research API Built for Exhaustive List Building", text: "Exa has released Agent Ultra, a deep research API.", cluster: 3 },
};
// Short excerpts of the articles (the pages' own wording), wrapped in page chrome the extractor must drop.
const PAGE = {
  [IT]: `<html><head><script>track()</script></head><body><nav>AI News Tech Menu</nav><article><h1>Two-thirds of IT leaders report AI results</h1><p>He describes speaking to about 160 IT vice presidents in Las Vegas. Azhar asked who could point to measurable AI results. Two-thirds stayed standing.</p><aside>Newsletter: subscribe now</aside><p>Only about eight people remained on their feet.</p></article><footer>© The Decoder</footer></body></html>`,
  [TC]: `<html><body><header>Disrupt 2026 tickets</header><main><p>Fifty-three &#8220;user-provided images&#8221; were &#8220;posted to image-hosting sites as links that weren&#8217;t publicly listed,&#8221; the company said.</p></main></body></html>`,
  [EXA]: `<html><body><article><p>Exa team reports that Ultra beats Opus 5.5, GPT-6 Astra, and Perplexity Agent, each at maximum effort, on 4 research benchmarks.</p><p>All results are vendor-reported and not yet independently reproduced.</p></article><article>Related: 136 chars</article></body></html>`,
};
const selected = (urls = Object.keys(FEED)) => {
  const sources = urls.map((url) => ({ url, feed: "https://feed.example/rss", ...FEED[url] }));
  return { clusters: sources.map((s) => ({ rank: s.cluster, topic: "t", summary: "s", independentOutlets: 1, sources: [s] })), sources, sourceHash: "x" };
};

async function withFetch(handler, work) {
  const original = globalThis.fetch, calls = [];
  globalThis.fetch = async (url, init) => { calls.push(String(url)); return handler(String(url), init); };
  try { return await work(calls); } finally { globalThis.fetch = original; }
}
const html = (body, headers = {}) => new Response(body, { status: 200, headers: { "content-type": "text/html; charset=utf-8", ...headers } });
const pages = (url) => (PAGE[url] ? html(PAGE[url]) : new Response("not found", { status: 404 }));
const articles = (source, config = {}) => runParseWeb({ config: { articles: "true", source: "{{steps.clusters.output}}", ...config } }, { priorOutputs: { clusters: source }, priorStepNames: {} });

test("parse-web articles: each selected page read once as static article text; clusters and ranks kept", async () => {
  const input = selected();
  input.sources.push({ ...input.sources[0] }); // the same URL twice is read once
  await withFetch(pages, async (calls) => {
    const out = (await articles(input)).output;
    assert.equal(calls.length, 3);
    const it = out.sources.find((s) => s.url === IT);
    assert.equal(it.articleStatus, "ok");
    assert.match(it.articleText, /^Two-thirds of IT leaders report AI results He describes speaking to about 160/);
    assert.doesNotMatch(it.articleText, /track\(\)|AI News Tech Menu|Newsletter|© The Decoder/);
    assert.match(out.sources.find((s) => s.url === TC).articleText, /links that weren’t publicly listed/);
    assert.match(out.sources.find((s) => s.url === EXA).articleText, /vendor-reported/, "the longest <article> is the story");
    assert.deepEqual(out.clusters.map((c) => [c.rank, c.sources[0].articleStatus]), [[1, "ok"], [2, "ok"], [3, "ok"]]);
    assert.equal(out.sourceHash, "x");
    assert.equal(out.articles.read, 3);
  });
});

test("parse-web articles: an unreachable page is recorded, not fatal; when none is readable the step fails", async () => {
  await withFetch((url) => (url === TC ? new Response("gone", { status: 404 }) : url === EXA ? Promise.reject(Object.assign(new Error("ECONNRESET"), { code: "ECONNRESET" })) : pages(url)), async () => {
    const out = (await articles(selected())).output;
    assert.equal(out.sources.find((s) => s.url === IT).articleStatus, "ok");
    const tc = out.sources.find((s) => s.url === TC);
    assert.deepEqual([tc.articleStatus, tc.articleText, tc.articleError], ["unavailable", null, "HTTP 404"]);
    assert.equal(out.sources.find((s) => s.url === EXA).articleStatus, "unavailable");
    assert.deepEqual(out.articles.unavailable.map((u) => u.url).sort(), [EXA, TC].sort());
  });
  await withFetch(() => new Response("down", { status: 404 }), async () => {
    await assert.rejects(articles(selected()), /none of the 3 article pages could be read \(HTTP 404\)/);
  });
  // A page that is not text, and a page with no readable text, are unavailable too.
  await withFetch((url) => (url === IT ? new Response("%PDF", { status: 200, headers: { "content-type": "application/pdf" } }) : url === TC ? html("<html><body><script>app()</script></body></html>") : pages(url)), async () => {
    const out = (await articles(selected())).output;
    assert.match(out.sources.find((s) => s.url === IT).articleError, /not a text page/);
    assert.equal(out.sources.find((s) => s.url === TC).articleError, "no readable static text");
  });
});

test("parse-web articles: local and private addresses are never requested, also behind a redirect", async () => {
  let hits = 0;
  const server = createServer((req, res) => { hits += 1; res.end("<article>internal secret</article>"); });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const local = `http://127.0.0.1:${server.address().port}/admin`;
  // The stub passes 127.0.0.1 requests to the real network, so a missing guard would reach the local server.
  const realFetch = globalThis.fetch;
  try {
  await withFetch((url, init) => (url.startsWith("http://127.0.0.1") ? realFetch(url, init) : url === "https://redirect.example/story" ? new Response(null, { status: 302, headers: { location: local } }) : pages(url)), async (calls) => {
    const refused = [local, "http://localhost/x", "http://10.1.2.3/x", "http://[::1]/", "http://169.254.169.254/latest/meta-data", "file:///etc/passwd", "http://user:pw@example.org/"];
    const out = (await articles({ sources: [...refused.map((url) => ({ url, text: "t" })), { url: "https://redirect.example/story", text: "t" }, { url: IT, ...FEED[IT] }] })).output;
    for (const url of refused) assert.equal(out.sources.find((s) => s.url === url).articleError, "not a public http(s) URL", url);
    assert.equal(out.sources.find((s) => s.url === "https://redirect.example/story").articleError, "redirect to a URL that is not public http(s)");
    assert.deepEqual(calls.sort(), ["https://redirect.example/story", IT].sort(), "only public URLs were requested");
  });
  } finally { server.closeAllConnections(); server.close(); }
  assert.equal(hits, 0, "no request reached the local server");
  for (const host of ["localhost", "a.localhost", "printer.local", "10.0.0.1", "172.16.5.4", "100.64.0.1", "::1", "fd00::1", "fe80::1", "::ffff:127.0.0.1"]) assert.ok(isLocalHost(host), host);
  for (const host of ["example.org", "the-decoder.com", "8.8.8.8", "172.32.0.1"]) assert.ok(!isLocalHost(host), host);
});

test("parse-web articles: size and character caps, at most 20 pages, a shared character budget", async () => {
  const long = `<article>${"Слово ".repeat(5000)}</article>`;
  await withFetch(() => html(long), async () => {
    const out = (await articles({ sources: [{ url: IT, text: "t" }] }, { maxChars: "1000" })).output;
    assert.equal(out.sources[0].articleText.length, 1000);
    assert.equal(out.sources[0].articleTruncated, true);
    const shared = (await articles(selected(), { maxChars: "6000", maxTotalChars: "1500" })).output;
    assert.ok(shared.sources.every((s) => s.articleText.length === 500), "1500 characters shared by 3 articles");
    assert.equal(shared.articles.charsPerArticle, 500);
  });
  // A page over 1.5 MB is cut, not read whole.
  await withFetch(() => html(`<article>${"x ".repeat(900_000)}</article>`), async () => {
    const out = (await articles({ sources: [{ url: IT, text: "t" }] }, { maxChars: "10000" })).output;
    assert.equal(out.sources[0].articleTruncated, true);
  });
  const many = { sources: Array.from({ length: 21 }, (_, i) => ({ url: `https://news.example/${i}`, text: "t" })) };
  await assert.rejects(articles(many), /at most 20 distinct URLs; got 21/);
  await assert.rejects(articles(selected(), { maxChars: "100" }), /maxChars must be 500\.\.10000/);
  await assert.rejects(articles(selected(), { maxTotalChars: "10" }), /maxTotalChars must be 1000\.\.200000/);
  await assert.rejects(articles(selected(), { articles: "yes" }), /articles must be "true"/);
  assert.equal(articleTextOf("<main>Main text</main><p>other</p>"), "Main text");
  assert.equal(articleTextOf("<body><nav>menu</nav><p>Body text</p></body>"), "Body text");
});

// verify-sources with the article text: the Digest's own checks config.
process.env.QF_DIGEST_DATE = "26.09";
const DIGEST = loadManifest(resolve("registry/workflows/digest.yaml"));
const CHECKS = DIGEST.steps.find((s) => s.id === "checks").config;
const HEADER = "**Штучно-інтелектуальний дайджест під суботню каву на [ХУЇКС](https://t.me/xyiikc)і by [QFactory.io](https://QFactory.io) 🧋26.09**\n\n";
const withArticles = async () => withFetch(pages, async () => (await articles(selected())).output);
const check = (sources, item, claim) => {
  const text = `${HEADER}${item}\n`;
  return runVerifySources({ config: CHECKS }, { priorOutputs: { articles: sources, factcheck: { text, claims: [{ item: 1, ...claim }] } }, priorStepNames: {} });
};
const IT_ITEM = (words) => `- ${words} ([The Decoder](${IT}))`;

test("factCheck grounds on the article: a quote only the article has passes; without the article it is refused", async () => {
  const read = await withArticles();
  const claim = { verdict: "supported", sources: [IT], quote: ["Only about eight people remained on their feet"] };
  const out = check(read, IT_ITEM("Лише близько восьми ІТ-керівників мають результати AI, вартi того, щоб перервати відпустку CEO"), claim).output;
  assert.match(out.factCheck.grounding, /static article text/);
  const summaryOnly = { ...read, sources: read.sources.map((s) => ({ ...s, articleStatus: "unavailable", articleText: null })) };
  assert.throws(() => check(summaryOnly, IT_ITEM("Лише близько восьми ІТ-керівників мають результати AI, вартi того, щоб перервати відпустку CEO"), claim), /the quote is not in the text of its linked sources/);
});

test("live run 97688656: «160» where the article says «about 160» is refused, although the feed summary said «160»", async () => {
  const read = await withArticles();
  const quote = ["Two-thirds raised their hands"];
  assert.throws(() => check(read, IT_ITEM("Дві третини з 160 ІТ-керівників повідомили про вимірні результати AI"), { verdict: "supported", sources: [IT], quote }),
    /List item 1 states «160» exactly; its source says «about 160»: keep the approximation or bound/);
  assert.doesNotThrow(() => check(read, IT_ITEM("Дві третини з близько 160 ІТ-керівників повідомили про вимірні результати AI"), { verdict: "revised", reason: "about 160", sources: [IT], quote }));
  // Without the article (unreachable page) the summary's «160» decides: the same item passes.
  const summaryOnly = { ...read, sources: read.sources.map((s) => ({ ...s, articleStatus: "unavailable", articleText: null })) };
  assert.doesNotThrow(() => check(summaryOnly, IT_ITEM("Дві третини з 160 ІТ-керівників повідомили про вимірні результати AI"), { verdict: "supported", sources: [IT], quote }));
  // A bound: «до 49%» keeps «up to 49 percent»; a bare «49%» does not.
  const sol = { sources: [{ url: "https://the-decoder.com/sol-pi/", title: "SoL-Pi", text: "Summary.", articleStatus: "ok", articleText: "SoL-Pi cuts coding agents' token usage by up to 49 percent with little change in performance.", cluster: 1 }] };
  const solItem = (w) => `- ${w} ([The Decoder](https://the-decoder.com/sol-pi/))`;
  const solClaim = { verdict: "supported", sources: ["https://the-decoder.com/sol-pi/"], quote: ["cuts coding agents' token usage"] };
  assert.throws(() => check(sol, solItem("SoL-Pi скорочує використання токенів на 49%"), solClaim), /states «49» exactly; its source says «up to 49»/);
  assert.doesNotThrow(() => check(sol, solItem("SoL-Pi скорочує використання токенів до 49%"), solClaim));
});

test("Digest 0.7.0: the articles step feeds the fact check and the checks; the prompt says the article decides", () => {
  assert.equal(DIGEST.version, "0.7.0");
  const ids = DIGEST.steps.map((s) => s.id);
  assert.deepEqual(ids.slice(ids.indexOf("clusters")), ["clusters", "articles", "draft", "factcheck", "checks", "approval", "delivery"]);
  const art = DIGEST.steps.find((s) => s.id === "articles");
  assert.equal(art.kind, "parse-web");
  assert.deepEqual([art.config.articles, art.config.source, art.config.maxTotalChars], ["true", "{{steps.clusters.output}}", "30000"]);
  const fc = DIGEST.steps.find((s) => s.id === "factcheck").config;
  assert.equal(fc.input, "{{steps.articles.output.clusters}}");
  assert.equal(CHECKS.sources, "{{steps.articles.output}}");
  const words = (s) => new RegExp(s.split(" ").join("\\s+"), "i");
  for (const rule of ["Check each claim against the full article text", "the article, not the feed summary, decides", "vendor-reported benchmarks are not independent results", "«about 160» is «близько 160»", "weren't publicly listed"]) assert.match(fc.instructions, words(rule), rule);
});
