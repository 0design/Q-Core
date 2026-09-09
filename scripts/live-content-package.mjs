import {mkdirSync,mkdtempSync,writeFileSync,readFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {createServer} from 'node:http';
import assert from 'node:assert/strict';
import {subprocess,scopedEnvironment} from '../src/subprocess.mjs';
import {hash} from '../src/contracts.mjs';
const model=process.argv[2];assert.ok(model,'Pass an explicit Codex model');
const root=resolve('.');mkdirSync('.qf',{recursive:true});
const sandbox=mkdtempSync(resolve('.qf/live-content-')),workspace=join(sandbox,'workspace');mkdirSync(workspace);
writeFileSync(join(sandbox,'package.json'),JSON.stringify({name:'content-proof-caller',private:true,type:'module'}));
const run=(exe,args)=>subprocess(exe,args,{cwd:sandbox,env:scopedEnvironment(),timeoutMs:180000});
const p=await run('npm',['pack',root,'--ignore-scripts','--json']);assert.equal(p.code,0);
const packed=JSON.parse(p.stdout)[0],archive=join(sandbox,packed.filename);
assert.equal((await run('npm',['install','--ignore-scripts','--no-audit','--no-fund',archive])).code,0);
const received=[],receipts=new Map(),results=[];
const server=createServer(async(req,res)=>{
  if(req.method==='GET'){res.setHeader('Content-Type','text/plain');return res.end('Synthetic release note '+req.url+': the sample team improved its local verification workflow. This is an authored test source, not real editorial news.');}
  let body='';for await(const part of req)body+=part;
  const key=req.headers['idempotency-key'];const parsed=JSON.parse(body);assert.ok(key);
  let receipt=receipts.get(key);if(!receipt){receipt={id:'local-'+(received.length+1),delivered:true};receipts.set(key,receipt);received.push({text:parsed.text,key,receipt});}
  res.setHeader('Content-Type','application/json');res.end(JSON.stringify(receipt));
});
try {
  await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin=`http://127.0.0.1:${server.address().port}`;
  const base={protocolVersion:'qf.content-request/v1',requestId:'live-content',workspace,allowedOrigins:[origin],deadlineMs:90000,
    provider:{kind:'codex',model,executable:'/Applications/ChatGPT.app/Contents/Resources/codex',payerScope:'local-cli'},
    receiver:{kind:'webhook',id:'synthetic-local-test',url:origin+'/sink'},profile:{language:'Ukrainian',tone:'factual',instructions:'One short factual paragraph. Label the content as a synthetic test. Include the supplied source URL verbatim.'}};
  const call=async request=>{const path=join(sandbox,'request.json');writeFileSync(path,JSON.stringify(request),{mode:0o600});const r=await run(process.execPath,[join(sandbox,'node_modules/qloops/bin/qloops.mjs'),'content',path]);assert.ok(r.stdout.trim(),r.stderr);const out=JSON.parse(r.stdout);results.push({exit:r.code,result:out});return out;};
  for(let i=1;i<=3;i++){
    const request={...base,sources:[{id:'source-'+i,url:origin+'/source-'+i}]};
    const draft=await call(request);assert.equal(draft.nextAction?.type,'approve_publication',JSON.stringify(draft));assert.equal(received.length,i-1);
    const done=await call({...request,approval:{hash:draft.nextAction.hash,decision:'approve'}});assert.equal(done.status,'success',JSON.stringify(done));
    assert.equal(received.length,i);assert.equal(received[i-1].text,draft.nextAction.text);assert.ok(received[i-1].text.includes(request.sources[0].url));
    const replay=await call(request);assert.equal(replay.nextAction?.type,'no_new_sources');assert.equal(received.length,i);
  }
  writeFileSync(join(root,'docs/delivery/content-package-live.json'),JSON.stringify({date:new Date().toISOString(),package:packed.version,sha256:hash(readFileSync(archive)),model,
    evidenceKind:'clean installed CLI with live Codex ChatGPT drafting; three authored synthetic localhost sources; explicit test-harness approval and exact-text local receiver receipts; NOT owner sources/channel/editorial acceptance',results,received},null,2)+'\n');
  console.log(JSON.stringify({package:packed.version,sha256:hash(readFileSync(archive)),drafts:3,deliveries:received.length,replayWithoutDuplicate:true}));
} finally {await new Promise(r=>server.close(r));}
