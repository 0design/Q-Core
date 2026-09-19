/** Authored fault injection, real independent Node verifiers; no model inference. */
import {mkdtempSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {runSkill} from '../src/skill.mjs';
import {hash} from '../src/contracts.mjs';
const workspace=mkdtempSync(join(tmpdir(),'qf-skill-demo-'));
const pin=name=>{const file=fileURLToPath(new URL('./skill-demo/'+name,import.meta.url));return {file,sha256:hash(readFileSync(file))};};
const bad='# Release note\n\n## Changes\nAdded the local workflow host.\n';
const good=bad+'\n## Risks\nThe machine must remain awake; caller inference still needs an active agent.\n';
const request={skill:pin('contract.json'),workspace,allowedPaths:['release.md']};
try{
 const omitted=await runSkill(request,{propose:async()=>({files:[{path:'release.md',content:bad}]})});
 const repaired=await runSkill({...request,maxRepairAttempts:1},{propose:async({attempt})=>({files:[{path:'release.md',content:attempt?good:bad}]})});
 const humanRequest={...request,skill:pin('human-contract.json')};
 const human=await runSkill(humanRequest);
 const approved=await runSkill({...humanRequest,approval:{hash:human.nextAction.hash,decision:'approve'}});
 writeFileSync(join(workspace,'release.md'),good+'\nChanged after review.\n');
 const stale=await runSkill({...humanRequest,approval:{hash:human.nextAction.hash,decision:'approve'}});
 console.log(JSON.stringify({evidenceKind:'authored controlled fault injection; real independent subprocess verifiers; synthetic explicit human decision, not owner review',omitted,repaired,human,approved,stale,output:good},null,2));
}finally{rmSync(workspace,{recursive:true,force:true});}
