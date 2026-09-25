import { hash, insist } from './contracts.mjs';
import { resolveTemplate, resolveTemplateValue } from './template.mjs';

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
export function runDeduplicate(step, ctx) {
  const input = value(step, 'source', ctx);
  const sources = Array.isArray(input) ? input : input?.sources;
  insist(Array.isArray(sources) && sources.length > 0 && sources.length <= 100, 'deduplicate requires 1..100 sources');
  const seen = new Set(), unique = [];
  for (const source of sources) {
    insist(typeof source?.url === 'string' && /^https?:\/\//.test(source.url) && typeof source.text === 'string', 'Invalid source');
    const key = hash({ url: source.url, text: source.text });
    if (!seen.has(key)) { seen.add(key); unique.push({ ...source, key }); }
  }
  return { output: { sources: unique, removed: sources.length - unique.length, sourceHash: hash(unique.map(s => ({ url: s.url, key: s.key }))) } };
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
    insist(requiredPrefix !== null && requiredHeadings.length > 0, 'introLinks require requiredPrefix and requiredHeadings');
    const start = requiredPrefix.length, end = text.indexOf(`\n${requiredHeadings[0]}`);
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
  if (step.config.citation != null) insist(timestampCitations, 'citation must be "timestamps" when set');
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
  if (!timestampCitations) insist([...urls].every(url => links.includes(url)), 'Draft must cite each selected source');
  if (step.config.language === 'uk') insist(/[іїєґІЇЄҐ]/.test(text), 'Draft does not contain Ukrainian language markers');
  return { output: { text, artifactHash: hash(text), sourceHash: hash(sources), ...(fixedLinks.length === 0 ? {} : { fixedLinks }), checks: ['bounded-text', 'source-link-allowlist', timestampCitations ? 'selected-sources-cited-by-timestamp' : 'all-selected-sources-cited', ...(requiredPrefix === null ? [] : ['required-literal-prefix']), ...(requiredHeadings.length === 0 ? [] : ['required-markdown-sections']), ...(introLinks.length === 0 ? [] : ['intro-links-inline']), ...(forbidLocal ? ['no-local-links'] : []), ...(timestampCitations ? ['timestamp-citations'] : [])], limitation: 'These checks verify provenance and format; factual claims still require independent review of the cited material.' } };
}
