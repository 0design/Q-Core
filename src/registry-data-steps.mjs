import { hash, insist } from './contracts.mjs';
import { resolveTemplate, resolveTemplateValue } from './template.mjs';
import { parseFeed } from './steps.mjs';

const context = ctx => ({ priorOutputs: ctx.priorOutputs, priorStepNames: ctx.priorStepNames, item: ctx.item, index: ctx.itemIndex });
const value = (step, field, ctx) => resolveTemplateValue(step.config[field], context(ctx));
const textValue = (step, field, ctx) => resolveTemplate(step.config[field], context(ctx));
const stringList = (step, field, ctx) => {
  if (!(field in step.config)) return [];
  const raw = textValue(step, field, ctx);
  let list;
  try { list = JSON.parse(raw); }
  catch { throw new Error(`${field} must be a JSON array of nonempty strings`); }
  insist(Array.isArray(list) && list.every(item => typeof item === 'string' && item.length > 0), `${field} must be a JSON array of nonempty strings`);
  return list;
};
const strip = html => html.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<(script|style|nav|header|footer)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&(?:nbsp|amp|quot|lt|gt);/g, s => ({'&nbsp;':' ', '&amp;':'&', '&quot;':'"', '&lt;':'<', '&gt;':'>'})[s]).replace(/\s+/g, ' ').trim();

/** A deliberately small readable-text extractor, not a browser or a facts verifier. */
/* Section-label matching (Core37): an item's opening words compared without markup a model may add around a
   label — HTML tags or escaped tags (&lt;b&gt;), Markdown emphasis, quotes («Кейси»), and leading emoji or bullets (📌). */
