import { hash, insist } from './contracts.mjs';
import { resolveTemplate, resolveTemplateValue } from './template.mjs';
import { parseFeed } from './steps.mjs';
import { fetchWithRetry } from './http.mjs';

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
  // «у 1,5 раза», «в 2 рази», «до 3,13 раза» / «разу» (live run f8ee3f9f): «раза» is the multiplier form of a fraction, so it is a ratio without «у/в» too.
  [new RegExp(`${B}[ву]\\s+(\\d+(?:[.,]\\d+)?)\\s+раз(?:и|а|у|ів)?${E}|${B}(\\d+[.,]\\d+)\\s+раз[ау]${E}`, 'giu'), m => `ratio:${Number((m[1] ?? m[2]).replace(',', '.'))}`],
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
  // Collective numerals count people or things («восьмеро» = 8; Core40, live run 97688656: «лише восьмеро»).
  [new RegExp(`${B}(двоє|троє|четверо|п['’ʼ]?ятеро|шестеро|семеро|восьмеро|дев['’ʼ]?ятеро|десятеро)${E}`, 'giu'), m => `n:${{ 'двоє': 2, 'троє': 3, 'четверо': 4, 'шестеро': 6, 'семеро': 7, 'восьмеро': 8, 'десятеро': 10 }[m[1].toLowerCase()] ?? (/^п/i.test(m[1]) ? 5 : 9)}`],
];
const SCALES = [[/^\s*(?:трлн|трильйон\p{L}*|trillion)(?![\p{L}\p{N}])/iu, 1e12], [/^\s*(?:млрд|мільярд\p{L}*|billion|bn)(?![\p{L}\p{N}])/iu, 1e9], [/^B(?![\p{L}\p{N}])/u, 1e9], [/^\s*(?:млн|мільйон\p{L}*|million|mln)(?![\p{L}\p{N}])/iu, 1e6], [/^M(?![\p{L}\p{N}])/u, 1e6], [/^\s*(?:тис\.|тисяч\p{L}*|thousand)(?![\p{L}\p{N}])/iu, 1e3], [/^[Kk](?![\p{L}\p{N}])/u, 1e3]];
export function numberTokens(input) {
  let text = String(input).normalize('NFKC');
  const found = [];
  // before: the text just ahead of a number, for the approximation check (hedgedBefore).
  for (const [re, token] of NUMBER_PHRASES) text = text.replace(re, (...args) => { const at = args.find(a => typeof a === 'number'); found.push({ token: token(args), surface: args[0], before: text.slice(Math.max(0, at - 30), at) }); return ' '.repeat(args[0].length); });
  // English number words count as numbers too (a quote may write «three» where a claim writes 3).
  text = text.replace(new RegExp(`${B}(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)${E}`, 'giu'), (w, word, at) => { found.push({ token: `n:${NUMBER_WORDS[word.toLowerCase()]}`, surface: w, quoteOnly: true, before: text.slice(Math.max(0, at - 30), at) }); return ' '.repeat(w.length); });
  const DIGITS = /(?<![\p{L}\p{N}.,])(\d{1,3}(?:[ \u00a0\u202f]\d{3})+(?![\d.,]\d)|\d{1,3}(?:,\d{3})+(?![\d.,]\d)|\d+(?:[.,]\d+)?)(?!\p{N})/gu;
  for (const m of text.matchAll(DIGITS)) {
    const raw = m[1];
    const value = /^\d{1,3}(?:[ \u00a0\u202f]\d{3})+$/.test(raw) || /^\d{1,3}(?:,\d{3})+$/.test(raw) ? Number(raw.replace(/[ \u00a0\u202f,]/g, '')) : Number(raw.replace(',', '.'));
    const rest = text.slice(m.index + m[0].length);
    const scale = SCALES.find(([re]) => re.test(rest));
    const scaled = scale ? value * scale[1] : value;
    found.push({ token: `n:${Number(scaled.toPrecision(12))}`, surface: scale ? `${raw}${rest.match(scale[0])[0]}` : raw, before: text.slice(Math.max(0, m.index - 30), m.index) });
  }
  return found;
}
/* An approximation or a bound right before a number («about 160», «up to 49 percent», «близько 160», «до 49%»). */
const HEDGE = /(?:^|[^\p{L}])(?:about|around|roughly|approximately|nearly|almost|some|circa|an estimated|more than|over|up to|at least|at most|less than|fewer than|under|близько|приблизно|майже|орієнтовно|понад|більше ніж|більш ніж|до|щонайменше|менше ніж|не менше|не більше|лише близько|більше|менше|від|десь|як мінімум|мінімум|максимум|в середньому|у середньому|під)(?:\s+(?:на|в|у|by|to|in))?\s*(?:[~≈$€£]\s*)?$/iu;
export const hedgedBefore = before => HEDGE.test(String(before ?? '').replace(/\s+/g, ' ')) || /[~≈]\s*$/.test(String(before ?? ''));
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
   - its sources are selected sources the item links, and each of its quotes (≥ 3 words) occurs verbatim (or as ellipsis-marked verbatim pieces in order, quoteInOrder) — case,
     spaces, quote marks and dashes normalised — in the title or text of one of those sources as the Core holds them;
   - every number in the item's own words is among the numbers of its quotes or linked sources' title/text (numberTokens);
   - a removed claim ({verdict: "removed", text}) is not in the final text (same words, ≥ 80% of them in one item).
   The model's judgment that a quote supports the wording is not proven here; the quote and numbers are. */
