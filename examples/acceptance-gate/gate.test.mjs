import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, existsSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { canonical, digest, contextSlice, bindCandidate, observe, signReceipt, acceptance, applyProposal } from './gate.mjs';
import { verifyCandidate } from './controller.mjs';
import { render } from './render.mjs';
const here = dirname(fileURLToPath(import.meta.url));
const read = n => JSON.parse(readFileSync(join(here,n), 'utf8'));
const contract = read('contract.json'), ds = read('ds.json'), screen = read('screen.json');
const key = generateKeyPairSync('ed25519'), syncKey = generateKeyPairSync('ed25519');
const now = Date.parse('2026-09-12T00:00:00Z');
const clone = x => structuredClone(x);
const binding = bindCandidate({baseSha:'a'.repeat(40),headSha:'b'.repeat(40),contract,ds,verifierDigest:'c'.repeat(64),files:[{path:contract.allowedFiles[0],sha256:digest(screen)}]});
function receipt(kind, patch = {}, pair = kind === 'review' ? key : syncKey) {
  return signReceipt({schema:'qgate.receipt/v1',kind,binding,receiptId:'test-'+kind,evidenceDigest:digest({fixture:true}),issuedAt:new Date(now-1000).toISOString(),expiresAt:new Date(now+60_000).toISOString(),...(kind==='review'?{decision:'approved',independent:true}:{confirmed:true}),...patch},pair.privateKey);
}
const options = () => ({binding,contract,changedFiles:contract.allowedFiles,review:receipt('review'),sync:receipt('linear-sync'),reviewPublicKey:key.publicKey,syncPublicKey:syncKey.publicKey,nowMs:now});
test('canonical binding is stable and rejects non-JSON data',()=>{
 assert.equal(digest({b:2,a:1}),digest({a:1,b:2}));assert.throws(()=>canonical({x:NaN}));
 assert.throws(()=>bindCandidate({...binding,contract,ds,files:[]}));
 const slice=contextSlice(contract,ds);assert.deepEqual(slice.contract.requirements,contract.requirements);slice.contract.requirements.length=0;assert.ok(contract.requirements.length);
 assert.throws(()=>contextSlice({...contract,detectorMode:'block'},ds));
 assert.throws(()=>contextSlice(contract,{...ds,version:'2'}));
});
test('registered component and project extension are valid',()=>{
 const candidate=clone(screen);candidate.nodes.find(n=>n.id==='save').extension='project-emphasis';
 assert.deepEqual(observe(candidate,contract,ds).findings,[]);
 const html=render(candidate,contract,ds);assert.match(html,/data-ds-component="Button"/);assert.match(html,/class="button primary project-emphasis"/);
 const changed=clone(ds);changed.tokens.semantic.action='ink';assert.match(render(candidate,contract,changed),/--action:#16202a/);
});
for(const [name,mutate,rule] of [
 ['raw style',s=>s.nodes[2].style={color:'#ff0000'},'DS-RAW'],
 ['raw HTML replacement',s=>s.nodes[2].component='div','DS-COMPONENT'],
 ['raw tag escape',s=>s.nodes[2].tag='div','DS-RAW'],
 ['waiver',s=>s.nodes[2]['ds-allow']='approved by worker','DS-WAIVER'],
 ['unregistered extension',s=>s.nodes[2].extension='custom-red','DS-EXTENSION'],
 ['wrong extension target',s=>s.nodes[0].extension='project-emphasis','DS-EXTENSION'],
 ['role mismatch',s=>s.nodes[2].role='info','DS-ROLE'],
 ['unsupported overlay',s=>s.nodes[2].presentation='overlay','DS-PRESENTATION'],
 ['copy drift',s=>s.nodes[2].content='Delete account','TASK-COPY'],
 ['duplicate ID',s=>s.nodes[1].id='heading','DS-ID'],
 ['token override',s=>s.tokens={action:'red'},'DS-RAW'],
 ['missing node',s=>s.nodes.pop(),'TASK-NODE'],
]) test('observer reports '+name,()=>{const s=clone(screen);mutate(s);const r=observe(s,contract,ds);assert.equal(r.mode,'observe');assert.ok(r.findings.some(f=>f.rule===rule));});
test('text mentioning CSS remains content; HTML is escaped',()=>{
 const s=clone(screen);s.nodes[1].content='<script>alert(1)</script> rgb(1,2,3) style=red';
 assert.deepEqual(observe(s,contract,ds).findings,[]);const html=render(s,contract,ds);assert.ok(!html.includes('<script>'));assert.match(html,/&lt;script&gt;/);
});
test('eligible requires valid separately signed review and synchronization',()=>assert.equal(acceptance(options()).state,'eligible'));
for(const field of ['review','sync']) test('missing '+field+' is pending',()=>assert.equal(acceptance({...options(),[field]:null}).state,'pending'));
test('observer mode does not replace independent review',()=>{
 assert.equal(acceptance({...options(),review:receipt('review',{decision:'rejected'})}).state,'rejected');
 // Observation results are intentionally not an input; attestor must judge requirements.
 assert.equal(acceptance(options()).detectorMode,'observe');
});
for(const changed of ['contract.json','gate.mjs','trust.json','README.md']) test('frozen '+changed+' cannot be changed',()=>{
 assert.equal(acceptance({...options(),changedFiles:[...contract.allowedFiles,'examples/acceptance-gate/'+changed]}).checks.contract.state,'failure');
});
for(const field of ['baseSha','headSha','contractDigest','dsDigest','verifierDigest','files']) test('receipt cannot be replayed after '+field+' changes',()=>{
 const other=clone(binding);other[field]=field==='files'?[{path:contract.allowedFiles[0],sha256:'9'.repeat(64)}]:'9'.repeat(field.endsWith('Sha')?40:64);
 assert.equal(acceptance({...options(),review:receipt('review',{binding:other})}).state,'rejected');
});
for(const [name,patch] of [
 ['expired',{expiresAt:new Date(now-1).toISOString()}],['future',{issuedAt:new Date(now+120_000).toISOString(),expiresAt:new Date(now+180_000).toISOString()}],
 ['unbounded lifetime',{expiresAt:new Date(now+86401_000).toISOString()}],['self-review',{independent:false}],['missing evidence',{evidenceDigest:''}],['wrong purpose',{kind:'linear-sync'}]
]) test('invalid review '+name+' fails',()=>assert.equal(acceptance({...options(),review:receipt('review',patch)}).state,'rejected'));
test('tampered, forged and wrong-attestor receipts fail',()=>{
 const tampered=receipt('review');tampered.body.decision='rejected';
 for(const review of [tampered,receipt('review',{},syncKey),{body:receipt('review').body,signature:'fake'}]) assert.equal(acceptance({...options(),review}).state,'rejected');
 assert.equal(acceptance({...options(),sync:receipt('linear-sync',{confirmed:false})}).state,'rejected');
});
test('worker proposal is bounded JSON, stale-safe, and cannot escape via path or symlink',()=>{
 const root=mkdtempSync(join(tmpdir(),'qgate-proposal-'));
 try {
  const path=contract.allowedFiles[0],file=join(root,path);mkdirSync(dirname(file),{recursive:true});writeFileSync(file,JSON.stringify(screen));
  const s=clone(screen);s.nodes[2].extension='project-emphasis';const proposal={path,expectedSha256:digest(readFileSync(file)),content:JSON.stringify(s)};
  assert.throws(()=>applyProposal(root,{...proposal,path:'../../outside'},contract));
  assert.throws(()=>applyProposal(root,{...proposal,content:'execute()'},contract));
  assert.throws(()=>applyProposal(root,{...proposal,command:'echo bypass'},contract));
  applyProposal(root,proposal,contract);assert.deepEqual(JSON.parse(readFileSync(file)),s);assert.throws(()=>applyProposal(root,proposal,contract));
  rmSync(file);symlinkSync('/tmp',file);assert.throws(()=>applyProposal(root,proposal,contract));
 } finally {rmSync(root,{recursive:true,force:true});}
});
test('real Git controller uses frozen base, refuses policy edits and removes stale preview',()=>{
 const root=mkdtempSync(join(tmpdir(),'qgate-git-'));const out=join(root,'out');
 const git=(...args)=>execFileSync('git',['-c','core.hooksPath=/dev/null',...args],{cwd:root,encoding:'utf8'}).trim();
 try {
  cpSync(here,join(root,'examples/acceptance-gate'),{recursive:true});git('init','-q');git('config','user.name','Synthetic fixture');git('config','user.email','fixture@example.invalid');git('add','examples');git('commit','-qm','trusted fixture');const baseSha=git('rev-parse','HEAD');
  const s=clone(screen);s.nodes[2].extension='project-emphasis';writeFileSync(join(root,contract.allowedFiles[0]),JSON.stringify(s));git('add','examples');git('commit','-qm','valid candidate');const goodSha=git('rev-parse','HEAD');
  let report=verifyCandidate({repository:root,baseSha,headSha:goodSha,outputDirectory:out,nowMs:now});assert.equal(report.state,'pending');assert.ok(existsSync(join(out,'preview.html')));
  s.nodes[2].style={color:'red'};writeFileSync(join(root,contract.allowedFiles[0]),JSON.stringify(s));writeFileSync(join(root,'examples/acceptance-gate/contract.json'),JSON.stringify({...contract,requirements:[]}));git('add','examples');git('commit','-qm','attempt policy bypass');
  report=verifyCandidate({repository:root,baseSha,headSha:git('rev-parse','HEAD'),outputDirectory:out,nowMs:now});assert.equal(report.checks.contract.state,'failure');assert.ok(report.observation.findings.length);assert.ok(!existsSync(join(out,'preview.html')));assert.equal(report.binding.contractDigest,digest(contract));
 } finally {rmSync(root,{recursive:true,force:true});}
});
