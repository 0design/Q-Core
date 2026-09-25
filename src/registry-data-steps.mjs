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
    lines.forEach((line, index) => insist(!(/^ {0,3}(?:=+|-+)[ \t]*$/.test(line) && index > 0 && lines[index - 1].trim() !== '' && !/^ {0,3}(?:[-*+]|\d+[.)])\s/.test(lines[index - 1])), 'Draft must contain exactly the required Markdown sections in order'));
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
  const bare = text.replace(/\]\((https?:\/\/[^\s()<>]+)\)/g, (_, url) => { linkTargets.push(url); return '] '; });
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
  const allowed = new Set([...urls, ...fixedLinks, ...introLinks]);
  insist(links.length > 0 && links.every(link => allowed.has(link)), 'Draft includes an unverified URL or no source links');
  insist([...urls].every(url => links.includes(url)), 'Draft must cite each selected source');
  if (step.config.language === 'uk') insist(/[іїєґІЇЄҐ]/.test(text), 'Draft does not contain Ukrainian language markers');
  return { output: { text, artifactHash: hash(text), sourceHash: hash(sources), ...(fixedLinks.length === 0 ? {} : { fixedLinks }), checks: ['bounded-text', 'source-link-allowlist', 'all-selected-sources-cited', ...(requiredPrefix === null ? [] : ['required-literal-prefix']), ...(requiredHeadings.length === 0 ? [] : ['required-markdown-sections']), ...(introLinks.length === 0 ? [] : ['intro-links-inline'])], limitation: 'These checks verify provenance and format; factual claims still require independent review of the cited material.' } };
}
