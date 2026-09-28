import {mkdtempSync,writeFileSync,readFileSync,copyFileSync,rmSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {execFileSync} from 'node:child_process';
import assert from 'node:assert/strict';
import {hash} from '../src/contracts.mjs';
const aindfOnly=process.argv.includes('--aindf-only');
const [aindfRoot,dsPath,unslopRoot]=process.argv.slice(2).filter(arg=>arg!=='--aindf-only');
assert.ok(aindfRoot && dsPath && (aindfOnly || unslopRoot),'Pass aindf root, synthetic DS path, and unslop root or --aindf-only');
const root=resolve('.'),sandbox=mkdtempSync(join(tmpdir(),'q-core-quality-install-'));
const run=(exe,args)=>execFileSync(exe,args,{cwd:sandbox,encoding:'utf8',timeout:30000});
try {
  writeFileSync(join(sandbox,'package.json'),JSON.stringify({name:'quality-proof-caller',private:true,type:'module'}));
  const packed=JSON.parse(run('npm',['pack',root,'--ignore-scripts','--json']))[0],archive=join(sandbox,packed.filename);
  run('npm',['install','--ignore-scripts','--no-audit','--no-fund',archive]);
  copyFileSync(join(root,'scripts/quality-caller.mjs'),join(sandbox,'caller.mjs'));
  writeFileSync(join(sandbox,'config.json'),JSON.stringify({aindfRoot:resolve(aindfRoot),dsPath:resolve(dsPath),aindfOnly,unslopRoot:unslopRoot ? resolve(unslopRoot) : null,
    fixtureRoot:join(sandbox,'node_modules/q-core/examples/quality'),browserRoot:join(root,'docs/delivery/browser'),emptyDs:join(sandbox,'empty-ds')}));
  const result=JSON.parse(run(process.execPath,['caller.mjs','config.json']));
  const evidence={date:new Date().toISOString(),package:packed.version,sha256:hash(readFileSync(archive)),...result};
  writeFileSync(join(root,aindfOnly ? 'docs/delivery/aindf-package.json' : 'docs/delivery/quality-package.json'),JSON.stringify(evidence,null,2)+'\n');
  console.log(JSON.stringify({package:packed.version,sha256:evidence.sha256,readiness:[result.aindf.readiness.status,result.aindf.badReadiness.status],
    composition:result.aindf.composition.map(r=>r.native.findings[0].outcome),unslop:result.unslop?.results.map(r=>r.result.status) ?? 'not run'}));
} finally {rmSync(sandbox,{recursive:true,force:true});}