/* Substring search on word boundaries: «up to 4» is not found inside «up to 49» (review of Q-Core #31). */
function wordIndexOf(ground, piece, from = 0) {
  for (let at = ground.indexOf(piece, from); at >= 0; at = ground.indexOf(piece, at + 1)) {
    const before = at === 0 ? '' : ground[at - 1], after = ground[at + piece.length] ?? '';
    // A decimal is one token: «49» is not in «49.5», «5» is not in «49.5», «3» is not in «3,13».
    const cutsNumberBefore = /[.,]/.test(before) && /\d/.test(ground[at - 2] ?? '') && /^\d/.test(piece);
    const cutsNumberAfter = /[.,]/.test(after) && /\d/.test(ground[at + piece.length + 1] ?? '') && /\d$/.test(piece);
    if (!/[\p{L}\p{N}]/u.test(before) && !/[\p{L}\p{N}]/u.test(after) && !cutsNumberBefore && !cutsNumberAfter) return at;
  }
  return -1;
}
const NEGATION = /(?<![\p{L}\p{N}])(?:not|no|never|without|none|nor|n't|не|ні|без|ніколи|жодн\p{L}*)(?![\p{L}\p{N}])/iu;
/* A quote is grounded when it occurs verbatim, or (Core39, live run 58c169c9) when it marks every omission with
   an ellipsis («…» or «...») and each piece between them (2–4 pieces of 2+ words) occurs verbatim in the source, in
   the same order, within one passage (span ≤ twice the quote + 120 characters). A word left out silently (a dropped scope such as «tool-based») is never accepted. */
function quoteInOrder(quote, ground) {
  const pieces = quote.split(/…|\.\.\./).map(piece => piece.replace(/^[\s.,;:!?"'()\-]+|[\s.,;:!?"'()\-]+$/g, '')).filter(Boolean);
  if (pieces.length < 2 || pieces.length > 4 || pieces.some(piece => (piece.match(/[\p{L}\p{N}]+/gu) ?? []).length < 2)) return false;
  // The pieces must come from one passage: their span in the source is at most twice the quote plus 120 characters.
  const quoted = pieces.join(' ').length;
  for (let start = wordIndexOf(ground, pieces[0]); start >= 0; start = wordIndexOf(ground, pieces[0], start + 1)) {
    let at = start + pieces[0].length, ok = true;
    for (const piece of pieces.slice(1)) {
      const found = wordIndexOf(ground, piece, at);
      // A left-out part may not carry a negation: «does … reduce» must not stand for «does not reduce».
      if (found < 0 || NEGATION.test(ground.slice(at, found))) { ok = false; break; }
      at = found + piece.length;
    }
    if (ok && at - start <= quoted * 2 + 120) return true;
  }
  return false;
}
function checkFactCheck(record, text, nestedItems, sources, citedUrls, citedOf = index => citedUrls(nestedItems[index].text)) {
  insist(record && typeof record === 'object' && Array.isArray(record.claims), 'factCheck must reference a fact-check output {claims:[...], text}');
  const listOf = t => { const i = t.search(/^[-*+] /m); return (i < 0 ? t : t.slice(i)).trim(); };
  insist(typeof record.text === 'string' && listOf(record.text) === listOf(text), 'The checked draft must be the fact-checked text (factCheck.text); the draft before the fact check is not delivered');
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
    // Grounds: the feed-item title and summary and, when parse-web articles read it, the article text (Core40).
    const groundsOf = url => { const s = byUrl.get(url); return [s.title, s.text, s.articleStatus === 'ok' ? s.articleText : null].filter(t => typeof t === 'string'); };
    const grounds = urls.flatMap(groundsOf).map(normQuote);
    // A claim stands on its verbatim quotes: at least one of 3+ words (a short one may name a product, live run
    // f8ee3f9f). Core40 (live run 3f16062b): an extra quote that is not verbatim is set aside and listed as unmatched
    // for the person who approves, instead of failing a claim another verbatim quote supports; its numbers do not count.
    for (const quote of quotes) insist(trimQuote(quote).length <= 600, `List item ${item}: a quote must be at most 600 characters: «${quote.slice(0, 60)}»`);
    const grounded = quote => { const q = trimQuote(quote); return (q.match(/[\p{L}\p{N}]+/gu) ?? []).length >= 1 && grounds.some(g => wordIndexOf(g, q) >= 0 || quoteInOrder(q, g)); };
    const matchedQuotes = quotes.filter(grounded), unmatchedQuotes = quotes.filter(quote => !grounded(quote));
    insist(matchedQuotes.length > 0, `List item ${item}: the quote is not in the text of its linked sources: «${(unmatchedQuotes[0] ?? "").slice(0, 80)}»`);
    insist(matchedQuotes.some(quote => (trimQuote(quote).match(/[\p{L}\p{N}]+/gu) ?? []).length >= 3), matchedQuotes.length < quotes.length ? `List item ${item}: the quote is not in the text of its linked sources: «${(unmatchedQuotes[0] ?? "").slice(0, 80)}»` : `List item ${item}: at least one quote must be 3 or more words: «${quotes[0].slice(0, 60)}»`);
    // Numbers are checked against the item's quotes and the full title + text of its linked sources (live run
    // 461a3df0, 27.09: «майже на половину» is in the source title «…nearly in half…», not in the chosen quote).
    const sourceTexts = urls.flatMap(groundsOf);
    // «in half» / «удвічі» (ratio 2) and «половина» (share 1/2) state the same halving; thirds stay apart (65ef7d49).
    const canon = token => token === 'share:1/2' ? 'ratio:2' : token;
    const quoteTokens = new Set([...matchedQuotes, ...sourceTexts].flatMap(q => numberTokens(unifyQuotes(q)).map(t => canon(t.token))));
    const missing = numberTokens(unifyQuotes(plainClaim(itemText))).filter(t => !t.quoteOnly && !quoteTokens.has(canon(t.token)));
    insist(missing.length === 0, `List item ${item} states «${missing[0]?.surface}» (${missing[0]?.token}), which is not in its quote or linked sources; numbers must be exactly as in the source: ${itemText.slice(0, 60)}`);
    // An approximation or bound stays (Core40, live run 97688656: «160 ІТ-керівників» for «about 160 IT vice presidents»,
    // while the feed summary said «160»): a number the item states bare is refused when every place that states it has
    // «about», «nearly», «up to»… right before it. The article decides when it states the number; else the quotes;
    // else the title and summary.
    const occurrences = (texts, t) => texts.flatMap(q => numberTokens(unifyQuotes(q))).filter(o => canon(o.token) === canon(t.token));
    const articles = urls.map(url => byUrl.get(url)).filter(s => s.articleStatus === 'ok' && typeof s.articleText === 'string').map(s => s.articleText);
    for (const t of numberTokens(unifyQuotes(plainClaim(itemText))).filter(t => !t.quoteOnly && !hedgedBefore(t.before))) {
      const inArticles = occurrences(articles, t), inQuotes = occurrences(matchedQuotes, t);
      const where = inArticles.length ? inArticles : inQuotes.length ? inQuotes : occurrences(sourceTexts, t);
      const hedged = where.length > 0 && where.every(o => hedgedBefore(o.before));
      insist(!hedged, `List item ${item} states «${t.surface}» exactly; its source says «${(HEDGE.exec(String(where[0]?.before ?? '').replace(/\s+/g, ' '))?.[0] ?? '').replace(/^[^\p{L}~≈]+/u, '').trim()} ${where[0]?.surface}»: keep the approximation or bound («близько», «майже», «до», «понад»): ${itemText.slice(0, 60)}`);
    }
    out.push({ item, verdict, sources: urls, quote: matchedQuotes, ...(unmatchedQuotes.length ? { unmatchedQuotes } : {}), numbers: [...new Set(numberTokens(unifyQuotes(plainClaim(itemText))).filter(t => !t.quoteOnly).map(t => t.token))], ...(claim.reason ? { reason: claim.reason } : {}) });
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
  return { claims: out, supported: count('supported'), revised: count('revised'), removed: count('removed'), grounding: sources.some(s => s.articleStatus === 'ok') ? 'feed-item title and summary plus the static article text of each linked source that parse-web articles could read (up to its maxChars); unreadable articles fall back to the summary' : 'feed-item title and summary of each linked source, as the Core holds them; the full articles are not read' };
}
export function runParseWeb(step, ctx) {
  if (step.config.items != null) return runParseFeedItems(step, ctx);
  if (step.config.articles != null) return runParseArticles(step, ctx);
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

/* articles: "true" (Core40) — the article behind each selected source, fetched once and read as static text, so a
   fact check can ground on the article and not only on the feed summary. Bounded: at most 20 distinct URLs, one
   GET each (20 s, 1 retry on a network error, 429 or 5xx), at most 3 redirects, 1.5 MB per page, http(s) only and
   never a local or private-network address (checked on every redirect hop; a host name that resolves to a private
   address is not detected: no DNS lookup). One unreachable page is recorded (articleStatus: "unavailable"), not
   fatal; when none is reachable the step fails. The text comes from the page's <article>, else <main>, else <body>,
   without scripts, navigation, headers, footers, asides, forms and figures, up to maxChars. No JavaScript runs. */
const LOCAL_V4 = /^(?:0\.0\.0\.0|127(?:\.\d+){3}|10(?:\.\d+){3}|192\.168(?:\.\d+){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d+){2}|169\.254(?:\.\d+){2}|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])(?:\.\d+){2})$/;
export function isLocalHost(raw) {
  const host = String(raw).toLowerCase().replace(/\.$/, '').replace(/^\[|\]$/g, '');
  return host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal') || LOCAL_V4.test(host)
    || /^\d+$/.test(host) || /^0x/i.test(host)
    || /^0(?:\.\d+){3}$/.test(host) // 0.0.0.0/8
    // IPv6: everything that starts with «::» (unspecified, ::1, IPv4-compatible «::a.b.c.d» = «::7f00:1», IPv4-mapped),
    // NAT64 64:ff9b::/96, link-local fe80::/10, site-local fec0::/10 and unique-local fc00::/7.
    || /^(?:::.*|64:ff9b:.*|fe[89a-f][0-9a-f]:.*|f[cd][0-9a-f]{2}:.*)$/.test(host);
}
const publicHttpUrl = raw => {
  let url;
  try { url = new URL(raw); } catch { return null; }
  return /^https?:$/.test(url.protocol) && !url.username && !url.password && url.hostname && !isLocalHost(url.hostname) ? url : null;
};
/* Linear-time article extraction (Core40 review): no backtracking regex over the page, so unclosed tags cost one
   pass, not a pass per tag. blocksOf finds <tag …>…</tag> by indexOf and continues after each block. */
function blocksOf(lower, tag) {
  const out = [], open = `<${tag}`, close = `</${tag}`;
  let at = 0;
  for (;;) {
    const start = lower.indexOf(open, at);
    if (start < 0) break;
    const after = lower[start + open.length];
    if (after !== undefined && !/[\s>/]/.test(after)) { at = start + open.length; continue; }
    const bodyStart = lower.indexOf('>', start);
    if (bodyStart < 0) break;
    const end = lower.indexOf(close, bodyStart);
    if (end < 0) break;
    const closeEnd = lower.indexOf('>', end);
    out.push([start, bodyStart + 1, end, closeEnd < 0 ? lower.length : closeEnd + 1]);
    at = end + close.length;
  }
  return out;
}
const DROPPED = ['script', 'style', 'nav', 'header', 'footer', 'aside', 'form', 'figure', 'noscript', 'svg', 'template', 'iframe', 'button', 'select', 'textarea'];
const ENTITY = { nbsp: ' ', amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', hellip: '…', mdash: '—', ndash: '–', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', laquo: '«', raquo: '»' };
function pageText(html) {
  let text = html;
  for (const tag of DROPPED) {
    const blocks = blocksOf(text.toLowerCase(), tag);
    if (!blocks.length) continue;
    let out = '', at = 0;
    for (const [start, , , stop] of blocks) { out += `${text.slice(at, start)} `; at = stop; }
    text = out + text.slice(at);
  }
  // Comments by indexOf; tags by [^<>] so a «<» without its «>» cannot swallow the page; a stray «<» becomes a space.
  let plain = '', at = 0;
  for (;;) {
    const start = text.indexOf('<!--', at);
    if (start < 0) { plain += text.slice(at); break; }
    const end = text.indexOf('-->', start + 4);
    plain += `${text.slice(at, start)} `;
    if (end < 0) break;
    at = end + 3;
  }
  return plain.replace(/<[^<>]*>/g, ' ').replace(/</g, ' ')
    .replace(/&#(\d{1,7});/g, (m, n) => { const c = Number(n); return c > 0 && c <= 0x10ffff ? String.fromCodePoint(c) : ' '; })
    .replace(/&#x([0-9a-f]{1,6});/gi, (m, n) => { const c = parseInt(n, 16); return c > 0 && c <= 0x10ffff ? String.fromCodePoint(c) : ' '; })
    .replace(/&([a-z]+);/gi, (m, n) => ENTITY[n.toLowerCase()] ?? m).replace(/\s+/g, ' ').trim();
}
/** Readable text of an article page: the longest <article>, else <main>, else the whole page (extraction "body"). */
export function extractArticle(html) {
  const page = String(html), lower = page.toLowerCase();
  for (const tag of ['article', 'main']) {
    const blocks = blocksOf(lower, tag);
    if (blocks.length) return { text: blocks.map(([, a, b]) => pageText(page.slice(a, b))).sort((x, y) => y.length - x.length)[0], extraction: tag };
  }
  return { text: pageText(page), extraction: 'body' };
}
export const articleTextOf = html => extractArticle(html).text;
const ARTICLE_BYTES = 1_500_000;
const ARTICLE_URL_BUDGET_MS = 30_000;
async function fetchArticle(raw, ctx) {
  // One budget per URL for every attempt, redirect hop and the body: 30 s in all (each attempt is also held to 20 s).
  const budget = AbortSignal.timeout(ARTICLE_URL_BUDGET_MS);
  const signal = ctx.signal ? AbortSignal.any([ctx.signal, budget]) : budget;
  let url = publicHttpUrl(raw);
  if (!url) return { articleStatus: 'unavailable', articleError: 'not a public http(s) URL' };
  for (let hop = 0; hop <= 3; hop++) {
    let res;
    try {
      res = await fetchWithRetry(url.href, { headers: { 'User-Agent': 'q-core-workflow-engine/1', Accept: 'text/html,application/xhtml+xml,text/plain;q=0.8' }, redirect: 'manual', signal }, { timeoutMs: 20_000, retries: 1, delaysMs: [1000] });
    } catch (error) {
      ctx.signal?.throwIfAborted();
      return { articleStatus: 'unavailable', articleError: error?.name === 'TimeoutError' || budget.aborted ? 'timed out (20 s per attempt, 30 s per URL)' : String(error?.message ?? error).slice(0, 120) };
    }
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      await res.body?.cancel().catch(() => {});
      let next = null;
      try { next = new URL(res.headers.get('location'), url).href; } catch { return { articleStatus: 'unavailable', articleError: 'invalid redirect location' }; }
      url = publicHttpUrl(next);
      if (!url) return { articleStatus: 'unavailable', articleError: 'redirect to a URL that is not public http(s)' };
      continue;
    }
    if (!res.ok) { await res.body?.cancel().catch(() => {}); return { articleStatus: 'unavailable', articleError: `HTTP ${res.status}` }; }
    const type = res.headers.get('content-type') ?? '';
    // An HTML or plain-text page only: no content type, SVG, PDF, JSON or feeds are not article text.
    if (!/^\s*(?:text\/html|application\/xhtml\+xml|text\/plain)\s*(?:;|$)/i.test(type)) { await res.body?.cancel().catch(() => {}); return { articleStatus: 'unavailable', articleError: `not an HTML or text page (${type.slice(0, 60) || 'no content type'})` }; }
    const reader = res.body?.getReader(), chunks = [];
    let bytes = 0, truncated = false;
    // A timeout or a dropped connection in the middle of the body makes this page unavailable, not the step failed.
    try {
      if (reader) for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        const room = ARTICLE_BYTES - bytes;
        chunks.push(Buffer.from(value.subarray(0, room)));
        bytes += Math.min(value.length, room);
        if (value.length >= room) { truncated = true; await reader.cancel().catch(() => {}); break; }
      }
    } catch (error) {
      await reader?.cancel().catch(() => {});
      ctx.signal?.throwIfAborted();
      return { articleStatus: 'unavailable', articleError: error?.name === 'TimeoutError' || error?.name === 'AbortError' ? 'timed out while reading the page' : `reading the page failed: ${String(error?.message ?? error).slice(0, 100)}` };
    }
    const raw = Buffer.concat(chunks);
    // Charset from the Content-Type or a <meta> in the first 4 KB (default utf-8); one Node cannot decode: unavailable.
    const label = (type.match(/charset\s*=\s*["']?([\w.:-]+)/i)?.[1] ?? raw.subarray(0, 4096).toString('latin1').match(/<meta[^>]{0,200}?charset\s*=\s*["']?([\w.:-]+)/i)?.[1] ?? 'utf-8').toLowerCase();
    let body;
    try { body = new TextDecoder(label).decode(raw); } catch { return { articleStatus: 'unavailable', articleError: `unsupported charset ${label.slice(0, 40)}` }; }
    return { articleStatus: 'ok', articleUrl: url.href, body, bodyTruncated: truncated, articleSha256: hash(raw), charset: label };

  }
  return { articleStatus: 'unavailable', articleError: 'more than 3 redirects' };
}
async function runParseArticles(step, ctx) {
  insist(step.config.articles === 'true' || step.config.articles === true, 'parse-web articles must be "true"');
  const input = value(step, 'source', ctx);
  const sources = Array.isArray(input) ? input : input?.sources;
  insist(Array.isArray(sources) && sources.length > 0 && sources.every(s => typeof s?.url === 'string'), 'parse-web articles requires source: selected sources {sources:[{url,...}]}');
  const maxChars = Number(step.config.maxChars ?? 4000);
  insist(Number.isInteger(maxChars) && maxChars >= 500 && maxChars <= 10000, 'parse-web maxChars must be 500..10000');
  const urls = [...new Set(sources.map(s => s.url))];
  insist(urls.length <= 20, `parse-web articles reads at most 20 distinct URLs; got ${urls.length}`);
  // maxTotalChars: one budget for all article texts, shared equally by the readable ones (a model reads them all).
  const maxTotal = step.config.maxTotalChars == null ? null : Number(step.config.maxTotalChars);
  insist(maxTotal === null || Number.isInteger(maxTotal) && maxTotal >= 1000 && maxTotal <= 200000, 'parse-web maxTotalChars must be 1000..200000');
  const fetched = new Map(await Promise.all(urls.map(async url => [url, await fetchArticle(url, ctx)])));
  const readable = [...fetched.values()].filter(page => page.articleStatus === 'ok').length || 1;
  const perArticle = maxTotal === null ? maxChars : Math.max(200, Math.min(maxChars, Math.floor(maxTotal / readable)));
  const read = url => {
    const page = fetched.get(url);
    if (page.articleStatus !== 'ok') return { articleStatus: 'unavailable', articleError: page.articleError, articleText: null, articleTruncated: false };
    const { text, extraction } = extractArticle(page.body);
    if (!text.trim()) return { articleStatus: 'unavailable', articleError: 'no readable static text', articleText: null, articleTruncated: false };
    return { articleStatus: 'ok', articleText: text.slice(0, perArticle), articleTruncated: text.length > perArticle || page.bodyTruncated, articleExtraction: extraction, articleSha256: page.articleSha256 };
  };
  const texts = new Map(urls.map(url => [url, read(url)]));
  insist([...texts.values()].some(t => t.articleStatus === 'ok'), `parse-web articles: none of the ${urls.length} article pages could be read (${[...texts.values()][0]?.articleError})`);
  const withArticle = s => ({ ...s, ...texts.get(s.url) });
  const out = { ...input, sources: sources.map(withArticle) };
  // Clusters keep their shape (rank, topic, independentOutlets), so nestedOrder and the prompt input still work.
  if (Array.isArray(input?.clusters)) out.clusters = input.clusters.map(c => ({ ...c, sources: Array.isArray(c.sources) ? c.sources.map(withArticle) : c.sources }));
  const unavailable = [...texts.entries()].filter(([, t]) => t.articleStatus !== 'ok').map(([url, t]) => ({ url, error: t.articleError }));
  out.articles = { read: urls.length - unavailable.length, unavailable, charsPerArticle: perArticle, extraction: 'static HTML text of <article>, else <main>, else <body>; no JavaScript; factual accuracy not verified' };
  return { output: out };
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
/* review (Core41, owner decision 27.09): a second model call looks only for overstatement, scope, attribution,
   generalisation, entity and wording problems and returns a small patch {edits:[{item, before, action, text, quote,
   sources, problem, reason}]} for the fact-checked text. verify-sources applies it deterministically, EDIT BY EDIT
   (review round 1 of PR #34): each edit is tried on top of the edits accepted so far and the full checks run; an edit
   that fails any check (or is malformed) is rejected with its reason and the item keeps its fact-checked line, which
   already passed. A theme removal and the removals of all its cases are tried as one unit; rejected edits are retried
   once more after the others (a case removal may need a theme revision listed later). Only a review output without an
   edits array fails the run.
   - item: the 1-based position among the list items of the fact-checked text; before: the start of that item's line
     (at least 30 characters, or the whole line if shorter), so an edit cannot land on the wrong item.
   - keep: no change and no other fields. revise: the line becomes text (same indentation); the item's claim record
     takes the edit's quotes (and sources, if given), verdict revised, reason «review <problem>: …». remove: the item
     goes and its claim record becomes a removed claim with exactly the removed line, so it may not remain. An item
     with sub-items goes only with all of them; a review never removes every item.
   - After the edits a theme's claim record keeps only the sources its remaining cases link; when its quotes no longer
     occur in those sources, the edit is rejected: revise the theme in the same review. */
const REVIEW_ACTIONS = ['keep', 'revise', 'remove'];
const REVIEW_PROBLEMS = ['overstatement', 'scope', 'attribution', 'generalisation', 'entity', 'language'];
const REVIEW_FIELDS = { keep: ['item', 'action', 'before', 'reason'], revise: ['item', 'action', 'before', 'text', 'quote', 'sources', 'problem', 'reason'], remove: ['item', 'action', 'before', 'problem', 'reason'] };
const collapse = s => String(s).replace(/\s+/g, ' ').trim();
function checkEdit(edit, itemLines) {
  insist(edit && typeof edit === 'object' && !Array.isArray(edit), 'the edit is not an object');
  const n = itemLines.length, item = Number(edit.item);
  insist(Number.isInteger(item) && item >= 1 && item <= n, `it names list item ${edit.item}, which is not an item of the fact-checked text (1..${n}); a review adds no items`);
  insist(REVIEW_ACTIONS.includes(edit.action), `its action is «${edit.action}»; an edit is keep, revise or remove`);
  const extra = Object.keys(edit).filter(key => !REVIEW_FIELDS[edit.action].includes(key));
  insist(extra.length === 0, `a ${edit.action} edit carries no ${extra.join(', ')}`);
  const line = collapse(itemLines[item - 1].m[2]), before = typeof edit.before === 'string' ? collapse(edit.before) : '';
  insist(before.length >= Math.min(30, line.length) && line.startsWith(before), `its before («${before.slice(0, 40)}») is not the start of list item ${item} («${line.slice(0, 40)}»); an edit names its item by number and by the start of its line`);
  if (edit.action !== 'keep') {
    insist(REVIEW_PROBLEMS.includes(edit.problem), `it names the problem «${edit.problem}»; one of ${REVIEW_PROBLEMS.join(', ')}`);
    insist(typeof edit.reason === 'string' && edit.reason.trim(), `a ${edit.action} edit needs a reason`);
  }
  if (edit.action === 'revise') {
    insist(typeof edit.text === 'string' && edit.text.trim() && !/[\r\n]/.test(edit.text), 'a revise edit needs the new text on one line');
    const quotes = Array.isArray(edit.quote) ? edit.quote : edit.quote == null ? [] : [edit.quote];
    insist(quotes.length > 0 && quotes.every(q => typeof q === 'string' && q.trim()), 'a revise edit needs the verbatim quotes that support the new wording');
    insist(edit.sources == null || Array.isArray(edit.sources) && edit.sources.every(s => typeof s === 'string'), 'sources must be a list of URLs');
  }
  return item;
}
/** Applies a set of edits (already one unit or accepted set) to the fact-checked text; throws on any problem. */
function applyReview(edits, text, record, sources) {
  insist(record && Array.isArray(record.claims), 'review requires factCheck (the claim records it edits)');
  const lines = text.split('\n');
  const itemLines = lines.map((line, index) => ({ line, index, m: line.match(/^( *)[-*+] +(\S.*)$/) })).filter(l => l.m);
  const n = itemLines.length, actions = new Map();
  for (const edit of edits) {
    const item = checkEdit(edit, itemLines);
    insist(!actions.has(item), `list item ${item} has more than one review edit`);
    actions.set(item, edit);
  }
  const depth = l => l.m[1].length;
  const lastChild = i => { let j = i; while (j + 1 < n && depth(itemLines[j + 1]) > depth(itemLines[i])) j += 1; return j; };
  for (const [item, edit] of actions) if (edit.action === 'remove') {
    const i = item - 1, end = lastChild(i);
    for (let j = i + 1; j <= end; j++) insist(actions.get(j + 1)?.action === 'remove', `it removes list item ${item}, which has sub-items; remove all of them in the same review (item ${j + 1} is kept) or revise the item`);
  }
  insist([...actions.values()].filter(e => e.action === 'remove').length < n, 'a review may not remove every item of the digest');
  const claims = record.claims.map(c => ({ ...c }));
  const claimOf = item => claims.find(c => c.verdict !== 'removed' && Number(c.item) === item);
  const newNumber = new Map();
  let next = 0;
  itemLines.forEach((l, i) => { if (actions.get(i + 1)?.action !== 'remove') newNumber.set(i + 1, ++next); });
  const out = [];
  for (const [item, edit] of [...actions].sort((a, b) => a[0] - b[0])) {
    const { index, m } = itemLines[item - 1];
    const claim = claimOf(item);
    if (edit.action === 'revise') {
      lines[index] = `${m[1]}- ${edit.text.trim().replace(/^[-*+] +/, '')}`;
      if (claim) Object.assign(claim, { verdict: 'revised', quote: edit.quote, ...(edit.sources ? { sources: edit.sources } : {}), reason: `review ${edit.problem}: ${edit.reason}` });
    } else if (edit.action === 'remove') {
      lines[index] = null;
      if (claim) { for (const key of Object.keys(claim)) delete claim[key]; Object.assign(claim, { verdict: 'removed', text: m[2], reason: `review ${edit.problem}: ${edit.reason}` }); }
    }
    out.push({ item, action: edit.action, ...(edit.problem ? { problem: edit.problem } : {}), ...(edit.reason ? { reason: edit.reason } : {}), ...(edit.action === 'keep' ? {} : { before: m[2] }), ...(edit.action === 'revise' ? { after: lines[index].replace(/^ *- /, '') } : {}) });
  }
  // A theme's record keeps only the sources its remaining cases link; its quotes must still occur in them.
  const byUrl = new Map((sources ?? []).map(s => [s.url, s]));
  itemLines.forEach((l, i) => {
    if (lines[l.index] === null || lastChild(i) === i) return;
    const claim = claimOf(i + 1);
    if (!claim || actions.get(i + 1)?.action === 'revise' && actions.get(i + 1).sources) return;
    // Only URLs that a case changed by this review linked are dropped; a URL no case ever linked stays, so the
    // fact check still refuses it.
    const links = (t, url) => t.includes(`](${url})`) || t.includes(`](${url} `);
    const subs = itemLines.slice(i + 1, lastChild(i) + 1);
    const kept = subs.filter(c => lines[c.index] !== null).map(c => lines[c.index]).join('\n');
    const changed = subs.filter(c => lines[c.index] !== c.line).map(c => c.line).join('\n');
    const linked = (claim.sources ?? []).filter(url => links(kept, url) || !links(changed, url));
    if (linked.length === (claim.sources ?? []).length) return;
    const grounds = linked.flatMap(url => { const s = byUrl.get(url); return s ? [s.title, s.text, s.articleStatus === 'ok' ? s.articleText : null].filter(t => typeof t === 'string').map(normQuote) : []; });
    const quotes = (Array.isArray(claim.quote) ? claim.quote : [claim.quote]).filter(q => typeof q === 'string');
    const grounded = quotes.some(quote => { const q = trimQuote(quote); return grounds.some(g => wordIndexOf(g, q) >= 0 || quoteInOrder(q, g)); });
    insist(linked.length > 0 && grounded, `theme item ${i + 1} stands on sources its remaining cases no longer link; revise the theme in the same review (its quotes must come from the cases that stay)`);
    claim.sources = linked;
  });
  for (const c of claims) if (c.verdict !== 'removed' && c.item != null && newNumber.has(Number(c.item))) c.item = newNumber.get(Number(c.item));
  const edited = lines.filter(l => l !== null).join('\n');
  const count = action => out.filter(e => e.action === action).length;
  return { text: edited, record: { ...record, claims, text: edited }, summary: { edits: out, revised: count('revise'), removed: count('remove'), kept: count('keep') } };
}
/* The edit-by-edit driver: returns the accepted edits and the rejected ones with their reasons. */
function reviewEditsOf(step, ctx, review, verify) {
  insist(review && typeof review === 'object' && Array.isArray(review.edits), 'review must reference a review output {edits:[...]}');
  insist(review.edits.length <= 100, 'review has more than 100 edits');
  verify([]); // the fact-checked text itself must pass; otherwise the run fails as before
  // Units: a removal of an item with sub-items goes together with the removals of all its sub-items.
  const list = review.edits.map((edit, index) => ({ edit, index }));
  const itemOf = e => Number(e?.item);
  const probe = verify.itemLines();
  const depth = i => probe[i - 1]?.m[1].length ?? 0;
  const inUnit = new Set(), units = [];
  for (const entry of list) {
    if (inUnit.has(entry.index)) continue;
    const unit = [entry];
    const i = itemOf(entry.edit);
    if (entry.edit?.action === 'remove' && Number.isInteger(i) && i >= 1 && i <= probe.length) {
      for (let j = i + 1; j <= probe.length && depth(j) > depth(i); j++) {
        const sub = list.find(e => !inUnit.has(e.index) && e !== entry && itemOf(e.edit) === j && e.edit?.action === 'remove');
        if (sub) unit.push(sub);
      }
    }
    unit.forEach(e => inUnit.add(e.index));
    units.push(unit);
  }
  let accepted = [], pending = units, rejected = [];
  for (let pass = 0; pass < 2 && pending.length; pass++) {
    rejected = [];
    for (const unit of pending) {
      try { verify([...accepted, ...unit.map(e => e.edit)]); accepted = [...accepted, ...unit.map(e => e.edit)]; }
      catch (error) { rejected.push({ unit, error: String(error?.message ?? error) }); }
    }
    pending = rejected.map(r => r.unit);
  }
  return { accepted, rejected: rejected.flatMap(({ unit, error }) => unit.map(({ edit }) => ({ item: edit?.item ?? null, action: edit?.action ?? null, ...(edit?.problem ? { problem: edit.problem } : {}), error: error.slice(0, 300) }))) };
}
export function runVerifySources(step, ctx) {
  if (step.config.review == null) return verifyOnce(step, ctx, null);
  const review = value(step, 'review', ctx);
  const verify = edits => verifyOnce(step, ctx, edits);
  verify.itemLines = () => verifyOnce(step, ctx, [], true);
  const { accepted, rejected } = reviewEditsOf(step, ctx, review, verify);
  const result = verify(accepted);
  const out = result.output;
  out.review = { ...out.review, rejected };
  out.factCheckSummary = out.factCheckSummary.replace(/review: (\d+) revised, (\d+) removed/, `review: $1 revised, $2 removed, ${rejected.length} rejected`);
  return result;
}
function verifyOnce(step, ctx, reviewEdits, itemLinesOnly = false) {
  const draft = value(step, 'draft', ctx), input = value(step, 'sources', ctx);
  const sources = Array.isArray(input) ? input : input?.sources;
  let text = typeof draft === 'string' ? draft : draft?.text;
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
  // Core39 (live run f8ee3f9f): with factCheck + nestedList the fixed header is not the model's to copy (the
  // fact-check call once changed its emoji). Everything before the first list line is replaced by requiredPrefix;
  // the list itself is checked as the model wrote it.
  if (requiredPrefix !== null && step.config.factCheck != null && step.config.nestedList != null) {
    const list = text.search(/^[-*+] /m);
    insist(list >= 0, 'The draft has no list after the header');
    // Only a header line may be replaced: anything else before the list (a paragraph, a second line) is refused.
    const before = text.slice(0, list).split(/\r?\n/).filter(line => line.trim());
    // Only a bold header line with the fixed links may stand there (the model's copy of the fixed header); prose is refused.
    const fixed = stringList(step, 'fixedLinks', ctx);
    insist(before.length === 0 || (before.length === 1 && /^\*\*.+\*\*$/.test(before[0].trim()) && fixed.every(url => before[0].includes(url))), 'The draft after the header must be a nested bullet list only (no section labels, headings or paragraphs): text before the list');
    text = requiredPrefix + text.slice(list);
  }
  // review (Core41): the reviewer's patch is applied to the fact-checked text and its claim records first; every
  // check below runs on the edited text.
  let factRecord = step.config.factCheck != null ? value(step, 'factCheck', ctx) : null, review = null;
  if (step.config.review != null) {
    insist(step.config.factCheck != null && step.config.nestedList != null, 'review requires factCheck and nestedList');
    insist(factRecord && typeof factRecord.text === 'string', 'review requires factCheck (the claim records it edits)');
    const listOf = t => { const i = t.search(/^[-*+] /m); return (i < 0 ? t : t.slice(i)).trim(); };
    insist(listOf(factRecord.text) === listOf(text), 'The checked draft must be the fact-checked text (factCheck.text); the draft before the fact check is not delivered');
    if (itemLinesOnly) return text.split('\n').map(line => ({ m: line.match(/^( *)[-*+] +(\S.*)$/) })).filter(l => l.m);
    const applied = applyReview(reviewEdits ?? [], text, factRecord, sources);
    text = applied.text; factRecord = applied.record; review = applied.summary;
  }
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
    factCheck = checkFactCheck(factRecord, text, nestedItems, sources, citedUrls, citedOf);
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
  // factCheckSummary sits right after the text, so the approval preview (its first 40 lines) shows the verdict counts,
  // the unread articles and every quote that was set aside as not found in its source.
  const unmatched = factCheck ? factCheck.claims.filter(c => c.unmatchedQuotes?.length) : [];
  const unread = sources.filter(s => s.articleStatus === 'unavailable').length;
  const factCheckSummary = factCheck ? `${factCheck.claims.length} claims: ${factCheck.supported} supported, ${factCheck.revised} revised, ${factCheck.removed} removed; ${review ? `review: ${review.revised} revised, ${review.removed} removed; ` : ''}${sources.some(s => s.articleStatus) ? `articles read for ${sources.filter(s => s.articleStatus === 'ok').length} of ${sources.length} sources${unread ? ` (${unread} unavailable: summary only)` : ''}` : 'articles not read (feed summaries only)'}; ${unmatched.length ? `quotes not found in the source, set aside: ${unmatched.map(c => `item ${c.item} «${c.unmatchedQuotes[0].slice(0, 60)}»`).join('; ')}` : 'every quote found in its source'}` : null;
  return { output: { text, ...(factCheckSummary ? { factCheckSummary } : {}), artifactHash: hash(text), sourceHash: hash(sources), ...(fixedLinks.length === 0 ? {} : { fixedLinks }), checks: ['bounded-text', 'source-link-allowlist', timestampCitations ? 'selected-sources-cited-by-timestamp' : linkCitations ? 'every-thesis-cites-a-selected-source' : 'all-selected-sources-cited', ...(requiredPrefix === null ? [] : ['required-literal-prefix']), ...(requiredHeadings.length === 0 ? [] : ['required-markdown-sections']), ...(introLinks.length === 0 ? [] : ['intro-links-inline']), ...(forbidLocal ? ['no-local-links'] : []), ...(timestampCitations ? ['timestamp-citations'] : []), ...(sectionItems ? ['section-item-counts'] : []), ...(sectionSentences ? ['section-sentence-counts'] : []), ...(itemMaxWords ? ['item-word-limits'] : []), ...(oneClusterPerItem ? ['one-cluster-per-item'] : []), ...(nestedItems ? ['nested-list-depth'] : []), ...(step.config.nestedOrder != null ? ['nested-order-by-cluster'] : []), ...(step.config.forbiddenLabels != null ? ['no-section-labels'] : []), ...(step.config.outletLinkText === 'true' || step.config.outletLinkText === true ? ['outlet-link-text'] : []), ...(compact ? ['compact-links'] : []), ...(caseMax !== null || themeMax !== null ? ['nested-item-word-limits'] : []), ...(maxSentences !== null ? ['nested-item-sentences'] : []), ...(factCheck ? ['fact-checked-claims'] : []), ...(review ? ['reviewed-for-overstatement'] : []), ...(step.config.forbiddenPhrases != null ? ['no-forbidden-phrases'] : [])], ...(factCheck ? { factCheck } : {}), ...(review ? { review } : {}), limitation: factCheck ? (sources.some(s => s.articleStatus === 'ok') ? '' : 'The full articles were not read: quotes and numbers are grounded on the feed-item title and summary only. ') + 'Every item has a claim record: at least one of its quotes occurs verbatim in the ' + (sources.some(s => s.articleStatus === 'ok') ? 'article (where parse-web articles read it), ' : '') + 'title or summary of its linked sources (other quotes that do not are listed as unmatched), and its numbers occur in its quotes or linked sources with their approximations kept; removed claims are absent. Whether a quote supports the wording is the fact-check model\'s verdict, so the human review still decides.' : 'These checks verify provenance and format; factual claims still require independent review of the cited material.' } };
}
