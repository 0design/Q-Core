import {mkdtempSync,writeFileSync,readFileSync,copyFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {execFileSync} from 'node:child_process';
import {hash} from '../src/contracts.mjs';
const root=resolve('.'),sandbox=mkdtempSync(join(tmpdir(),'q-core-determined-install-'));
const run=(exe,args)=>execFileSync(exe,args,{cwd:sandbox,encoding:'utf8',timeout:30000});
try {
  writeFileSync(join(sandbox,'package.json'),JSON.stringify({name:'determined-caller',private:true,type:'module'}));
  const packed=JSON.parse(run('npm',['pack',root,'--ignore-scripts','--json']))[0];
  const archive=join(sandbox,packed.filename),sha256=hash(readFileSync(archive));
  run('npm',['install','--ignore-scripts','--no-audit','--no-fund',archive]);
  copyFileSync(join(sandbox,'node_modules/q-core/examples/determined-caller.mjs'),join(sandbox,'caller.mjs'));
  const result=JSON.parse(run(process.execPath,['caller.mjs']));
  writeFileSync(join(root,'docs/delivery/determined-package.json'),JSON.stringify({date:new Date().toISOString(),package:packed.version,sha256,...result},null,2)+'\n');
  console.log(JSON.stringify({package:packed.version,sha256,status:result.repaired.status,checks:result.repairChecks.map(x=>x.exitCode)}));
} finally {rmSync(sandbox,{recursive:true,force:true});}
