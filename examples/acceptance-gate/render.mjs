import { observe } from './gate.mjs';

const escape = s => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');

export function render(screen, contract, ds) {
  if (observe(screen, contract, ds).findings.length) throw new Error('The typed renderer cannot represent this candidate; review its observations');
  const semantic = role => {
    const key = ds.tokens.semantic[role];
    if (!Object.hasOwn(ds.tokens.foundations, key)) throw new Error('Unresolved semantic token: ' + role);
    return ds.tokens.foundations[key];
  };
  const component = role => semantic(ds.tokens.component[role]);
  const t = { ink: semantic('text'), paper: semantic('surface'), accent: component('button.background'), gap: component('panel.gap'), radius: component('button.radius'), emphasis: semantic(ds.instance.extensions['project-emphasis'].tokens.outline) };
  const nodes = screen.nodes.map(n => {
    const tag = ds.components[n.component].tag;
    if (!['h1', 'p', 'button'].includes(tag)) throw new Error('Unsupported trusted renderer component');
    const cls = n.component.toLowerCase() + (n.variant === 'primary' ? ' primary' : '') + (n.extension ? ' project-emphasis' : '');
    return '<' + tag + (tag === 'button' ? ' type="button"' : '') + ' id="' + escape(n.id)
      + '" class="' + cls + '" data-ds-component="' + n.component + '" data-ds-role="' + n.role
      + '" data-instance="' + escape(screen.instance) + '">' + escape(n.content) + '</' + tag + '>';
  }).join('\n');
  return '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<title>Contract acceptance pilot</title><style>'
    + ':root{--ink:' + t.ink + ';--paper:' + t.paper + ';--action:' + t.accent + ';--gap:' + t.gap + ';--radius:' + t.radius + ';--emphasis:' + t.emphasis + '}'
    + '*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font-family:system-ui,sans-serif;line-height:1.5}'
    + 'main{max-width:42rem;margin:10vh auto;padding:2rem;display:grid;gap:var(--gap)}h1,p{margin:0}'
    + 'h1{font-size:2rem}.button{justify-self:start;border:0;border-radius:var(--radius);padding:.8rem 1.25rem;font:inherit;cursor:pointer}'
    + '.primary{background:var(--action);color:var(--paper)}.project-emphasis{outline:2px solid var(--emphasis);outline-offset:4px}'
    + '.button:focus-visible{outline:3px solid var(--ink);outline-offset:5px}footer{font-size:.8rem;margin-top:1rem}'
    + '</style></head><body><main>' + nodes + '<footer>Synthetic contract example. No account data is saved.</footer></main></body></html>\n';
}