const HTML_ENTITIES = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'", nbsp: ' ', laquo: '«', raquo: '»' };
function labelHead(text) {
  let t = String(text);
  for (let i = 0; i < 2; i++) t = t.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => e[0] === '#' ? String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : (HTML_ENTITIES[e.toLowerCase()] ?? m));
  return t.replace(/<\/?[a-z][^>]*>/gi, '').replace(/[*_~`«»“”„‟"'‘’‹›]/g, '').replace(/^[^\p{L}\p{N}]+/u, '').replace(/\s+/g, ' ').trim().toLocaleLowerCase('uk');
}
/* Outlet names a link text may use for a host (Core37): every host label except generic prefixes (www, m, blog,
   news…), generic second levels before a country code (co, com, org… as in bbc.co.uk) and generic or country
   top-level domains. So blog.google → google, bbc.co.uk → bbc, electrek.co → electrek, theverge.com → theverge. */
const GENERIC_PREFIX = new Set(['www', 'm', 'mobile', 'amp', 'blog', 'blogs', 'news', 'feeds', 'feed', 'rss', 'en', 'uk', 'us', 'edition', 'go']);
const GENERIC_SECOND = new Set(['co', 'com', 'org', 'net', 'gov', 'ac', 'edu', 'or', 'ne', 'go', 'gv', 'mil', 'nic']);
const GENERIC_TLD = new Set(['com', 'org', 'net', 'edu', 'gov', 'mil', 'int', 'info', 'biz', 'io', 'ai', 'app', 'dev', 'tech', 'news', 'media', 'blog', 'online', 'site', 'xyz', 'me', 'tv', 'fm', 'so', 'to', 'ly', 'example', 'test', 'invalid', 'localhost']);
const OUTLET_ALIASES = { t: ['telegram'], x: ['twitter'] };
function outletNames(host) {
  const parts = String(host).toLowerCase().split('.').filter(Boolean);
  if (parts.length < 2) return parts;
  let end = parts.length;
  const last = parts[end - 1];
  if (last.length === 2 || GENERIC_TLD.has(last)) end--;
  if (end >= 2 && parts[end - 1].length <= 3 && GENERIC_SECOND.has(parts[end - 1]) && last.length === 2) end--;
  const names = parts.slice(0, end).filter((p, i, all) => !(GENERIC_PREFIX.has(p) && i < all.length - 1));
  return names.length ? names : [parts[Math.max(0, end - 1)]];
}
/* Fact check (Core38): the numbers a claim states, as comparable tokens. Digits (11,6 · 11.6 · 3,000 · 3 000) with a
   scale word or suffix (млрд, billion, $3.36B…) become values; a few words that carry a number become typed tokens:
   a ratio (втричі, «three times less», «a third as often», «nearly in half»), a share of a whole (третина, «a third
   of», половина) and a count (двічі, twice). A claim's tokens must all be among its quote's tokens, so «в третині
   випадків» (a share) does not pass on «a third as often» (a ratio). Only these forms are read; a number written
   out in other Ukrainian words is not compared. */
const NUMBER_WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, twice: 2, thrice: 3 };
const B = '(?<![\\p{L}\\p{N}])', E = '(?![\\p{L}\\p{N}])';
const COMPARATIVE = '(?:less|fewer|more|lower|higher|smaller|larger|bigger|faster|slower|cheaper|as)';
const NUMBER_PHRASES = [
  // Ratios first, so «a third as often» is not also read as a share.
  // «у 1,5 раза», «в 2 рази», «до 3,13 раза»: «раза» is the multiplier form of a fraction, so it is a ratio without «у/в» too.
  [new RegExp(`${B}[ву]\\s+(\\d+(?:[.,]\\d+)?)\\s+раз(?:и|а|ів)?${E}|${B}(\\d+[.,]\\d+)\\s+раза${E}`, 'giu'), m => `ratio:${Number((m[1] ?? m[2]).replace(',', '.'))}`],
  [new RegExp(`${B}[ву]\\s+(два|дві|три|чотири|п['’ʼ]?ять|десять)\\s+раз(?:и|ів)${E}`, 'giu'), m => `ratio:${{ 'два': 2, 'дві': 2, 'три': 3, 'чотири': 4, 'десять': 10 }[m[1].toLowerCase()] ?? 5}`],
  [new RegExp(`${B}(?:[ву]дві[чк]і|[ву]двоє|наполовину|подвоїл\\p{L}*|подвоєн\\p{L}*)${E}`, 'giu'), () => 'ratio:2'],
  [new RegExp(`${B}(?:[ву]тричі|[ву]троє|потроїл\\p{L}*)${E}`, 'giu'), () => 'ratio:3'],
  [new RegExp(`${B}(?:[ву]четверо)${E}`, 'giu'), () => 'ratio:4'],
  [new RegExp(`${B}(?:[ву]п['’ʼ]?ятеро)${E}`, 'giu'), () => 'ratio:5'],
  [new RegExp(`${B}(?:[ву]десятеро)${E}`, 'giu'), () => 'ratio:10'],
  [new RegExp(`${B}(\\d+(?:\\.\\d+)?|two|three|four|five|six|seven|eight|nine|ten)[\\s-]+times\\s+${COMPARATIVE}${E}`, 'giu'), m => `ratio:${NUMBER_WORDS[m[1].toLowerCase()] ?? Number(m[1])}`],
  [new RegExp(`${B}(\\d+(?:\\.\\d+)?)\\s*[x×]${E}|${B}(\\d+(?:\\.\\d+)?)[\\s-]+fold${E}`, 'giu'), m => `ratio:${Number(m[1] ?? m[2])}`],
  [new RegExp(`${B}(?:twice|half)\\s+as${E}|${B}in\\s+half${E}|${B}halv(?:e|ed|es|ing)${E}|${B}doubl(?:e|ed|es|ing)${E}`, 'giu'), () => 'ratio:2'],
  [new RegExp(`${B}(?:a|one)[\\s-]+third\\s+as${E}|${B}tripl(?:e|ed|es|ing)${E}`, 'giu'), () => 'ratio:3'],
  [new RegExp(`${B}(?:a|one)[\\s-]+(?:quarter|fourth)\\s+as${E}`, 'giu'), () => 'ratio:4'],
  // Shares of a whole.
  [new RegExp(`${B}(?:дв[іа]\\s+третин\\p{L}*|two[\\s-]+thirds)${E}`, 'giu'), () => 'share:2/3'],
  [new RegExp(`${B}(?:третин\\p{L}*|(?:a|one)[\\s-]+third|one\\s+in\\s+three)${E}`, 'giu'), () => 'share:1/3'],
  [new RegExp(`${B}(?:половин\\p{L}*|half)${E}`, 'giu'), () => 'share:1/2'],
  [new RegExp(`${B}(?:чверт\\p{L}*|(?:a|one)[\\s-]+(?:quarter|fourth))${E}`, 'giu'), () => 'share:1/4'],
  // Counts of times.
  [new RegExp(`${B}(?:двічі|twice)${E}`, 'giu'), () => 'count:2'],
  [new RegExp(`${B}(?:тричі|thrice)${E}`, 'giu'), () => 'count:3'],
];
const SCALES = [[/^\s*(?:трлн|трильйон\p{L}*|trillion)(?![\p{L}\p{N}])/iu, 1e12], [/^\s*(?:млрд|мільярд\p{L}*|billion|bn)(?![\p{L}\p{N}])/iu, 1e9], [/^B(?![\p{L}\p{N}])/u, 1e9], [/^\s*(?:млн|мільйон\p{L}*|million|mln)(?![\p{L}\p{N}])/iu, 1e6], [/^M(?![\p{L}\p{N}])/u, 1e6], [/^\s*(?:тис\.|тисяч\p{L}*|thousand)(?![\p{L}\p{N}])/iu, 1e3], [/^[Kk](?![\p{L}\p{N}])/u, 1e3]];
export function numberTokens(input) {
  let text = String(input).normalize('NFKC');
  const found = [];
  for (const [re, token] of NUMBER_PHRASES) text = text.replace(re, (...args) => { found.push({ token: token(args), surface: args[0] }); return ' '.repeat(args[0].length); });
  // English number words count as numbers too (a quote may write «three» where a claim writes 3).
  text = text.replace(new RegExp(`${B}(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)${E}`, 'giu'), (w, word, at) => { found.push({ token: `n:${NUMBER_WORDS[word.toLowerCase()]}`, surface: w, quoteOnly: true }); return ' '.repeat(w.length); });
  const DIGITS = /(?<![\p{L}\p{N}.,])(\d{1,3}(?:[ \u00a0\u202f]\d{3})+(?![\d.,]\d)|\d{1,3}(?:,\d{3})+(?![\d.,]\d)|\d+(?:[.,]\d+)?)(?!\p{N})/gu;
  for (const m of text.matchAll(DIGITS)) {
    const raw = m[1];
    const value = /^\d{1,3}(?:[ \u00a0\u202f]\d{3})+$/.test(raw) || /^\d{1,3}(?:,\d{3})+$/.test(raw) ? Number(raw.replace(/[ \u00a0\u202f,]/g, '')) : Number(raw.replace(',', '.'));
    const rest = text.slice(m.index + m[0].length);
    const scale = SCALES.find(([re]) => re.test(rest));
    const scaled = scale ? value * scale[1] : value;
    found.push({ token: `n:${Number(scaled.toPrecision(12))}`, surface: scale ? `${raw}${rest.match(scale[0])[0]}` : raw });
  }
  return found;
}
const unifyQuotes = s => String(s).normalize('NFKC').replace(/[‘’ʼ`´]/g, "'").replace(/[“”«»„‟]/g, '"').replace(/[‐‑‒–—−]/g, '-').replace(/…/g, '...');
const normQuote = s => unifyQuotes(s).toLocaleLowerCase('en').replace(/\s+/g, ' ').trim();
const trimQuote = s => normQuote(s).replace(/^[\s.,;:!?"'()\-]+|[\s.,;:!?"'()\-]+$/g, '');
/** An item's own words: Markdown links (their text is an outlet name), bare URLs and emphasis removed. */
const plainClaim = s => String(s).replace(/\[[^\]\n]*\]\([^)\s]*(?:\s+"[^"\n]*")?\)/g, ' ').replace(/https?:\/\/\S+/g, ' ').replace(/\(\s*[,;\s]*\)/g, ' ').replace(/[*_~`]/g, '').replace(/\s+/g, ' ').trim();
/** Words of a list item without its source links (the «([Outlet](url), …)» parentheses are not counted). */
export const nestedWords = s => (plainClaim(s).match(/[\p{L}\p{N}][\p{L}\p{N}'’ʼ.,%-]*/gu) ?? []).length;
const ABBREVIATION = /(?:^|[^\p{L}])(?:млн|млрд|трлн|тис|грн|дол|див|напр|ін|рр?|ст|пор|U\.S|U\.K|e\.g|i\.e|vs|etc|Inc|Ltd|Corp|Co|Dr|Mr|Mrs|Ms|No|St|Jr|Sr|\p{Lu})$/u;
/** Sentences of a list item, counted conservatively (see itemMaxSentences). */
export function nestedSentences(s) {
  const t = plainClaim(s);
  let count = 1;
  for (const m of t.matchAll(/[.!?…]+["»”’)]*\s+(?=[\p{Lu}«"„“])/gu)) {
    if (m[0].startsWith('.') && !m[0].startsWith('..') && ABBREVIATION.test(t.slice(0, m.index))) continue;
    count += 1;
  }
  return count;
}
const tokensOf = s => normQuote(plainClaim(s)).match(/[\p{L}\p{N}]+/gu) ?? [];
/** The longest run of consecutive words two texts share. */
function longestRun(a, b) {
  let best = 0, prev = new Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    const row = new Array(b.length + 1).fill(0);
    for (let j = 1; j <= b.length; j++) if (a[i - 1] === b[j - 1]) { row[j] = prev[j - 1] + 1; if (row[j] > best) best = row[j]; }
    prev = row;
  }
  return best;
}
/* forbiddenPhrases: {"wrong": "right"} — known wrong spellings or calques, matched as whole words, case-insensitively. */
function checkForbiddenPhrases(step, text) {
  let map;
  try { map = JSON.parse(step.config.forbiddenPhrases); } catch { map = null; }
  insist(map && typeof map === 'object' && !Array.isArray(map) && Object.entries(map).every(([k, v]) => k.trim() && typeof v === 'string' && v.trim()), 'forbiddenPhrases must be a JSON object of a wrong phrase to its right form');
  const lower = normQuote(text);
  for (const [wrong, right] of Object.entries(map)) {
    const re = new RegExp(`${B}${normQuote(wrong).replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '\\s+')}${E}`, 'u');
    insist(!re.test(lower), `The text uses «${wrong}»; write «${right}»`);
  }
}
const FACT_VERDICTS = ['supported', 'revised', 'removed'];
/* factCheck: a model step's claim records for the final text, checked here deterministically:
   - every list item of the final text has exactly one kept claim record ({item: its 1-based position});
   - a kept claim is "supported" or "revised"; any other verdict (unsupported, overstated…) must be revised or removed;
   - its sources are selected sources the item links, and each of its quotes (≥ 3 words) occurs verbatim — case,
     spaces, quote marks and dashes normalised — in the title or text of one of those sources as the Core holds them;
   - every number in the item's own words is among the numbers of its quotes or linked sources' title/text (numberTokens);
   - a removed claim ({verdict: "removed", text}) is not in the final text (same words, ≥ 80% of them in one item).
   The model's judgment that a quote supports the wording is not proven here; the quote and numbers are. */
function checkFactCheck(record, text, nestedItems, sources, citedUrls, citedOf = index => citedUrls(nestedItems[index].text)) {
  insist(record && typeof record === 'object' && Array.isArray(record.claims), 'factCheck must reference a fact-check output {claims:[...], text}');
  insist(typeof record.text === 'string' && record.text.trim() === text.trim(), 'The checked draft must be the fact-checked text (factCheck.text); the draft before the fact check is not delivered');
  insist(record.claims.length > 0 && record.claims.length <= 100, 'factCheck needs 1..100 claim records');
  const byUrl = new Map(sources.map(source => [source.url, source]));
  const kept = new Map(), removed = [], out = [];
  record.claims.forEach((claim, index) => {
    const label = `Fact check claim ${index + 1}`;
    insist(claim && typeof claim === 'object', `${label} is not an object`);
    const verdict = claim.verdict;
    insist(FACT_VERDICTS.includes(verdict), `${label} has the verdict «${verdict}»; a claim is supported, revised (an unsupported or overstated claim rewritten to what the source says) or removed`);
    insist(verdict === 'supported' || typeof claim.reason === 'string' && claim.reason.trim(), `${label} (${verdict}) needs a reason`);
    if (verdict === 'removed') {
      insist(claim.item == null, `${label} is removed but still names list item ${claim.item}; a removed claim is not in the final text`);
      insist(typeof claim.text === 'string' && claim.text.trim(), `${label} is removed and needs the removed text`);
      removed.push(claim);
      out.push({ verdict, text: claim.text, reason: claim.reason });
      return;
    }
    const item = Number(claim.item);
    insist(Number.isInteger(item) && item >= 1 && item <= nestedItems.length, `${label} names list item ${claim.item}, which is not an item of the final text (1..${nestedItems.length})`);
    insist(!kept.has(item), `List item ${item} has more than one claim record (claims ${kept.get(item) + 1} and ${index + 1})`);
    kept.set(item, index);
    const itemText = nestedItems[item - 1].text;
    const cited = new Set(citedOf(item - 1));
    const urls = Array.isArray(claim.sources) ? claim.sources : [];
    insist(urls.length > 0 && urls.every(url => typeof url === 'string'), `${label} (item ${item}) needs the sources it was checked against`);
    for (const url of urls) insist(byUrl.has(url) && cited.has(url), `${label} (item ${item}) was checked against ${url}, which the item does not link as a selected source${nestedItems[item - 1].parent ? ' (a theme without links stands on the links of its sub-items)' : ''}`);
    const quotes = (Array.isArray(claim.quote) ? claim.quote : claim.quote == null ? [] : [claim.quote]).filter(q => typeof q === 'string' && q.trim());
    insist(quotes.length > 0, `List item ${item} has no quote from its linked sources; every claim, a theme's generalisation included, needs a verbatim quote that supports it: ${itemText.slice(0, 60)}`);
    const grounds = urls.flatMap(url => [byUrl.get(url).title, byUrl.get(url).text].filter(t => typeof t === 'string').map(normQuote));
    for (const quote of quotes) {
      const q = trimQuote(quote);
      insist((q.match(/[\p{L}\p{N}]+/gu) ?? []).length >= 3 && q.length <= 600, `List item ${item}: a quote must be 3 or more words and at most 600 characters: «${quote.slice(0, 60)}»`);
      insist(grounds.some(g => g.includes(q)), `List item ${item}: the quote is not in the text of its linked sources: «${quote.slice(0, 80)}»`);
    }
    // Numbers are checked against the item's quotes and the full title + text of its linked sources (live run
    // 461a3df0, 27.09: «майже на половину» is in the source title «…nearly in half…», not in the chosen quote).
    const sourceTexts = urls.flatMap(url => [byUrl.get(url).title, byUrl.get(url).text].filter(t => typeof t === 'string'));
    // «in half» / «удвічі» (ratio 2) and «половина» (share 1/2) state the same halving; thirds stay apart (65ef7d49).
    const canon = token => token === 'share:1/2' ? 'ratio:2' : token;
    const quoteTokens = new Set([...quotes, ...sourceTexts].flatMap(q => numberTokens(unifyQuotes(q)).map(t => canon(t.token))));
    const missing = numberTokens(unifyQuotes(plainClaim(itemText))).filter(t => !t.quoteOnly && !quoteTokens.has(canon(t.token)));
    insist(missing.length === 0, `List item ${item} states «${missing[0]?.surface}» (${missing[0]?.token}), which is not in its quote or linked sources; numbers must be exactly as in the source: ${itemText.slice(0, 60)}`);
    out.push({ item, verdict, sources: urls, quote: quotes, numbers: [...new Set(numberTokens(unifyQuotes(plainClaim(itemText))).filter(t => !t.quoteOnly).map(t => t.token))], ...(claim.reason ? { reason: claim.reason } : {}) });
  });
  const unmapped = nestedItems.findIndex((_, i) => !kept.has(i + 1));
  insist(unmapped < 0, `List item ${unmapped + 1} has no claim record; every item of the final text is fact-checked: ${nestedItems[unmapped]?.text.slice(0, 60)}`);
  // Removed wording is still present when an item contains it, or a contiguous run of at least 60% of its words
  // (4 or more). Shared words alone do not count: a model may record a whole original item as removed and keep a
  // correct rewrite that reuses most of its words in another order (review of PR #29: 84% on the Nscale item).
  for (const claim of removed) {
    const plain = normQuote(plainClaim(claim.text)), words = tokensOf(claim.text);
    const present = nestedItems.find(({ text: t }) => {
      if (plain.length >= 12 && normQuote(plainClaim(t)).includes(plain)) return true;
      const run = longestRun(words, tokensOf(t));
      return run >= 4 && run >= 0.6 * words.length;
    });
    insist(!present, `A removed claim is still in the final text: «${claim.text.slice(0, 60)}» in «${present?.text.slice(0, 60)}»`);
  }
  out.sort((a, b) => (a.item ?? Infinity) - (b.item ?? Infinity));
  const count = verdict => out.filter(c => c.verdict === verdict).length;
  return { claims: out, supported: count('supported'), revised: count('revised'), removed: count('removed'), grounding: 'feed-item title and summary of each linked source, as the Core holds them; the full articles are not read' };
}
export function runParseWeb(step, ctx) {
  if (step.config.items != null) return runParseFeedItems(step, ctx);
  const inputs = step.config.source ? [value(step, 'source', ctx)] : Object.values(ctx.priorOutputs).filter(v => v && typeof v.url === 'string' && typeof v.body === 'string');
  insist(inputs.length > 0 && inputs.length <= 20, 'parse-web requires 1..20 fetched text sources');
  const maxChars = Number(step.config.maxChars ?? 6000);
  insist(Number.isInteger(maxChars) && maxChars >= 500 && maxChars <= 10000, 'parse-web maxChars must be 500..10000');
  const sources = inputs.map(source => {
    insist(source?.status >= 200 && source.status < 300 && typeof source.body === 'string' && /^https?:\/\//.test(source.url), 'parse-web requires a successful fetch');
    const text = strip(source.body);
    insist(text.length > 0, 'Source has no readable text');
    return { id: hash(source.url), url: source.url, text: text.slice(0, maxChars), sourceSha256: hash(source.body), sourceTruncated: source.truncated === true, textTruncated: text.length > maxChars, extraction: 'static-html-text; dynamic content and factual accuracy not verified' };
  });
  return { output: { sources } };
}

const intIn = (step, field, min, max, fallback) => {
  const n = step.config[field] == null ? fallback : Number(step.config[field]);
  insist(Number.isInteger(n) && n >= min && n <= max, `parse-web ${field} must be ${min}..${max}`);
  return n;
};
const timeBound = (step, field, ctx) => {
  if (step.config[field] == null) return null;
  const raw = textValue(step, field, ctx);
  insist(!/\{\{[^{}]*\}\}/.test(raw), `parse-web ${field} has an unresolved template placeholder`);
  const at = Date.parse(raw);
  insist(/^\d{4}-\d{2}-\d{2}/.test(raw) && Number.isFinite(at), `parse-web ${field} must be an ISO date or date-time`);
  return at;
};
// Feed summaries often carry escaped HTML and numeric entities after the feed reader: decode, then strip again.
const NAMED = { nbsp: ' ', amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', hellip: '…', mdash: '—', ndash: '–', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“' };
const cleanItemText = raw => {
  let text = String(raw);
  for (let pass = 0; pass < 2; pass += 1) text = text
    .replace(/&#(\d{1,7});/g, (m, n) => { const c = Number(n); return c > 0 && c <= 0x10ffff ? String.fromCodePoint(c) : ' '; })
    .replace(/&#x([0-9a-f]{1,6});/gi, (m, n) => { const c = parseInt(n, 16); return c > 0 && c <= 0x10ffff ? String.fromCodePoint(c) : ' '; })
    .replace(/&([a-z]+);/gi, (m, n) => NAMED[n.toLowerCase()] ?? m);
  return strip(text);
};
/** items: feed — each RSS/Atom item becomes its own source with its own link, date and bounded text. */
function runParseFeedItems(step, ctx) {
  insist(step.config.items === 'feed', 'parse-web items must be "feed"');
  const inputs = step.config.source ? [value(step, 'source', ctx)] : Object.values(ctx.priorOutputs).filter(v => v && typeof v.url === 'string' && typeof v.body === 'string');
  insist(inputs.length > 0 && inputs.length <= 20, 'parse-web requires 1..20 fetched text sources');
  const perFeed = intIn(step, 'maxItemsPerSource', 1, 50, 10), itemChars = intIn(step, 'itemChars', 100, 2000, 400);
  const since = timeBound(step, 'since', ctx), until = timeBound(step, 'until', ctx);
  insist(since === null || until === null || since < until, 'parse-web since must be before until');
  const sources = [], feeds = [];
  for (const source of inputs) {
    insist(source?.status >= 200 && source.status < 300 && typeof source.body === 'string' && /^https?:\/\//.test(source.url), 'parse-web requires a successful fetch');
    const entries = parseFeed(source.body);
    insist(entries.length > 0, `Source is not an RSS/Atom feed: ${source.url}`);
    const dated = entries.map(entry => ({ ...entry, at: Date.parse(entry.published) }))
      .filter(entry => /^https?:\/\//.test(entry.link) && entry.title)
      .filter(entry => since === null && until === null || Number.isFinite(entry.at) && (since === null || entry.at >= since) && (until === null || entry.at < until))
      .sort((a, b) => (Number.isFinite(b.at) ? b.at : -Infinity) - (Number.isFinite(a.at) ? a.at : -Infinity));
    const kept = dated.slice(0, perFeed);
    feeds.push({ url: source.url, sourceSha256: hash(source.body), sourceTruncated: source.truncated === true, entries: entries.length, inWindow: dated.length, kept: kept.length });
    // Items stay small because a model reads them: provenance of the feed bytes lives in feeds[].
    for (const entry of kept) {
      const summary = cleanItemText(entry.summary);
      sources.push({ n: sources.length + 1, url: entry.link, feed: source.url, title: cleanItemText(entry.title), published: Number.isFinite(entry.at) ? new Date(entry.at).toISOString() : null, text: summary.slice(0, itemChars), textTruncated: summary.length > itemChars });
    }
  }
  insist(sources.length > 0, 'No feed items in the requested time window');
  insist(sources.length <= 100, 'parse-web items produced more than 100 sources; lower maxItemsPerSource');
  return { output: { sources, feeds, extraction: 'feed-item title and summary only; the linked articles were not read and factual accuracy is not verified', window: { since: since === null ? null : new Date(since).toISOString(), until: until === null ? null : new Date(until).toISOString() } } };
}
export function runDeduplicate(step, ctx) {
  const input = value(step, 'source', ctx);
  const sources = Array.isArray(input) ? input : input?.sources;
  insist(Array.isArray(sources) && sources.length > 0 && sources.length <= 100, 'deduplicate requires 1..100 sources');
  if (step.config.clusters != null) return clusterSources(step, ctx, sources);
  const seen = new Set(), unique = [];
  for (const source of sources) {
    insist(typeof source?.url === 'string' && /^https?:\/\//.test(source.url) && typeof source.text === 'string', 'Invalid source');
    const key = hash({ url: source.url, text: source.text });
    if (!seen.has(key)) { seen.add(key); unique.push({ ...source, key }); }
  }
  return { output: { sources: unique, removed: sources.length - unique.length, sourceHash: hash(unique.map(s => ({ url: s.url, key: s.key }))) } };
}

/* clusters: a meaning-level deduplication proposed by a model step and checked here. Each cluster is one meaning
   with every source that reports it; a source belongs to at most one cluster, every URL must be a selected source,
   and the model's order is its importance ranking. Only the first maxClusters clusters are kept. */
function clusterSources(step, ctx, sources) {
  const proposal = value(step, 'clusters', ctx);
  const clusters = Array.isArray(proposal) ? proposal : proposal?.clusters;
  insist(Array.isArray(clusters) && clusters.length > 0 && clusters.length <= 50, 'deduplicate clusters requires 1..50 clusters');
  const maxClusters = step.config.maxClusters == null ? 8 : Number(step.config.maxClusters);
  insist(Number.isInteger(maxClusters) && maxClusters >= 1 && maxClusters <= 20, 'deduplicate maxClusters must be 1..20');
  const byUrl = new Map(), byNumber = new Map();
  for (const source of sources) {
    insist(typeof source?.url === 'string' && /^https?:\/\//.test(source.url) && typeof source.text === 'string', 'Invalid source');
    if (!byUrl.has(source.url)) byUrl.set(source.url, source);
    if (Number.isInteger(source.n) && !byNumber.has(source.n)) byNumber.set(source.n, source);
  }
  // A cluster names its sources by their item number n (preferred: a model cannot misspell a number into a
  // plausible URL) or by their exact URL; either way only selected sources are accepted.
  const resolveRef = (ref, index) => {
    if (Number.isInteger(ref)) { insist(byNumber.has(ref), `Cluster ${index + 1} cites item ${ref}, which is not a selected source`); return byNumber.get(ref).url; }
    insist(typeof ref === 'string', `Cluster ${index + 1} needs a nonempty sources array of item numbers or URLs`);
    return ref;
  };
  const claimed = new Map();
  const checked = clusters.map((cluster, index) => {
    const topic = typeof cluster?.topic === 'string' ? cluster.topic.trim() : '';
    const summary = typeof cluster?.summary === 'string' ? cluster.summary.trim() : '';
    insist(topic.length > 0 && topic.length <= 200, `Cluster ${index + 1} needs a topic of 1..200 characters`);
    insist(summary.length <= 1200, `Cluster ${index + 1} summary is longer than 1200 characters`);
    const urls = cluster?.sources;
    insist(Array.isArray(urls) && urls.length > 0, `Cluster ${index + 1} needs a nonempty sources array of item numbers or URLs`);
    const refs = [...new Set(urls.map(ref => resolveRef(ref, index)))];
    for (const url of refs) {
      insist(byUrl.has(url), `Cluster ${index + 1} cites a URL that is not a selected source: ${url}`);
      insist(!claimed.has(url), `Source ${url} is in clusters ${claimed.get(url) + 1} and ${index + 1}; a meaning is counted once`);
      claimed.set(url, index);
    }
    const members = refs.map(url => byUrl.get(url));
    const outlets = new Set(members.map(member => { try { return new URL(member.feed ?? member.url).hostname.replace(/^www\./, ''); } catch { return member.url; } }));
    return { rank: index + 1, topic, summary, independentOutlets: outlets.size, sources: members.map(({ key, ...member }) => member) };
  });
  // Importance: a meaning reported by more independent outlets ranks first; the model's order breaks ties. So a
  // single-outlet item cannot push a story that several outlets carry out of the kept clusters.
  checked.sort((a, b) => b.independentOutlets - a.independentOutlets || a.rank - b.rank);
  checked.forEach((cluster, index) => { cluster.modelRank = cluster.rank; cluster.rank = index + 1; });
  const kept = checked.slice(0, maxClusters);
  // Each selected source names its cluster, so a later check can hold one list item to one meaning.
  const selected = kept.flatMap(cluster => cluster.sources.map(source => ({ ...source, cluster: cluster.rank })));
  return { output: { clusters: kept, sources: selected, removed: sources.length - selected.length, droppedClusters: checked.length - kept.length, unclustered: sources.length - claimed.size, sourceHash: hash(selected.map(s => ({ url: s.url, title: s.title ?? null, text: s.text }))) } };
}
export function runVerifySources(step, ctx) {
  const draft = value(step, 'draft', ctx), input = value(step, 'sources', ctx);
  const sources = Array.isArray(input) ? input : input?.sources;
  const text = typeof draft === 'string' ? draft : draft?.text;
  insist(typeof text === 'string' && text.trim() && text.length <= 16000, 'A bounded nonempty draft is required');
  insist(Array.isArray(sources) && sources.length > 0, 'Pinned source list required');
  const urls = new Set(sources.map(s => s.url));
  const fixedLinks = stringList(step, 'fixedLinks', ctx);
  insist(fixedLinks.every(url => /^https?:\/\//.test(url)), 'fixedLinks must be a JSON array of HTTP(S) URLs');
  const requiredHeadings = stringList(step, 'requiredHeadings', ctx);
  insist(step.config.nestedList == null || requiredHeadings.length === 0, 'nestedList replaces requiredHeadings, introLinks and the section shape checks');
  // introLinks: URLs allowed only once each, as an inline Markdown link inside the introduction sentence
  // (between requiredPrefix and the first required section), never as a standalone link line.
  const introLinks = stringList(step, 'introLinks', ctx);
  insist(introLinks.every(url => /^https?:\/\//.test(url)), 'introLinks must be a JSON array of HTTP(S) URLs');
  // requiredEnvPatterns: {"NAME": "regex"} — each variable must be set and match fully (e.g. a DD.MM date).
  if (step.config.requiredEnvPatterns != null) {
    let patterns;
    try { patterns = JSON.parse(step.config.requiredEnvPatterns); } catch { patterns = null; }
    insist(patterns && typeof patterns === 'object' && !Array.isArray(patterns) && Object.entries(patterns).every(([name, re]) => /^[A-Z][A-Z0-9_]*$/.test(name) && typeof re === 'string' && re.length > 0), 'requiredEnvPatterns must be a JSON object of NAME to regular expression');
    for (const [name, re] of Object.entries(patterns)) {
      const value = process.env[name];
      insist(typeof value === 'string' && new RegExp(`^(?:${re})$`).test(value), `Environment variable ${name} must match ${re}`);
    }
  }
  const requiredPrefix = step.config.requiredPrefix == null ? null : textValue(step, 'requiredPrefix', ctx);
  insist(requiredPrefix === null || typeof requiredPrefix === 'string' && requiredPrefix.length > 0, 'requiredPrefix must be a nonempty string');
  // An unset {{env.NAME}} stays in place by design; a contract that still carries
  // a placeholder would silently require the literal braces, so refuse it.
  insist(![requiredPrefix ?? '', ...fixedLinks, ...requiredHeadings, ...introLinks].some(item => /\{\{[^{}]*\}\}/.test(item)), 'Format contract has an unresolved template placeholder');
  if (requiredPrefix !== null) insist(text.startsWith(requiredPrefix), 'Draft does not begin with the required literal prefix');
  if (requiredHeadings.length > 0) {
    insist(requiredHeadings.every(heading => /^## \S/.test(heading) && !/[\r\n]/.test(heading)), 'requiredHeadings must be level-two Markdown headings');
    // Only the required level-two sections may exist; ### thematic sub-blocks inside them are allowed. Any other
    // level-one/two heading form (ATX with up to three leading spaces, or a setext underline) is refused.
    const lines = text.split(/\r?\n/);
    // A setext underline makes a heading only under a paragraph; under a list item (or its continuation) or a
    // quote it is a thematic break, so it is allowed there.
    // Context of a line = the contiguous non-blank lines above it. Under a list item an underline indented into the
    // item's content (2+ spaces) makes a heading inside the item, so it is refused; at column 0–1 it is a break.
    // Inside a quote, a "> ---" underline makes a heading inside the quote and is refused too.
    const context = index => { let i = index; while (i > 0 && lines[i - 1].trim() !== '') i -= 1; return lines.slice(i, index); };
    lines.forEach((line, index) => {
      if (index === 0 || lines[index - 1].trim() === '') return;
      const above = context(index);
      if (/^\s*>\s*(?:=+|-+)[ \t]*$/.test(line) && /^\s*>/.test(lines[index - 1]) && /[^>\s]/.test(lines[index - 1].replace(/^\s*>/, '')))
        insist(false, 'Draft must contain exactly the required Markdown sections in order');
      if (!/^ {0,3}(?:=+|-+)[ \t]*$/.test(line)) return;
      const listOrQuote = above.some(l => /^ {0,3}(?:(?:[-*+]|\d+[.)])\s|>)/.test(l));
      insist(listOrQuote && /^ ?(?:=+|-+)/.test(line), 'Draft must contain exactly the required Markdown sections in order');
    });
    insist(lines.filter(line => /^ {0,3}#{1,2}(?:[ \t]|$)/.test(line)).every(line => /^##(?!#)/.test(line)), 'Draft must contain exactly the required Markdown sections in order');
    // A heading nested in a list item or a quote is not a section; refuse it rather than let it look like one.
    insist(!lines.some(line => /^\s*(?:(?:[-*+]|\d+[.)])\s+|>\s*)+#{1,6}(?:\s|$)/.test(line)), 'Draft must contain exactly the required Markdown sections in order');
    const headings = [...text.matchAll(/^##(?!#)[^\r\n]*$/gm)];
    insist(headings.length === requiredHeadings.length && headings.every((heading, index) => heading[0] === requiredHeadings[index]), 'Draft must contain exactly the required Markdown sections in order');
    headings.forEach((heading, index) => {
      const body = text.slice(heading.index + heading[0].length, headings[index + 1]?.index ?? text.length);
      insist(/\S/.test(body), `Required section is empty: ${heading[0]}`);
    });
  }
  // Markdown link targets are read exactly, so text glued to the closing
  // parenthesis (")і by") does not become part of the URL; bare URLs elsewhere.
  const linkTargets = [];
  const bare = text.replace(/\]\((https?:\/\/[^\s()<>]+)(?:\s+"[^"\n]*")?\)/g, (_, url) => { linkTargets.push(url); return '] '; });
  const links = [...linkTargets, ...[...bare.matchAll(/https?:\/\/[^\s<>"\]]+/g)].map(m => m[0].replace(/[).,;]+$/, ''))];
  // With a format contract, every other way to write a link is refused too: an uppercase scheme, a Markdown or
  // reference link target that is not a plain http(s) URL, a scheme-less www. address, or a raw HTML link.
  if (fixedLinks.length > 0 || introLinks.length > 0 || requiredPrefix !== null || requiredHeadings.length > 0 || step.config.nestedList != null) {
    const rest = bare.replace(/https?:\/\/[^\s<>"\]]+/g, ' ');
    insist(!/[a-z][a-z0-9+.-]*:\/\//i.test(rest), 'Draft includes an unverified URL or no source links');
    insist(!/\]\(\s*<?[^)\s]/.test(rest) && !/^ {0,3}\[[^\]]+\]:\s*\S/m.test(rest), 'Draft includes an unverified URL or no source links');
    insist(!/\bwww\./i.test(rest) && !/<\s*a\b|\b(?:href|src)\s*=/i.test(rest), 'Draft includes an unverified URL or no source links');
    // A scheme-less address with a path (t.me/x, example.com/page) is auto-linked by many clients.
    insist(!/(?<![\w@/.-])(?:[a-z0-9-]+\.)+[a-z]{2,}\/[^\s)\]]*/i.test(rest), 'Draft includes an unverified URL or no source links');
  }
  if (introLinks.length > 0) {
    // Without requiredPrefix the introduction starts at the top of the draft (a document with no fixed header).
    insist(requiredHeadings.length > 0, 'introLinks require requiredHeadings');
    const start = requiredPrefix?.length ?? 0, end = text.indexOf(`\n${requiredHeadings[0]}`);
    const intro = end < 0 ? '' : text.slice(start, end);
    // The introduction is one paragraph (no blank line, no list item, heading or quote inside it).
    const paragraph = intro.trim();
    // The introduction is one line: no blank line, no second line, no list item, heading or quote.
    insist(paragraph.length > 0 && !paragraph.includes('\n') && !/^\s*(?:[-*+>#]|\d+[.)])\s/.test(paragraph), 'The introduction must be one paragraph on one line before the first section');
    const introPrefix = step.config.requiredIntroPrefix == null ? null : textValue(step, 'requiredIntroPrefix', ctx);
    if (introPrefix !== null) insist(paragraph.startsWith(introPrefix), `The introduction must begin with: ${introPrefix}`);
    // With a required opening that ends in "[", the first link of the introduction must be the introduction link itself.
    if (introPrefix !== null && introPrefix.endsWith('[')) {
      const first = paragraph.slice(introPrefix.length - 1).match(/^\[[^\]\n]+\]\((https?:\/\/[^\s()<>]+)\)/);
      insist(first && introLinks.includes(first[1]), 'The introduction must open with the introduction link right after its required words');
    }
    for (const url of introLinks) {
      const escaped = url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const inline = new RegExp(`\\[([^\\]\\n]+)\\]\\(${escaped}\\)`, 'g');
      const everywhere = [...text.matchAll(inline)], inIntro = [...intro.matchAll(inline)];
      insist(inIntro.length === 1 && everywhere.length === 1 && links.filter(link => link === url).length === 1, `Introduction must link ${url} exactly once, inline, and nowhere else`);
      const [match, label] = inIntro[0];
      const line = intro.split('\n').find(l => l.includes(match));
      const words = line.replace(match, ' ').match(/[\p{L}\p{N}]+/gu) ?? [];
      const before = paragraph.slice(0, paragraph.indexOf(match));
      insist(!/^https?:/i.test(label.trim()) && words.length >= 3 && !/[:：]\s*$/.test(before) && !/^\s*(?:[-*+]|\d+[.)])?\s*[\p{L}\s]{0,24}:\s*$/u.test(line.replace(match, '')), `Introduction link ${url} must sit inside a sentence, not on its own link line`);
    }
  }
  // forbidLocalLinks: no localhost, private-network or file link may reach the final text.
  const forbidLocal = step.config.forbidLocalLinks === 'true' || step.config.forbidLocalLinks === true || step.config.citation === 'timestamps';
  if (forbidLocal) {
    const LOCAL_V4 = /^(?:0\.0\.0\.0|127(?:\.\d+){3}|10(?:\.\d+){3}|192\.168(?:\.\d+){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d+){2}|169\.254(?:\.\d+){2}|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])(?:\.\d+){2})$/;
    const isLocalHost = raw => {
      const host = raw.toLowerCase().replace(/\.$/, '').replace(/^\[|\]$/g, '');
      return host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || LOCAL_V4.test(host)
        || /^(?:::1|::|::ffff:.*|fe[89ab][0-9a-f]:.*|f[cd][0-9a-f]{2}:.*)$/.test(host);
    };
    insist(!/\bfile:/i.test(text), 'Draft includes a local link');
    for (const link of links) {
      let host = '';
      try { host = new URL(link).hostname; } catch { host = ''; }
      insist(host && !isLocalHost(host), `Draft includes a local link: ${link}`);
    }
    // Also without a scheme and anywhere in the text (for example inside a link title).
    const bareHost = /(?<![\w.@-])(localhost\.?|[\w-]+\.localhost\.?|[\w-]+\.local\.?|\d{1,3}(?:\.\d{1,3}){3})(?=[:/\s)\]"'`,;]|$)/gi;
    for (const m of text.matchAll(bareHost)) insist(!isLocalHost(m[1]), `Draft includes a local address: ${m[1]}`);
  }
  // citation: "timestamps" — sources are cited by [mm:ss] markers that exist in the selected source text, not by
  // their (possibly private) URLs; every cited paragraph or item in the required sections carries a marker.
  const timestampCitations = step.config.citation === 'timestamps';
  // citation: "links" — every thesis (paragraph or list item) in the required sections carries at least one link to a
  // selected source; not every selected source has to be cited (a digest selects from them).
  const linkCitations = step.config.citation === 'links';
  if (step.config.citation != null) insist(timestampCitations || linkCitations, 'citation must be "timestamps" or "links" when set');
  // The theses of each required section: paragraphs, or the items of a list; heading lines are removed.
  const sectionTheses = () => {
    const headings = [...text.matchAll(/^##(?!#)[^\r\n]*$/gm)];
    return headings.map((heading, index) => {
      const body = text.slice(heading.index + heading[0].length, headings[index + 1]?.index ?? text.length);
      const blocks = body.split(/\n\s*\n/).map(b => b.split('\n').filter(l => !/^ {0,3}#{1,6}\s/.test(l)).join('\n').trim()).filter(b => b && /[\p{L}]{3}/u.test(b));
      return { heading: heading[0], blocks, items: blocks.flatMap(b => /^(?:[-*+]|\d+[.)])\s/m.test(b) ? b.split(/\n(?=\s*(?:[-*+]|\d+[.)])\s)/) : [b]) };
    });
  };
  // Sentences of a prose block, with their links kept. Link targets, URLs and decimal points do not end a sentence;
  // a sentence ends with . ! ? or … (and closing quotes or brackets) before a space or the end.
  const sentencesOf = block => {
    const masked = [];
    const hide = match => { masked.push(match); return `\u0000${masked.length - 1}\u0001`; };
    const plain = block.replace(/\]\([^)\s]*(?:\s+"[^"\n]*")?\)/g, hide).replace(/https?:\/\/[^\s<>"\]]*[^\s<>"\].,;:!?)]/g, hide).replace(/(\d)[.,](?=\d)/g, '$1\u0002');
    const found = plain.match(/[^.!?…]*[\p{L}\p{N}][^.!?…]*(?:[.!?…]+["»”)\]]*(?=\s|$)|$)/gu) ?? [];
    return found.map(sentence => sentence.trim()).filter(sentence => /[\p{L}]{2}/u.test(sentence.replace(/\u0000\d+\u0001/g, ' ')))
      .map(sentence => sentence.replace(/\u0000(\d+)\u0001/g, (m, i) => masked[Number(i)]).replace(/\u0002/g, '.'));
  };
  const range = (raw, field) => {
    const m = typeof raw === 'string' ? raw.match(/^(\d{1,2})\.\.(\d{1,2})$/) : null;
    insist(m && Number(m[1]) >= 1 && Number(m[1]) <= Number(m[2]), `${field} values must be "min..max" with 1 <= min <= max <= 99`);
    return [Number(m[1]), Number(m[2])];
  };
  const shapeMap = field => {
    if (step.config[field] == null) return null;
    let map;
    try { map = JSON.parse(step.config[field]); } catch { map = null; }
    insist(map && typeof map === 'object' && !Array.isArray(map) && Object.keys(map).length > 0, `${field} must be a JSON object of required heading to "min..max"`);
    insist(Object.keys(map).every(heading => requiredHeadings.includes(heading)), `${field} may only name headings from requiredHeadings`);
    return Object.fromEntries(Object.entries(map).map(([heading, raw]) => [heading, range(raw, field)]));
  };
  const sectionItems = shapeMap('sectionItems'), sectionSentences = shapeMap('sectionSentences');
  // itemMaxWords: {"## Heading": N} — every list item of that section has at most N words (link targets not counted).
  let itemMaxWords = null;
  if (step.config.itemMaxWords != null) {
    try { itemMaxWords = JSON.parse(step.config.itemMaxWords); } catch { itemMaxWords = null; }
    insist(itemMaxWords && typeof itemMaxWords === 'object' && !Array.isArray(itemMaxWords) && Object.entries(itemMaxWords).every(([h, n]) => requiredHeadings.includes(h) && Number.isInteger(n) && n >= 5 && n <= 500), 'itemMaxWords must be a JSON object of a required heading to 5..500 words');
  }
  // oneClusterPerItem: ["## Heading"] — the selected-source links of each list item there belong to one cluster
  // (sources carry the cluster rank given by deduplicate clusters), so one item is one meaning.
  const oneClusterPerItem = step.config.oneClusterPerItem == null ? null : stringList(step, 'oneClusterPerItem', ctx);
  if (oneClusterPerItem) {
    insist(oneClusterPerItem.every(h => requiredHeadings.includes(h)), 'oneClusterPerItem may only name headings from requiredHeadings');
    insist(sources.every(source => Number.isInteger(source.cluster)), 'oneClusterPerItem requires sources from deduplicate clusters');
  }
  // nestedList: "N" — after requiredPrefix the draft is only a nested bullet list of at most N levels (no headings,
  // section labels or paragraphs; readers see the structure). Each item is one line; with citation: links every item,
  // at any level, links a selected source.
  let nestedItems = null;
  if (step.config.nestedList != null) {
    const maxDepth = Number(step.config.nestedList);
    insist(/^[1-6]$/.test(String(step.config.nestedList)), 'nestedList must be the maximum list depth, 1..6');
    insist(requiredHeadings.length === 0 && introLinks.length === 0 && !sectionItems && !sectionSentences && !itemMaxWords && !oneClusterPerItem, 'nestedList replaces requiredHeadings, introLinks and the section shape checks');
    const body = requiredPrefix === null ? text : text.slice(requiredPrefix.length);
    const lines = body.split(/\r?\n/).filter(line => line.trim() !== '');
    insist(lines.length > 0, 'The draft has no list after the header');
    let unit = null, previous = 0;
    nestedItems = lines.map(line => {
      const m = line.match(/^( *)[-*+] +(\S.*)$/);
      insist(m && !/^\s*(?:[-*+] +)+#{1,6}(?:\s|$)/.test(line), `The draft after the header must be a nested bullet list only (no section labels, headings or paragraphs): ${line.slice(0, 60)}`);
      // Item text that opens another list, a quote or a code fence would nest deeper than the indentation says.
      insist(!/^(?:[-*+]\s|\d+[.)]\s|>)/.test(m[2]) && !/```|~~~/.test(m[2]), `A list item may not open another list, a quote or a code block: ${line.slice(0, 60)}`);
      const indent = m[1].length;
      if (indent > 0 && unit === null) unit = indent;
      insist(indent === 0 || (unit >= 2 && unit <= 4 && indent % unit === 0), `List indentation must be a consistent 2-4 spaces per level: ${line.slice(0, 60)}`);
      const depth = indent === 0 ? 1 : indent / unit + 1;
      insist(depth <= previous + 1, `A list item skips a level: ${line.slice(0, 60)}`);
      insist(depth <= maxDepth, `The list is deeper than ${maxDepth} levels: ${line.slice(0, 60)}`);
      previous = depth;
      return { depth, text: m[2] };
    });
    // An item with sub-items is a parent (a theme at level 1); its sub-items run until the depth returns to its own.
    nestedItems.forEach((item, index) => {
      let end = index;
      while (end + 1 < nestedItems.length && nestedItems[end + 1].depth > item.depth) end += 1;
      Object.assign(item, { parent: end > index, end });
    });
    // forbiddenLabels: ["Кейси", ...] — an item may not open with a section label (bold or plain, before ":", "—",
    // "(" or the end), even when it carries a link: readers see the structure without labels.
    const labels = step.config.forbiddenLabels == null ? [] : stringList(step, 'forbiddenLabels', ctx);
    insist(labels.every(label => typeof label === 'string' && label.trim().length > 0), 'forbiddenLabels must be a JSON array of nonempty strings');
    for (const item of nestedItems) {
      const head = labelHead(item.text);
      const label = labels.find(l => { const low = labelHead(l); return low && head.startsWith(low) && /^[^\p{L}\p{N}]*(?:[:：—–\-.(\[]|$)/u.test(head.slice(low.length)); });
      insist(!label, `A list item opens with the section label «${label}»: ${item.text.slice(0, 60)}`);
    }
    // outletLinkText: every selected-source link in an item names its outlet (the link text contains the site name).
    if (step.config.outletLinkText === 'true' || step.config.outletLinkText === true) {
      const norm = value => value.toLocaleLowerCase('en').replace(/[^\p{L}\p{N}]/gu, '');
      for (const item of nestedItems) for (const [, label, url] of item.text.matchAll(/\[([^\]\n]+)\]\((https?:\/\/[^\s()<>]+)\)/g)) {
        if (!urls.has(url)) continue;
        let host = '';
        try { host = new URL(url).hostname.replace(/^www\./, ''); } catch { host = ''; }
        const text = norm(label), names = outletNames(host).map(norm).filter(Boolean);
        const words = label.toLocaleLowerCase('en').split(/[^\p{L}\p{N}]+/u).filter(Boolean);
        // A one- or two-letter name (x.com, t.me) must be a whole word of the link text, or a known outlet name.
        const matches = site => site.length < 3 ? words.includes(site) || (OUTLET_ALIASES[site] ?? []).some(a => text.includes(a)) : text.includes(site) || (text.length >= 3 && site.includes(text));
        insist(text && names.some(matches), `A source link must name its outlet («${label}» for ${host}): ${item.text.slice(0, 60)}`);
      }
    }
  }
  const shaped = (linkCitations && !nestedItems) || sectionItems || sectionSentences || itemMaxWords || oneClusterPerItem;
  if (shaped) insist(requiredHeadings.length > 0, 'citation: links, sectionItems, sectionSentences, itemMaxWords and oneClusterPerItem require requiredHeadings (or nestedList for citation: links)');
  const theses = shaped ? sectionTheses() : [];
  // Selected-source URLs a piece of text cites, as a Markdown link target or a bare URL. Inline code and HTML comments
  // are not links a reader can open, so they are removed first.
  const selected = [...urls];
  const readable = piece => piece.replace(/`[^`\n]*`/g, ' ').replace(/<!--[\s\S]*?-->/g, ' ');
  const citedUrls = piece => { const text = readable(piece); return selected.filter(url => text.includes(`](${url})`) || text.includes(`](${url} `) || new RegExp(`(?<![\\w/])${url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w/-])`).test(text)); };
  if (shaped) for (const { heading } of theses) {
    // A ### sub-heading inside a shaped section would be a thesis the checks cannot see; the shape is flat.
    const body = text.slice(text.indexOf(heading) + heading.length).split(/^##(?!#)/m)[0];
    insist(!/^ {0,3}#{3,6}\s/m.test(body), `${heading}: sub-headings are not allowed where theses are checked`);
  }
  const wordsOf = piece => (piece.replace(/\]\([^)\s]*\)/g, ']').replace(/https?:\/\/\S+/g, ' ').match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) ?? []).length;
  if (sectionItems) for (const { heading, blocks, items } of theses) {
    if (!sectionItems[heading]) continue;
    const [min, max] = sectionItems[heading];
    // Only top-level list items count, and the section holds nothing but that list; each item is one line.
    insist(blocks.every(b => /^(?:[-*+]|\d+[.)])\s/.test(b)), `${heading} must be a list only`);
    const count = blocks.join('\n').split('\n').filter(l => /^(?:[-*+]|\d+[.)])\s/.test(l)).length;
    insist(count >= min && count <= max, `${heading} must have ${min}..${max} list items; found ${count}`);
    insist(items.every(item => !item.trim().includes('\n')), `${heading}: each list item must be one line (a line break inside an item can split a word)`);
    insist(!blocks.some(b => /^\s+(?:[-*+]|\d+[.)])\s/m.test(b)), `${heading}: nested list items are not allowed; one item is one thesis`);
  }
  for (const { heading, items } of theses) {
    if (itemMaxWords?.[heading]) {
      const long = items.find(item => wordsOf(item) > itemMaxWords[heading]);
      insist(!long, `${heading}: a list item has more than ${itemMaxWords[heading]} words: ${long?.slice(0, 60)}`);
    }
    if (oneClusterPerItem?.includes(heading)) {
      const clusterOf = new Map(sources.map(source => [source.url, source.cluster]));
      const used = new Map();
      for (const item of items) {
        const ranks = new Set(citedUrls(item).map(url => clusterOf.get(url)));
        insist(ranks.size <= 1, `${heading}: one list item cites ${ranks.size} clusters; one item is one meaning: ${item.slice(0, 60)}`);
        // Different items are different meanings: two items may not cite the same cluster.
        for (const rank of ranks) {
          insist(!used.has(rank), `${heading}: two list items cite the same cluster ${rank}; each meaning appears once: ${item.slice(0, 60)}`);
          used.set(rank, item);
        }
      }
    }
  }
  if (sectionSentences) for (const { heading, blocks } of theses) {
    if (!sectionSentences[heading]) continue;
    const [min, max] = sectionSentences[heading];
    insist(blocks.every(b => !/^(?:[-*+>]|\d+[.)])\s/m.test(b)), `${heading} must be prose, not a list or a quote`);
    insist(blocks.every(b => !b.includes('\n')), `${heading}: each paragraph must be one line (a line break inside a paragraph can split a word)`);
    const count = blocks.flatMap(sentencesOf).length;
    insist(count >= min && count <= max, `${heading} must have ${min}..${max} sentences; found ${count}`);
  }
  // compactLinks: "true" (Core38) — an item with sub-items carries no links: its cases link the sources, and the
  // parent (a theme) is a plain conclusion. A top-level item without sub-items keeps its links like any case.
  const compact = step.config.compactLinks === 'true' || step.config.compactLinks === true;
  if (step.config.compactLinks != null) insist((compact || String(step.config.compactLinks) === 'false') && nestedItems, 'compactLinks must be "true" or "false" and requires nestedList');
  if (compact) for (const item of nestedItems.filter(i => i.parent))
    insist(!/https?:\/\/|\]\(/i.test(item.text), `A list item with sub-items carries no links under compactLinks; its cases link the sources: ${item.text.slice(0, 60)}`);
  // The sources an item stands on: its own links, or under compactLinks for a parent the links of its sub-items.
  const citedOf = index => {
    const item = nestedItems[index];
    if (!(compact && item.parent)) return citedUrls(item.text);
    return [...new Set(nestedItems.slice(index + 1, item.end + 1).flatMap(sub => citedUrls(sub.text)))];
  };
  // caseMaxWords / themeMaxWords / itemMaxSentences (Core38): short items. A theme is a top-level item with sub-items;
  // every other item (a case, a comment, a stand-alone top-level item) is a case. Words are counted without the link
  // parentheses and link markup; a sentence ends at . ! ? … before a space and an uppercase letter or an opening quote,
  // not after an abbreviation (млн., U.S.) or inside a decimal.
  const cap = field => {
    if (step.config[field] == null) return null;
    insist(nestedItems, `${field} requires nestedList`);
    const n = Number(step.config[field]);
    insist(Number.isInteger(n) && n >= 1 && n <= 500, `${field} must be an integer 1..500`);
    return n;
  };
  const caseMax = cap('caseMaxWords'), themeMax = cap('themeMaxWords'), maxSentences = cap('itemMaxSentences');
  if (nestedItems) nestedItems.forEach(item => {
    const theme = item.depth === 1 && item.parent, max = theme ? themeMax : caseMax;
    if (max !== null) {
      const words = nestedWords(item.text);
      insist(words <= max, `A ${theme ? 'theme' : 'case'} has ${words} words; at most ${max} (without its source links): ${item.text.slice(0, 60)}`);
    }
    if (maxSentences !== null) {
      const count = nestedSentences(item.text);
      insist(count <= maxSentences, `A list item has ${count} sentences; at most ${maxSentences}, the key fact only: ${item.text.slice(0, 60)}`);
    }
  });
  if (linkCitations) {
    const cites = piece => citedUrls(piece).length > 0;
    // A list item is one thesis; in prose every sentence is one (a sentence may lean on the link that closes the next
    // one only if it has none itself — that is refused, so each claim carries its own source).
    const pieces = nestedItems ? nestedItems.filter(item => !(compact && item.parent)).map(item => item.text) : theses.flatMap(section => section.items.flatMap(item => /^(?:[-*+]|\d+[.)])\s/.test(item) ? [item] : sentencesOf(item)));
    const uncited = pieces.filter(piece => !cites(piece));
    insist(uncited.length === 0, `Every thesis needs a link to a selected source; uncited: ${uncited[0]?.slice(0, 60)}`);
  }
  // nestedOrder: "cluster" — top-level items (with everything nested under them) are ordered by weight: the best
  // (lowest) cluster rank they cite never goes back up. Ranks come from deduplicate clusters (independent outlets).
  if (step.config.nestedOrder != null) {
    insist(step.config.nestedOrder === 'cluster' && nestedItems, 'nestedOrder must be "cluster" and requires nestedList');
    insist(sources.every(source => Number.isInteger(source.cluster)), 'nestedOrder requires sources from deduplicate clusters');
    const clusterOf = new Map(sources.map(source => [source.url, source.cluster]));
    const groups = [];
    for (const item of nestedItems) if (item.depth === 1) groups.push([item]); else groups.at(-1).push(item);
    let last = 0;
    for (const group of groups) {
      const ranks = group.flatMap(item => citedUrls(item.text).map(url => clusterOf.get(url)));
      if (!ranks.length) continue;
      const best = Math.min(...ranks);
      insist(best >= last, `Top-level items must be ordered by weight (cluster rank ${best} comes after ${last}): ${group[0].text.slice(0, 60)}`);
      last = best;
    }
  }
  // factCheck (Core38): claim records of a fact-check model step for this exact text; see checkFactCheck.
  let factCheck = null;
  if (step.config.factCheck != null) {
    insist(nestedItems && linkCitations, 'factCheck requires nestedList and citation: links');
    factCheck = checkFactCheck(value(step, 'factCheck', ctx), text, nestedItems, sources, citedUrls, citedOf);
  }
  if (step.config.forbiddenPhrases != null) checkForbiddenPhrases(step, text);
  if (timestampCitations) {
    insist(requiredHeadings.length > 0, 'citation: timestamps requires requiredHeadings');
    const known = new Set(sources.flatMap(source => String(source.text ?? '').match(/\[\d{1,2}:\d{2}(?::\d{2})?\]/g) ?? []));
    insist(known.size > 0, 'Selected sources carry no [mm:ss] markers');
    const stamps = text.match(/\[\d{1,2}:\d{2}(?::\d{2})?\]/g) ?? [];
    insist(stamps.length > 0, 'Draft cites no [mm:ss] timestamp');
    const unknown = stamps.filter(stamp => !known.has(stamp));
    insist(unknown.length === 0, `Draft timestamps are not markers of the selected sources: ${[...new Set(unknown)].join(', ')}`);
    // A two-digit mm:ss outside square brackets is a timestamp in the wrong form (write a time of day as 14.30).
    const loose = text.replace(/\[\d{1,2}:\d{2}(?::\d{2})?\]/g, ' ').match(/(?<![\d.:])\d{2}:\d{2}(?::\d{2})?(?![\d:])/g);
    insist(!loose, `Draft writes timestamps outside the [mm:ss] form: ${(loose ?? []).slice(0, 3).join(', ')}`);
    const first = text.search(new RegExp(`^${requiredHeadings[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'));
    insist(first >= 0, 'Draft must contain exactly the required Markdown sections in order');
    const body = text.slice(first);
    // Heading lines are removed, not the blocks that follow them, so a thesis under a ### title still needs a marker.
    const blocks = body.split(/\n\s*\n/).map(b => b.split('\n').filter(l => !/^ {0,3}#{1,6}\s/.test(l)).join('\n').trim()).filter(b => b && /[\p{L}]{3}/u.test(b));
    const items = blocks.flatMap(b => /^(?:[-*+]|\d+[.)])\s/m.test(b) ? b.split(/\n(?=\s*(?:[-*+]|\d+[.)])\s)/) : [b]);
    const uncited = items.filter(item => !/\[\d{1,2}:\d{2}(?::\d{2})?\]/.test(item));
    insist(uncited.length === 0, `Every item needs its own [mm:ss] timestamp; uncited: ${uncited[0]?.slice(0, 60)}`);
  }
  const allowed = new Set([...(timestampCitations ? [] : urls), ...fixedLinks, ...introLinks]);
  insist(links.length > 0 && links.every(link => allowed.has(link)), 'Draft includes an unverified URL or no source links');
  if (!timestampCitations && !linkCitations) insist([...urls].every(url => links.includes(url)), 'Draft must cite each selected source');
  if (step.config.language === 'uk') insist(/[іїєґІЇЄҐ]/.test(text), 'Draft does not contain Ukrainian language markers');
  return { output: { text, artifactHash: hash(text), sourceHash: hash(sources), ...(fixedLinks.length === 0 ? {} : { fixedLinks }), checks: ['bounded-text', 'source-link-allowlist', timestampCitations ? 'selected-sources-cited-by-timestamp' : linkCitations ? 'every-thesis-cites-a-selected-source' : 'all-selected-sources-cited', ...(requiredPrefix === null ? [] : ['required-literal-prefix']), ...(requiredHeadings.length === 0 ? [] : ['required-markdown-sections']), ...(introLinks.length === 0 ? [] : ['intro-links-inline']), ...(forbidLocal ? ['no-local-links'] : []), ...(timestampCitations ? ['timestamp-citations'] : []), ...(sectionItems ? ['section-item-counts'] : []), ...(sectionSentences ? ['section-sentence-counts'] : []), ...(itemMaxWords ? ['item-word-limits'] : []), ...(oneClusterPerItem ? ['one-cluster-per-item'] : []), ...(nestedItems ? ['nested-list-depth'] : []), ...(step.config.nestedOrder != null ? ['nested-order-by-cluster'] : []), ...(step.config.forbiddenLabels != null ? ['no-section-labels'] : []), ...(step.config.outletLinkText === 'true' || step.config.outletLinkText === true ? ['outlet-link-text'] : []), ...(compact ? ['compact-links'] : []), ...(caseMax !== null || themeMax !== null ? ['nested-item-word-limits'] : []), ...(maxSentences !== null ? ['nested-item-sentences'] : []), ...(factCheck ? ['fact-checked-claims'] : []), ...(step.config.forbiddenPhrases != null ? ['no-forbidden-phrases'] : [])], ...(factCheck ? { factCheck } : {}), limitation: factCheck ? 'Every item has a claim record: its quotes occur verbatim in the feed-item title or summary of its linked sources and its numbers are among the quoted numbers; removed claims are absent. Whether a quote supports the wording is the fact-check model\'s verdict, and the full articles were not read, so the human review still decides.' : 'These checks verify provenance and format; factual claims still require independent review of the cited material.' } };
}
