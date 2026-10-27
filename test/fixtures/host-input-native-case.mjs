// Fresh local authority fixtures only. No existing key, run or live service.
import assert from 'node:assert/strict';
import { mkdtempSync,writeFileSync,readFileSync,readdirSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { generateKeyPairSync,randomUUID,sign } from 'node:crypto';
import { canonical,hash } from '../../src/contracts.mjs';
import { createLocalHost } from '../../src/host.mjs';
import { RunStore } from '../../src/state.mjs';
import { enrollRemoteHumanProvider,requestRemoteHumanDecision,consumeRemoteHumanDecision,
  resumeRemoteHumanWorkflow,inspectRemoteHumanExecution } from '../../src/remote-human-host.mjs';

const root=mkdtempSync(join(tmpdir(),'qf-native-input-fixture-')),file=join(root,'workflow.yaml');
const store=new RunStore(file);let effects=0,activeId,activeHash;const errors=[];
const server=createServer((req,res)=>{
  try {
    assert.equal(req.method,'POST');assert.equal(req.url,'/effect/'+activeId);
    const proof=inspectRemoteHumanExecution(file,activeId);assert.equal(proof.approvalHash,activeHash);
    assert.equal(proof.step.stepId,'publish');assert.equal(proof.step.final,true);
    effects++;res.end('{"received":true}');
  } catch(e){errors.push(e);res.statusCode=500;res.end('{}');}
});
try {
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  writeFileSync(file,`manifest: q-core.workflow/v1\nid: prepared-native-input\nversion: 1.0.0\nenabled: true\ninputs:\n  subject:\n    type: object\ntriggers:\n  - kind: manual\nsteps:\n  - id: review\n    kind: approval-gate\n    config:\n      reviewer: human\n      bind: sha256\n      source: "{{inputs.subject}}"\n  - id: publish\n    kind: api-request\n    config:\n      url: "http://127.0.0.1:${server.address().port}/effect/{{run.id}}"\n      body: '{}'\n      receiptKey: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n`);
  const manifestHash=hash(readFileSync(file)),pair=generateKeyPairSync('ed25519');
  const policy={publicKey:pair.publicKey.export({type:'spki',format:'pem'}),endpoint:'https://approval.example.test/',
    reviewerId:'12345678',chatId:'-100123456789',manifestHash};
  enrollRemoteHumanProvider(file,policy,{env:{},stdinIsTTY:true,stdoutIsTTY:true,code:'ABC234',
    openTerminal:()=>({write(){},readLine:()=> 'ABC234',close(){}})});
  const host=createLocalHost({manifest:file,manifestSha256:manifestHash});
  for (let n=0;n<2;n++) {
    const subject={text:'Prepared '+n+' {{env.NEVER_EXPAND}} '+ 'Ї'.repeat(35000),evidence:{hash:'a'.repeat(64)},number:n};
    const event='signal-'+n,inputs={subject};activeHash=hash(subject);
    const dispatch=await host.dispatch('manual',event,inputs);activeId=dispatch.runId;
    assert.equal(dispatch.status,'waiting_human');assert.equal(dispatch.inputsHash,hash(inputs));
    const waiting=store.load(activeId);assert.equal(waiting.pendingInference,undefined);
    assert.equal(waiting.steps.length,2);assert.deepEqual(waiting.steps[0].output.subject,subject);
    assert.equal(waiting.steps[0].output.approvalHash,activeHash);assert.equal(effects,n);
    const bytes=readFileSync(store.runFile(activeId));
    assert.equal((await createLocalHost({manifest:file,manifestSha256:manifestHash}).dispatch('manual',event,inputs)).duplicate,true);
    await assert.rejects(host.dispatch('manual',event,{subject:{...subject,text:'Changed'}}),/inputs changed/);
    await assert.rejects(host.dispatch('manual','other-event',inputs),/still active or waiting/);
    for (const bad of [{}, {subject:[]}, {subject:'not object'}, {subject,extra:1}]) await assert.rejects(host.dispatch('manual','invalid',bad),/input/);
    let getters=0;const getter={};Object.defineProperty(getter,'subject',{enumerable:true,get(){getters++;return subject;}});
    await assert.rejects(host.dispatch('manual','invalid',getter),/getters/);assert.equal(getters,0);
    for(const bad of [{subject:{x:NaN}},{subject:{x:undefined}},{subject:new Date()},{subject:{x:Array(2)}},{subject:{x:'a'.repeat(1048576)}}])
      await assert.rejects(host.dispatch('manual','invalid',bad),/JSON|MiB/);
    assert.deepEqual(readFileSync(store.runFile(activeId)),bytes);
    assert.equal(readdirSync(store.runsDir).length,n+1);
    // Changing the exact bound input after reaching the gate cannot allocate a challenge.
    const corrupted=JSON.parse(bytes);corrupted.invocations.root.inputs.subject.text='changed';
    writeFileSync(store.runFile(activeId),JSON.stringify(corrupted));const corruptBytes=readFileSync(store.runFile(activeId));
    assert.throws(()=>requestRemoteHumanDecision(file,activeId),/exact subject/);
    assert.deepEqual(readFileSync(store.runFile(activeId)),corruptBytes);writeFileSync(store.runFile(activeId),bytes);
    const request=requestRemoteHumanDecision(file,activeId);assert.equal(request.approvalHash,activeHash);
    const {issuedAt,requestHash,...fields}=request;
    const body={...fields,requestHash,protocol:'qf.remote-human-receipt/v1',receiptId:randomUUID(),decision:'approve',decidedAt:Date.now()};
    const receipt=canonical({body,signature:sign(null,Buffer.from(canonical(body)),pair.privateKey).toString('base64')});
    consumeRemoteHumanDecision(file,activeId,receipt);
    const finished=await resumeRemoteHumanWorkflow(file,activeId);
    if(errors.length)throw errors[0];
    assert.equal(finished.status,'success',store.load(activeId).summary);
    if(errors.length)throw errors[0];assert.equal(effects,n+1);
    assert.equal((await resumeRemoteHumanWorkflow(file,activeId)).executionResumed,false);
    assert.equal((await host.dispatch('manual',event,inputs)).duplicate,true);assert.equal(effects,n+1);
  }
  console.log(JSON.stringify({passed:true,local_effects:effects,model_calls:0,social_posted:false}));
} finally {server.closeAllConnections();await new Promise(r=>server.close(r));rmSync(root,{recursive:true,force:true});}
