// Every state/key/endpoint/terminal below is newly allocated for this fixture.
import assert from 'node:assert/strict';
import {mkdtempSync,realpathSync,writeFileSync,readFileSync,readdirSync,rmSync,existsSync,renameSync,unlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync,spawn} from 'node:child_process';
import {createServer} from 'node:http';
import {generateKeyPairSync,randomUUID,sign} from 'node:crypto';
import {canonical,hash} from '../../src/contracts.mjs';
import {createLocalHost} from '../../src/host.mjs';
import {RunStore} from '../../src/state.mjs';
import {acquireWorkflowLease,workflowRecoveryClaims} from '../../src/workflow-lease.mjs';
import {enrollRemoteHumanProvider,requestRemoteHumanDecision,consumeRemoteHumanDecision,resumeRemoteHumanWorkflow,
 inspectInterruptedRemoteHumanRecovery,finalizeInterruptedRemoteHumanRecovery,inspectRemoteHumanRecoveryFinalization,
 inspectStoppedRemoteHumanRun} from '../../src/remote-human-host.mjs';
const scenario=process.argv[2];assert.ok(['before-stop','after-stop','after-lease','after-publish','after-archive','interrupted-finalizer','live-owner','mutations','confirmation','concurrent','expired','consumed-effect','guard'].includes(scenario));
const root=realpathSync(mkdtempSync(join(tmpdir(),'qf-finalize-fixture-'))),file=join(root,'workflow.yaml');
let probes=0,effects=0,effectChild;
const server=createServer((req,res)=>{effects++;effectChild?.kill('SIGKILL');res.end('{}');});
const io={env:{},stdinIsTTY:true,stdoutIsTTY:true,code:'ABC234',openTerminal:()=>({write(){},readLine:()=> 'ABC234',close(){}})};
const fixture=new URL('./remote-human-finalize-child.mjs',import.meta.url).pathname;
const childEnv={PATH:process.env.PATH};
try{
 if(scenario==='guard'){
  for(const fn of [inspectInterruptedRemoteHumanRecovery,finalizeInterruptedRemoteHumanRecovery,inspectRemoteHumanRecoveryFinalization]){
   assert.throws(()=>fn(join(root,'never-read'),null,null,io),e=>e.code==='HUMAN_CONFIRMATION_REQUIRED');probes++;
  }
  assert.deepEqual(readdirSync(root),[]);probes++;
 }else{
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  writeFileSync(file,`manifest: q-core.workflow/v1\nid: finalize-fixture\nname: Finalize fixture\nversion: 1.0.0\nowner: test\nenabled: true\ninputs:\n  subject:\n    type: object\n    required: true\ntriggers:\n  - kind: manual\nsteps:\n  - id: review\n    kind: approval-gate\n    config:\n      reviewer: human\n      bind: sha256\n      source: "{{inputs.subject}}"\n  - id: publish\n    kind: api-request\n    config:\n      url: "http://127.0.0.1:${server.address().port}/effect"\n      method: POST\n      body: "{}"\n      receiptKey: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n`);
  const pair=generateKeyPairSync('ed25519'),policy={publicKey:pair.publicKey.export({type:'spki',format:'pem'}),endpoint:'https://approval.example.test/',reviewerId:'12345678',chatId:'-100123456789',manifestHash:hash(readFileSync(file))};
  enrollRemoteHumanProvider(file,policy,io);
  const host=createLocalHost({manifest:file,manifestSha256:policy.manifestHash});
  const runId=(await host.dispatch('manual','new-fixture',{subject:{text:'Synthetic exact subject'}})).runId;
  const request=requestRemoteHumanDecision(file,runId,scenario==='expired'?{nowMs:1000,ttlMs:10000}:{});
  const store=new RunStore(file),runFile=store.runFile(runId),nonce=randomUUID();
  writeFileSync(join(root,'disposable-fixture.json'),JSON.stringify({runId,nonce}));
  let deadPid=spawnSync(process.execPath,['-e','process.exit(0)'],{env:childEnv,timeout:5000}).pid;
  if(scenario==='consumed-effect'){
   const {issuedAt,requestHash,...fields}=request;
   const body={...fields,requestHash,protocol:'qf.remote-human-receipt/v1',receiptId:randomUUID(),decision:'approve',decidedAt:Date.now()};
   consumeRemoteHumanDecision(file,runId,canonical({body,signature:sign(null,Buffer.from(canonical(body)),pair.privateKey).toString('base64')}));
   const script=`import {resumeRemoteHumanWorkflow} from ${JSON.stringify(new URL('../../src/remote-human-host.mjs',import.meta.url).href)};await resumeRemoteHumanWorkflow(process.argv[1],process.argv[2]);`;
   effectChild=spawn(process.execPath,['--input-type=module','-e',script,file,runId],{env:childEnv,stdio:'ignore'});
   await new Promise((resolve,reject)=>{const timer=setTimeout(()=>{effectChild.kill('SIGKILL');reject(Error('effect fixture timeout'));},8000);effectChild.once('exit',(code,signal)=>{clearTimeout(timer);assert.equal(signal,'SIGKILL');resolve();});effectChild.once('error',reject);});
   deadPid=effectChild.pid;effectChild=undefined;assert.equal(effects,1);probes++;
  }
  const leaseFile=join(store.dir,'workflow.lock');writeFileSync(leaseFile,JSON.stringify({pid:deadPid}),{mode:0o600});
  const spawnArgs=(operation,boundary,plan='')=>[fixture,file,runId,nonce,operation,boundary,plan];
  const child=(operation,boundary,plan='')=>spawnSync(process.execPath,spawnArgs(operation,boundary,plan),{env:childEnv,encoding:'utf8',timeout:12000});
  const initial=readFileSync(runFile),effectBaseline=effects;
  let stage=scenario==='before-stop'?'before-run':scenario==='after-lease'?'after-lease':scenario==='after-publish'?'after-publish':scenario==='after-archive'?'after-archive':'after-run';
  if(scenario==='live-owner'){
   const live=spawn(process.execPath,spawnArgs('stop','hold-after-run'),{env:childEnv,stdio:['ignore','pipe','pipe']});
   await new Promise((resolve,reject)=>{const timer=setTimeout(()=>{live.kill('SIGKILL');reject(Error('live fixture timeout'));},5000);live.stdout.once('data',data=>{clearTimeout(timer);assert.match(data.toString(),/owned-recovery-live/);resolve();});live.once('error',reject);});
   assert.throws(()=>inspectInterruptedRemoteHumanRecovery(file,runId),e=>e.code==='WORKSPACE_LOCKED');probes++;
   const done=new Promise(resolve=>live.once('exit',resolve));live.kill('SIGKILL');await done;
  }else{const interrupted=child('stop',stage);assert.equal(interrupted.status,42,interrupted.stderr||interrupted.stdout);probes++;}
  const stoppedBytes=readFileSync(runFile);
  if(scenario==='after-archive'){
   assert.equal(workflowRecoveryClaims(root).length,0);assert.equal(inspectRemoteHumanRecoveryFinalization(file,runId).recoveryFinalized,true);probes+=2;
  }else{
   assert.equal(workflowRecoveryClaims(root).length,1);assert.throws(()=>acquireWorkflowLease(file),e=>e.code==='WORKSPACE_LOCKED');probes+=2;
   let plan=inspectInterruptedRemoteHumanRecovery(file,runId);
   assert.equal(plan.effectOutcome,'unknown');probes++;
   const dir=join(store.dir,workflowRecoveryClaims(root)[0]),bodyFile=join(dir,'claim.json');
   if(scenario==='mutations'){
    for(const target of [file,join(store.dir,'remote-human-provider.json'),runFile,bodyFile]){
     const before=readFileSync(target);
     if(target===file)writeFileSync(target,before+'\n');
     else{const value=JSON.parse(before);if(target===bodyFile)value.lease.sha256='f'.repeat(64);else value.unexpected=true;writeFileSync(target,JSON.stringify(value));}
     const corrupt=readFileSync(target);assert.throws(()=>inspectInterruptedRemoteHumanRecovery(file,runId));assert.deepEqual(readFileSync(target),corrupt);probes+=2;writeFileSync(target,before);
    }
    const owner=readdirSync(dir).find(name=>name.startsWith('owner-')),liveName=`owner-${process.pid}-${randomUUID()}.lock`;
    renameSync(join(dir,owner),join(dir,liveName));assert.throws(()=>inspectInterruptedRemoteHumanRecovery(file,runId),e=>e.code==='WORKSPACE_LOCKED');probes++;renameSync(join(dir,liveName),join(dir,owner));
    const leaseBackup=leaseFile+'.fixture-backup';renameSync(leaseFile,leaseBackup);writeFileSync(leaseFile,readFileSync(leaseBackup),{mode:0o600});
    assert.throws(()=>inspectInterruptedRemoteHumanRecovery(file,runId));probes++;unlinkSync(leaseFile);renameSync(leaseBackup,leaseFile);
    plan=inspectInterruptedRemoteHumanRecovery(file,runId);
   }
   if(scenario==='confirmation'){
    for(const confirmation of [{...io,stdinIsTTY:false},{...io,openTerminal:()=>({write(){},readLine:()=> 'WRONG',close(){}})}]){
     assert.throws(()=>finalizeInterruptedRemoteHumanRecovery(file,runId,plan.snapshotHash,confirmation));assert.deepEqual(readFileSync(runFile),stoppedBytes);probes+=2;
    }
    const race={...io,openTerminal:()=>({write(){},readLine(){const changed=JSON.parse(readFileSync(bodyFile));changed.confirmation.confirmedAt=new Date(0).toISOString();writeFileSync(bodyFile,JSON.stringify(changed));return 'ABC234';},close(){}})};
    const original=readFileSync(bodyFile);assert.throws(()=>finalizeInterruptedRemoteHumanRecovery(file,runId,plan.snapshotHash,race));probes++;writeFileSync(bodyFile,original);
    plan=inspectInterruptedRemoteHumanRecovery(file,runId);
   }
   if(scenario==='interrupted-finalizer'){
    for(const boundary of ['after-owner','after-cleanup','after-run','after-lease']){
     // Once a STOP is durable, rewriting its exact bytes is still flushed.
     const result=child('finalize',boundary,plan.snapshotHash);assert.equal(result.status,42,result.stderr||result.stdout);probes++;
     assert.equal(workflowRecoveryClaims(root).length,1);assert.equal(effects,effectBaseline);probes+=2;
     plan=inspectInterruptedRemoteHumanRecovery(file,runId);
    }
   }
   if(scenario==='concurrent'){
    const first=spawn(process.execPath,spawnArgs('finalize','barrier',plan.snapshotHash),{env:childEnv,stdio:['ignore','pipe','pipe']});
    const second=spawn(process.execPath,spawnArgs('finalize','barrier',plan.snapshotHash),{env:childEnv,stdio:['ignore','pipe','pipe']});
    const done=p=>new Promise(resolve=>{let stdout='',stderr='';p.stdout.on('data',v=>stdout+=v);p.stderr.on('data',v=>stderr+=v);p.once('exit',code=>resolve({code,stdout,stderr}));});
    const resultsPromise=Promise.all([done(first),done(second)]),limit=Date.now()+6000;
    while(readdirSync(root).filter(name=>name.startsWith('ready-')).length<2&&Date.now()<limit)await new Promise(r=>setTimeout(r,20));
    assert.equal(readdirSync(root).filter(name=>name.startsWith('ready-')).length,2);
    writeFileSync(join(root,'release-finalizers'),'go');
    const results=await resultsPromise;assert.equal(results.filter(v=>v.code===0).length,1,JSON.stringify(results));assert.equal(results.filter(v=>v.code===1).length,1,JSON.stringify(results));probes+=2;
   }else{
    const finalized=finalizeInterruptedRemoteHumanRecovery(file,runId,plan.snapshotHash,io);
    assert.equal(finalized.recoveryFinalized,true);assert.equal(finalized.effectOutcome,'unknown');probes+=2;
   }
   assert.equal(workflowRecoveryClaims(root).length,0);assert.equal(existsSync(leaseFile),false);probes+=2;
   if(stage!=='before-run'&&stage!=='after-publish')assert.deepEqual(readFileSync(runFile),stoppedBytes);
   assert.equal(inspectRemoteHumanRecoveryFinalization(file,runId).recoveryFinalized,true);probes++;
   assert.throws(()=>finalizeInterruptedRemoteHumanRecovery(file,runId,plan.snapshotHash,io));probes++;
  }
  assert.equal(effects,effectBaseline);assert.equal(inspectStoppedRemoteHumanRun(file,runId).status,'cancelled');probes+=2;
  if(scenario==='consumed-effect')assert.equal((await resumeRemoteHumanWorkflow(file,runId)).executionResumed,false);
  else await assert.rejects(resumeRemoteHumanWorkflow(file,runId));
  assert.equal((await host.dispatch('manual','new-fixture',{subject:{text:'Synthetic exact subject'}})).duplicate,true);assert.equal(effects,effectBaseline);probes+=2;
  const next=await host.dispatch('manual','different-event',{subject:{text:'Different synthetic task'}});
  assert.equal(next.status,'waiting_human');assert.notEqual(next.runId,runId);assert.equal(inspectRemoteHumanRecoveryFinalization(file,runId).readOnly,true);probes+=3;
 }
 console.log(JSON.stringify({passed:true,scenario,probes,localEffects:effects,real_human:false,real_social_posted:false}));
}finally{effectChild?.kill('SIGKILL');server.closeAllConnections();if(server.listening)await new Promise(r=>server.close(r));rmSync(root,{recursive:true,force:true});}
