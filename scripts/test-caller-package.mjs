import {mkdtempSync, readFileSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';

const root=resolve('.'), dir=mkdtempSync(join(tmpdir(),'qf-installed-caller-'));
const exec=(cmd,args)=>execFileSync(cmd,args,{cwd:dir,encoding:'utf8',timeout:120000});
try {
  writeFileSync(join(dir,'package.json'),JSON.stringify({name:'caller-proof',private:true,type:'module'}));
  const packed=JSON.parse(exec('npm',['pack',root,'--ignore-scripts','--json']))[0];
  const artifact=join(dir,packed.filename);
  const sha256=createHash('sha256').update(readFileSync(artifact)).digest('hex');
  exec('npm',['install','--ignore-scripts','--no-audit','--no-fund',artifact]);
  const tests=readFileSync(join(root,'test/caller-inference.test.mjs'),'utf8').replaceAll("'../src/","'q-core/src/");
  writeFileSync(join(dir,'caller.test.mjs'),tests);
  const output=exec(process.execPath,['--test','caller.test.mjs']);
  for(const path of ['contracts/v1/caller-inference.md','examples/caller-request.json','examples/caller-content-request.json']) readFileSync(join(dir,'node_modules/q-core',path));
  const evidence={version:packed.version,sha256,evidenceKind:'Clean installed package; scripted caller replies, real independent Node verifier and localhost receipt. Not live parent inference.',output};
  writeFileSync(join(root,'docs/delivery/caller-package.json'),JSON.stringify(evidence,null,2)+'\n');
  console.log(JSON.stringify(evidence,null,2));
} finally {rmSync(dir,{recursive:true,force:true});}
