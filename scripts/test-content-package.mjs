import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:http';
import { subprocess } from '../src/subprocess.mjs';
import { hash } from '../src/contracts.mjs';

const root=resolve('.'), sandbox=mkdtempSync(join(tmpdir(),'qf-content-contract-'));
const exec=(exe,args)=>subprocess(exe,args,{cwd:sandbox,timeoutMs:30000});
const received=[], outputs=[]; let fail=false;
const server=createServer(async(req,res)=>{
  if(req.method==='GET') return res.end('SYNTHETIC source: a local sample release improved checks.');
  let body='';for await(const part of req) body+=part;
  received.push({text:JSON.parse(body).text,key:req.headers['idempotency-key']});
  if(fail){res.writeHead(503);return res.end('unconfirmed');}
  res.setHeader('Content-Type','application/json');res.end(JSON.stringify({id:'receipt-'+received.length,delivered:true}));
});
try {
  writeFileSync(join(sandbox,'package.json'),JSON.stringify({name:'content-contract-consumer',private:true,type:'module'}));
  const pack=await exec('npm',['pack',root,'--ignore-scripts','--json']);assert.equal(pack.code,0,pack.stderr);
  const packed=JSON.parse(pack.stdout)[0],tarball=join(sandbox,packed.filename);
  assert.equal((await exec('npm',['install','--ignore-scripts','--no-audit','--no-fund',tarball])).code,0);
  const installed=join(sandbox,'node_modules/qloops');
  const contract=readFileSync(join(installed,'contracts/v1/content.md'),'utf8');
  assert.ok(contract.includes('qf.content-request/v1')&&contract.includes('approve_publication')&&contract.includes('Idempotency-Key'));
  const example=JSON.parse(readFileSync(join(installed,'examples/content-request.json'),'utf8'));
  assert.ok(example.profile.instructions.includes('SYNTHETIC TEST ONLY'));
  assert.equal(example.approval,undefined);
  assert.equal(example.receiver.kind,'webhook');
  // The only source-repo file consumed here is explicitly a model fixture,
  // copied into this otherwise independent installed consumer. No runtime imports.
  const fixture=join(sandbox,'codex-fixture.mjs');copyFileSync(join(root,'test/fixtures/codex.mjs'),fixture);chmodSync(fixture,0o755);
  const workspace=join(sandbox,'workspace');mkdirSync(workspace);
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const origin=`http://127.0.0.1:${server.address().port}`;
  const base={...example,workspace,allowedOrigins:[origin],deadlineMs:5000,
    provider:{...example.provider,executable:fixture,model:'fixture'},
    receiver:{...example.receiver,url:origin+'/receipt'},
    sources:example.sources.map(s=>({...s,url:origin+'/source/1'}))};
  async function call(request) {
    const file=join(sandbox,'request.json');writeFileSync(file,JSON.stringify(request),{mode:0o600});
    const p=await exec(process.execPath,[join(installed,'bin/qloops.mjs'),'content',file]);
    assert.ok(p.stdout.trim(),p.stderr);const result=JSON.parse(p.stdout);
    assert.equal(result.protocolVersion,'qf.content/v1');assert.equal(p.code,{success:0,failed:1,needs_human:2,cancelled:130}[result.status]);
    outputs.push({exit:p.code,result});return result;
  }
  const noKey=await call({...base,receiver:{...base.receiver,keyRef:'QF_CONTENT_CONTRACT_ABSENT_TEST_KEY'}});
  assert.equal(noKey.nextAction.type,'configure_access');assert.equal(received.length,0);
  const draft=await call(base);assert.equal(draft.nextAction.type,'approve_publication');assert.equal(received.length,0);
  const approval={hash:draft.nextAction.hash,decision:'approve'};
  const done=await call({...base,approval});assert.equal(done.status,'success');assert.equal(received.length,1);
  assert.equal(received[0].text,draft.nextAction.text);assert.match(received[0].key,/^[a-f0-9]{64}$/);
  assert.equal(done.evidence.at(-1).receipt.delivered,true);
  assert.equal((await call(base)).nextAction.type,'no_new_sources');assert.equal(received.length,1);
  const second={...base,sources:[{id:'synthetic-source-2',url:origin+'/source/2'}]};
  const next=await call({...second,approval});assert.equal(next.nextAction.type,'approve_publication');assert.notEqual(next.nextAction.hash,approval.hash);
  const stale=await call({...second,approval:{...approval,decision:'reject'}});assert.equal(stale.nextAction.type,'approve_publication');
  assert.equal((await call({...second,approval:{hash:next.nextAction.hash,decision:'reject'}})).status,'cancelled');
  assert.equal(received.length,1);
  const third={...base,sources:[{id:'synthetic-source-3',url:origin+'/source/3'}]};
  const thirdDraft=await call(third);fail=true;
  const uncertain=await call({...third,approval:{hash:thirdDraft.nextAction.hash,decision:'approve'}});
  assert.equal(uncertain.nextAction.type,'reconcile_receipt');assert.equal(received.length,2);
  assert.equal((await call(third)).nextAction.type,'reconcile_receipt');assert.equal(received.length,2);
  const evidence={date:new Date().toISOString(),package:packed.version,artifactSha256:hash(readFileSync(tarball)),
    evidenceKind:'clean-installed shipped Content request example; Codex subprocess fixture; real localhost HTTP only; not live inference or owner acceptance',
    contractSha256:hash(contract),exampleSha256:hash(readFileSync(join(installed,'examples/content-request.json'))),
    checks:{exactText:true,approvalRequired:true,receipt:true,dedup:true,staleApprovalRejected:true,rejection:true,missingKey:true,uncertainReplayNoResend:true},outputs};
  writeFileSync(join(root,'docs/delivery/content-contract-package.json'),JSON.stringify(evidence,null,2)+'\n');
  console.log(JSON.stringify({package:packed.version,artifactSha256:evidence.artifactSha256,checks:evidence.checks}));
} finally {
  if(server.listening) await new Promise(r=>server.close(r));
  rmSync(sandbox,{recursive:true,force:true});
}
