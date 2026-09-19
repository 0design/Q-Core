import { hash, insist } from './contracts.mjs';
import { resolveTemplate, resolveTemplateValue } from './template.mjs';

const context = ctx => ({ priorOutputs: ctx.priorOutputs, priorStepNames: ctx.priorStepNames, item: ctx.item, index: ctx.itemIndex });
const value = (step, field, ctx) => resolveTemplateValue(step.config[field], context(ctx));
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
  const links = [...text.matchAll(/https?:\/\/[^\s<>"\]]+/g)].map(m => m[0].replace(/[).,;]+$/, ''));
  insist(links.length > 0 && links.every(link => urls.has(link)), 'Draft includes an unverified URL or no source links');
  insist([...urls].every(url => links.includes(url)), 'Draft must cite each selected source');
  if (step.config.language === 'uk') insist(/[іїєґІЇЄҐ]/.test(text), 'Draft does not contain Ukrainian language markers');
  return { output: { text, artifactHash: hash(text), sourceHash: hash(sources), checks: ['bounded-text', 'source-link-allowlist', 'all-selected-sources-cited'], limitation: 'These checks verify provenance and format; factual claims still require independent review of the cited material.' } };
}
