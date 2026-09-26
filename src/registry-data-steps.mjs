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
  if (fixedLinks.length > 0 || introLinks.length > 0 || requiredPrefix !== null || requiredHeadings.length > 0) {
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
  const shaped = linkCitations || sectionItems || sectionSentences || itemMaxWords || oneClusterPerItem;
  if (shaped) insist(requiredHeadings.length > 0, 'citation: links, sectionItems, sectionSentences, itemMaxWords and oneClusterPerItem require requiredHeadings');
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
  if (linkCitations) {
    const cites = piece => citedUrls(piece).length > 0;
    // A list item is one thesis; in prose every sentence is one (a sentence may lean on the link that closes the next
    // one only if it has none itself — that is refused, so each claim carries its own source).
    const pieces = theses.flatMap(section => section.items.flatMap(item => /^(?:[-*+]|\d+[.)])\s/.test(item) ? [item] : sentencesOf(item)));
    const uncited = pieces.filter(piece => !cites(piece));
    insist(uncited.length === 0, `Every thesis needs a link to a selected source; uncited: ${uncited[0]?.slice(0, 60)}`);
  }
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
  return { output: { text, artifactHash: hash(text), sourceHash: hash(sources), ...(fixedLinks.length === 0 ? {} : { fixedLinks }), checks: ['bounded-text', 'source-link-allowlist', timestampCitations ? 'selected-sources-cited-by-timestamp' : linkCitations ? 'every-thesis-cites-a-selected-source' : 'all-selected-sources-cited', ...(requiredPrefix === null ? [] : ['required-literal-prefix']), ...(requiredHeadings.length === 0 ? [] : ['required-markdown-sections']), ...(introLinks.length === 0 ? [] : ['intro-links-inline']), ...(forbidLocal ? ['no-local-links'] : []), ...(timestampCitations ? ['timestamp-citations'] : []), ...(sectionItems ? ['section-item-counts'] : []), ...(sectionSentences ? ['section-sentence-counts'] : []), ...(itemMaxWords ? ['item-word-limits'] : []), ...(oneClusterPerItem ? ['one-cluster-per-item'] : [])], limitation: 'These checks verify provenance and format; factual claims still require independent review of the cited material.' } };
}
