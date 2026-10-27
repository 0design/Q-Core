// Fresh disposable state/keys/terminal and loopback receiver ONLY. No operator
// context can be supplied. The parent agent environment is never changed.
import assert from 'node:assert/strict';
import fs, { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync, realpathSync, chmodSync, unlinkSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { canonical, hash } from '../../src/contracts.mjs';
import { createLocalHost } from '../../src/host.mjs';
import { acquireWorkflowLease } from '../../src/workflow-lease.mjs';
import { RunStore } from '../../src/state.mjs';
import { enrollRemoteHumanProvider, requestRemoteHumanDecision, consumeRemoteHumanDecision,
  resumeRemoteHumanWorkflow, inspectRemoteHumanRecovery, inspectStoppedRemoteHumanRun,
  stopInterruptedRemoteHumanRun } from '../../src/remote-human-host.mjs';
const scenario = process.argv[2];
const choices = ['requested','consumed','running','held','expired','guard','mutations','tty','faults','stopped-mutations'];
assert.ok(choices.includes(scenario));
const root = realpathSync(mkdtempSync(join(tmpdir(), 'qf-recovery-fixture-'))), file = join(root,'workflow.yaml');
let probes = 0, effects = 0, child;
const io = { env: {}, stdinIsTTY: true, stdoutIsTTY: true, code: 'ABC234',
  openTerminal: () => ({ write() {}, readLine: () => 'ABC234', close() {} }) };
const server = createServer((req,res) => { effects++; child?.kill('SIGKILL'); res.end('{}'); });
try {
  if (scenario === 'guard') {
    for (const fn of [inspectRemoteHumanRecovery, inspectStoppedRemoteHumanRun, stopInterruptedRemoteHumanRun]) {
      assert.throws(() => fn(join(root,'never-read'),null,null,io),e=>e.code==='HUMAN_CONFIRMATION_REQUIRED'); probes++;
    }
    assert.deepEqual(readdirSync(root),[]); probes++;
  } else {
    await new Promise(r=>server.listen(0,'127.0.0.1',r));
    writeFileSync(file,`manifest: q-core.workflow/v1\nid: recovery-fixture\nname: Recovery fixture\nversion: 1.0.0\nowner: test\nenabled: true\ninputs:\n  subject:\n    type: object\n    required: true\ntriggers:\n  - kind: manual\nsteps:\n  - id: review\n    kind: approval-gate\n    config:\n      reviewer: human\n      bind: sha256\n      source: "{{inputs.subject}}"\n  - id: publish\n    kind: api-request\n    config:\n      url: "http://127.0.0.1:${server.address().port}/effect"\n      method: POST\n      body: "{}"\n      receiptKey: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n`);
    const pair=generateKeyPairSync('ed25519');
    const policy={publicKey:pair.publicKey.export({type:'spki',format:'pem'}),endpoint:'https://approval.example.test/',
      reviewerId:'12345678',chatId:'-100123456789',manifestHash:hash(readFileSync(file))};
    enrollRemoteHumanProvider(file,policy,io);
    const hosted=await createLocalHost({manifest:file,manifestSha256:policy.manifestHash}).dispatch('manual','new-fixture',{subject:{text:'Synthetic exact review'}});
    const runId=hosted.runId,store=new RunStore(file),runFile=store.runFile(runId);
    const request=requestRemoteHumanDecision(file,runId,{...(scenario==='expired'?{nowMs:1000,ttlMs:10000}:{})});
    if (['consumed','running','held'].includes(scenario)) {
      const {issuedAt,requestHash,...fields}=request;
      const body={...fields,requestHash,protocol:'qf.remote-human-receipt/v1',receiptId:randomUUID(),decision:'approve',decidedAt:Date.now()};
      const receipt=canonical({body,signature:sign(null,Buffer.from(canonical(body)),pair.privateKey).toString('base64')});
      consumeRemoteHumanDecision(file,runId,receipt);
    }
    // Obtain a PID from a process observed to have really exited. Do not infer
    // death from an age, a guessed large PID or an observation timeout.
    let deadPid=spawnSync(process.execPath,['-e','process.exit(0)'],{env:{PATH:process.env.PATH},timeout:5000}).pid;
    if (['running','held'].includes(scenario)) {
      const source=`import {resumeRemoteHumanWorkflow} from ${JSON.stringify(new URL('../../src/remote-human-host.mjs',import.meta.url).href)};await resumeRemoteHumanWorkflow(process.argv[1],process.argv[2]);`;
      child=spawn(process.execPath,['--input-type=module','-e',source,file,runId],{env:{PATH:process.env.PATH},stdio:['ignore','pipe','pipe']});
      const status=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>{child.kill('SIGKILL');reject(Error('fixture child timeout'));},10000);child.once('exit',(code,signal)=>{clearTimeout(timer);resolve({code,signal});});child.once('error',reject);});
      assert.equal(status.signal,'SIGKILL');assert.equal(effects,1);probes+=2;deadPid=child.pid;child=undefined;
      assert.equal(store.load(runId).steps[1].status,'running');probes++;
      if(scenario==='held'){
        unlinkSync(join(store.dir,'workflow.lock'));
        assert.equal((await resumeRemoteHumanWorkflow(file,runId)).status,'needs_human');probes++;
      }
    }
    const leaseFile=join(store.dir,'workflow.lock'),claimFile=join(store.dir,'remote-human-recovery.lock');
    writeFileSync(leaseFile,JSON.stringify({pid:deadPid}),{mode:0o600});chmodSync(leaseFile,0o600);
    const baseline=readFileSync(runFile),lease=readFileSync(leaseFile),effectBaseline=effects;
    const host=join(store.dir,'host',hash(file)),activeFile=join(host,'active.json'),eventFile=join(host,hash({kind:'manual',eventId:'new-fixture'})+'.json');
    const plan=()=>inspectRemoteHumanRecovery(file,runId);
    const refuse=(fn)=>{assert.throws(fn);assert.deepEqual(readFileSync(runFile),baseline);assert.equal(effects,effectBaseline);probes+=3;};
    assert.throws(()=>inspectRemoteHumanRecovery(file,'../wrong'));probes++;
    const expected=plan();assert.equal(expected.effectOutcome,'unknown');assert.deepEqual(readFileSync(runFile),baseline);probes+=2;
    if(scenario==='mutations'){
      for(const target of [file,join(store.dir,'remote-human-provider.json'),runFile,activeFile,eventFile,leaseFile]){
        const original=readFileSync(target);
        if(target===file)writeFileSync(target,original+'\n');
        else{const value=JSON.parse(original);if(target===leaseFile)value.pid=process.pid;else value.unexpected=true;writeFileSync(target,JSON.stringify(value));}
        assert.throws(()=>stopInterruptedRemoteHumanRun(file,runId,expected.snapshotHash,io));probes++;
        assert.equal(existsSync(claimFile),false);probes++;
        writeFileSync(target,original);
      }
      const original=readFileSync(leaseFile);
      for(const value of ['',JSON.stringify({pid:deadPid,extra:true}),JSON.stringify({pid:-1})]){writeFileSync(leaseFile,value);refuse(plan);}
      writeFileSync(leaseFile,original);chmodSync(leaseFile,0o644);refuse(plan);chmodSync(leaseFile,0o600);
      unlinkSync(leaseFile);refuse(plan);writeFileSync(leaseFile,lease,{mode:0o600});
      writeFileSync(join(host,'lock'),'');refuse(plan);unlinkSync(join(host,'lock'));
      const event=readFileSync(eventFile);writeFileSync(eventFile,JSON.stringify({...JSON.parse(event),phase:'claimed'}));refuse(plan);writeFileSync(eventFile,event);
      writeFileSync(claimFile,'');refuse(plan);unlinkSync(claimFile);
      const race={...io,openTerminal:()=>({write(){},readLine(){writeFileSync(activeFile,JSON.stringify({runId:randomUUID()}));return 'ABC234';},close(){}})};
      refuse(()=>stopInterruptedRemoteHumanRun(file,runId,expected.snapshotHash,race));assert.equal(existsSync(claimFile),false);probes++;
    } else if(scenario==='tty') {
      for(const terminal of [{...io,stdinIsTTY:false},{...io,stdoutIsTTY:false},{...io,env:{AI_AGENT:'fixture'}},
        {...io,openTerminal:()=>({write(){},readLine:()=> 'WRONG',close(){}})}]){
        refuse(()=>stopInterruptedRemoteHumanRun(file,runId,expected.snapshotHash,terminal));assert.equal(existsSync(claimFile),false);probes++;
      }
    } else if(scenario==='faults') {
      // Fail each durable stage in a fresh snapshot; failed repairs retain their
      // claim. Explicit fixture reset below is NOT an operator recovery API.
      for(const boundary of ['run-rename','run-dir-sync','lease-unlink','lease-dir-sync','claim-unlink','claim-dir-sync']){
        const currentExpected=plan();
        const rename=fs.renameSync,sync=fs.fsyncSync,unlink=fs.unlinkSync;let runRenamed=false,leaseRemoved=false,claimRemoved=false;
        fs.renameSync=(from,to)=>{if(to===runFile){if(boundary==='run-rename')throw Object.assign(Error('fixture EIO'),{code:'EIO'});runRenamed=true;}return rename(from,to);};
        fs.fsyncSync=(fd)=>{if((boundary==='run-dir-sync'&&runRenamed)||(boundary==='lease-dir-sync'&&leaseRemoved)||(boundary==='claim-dir-sync'&&claimRemoved))throw Object.assign(Error('fixture EIO'),{code:'EIO'});return sync(fd);};
        fs.unlinkSync=(target)=>{if((boundary==='lease-unlink'&&target===leaseFile)||(boundary==='claim-unlink'&&target===claimFile))throw Object.assign(Error('fixture EIO'),{code:'EIO'});const value=unlink(target);if(target===leaseFile)leaseRemoved=true;if(target===claimFile)claimRemoved=true;return value;};
        syncBuiltinESMExports();
        try { assert.throws(()=>stopInterruptedRemoteHumanRun(file,runId,currentExpected.snapshotHash,io));probes++; }
        finally {fs.renameSync=rename;fs.fsyncSync=sync;fs.unlinkSync=unlink;syncBuiltinESMExports();}
        assert.equal(existsSync(claimFile),!claimRemoved);assert.equal(existsSync(leaseFile),!leaseRemoved);assert.equal(effects,effectBaseline);probes+=3;
        assert.throws(plan);probes++;
        if(!claimRemoved){assert.throws(()=>acquireWorkflowLease(file),e=>e.code==='WORKSPACE_LOCKED');probes++;unlinkSync(claimFile);}
        else {assert.equal(inspectStoppedRemoteHumanRun(file,runId).status,'cancelled');probes++;}
        writeFileSync(runFile,baseline);if(leaseRemoved)writeFileSync(leaseFile,lease,{mode:0o600});
      }
    } else {
      const stopped=stopInterruptedRemoteHumanRun(file,runId,expected.snapshotHash,io);
      assert.equal(stopped.status,'cancelled');assert.equal(stopped.effectOutcome,'unknown');assert.equal(stopped.executionResumed,false);
      assert.equal(existsSync(leaseFile),false);assert.equal(existsSync(claimFile),false);assert.equal(effects,effectBaseline);probes+=6;
      const current=readFileSync(runFile);const observed=inspectStoppedRemoteHumanRun(file,runId);
      assert.equal(observed.readOnly,true);assert.equal(observed.requestId,request.requestId);assert.deepEqual(readFileSync(runFile),current);probes+=3;
      if(scenario==='stopped-mutations'){
        for(const mutate of [r=>r.summary='changed',r=>r.steps[1].status='success',r=>r.inputs.extra=true,
          r=>r.remoteHuman.request.approvalHash='f'.repeat(64),r=>r.humanRecovery.prior.summary='changed',
          r=>r.humanRecovery.confirmation.channel='imported',r=>r.humanRecovery.effectOutcome='none']){
          const changed=JSON.parse(current);mutate(changed);writeFileSync(runFile,JSON.stringify(changed));
          assert.throws(()=>inspectStoppedRemoteHumanRun(file,runId));probes++;writeFileSync(runFile,current);
        }
      }
      assert.throws(()=>stopInterruptedRemoteHumanRun(file,runId,expected.snapshotHash,io));probes++;
      if(['consumed','running','held'].includes(scenario))assert.equal((await resumeRemoteHumanWorkflow(file,runId)).executionResumed,false);
      else await assert.rejects(resumeRemoteHumanWorkflow(file,runId));
      assert.equal(effects,effectBaseline);assert.deepEqual(readFileSync(runFile),current);probes+=3;
      const next=await createLocalHost({manifest:file,manifestSha256:policy.manifestHash}).dispatch('manual','different-event',{subject:{text:'Different synthetic task'}});
      assert.equal(next.status,'waiting_human');assert.notEqual(next.runId,runId);assert.equal(effects,effectBaseline);probes+=3;
      assert.equal(inspectStoppedRemoteHumanRun(file,runId).status,'cancelled');probes++;
    }
  }
  console.log(JSON.stringify({passed:true,scenario,probes,effects,real_human:false,real_social_posted:false}));
} finally {
  child?.kill('SIGKILL');server.closeAllConnections();if(server.listening)await new Promise(r=>server.close(r));rmSync(root,{recursive:true,force:true});
}
