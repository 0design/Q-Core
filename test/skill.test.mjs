import test from 'node:test';import assert from 'node:assert/strict';
import{mkdtempSync,readFileSync,writeFileSync,rmSync,cpSync}from'node:fs';import{tmpdir}from'node:os';import{join,resolve}from'node:path';
import{runSkill,loadSkill}from'../src/skill.mjs';import{hash}from'../src/contracts.mjs';
function setup(t){const root=mkdtempSync(join(tmpdir(),'qf-skill-'));t.after(()=>rmSync(root,{recursive:true,force:true}));cpSync(resolve('examples/skill-demo'),join(root,'bundle'),{recursive:true});const pin=name=>{const file=join(root,'bundle',name);return {file,sha256:hash(readFileSync(file))};};return{root,pin,request:{skill:pin('contract.json'),workspace:root,allowedPaths:['release.md']}};}
const bad='# Release note\n## Changes\nA change.\n',good=bad+'## Risks\nKnown local execution limits.\n';
test('omitted required skill rule blocks acceptance; bounded independent repair passes',async t=>{
 const{request}=setup(t);const omitted=await runSkill(request,{propose:async({criteria})=>{criteria.pop();return{files:[{path:'release.md',content:bad}]};}});assert.equal(omitted.accepted,false);assert.equal(omitted.history[0].outcomes.at(-1).outcome,'fail');
 const repaired=await runSkill({...request,maxRepairAttempts:1},{propose:async({attempt})=>({files:[{path:'release.md',content:attempt?good:bad}]})});assert.equal(repaired.accepted,true);assert.equal(repaired.history.length,2);assert.equal(repaired.history[0].outcomes.at(-1).outcome,'fail');
});
test('subjective rule needs concrete human decision; changed artifact invalidates approval',async t=>{
 const{request,pin,root}=setup(t);writeFileSync(join(root,'release.md'),good);request.skill=pin('human-contract.json');const pending=await runSkill(request);assert.equal(pending.status,'needs_human');assert.equal(pending.accepted,false);
 assert.equal((await runSkill({...request,approval:{hash:pending.nextAction.hash,decision:'approve'}})).accepted,true);
 assert.equal((await runSkill({...request,approval:{hash:pending.nextAction.hash,decision:'reject'}})).accepted,false);
 writeFileSync(join(root,'release.md'),good+'Changed.');assert.equal((await runSkill({...request,approval:{hash:pending.nextAction.hash,decision:'approve'}})).accepted,false);
});
test('skill pins, omitted verifier, scope escape and claimed evidence fail closed',async t=>{
 const{request,root,pin}=setup(t);assert.throws(()=>loadSkill({...request.skill,sha256:'0'.repeat(64)}),/pin mismatch/);
 assert.equal((await runSkill(request,{propose:async()=>({files:[{path:'../escape',content:'x'}]})})).status,'needs_human');
 assert.equal((await runSkill(request,{propose:async()=>({files:[{path:'release.md',content:good}],accepted:true})})).accepted,false);
 const contract=JSON.parse(readFileSync(request.skill.file));delete contract.criteria[0].verifier;writeFileSync(request.skill.file,JSON.stringify(contract));assert.throws(()=>loadSkill(pin('contract.json')),/machine verifier/);

});
test('changing pinned checker or instructions during execution cannot yield accepted evidence',async t=>{
 const{request,root}=setup(t);
 await assert.rejects(runSkill(request,{propose:async()=>{writeFileSync(join(root,'bundle','verify.mjs'),'process.exit(0)');return{files:[{path:'release.md',content:bad}]};}}),/Pinned skill or verifier changed/);
});
