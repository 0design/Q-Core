import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {createServer} from 'node:http';
import assert from 'node:assert/strict';
import {subprocess,scopedEnvironment} from '../src/subprocess.mjs';
import {hash} from '../src/contracts.mjs';
const site=resolve(process.argv[2]),root=resolve('.'),dataRoot=join(site,'apps/web/src/data');
const catalogBytes=readFileSync(join(dataRoot,'catalog.json')),catalog=JSON.parse(catalogBytes);
const pin=JSON.parse(readFileSync(join(site,'contracts/core.lock.json')));
assert.equal(catalog.core.version,pin.version);
const retained=join(root,'artifacts',`qloops-${pin.version}.tgz`);assert.equal(hash(readFileSync(retained)),pin.artifactSha256);
const sandbox=mkdtempSync(join(tmpdir(),'qloops-registry-caller-'));
const commands=[],requests=[],received=[];
const run=async(exe,args,cwd,env={})=>{
  const r=await subprocess(exe,args,{cwd,env:{...scopedEnvironment(),QF_NO_UPDATE_CHECK:'1',QFACTORY_REGISTRY:'',QLOOP_CATALOG_URL:'',...env},timeoutMs:30000});
  commands.push({args,exit:r.code,stdoutHash:hash(r.stdout),stderrHash:hash(r.stderr)});return r;
};
let candidateBytes;
const assets=new Map([['catalog.json',catalogBytes]]);
for(const section of ['loops','components','demos'])for(const e of catalog[section]??[]){
  const file=e.file??`${section}/${e.id}.json`;assert.match(file,/^(loops|components|demos)\/[a-z0-9-]+\.(yaml|json)$/);
  const bytes=readFileSync(join(dataRoot,file));assert.equal(hash(bytes),e.sha256);assets.set(file,bytes);
}
const server=createServer(async(req,res)=>{
  requests.push({method:req.method,path:req.url});
  if(req.url==='/source'){res.setHeader('Content-Type','application/json');return res.end(JSON.stringify({message:'synthetic registry delivery'}));}
  if(req.url==='/sink'){
    let body='';for await(const chunk of req)body+=chunk;
    received.push(JSON.parse(body));res.setHeader('Content-Type','application/json');return res.end('{"received":true}');
  }
  const match=/^\/(registry|candidate)\/(.+)$/.exec(req.url);
  const bytes=match && (match[1]==='candidate' && match[2]==='catalog.json' ? candidateBytes : assets.get(match[2]));
  if(!bytes){res.writeHead(404);return res.end();}res.end(bytes);
});
try {
  for(const name of ['retained','candidate']){const cwd=join(sandbox,name);mkdirSync(cwd);writeFileSync(join(cwd,'package.json'),JSON.stringify({name:'registry-caller',private:true,type:'module'}));}
  const old=join(sandbox,'retained'),current=join(sandbox,'candidate');
  assert.equal((await run('npm',['install','--ignore-scripts','--no-audit','--no-fund',retained],old)).code,0);
  const packed=await run('npm',['pack',root,'--ignore-scripts','--json'],current);assert.equal(packed.code,0);
  const pack=JSON.parse(packed.stdout)[0],archive=join(current,pack.filename);
  assert.equal((await run('npm',['install','--ignore-scripts','--no-audit','--no-fund',archive],current)).code,0);
  // A separate synthetic catalog changes only engine metadata. The exact Site
  // catalog remains unchanged and is always exercised with its retained pin.
  const synthetic=structuredClone(catalog);synthetic.releaseVersion='synthetic-core-compatibility';synthetic.core.version=pack.version;
  for(const section of ['loops','components','demos'])for(const e of synthetic[section]??[])if(e.engine)e.engine.version=pack.version;
  candidateBytes=Buffer.from(JSON.stringify(synthetic));
  await new Promise(r=>server.listen(0,'127.0.0.1',r));const host=`http://127.0.0.1:${server.address().port}`;
  const bin=cwd=>join(cwd,'node_modules/qloops/bin/qloops.mjs');
  const installArgs=(base,sha,dest)=>['install',base,sha,'webhook-relay','1.0.0',dest];
  const originalHash=hash(catalogBytes),dest=join(old,'relay.yaml');
  assert.equal((await run(process.execPath,[bin(old),...installArgs(host+'/registry',originalHash,dest)],old)).code,0);
  assert.equal(hash(readFileSync(dest)),catalog.loops.find(e=>e.id==='webhook-relay').sha256);
  assert.equal((await run(process.execPath,[bin(old),'validate',dest],old)).code,0);
  const env={QLOOP_SOURCE_URL:host+'/source',QLOOP_WEBHOOK_URL:host+'/sink'};
  assert.equal((await run(process.execPath,[bin(old),'run',dest],old,env)).code,0);
  assert.equal(received.length,1);
  const mismatch=await run(process.execPath,[bin(current),...installArgs(host+'/registry',originalHash,join(current,'mismatch.yaml'))],current);
  assert.equal(mismatch.code,1);assert.match(mismatch.stderr,/installed engine version/);
  const fresh=join(current,'relay.yaml');
  assert.equal((await run(process.execPath,[bin(current),...installArgs(host+'/candidate',hash(candidateBytes),fresh)],current)).code,0);
  assert.equal((await run(process.execPath,[bin(current),'validate',fresh],current)).code,0);
  assert.equal((await run(process.execPath,[bin(current),'run',fresh],current,env)).code,0);assert.equal(received.length,2);
  assert.equal((await run(process.execPath,[bin(current),...installArgs(host+'/candidate',hash(candidateBytes),fresh)],current)).code,1);
  assert.equal((await run(process.execPath,[bin(current),...installArgs(host+'/candidate','0'.repeat(64),join(current,'corrupt.yaml'))],current)).code,1);
  assert.ok(received.every(r=>JSON.stringify(r).includes('synthetic registry delivery')));
  const evidence={date:new Date().toISOString(),evidenceKind:'clean installed CLI over real localhost HTTP; exact read-only Site export on retained engine, separate synthetic engine-repin catalog on current candidate; no public-registry or product live acceptance',
    package:pack.version,sha256:hash(readFileSync(archive)),site:{release:catalog.releaseVersion,catalogSha256:originalHash,core:pin.version,coreSha256:pin.artifactSha256},
    syntheticCatalogSha256:hash(candidateBytes),checks:{retainedDownloadValidateRun:true,currentExactPinMismatchRejected:true,currentSyntheticDownloadValidateRun:true,overwriteRejected:true,checksumRejected:true,received:received.length},commands,requests,received};
  writeFileSync(join(root,'docs/delivery/registry-package.json'),JSON.stringify(evidence,null,2)+'\n');
  console.log(JSON.stringify({package:pack.version,sha256:evidence.sha256,...evidence.checks}));
} finally {await new Promise(r=>server.close(r));rmSync(sandbox,{recursive:true,force:true});}
