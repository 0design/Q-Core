// Only invoked by remote-human-finalize-case.mjs with its new disposable root.
// No operator context, real user terminal, q-core approve or external receiver.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import {join,dirname,basename} from 'node:path';
import {syncBuiltinESMExports} from 'node:module';
import {inspectRemoteHumanRecovery,stopInterruptedRemoteHumanRun,finalizeInterruptedRemoteHumanRecovery} from '../../src/remote-human-host.mjs';
const [file,runId,nonce,operation,boundary,planHash]=process.argv.slice(2),root=dirname(file);
assert.ok(basename(root).startsWith('qf-finalize-fixture-'));assert.equal(basename(file),'workflow.yaml');
assert.deepEqual(JSON.parse(fs.readFileSync(join(root,'disposable-fixture.json'))),{runId,nonce});
assert.ok(['stop','finalize'].includes(operation));
const runFile=join(root,'.qf','runs',runId+'.json'),leaseFile=join(root,'.qf','workflow.lock');
const exit=()=>{
  if(boundary==='hold-after-run'){
    process.stdout.write('owned-recovery-live\n');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10000);
  }
  process.exit(42);
};
const rename=fs.renameSync,unlink=fs.unlinkSync;
fs.renameSync=(from,to)=>{
  if(to===runFile&&boundary==='before-run')exit();
  const value=rename(from,to);
  if(to===runFile&&['after-run','hold-after-run'].includes(boundary))exit();
  if(boundary==='after-publish'&&basename(String(from)).startsWith('.remote-human-recovery-draft-')&&basename(String(to)).startsWith('remote-human-recovery-claim-'))exit();
  if(boundary==='after-owner'&&basename(String(from)).startsWith('owner-')&&basename(String(to)).startsWith('owner-'))exit();
  if(boundary==='after-cleanup'&&basename(String(to))==='cleanup.json')exit();
  if(boundary==='after-archive'&&String(to).includes('/remote-human-recovery-history/'))exit();
  return value;
};
fs.unlinkSync=target=>{const value=unlink(target);if(target===leaseFile&&boundary==='after-lease')exit();return value;};
syncBuiltinESMExports();
const io={env:{},stdinIsTTY:true,stdoutIsTTY:true,code:'ABC234',openTerminal:()=>({write(){},readLine(){
  if(boundary==='barrier'){
    fs.writeFileSync(join(root,'ready-'+process.pid),'ready');
    const limit=Date.now()+7000;
    while(!fs.existsSync(join(root,'release-finalizers'))&&Date.now()<limit)Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,20);
    assert.ok(fs.existsSync(join(root,'release-finalizers')));
  }
  return 'ABC234';
},close(){}})};
try{
 const value=operation==='stop'?stopInterruptedRemoteHumanRun(file,runId,inspectRemoteHumanRecovery(file,runId).snapshotHash,io):
  finalizeInterruptedRemoteHumanRecovery(file,runId,planHash,io);
 process.stdout.write(JSON.stringify({passed:true,...value}));
}catch(error){process.stdout.write(JSON.stringify({refused:true,code:error.code??'fixture-error'}));process.exitCode=1;}
