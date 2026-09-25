import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { subprocess } from '../src/subprocess.mjs';
import { hash } from '../src/contracts.mjs';

const model = process.argv[2];
assert.ok(model && !model.startsWith('--'), 'Pass an explicit Claude model');
const root = resolve('.');
mkdirSync('.qf', {recursive:true});
const sandbox = mkdtempSync(resolve('.qf/claude-package-'));
const exec = (exe,args,input='') => subprocess(exe,args,{cwd:sandbox,input,timeoutMs:180000});
writeFileSync(join(sandbox,'package.json'), JSON.stringify({name:'qf-claude-proof',private:true,type:'module'}));
const pack = await exec('npm',['pack',root,'--ignore-scripts','--json']);
assert.equal(pack.code,0,pack.stderr);
const packed = JSON.parse(pack.stdout)[0], tarball = join(sandbox,packed.filename);
const install = await exec('npm',['install','--ignore-scripts','--no-audit','--no-fund',tarball]);
assert.equal(install.code,0,install.stderr);
const workspace = join(sandbox,'workspace'); mkdirSync(workspace);
const before = 'export const add=()=>0;\n';
writeFileSync(join(workspace,'value.mjs'),before);
writeFileSync(join(workspace,'verify.mjs'),"import assert from 'node:assert/strict';import {add} from './value.mjs';assert.equal(add(2,3),5);assert.equal(add(-2,1),-1);assert.equal(add(0,0),0);console.log('3 independent assertions passed');\n");
const request = {protocolVersion:'qf.agent/v1',requestId:'claude-installed-proof',workflow:{id:'sdd-pipeline',version:'1.0.0'},intent:'Implement arithmetic add(a,b) in value.mjs. Only value.mjs is writable. The independent verifier is already provided.',workspace,allowedPaths:['value.mjs'],allowedTools:[process.execPath],provider:{kind:'claude',model,executable:'/usr/local/bin/claude',payerScope:'local-cli'},deadlineMs:90000,maxRepairAttempts:1,verifier:{command:process.execPath,args:['verify.mjs']}};
const outputs=[];
async function call(r) {
  const p=await exec(process.execPath,[join(sandbox,'node_modules/q-core/bin/q-core.mjs'),'agent','-'],JSON.stringify(r));
  const result=JSON.parse(p.stdout); outputs.push({exit:p.code,result}); return result;
}
let result = await call(request);
let completedResume = false;
if (result.nextAction?.type === 'approve_spec' && process.argv.includes('--approve-synthetic')) {
  const approved={...request,resumeRunId:result.runId,approval:{hash:result.nextAction.hash,decision:'approve'}};
  result=await call(approved);
  if (result.status==='success') {
    const cached=await call(approved); assert.equal(cached.status,'success');
    assert.deepEqual(cached.usage,result.usage); completedResume=true;
  }
}
const sourceUnchanged=readFileSync(join(workspace,'value.mjs'),'utf8')===before;
if (outputs[0].result.error?.code==='AUTH_REQUIRED') assert.equal(sourceUnchanged,true);
const evidence={date:new Date().toISOString(),evidenceKind:'clean installed package + actual Claude adapter invocation; not a Claude parent-session golden path',package:packed.version,artifactSha256:hash(readFileSync(tarball)),workspace,requestedModel:model,sourceUnchanged,completedResume,outputs};
writeFileSync(join(root,'docs/delivery/claude-package-current.json'),JSON.stringify(evidence,null,2)+'\n');
console.log(JSON.stringify({package:packed.version,artifactSha256:evidence.artifactSha256,status:result.status,error:result.error?.code,nextAction:result.nextAction?.type,sourceUnchanged,completedResume}));
process.exitCode=result.status==='success'?0:result.status==='needs_human'?2:1;
