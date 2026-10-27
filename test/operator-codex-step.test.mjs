import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, chmodSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { operatorCodexPolicy, validateOperatorCodexProvider } from '../src/registry-codex-step.mjs';

const cli=resolve('bin/q-core.mjs');
function fresh(t,{model='fixture',budget='null',config='',after=''}={}) {
  // Entirely new root, executable, synthetic identity and process. No real auth,
  // account, previous runtime, key, TTY decision or effect is involved.
  const dir=mkdtempSync(join(tmpdir(),'qf-operator-codex-fixture-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const executable=join(dir,'codex-fixture.mjs'),trace=join(dir,'probes.txt');
  let source=readFileSync(resolve('test/fixtures/codex.mjs'),'utf8').replace('fixture-thread',randomUUID());
  source=source.replace('import { readFileSync }', `import {appendFileSync} from 'node:fs';appendFileSync(${JSON.stringify(trace)},'probe\\n');\nimport { readFileSync }`);
  writeFileSync(executable,source);chmodSync(executable,0o700);
  const provider=join(dir,'provider.json'),manifest=join(dir,'workflow.yaml');
  writeFileSync(provider,JSON.stringify({kind:'codex',executable,model,payerScope:'local-cli'}),{mode:0o600});
  writeFileSync(manifest,`manifest: q-core.workflow/v1\nid: operator-codex\nname: Operator inference fixture\nversion: 0.1.0\nenabled: true\nsettings:\n  budgetUsd: ${budget}\nsteps:\n  - id: draft\n    kind: llm-call\n    config:\n      provider: codex\n      instructions: Return JSON with summary:string\n      format: json\n      retries: 0\n      timeoutSec: 5\n${config}${after}`);
  const invoke=(args,extra={})=>spawnSync(process.execPath,[cli,...args],{cwd:dir,encoding:'utf8',env:{PATH:process.env.PATH,GF_NATIVE_PROVIDER_TOKEN:'new-synthetic-must-not-inherit',...extra},timeout:15000});
  return {dir,manifest,provider,trace,executable,invoke,run:extra=>invoke(['run',manifest,'--operator-codex-provider',provider,'--json'],extra)};
}

test('operator guard refuses before options/configuration access',()=>{
  const script=`import assert from 'node:assert/strict';import {registryCodexStep} from ${JSON.stringify(new URL('../src/registry-codex-step.mjs',import.meta.url).href)};let reads=0;const options=new Proxy({}, {get(){reads++;throw Error('accessed');}});await assert.rejects(registryCodexStep(null,options),e=>e.code==='OPERATOR_HOST_REQUIRED');assert.equal(reads,0);console.log('guard-pass');`;
  const r=spawnSync(process.execPath,['--input-type=module','-e',script],{env:{...process.env,AI_AGENT:'new-negative-fixture'},encoding:'utf8'});
  assert.equal(r.status,0,r.stderr);assert.equal(r.stdout.trim(),'guard-pass');
});

test('operator identity and call policy reject caller fallback, secrets and ignored options',()=>{
  const identity={kind:'codex',executable:'/fresh/fixture',model:'fixture',payerScope:'local-cli'};
  for(const delta of [{kind:'caller'},{apiKey:'synthetic-secret'},{model:'bad model'},{executable:'relative'},{payerScope:'api'}])assert.throws(()=>validateOperatorCodexProvider({...identity,...delta}));
  const config={provider:'codex',instructions:'fixture',retries:'0',timeoutSec:'5',format:'json'};
  for(const delta of [{retries:'1'},{timeoutSec:'0'},{timeoutSec:'301'},{model:'other'},{maxTokens:'10'},{format:'xml'}])assert.throws(()=>operatorCodexPolicy({...config,...delta}));
});

test('explicit YAML/operator provider completes actual Core step with unknown USD and persisted identity',t=>{
  const f=fresh(t),r=f.run();assert.equal(r.status,0,r.stderr+r.stdout);const run=JSON.parse(r.stdout);
  assert.equal(run.status,'success');assert.equal(run.steps[0].provider.kind,'codex');assert.equal(run.steps[0].provider.model,null);
  assert.equal(run.steps[0].provider.requestedModel,'fixture');assert.equal(run.steps[0].output.summary,'Implement addition');
  assert.equal(run.costUsd,null);assert.equal(run.tokensIn,10);assert.equal(run.tokensOut,5);
  assert.equal(run.operatorCodexProvider.executable,f.executable);assert.equal(run.pendingInference,undefined);
  assert.equal(readFileSync(f.trace,'utf8').trim().split('\n').length,3);
  const status=f.invoke(['status',f.manifest,'--json']);assert.equal(status.status,0,status.stderr);assert.ok(status.stdout.includes(run.runId));
});

test('operator model gets isolated environment without publication/signing secrets',t=>{
  const f=fresh(t,{model:'inspect'}),r=f.run();assert.equal(r.status,0,r.stderr+r.stdout);const output=JSON.parse(r.stdout).steps[0].output;
  assert.equal(output.env.GF_NATIVE_PROVIDER_TOKEN,undefined);assert.notEqual(output.cwd,f.dir);assert.equal(existsSync(output.cwd),false);
  assert.ok(output.args.includes('read-only'));assert.ok(output.args.includes('--ignore-user-config'));assert.ok(output.args.includes('plugins'));
});

test('agent-origin YAML invocation refuses before executable probes',t=>{
  const f=fresh(t),r=f.run({AI_AGENT:'new-negative-fixture'});assert.equal(r.status,1,r.stderr+r.stdout);assert.match(JSON.parse(r.stdout).summary,/independent operator host/);assert.equal(existsSync(f.trace),false);
});

test('USD ceiling refuses unknown subscription usage before executable probes',t=>{
  const f=fresh(t,{budget:'1'}),r=f.run();assert.equal(r.status,1,r.stderr+r.stdout);assert.match(JSON.parse(r.stdout).summary,/cost is unknown/);assert.equal(existsSync(f.trace),false);
});

test('invalid retry/config fails validation without a probe',t=>{
  const f=fresh(t,{config:'      maxTokens: 10\n'}),r=f.run();assert.equal(r.status,1,r.stderr+r.stdout);assert.match(r.stderr+r.stdout,/operator Codex/);assert.equal(existsSync(f.trace),false);
});

for(const model of ['auth','denied','invalid'])test(`operator ${model} holds failed result, unknown cost and no retry/fallback`,t=>{
  const f=fresh(t,{model}),r=f.run();assert.equal(r.status,1,r.stderr+r.stdout);const run=JSON.parse(r.stdout);
  assert.equal(run.status,'failed');assert.equal(run.costUsd,null);assert.equal(run.steps[0].costUsd,null);assert.equal(run.steps[0].output,null);
  assert.equal(readFileSync(f.trace,'utf8').trim().split('\n').length,3);assert.equal(JSON.stringify(run).includes('secret-do-not-expose'),false);
});

test('model result reaches ordinary human gate but never decides it',t=>{
  const f=fresh(t,{after:'  - id: review\n    kind: approval-gate\n    config:\n      reviewer: human\n      bind: sha256\n'}),r=f.run();assert.equal(r.status,2,r.stderr+r.stdout);const run=JSON.parse(r.stdout);
  assert.equal(run.status,'waiting_human');assert.equal(run.steps[0].status,'success');assert.equal(run.steps[1].status,'waiting_human');assert.equal(run.costUsd,null);
});

test('dry-run validates call limits without executing operator CLI',t=>{
  const f=fresh(t),r=f.invoke(['run',f.manifest,'--operator-codex-provider',f.provider,'--json','--dry-run'],{AI_AGENT:'new-negative-dry-run'});
  assert.equal(r.status,0,r.stderr+r.stdout);const run=JSON.parse(r.stdout);assert.equal(run.steps[0].status,'planned');assert.equal(run.steps[0].output.retries,0);assert.equal(existsSync(f.trace),false);
});

test('missing concrete store refuses before executable probes',t=>{
  const f=fresh(t);
  const script=`import assert from 'node:assert/strict';import {loadManifest} from ${JSON.stringify(new URL('../src/manifest.mjs',import.meta.url).href)};import {createRun,driveRun,resolveKnobs} from ${JSON.stringify(new URL('../src/run.mjs',import.meta.url).href)};import {readFileSync,existsSync} from 'node:fs';const [manifest,provider,trace]=process.argv.slice(1);const m=loadManifest(manifest),run=createRun(m);const result=await driveRun(run,{knobs:resolveKnobs(m.settings),operatorCodexProvider:JSON.parse(readFileSync(provider))});assert.equal(result.status,'failed');assert.match(result.summary,/concrete durable RunStore/);assert.equal(existsSync(trace),false);console.log('missing-store-pass');`;
  const r=spawnSync(process.execPath,['--input-type=module','-e',script,f.manifest,f.provider,f.trace],{env:{PATH:process.env.PATH},cwd:f.dir,encoding:'utf8',timeout:15000});
  assert.equal(r.status,0,r.stderr+r.stdout);assert.equal(r.stdout.trim(),'missing-store-pass');
});

for(const faultAt of [1,2,3,4])test(`actual RunStore fsync failure ${faultAt} stops before executable probes`,t=>{
  const f=fresh(t);
  const script=`import assert from 'node:assert/strict';import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';let calls=0;const original=fs.fsyncSync;fs.fsyncSync=fd=>{calls++;if(calls===${faultAt})throw Object.assign(Error('new-fixture-fsync-EIO'),{code:'EIO'});return original(fd);};syncBuiltinESMExports();const {loadManifest}=await import(${JSON.stringify(new URL('../src/manifest.mjs',import.meta.url).href)});const {createRun,driveRun,resolveKnobs,RunStore}=await import(${JSON.stringify(new URL('../src/run.mjs',import.meta.url).href)});const [manifest,provider,trace]=process.argv.slice(1);const m=loadManifest(manifest),run=createRun(m),store=new RunStore(manifest);const result=await driveRun(run,{store,knobs:resolveKnobs(m.settings),operatorCodexProvider:JSON.parse(fs.readFileSync(provider))});assert.equal(result.status,'failed');assert.equal(fs.existsSync(trace),false);assert.ok(calls>=${faultAt});assert.equal(result.costUsd,null);console.log('fsync-fault-pass');`;
  const r=spawnSync(process.execPath,['--input-type=module','-e',script,f.manifest,f.provider,f.trace],{env:{PATH:process.env.PATH},cwd:f.dir,encoding:'utf8',timeout:15000});
  assert.equal(r.status,0,r.stderr+r.stdout);assert.equal(r.stdout.trim(),'fsync-fault-pass');
});

test('persisted provider cannot be replaced by options',t=>{
  const f=fresh(t);
  const script=`import assert from 'node:assert/strict';import {loadManifest} from ${JSON.stringify(new URL('../src/manifest.mjs',import.meta.url).href)};import {createRun,driveRun,resolveKnobs,RunStore} from ${JSON.stringify(new URL('../src/run.mjs',import.meta.url).href)};import {readFileSync,existsSync} from 'node:fs';const [manifest,provider,trace]=process.argv.slice(1);const m=loadManifest(manifest),run=createRun(m),store=new RunStore(manifest),identity=JSON.parse(readFileSync(provider));run.operatorCodexProvider=identity;store.save(run);const result=await driveRun(store.load(run.runId),{store,knobs:resolveKnobs(m.settings),operatorCodexProvider:{...identity,model:'inspect'}});assert.equal(result.status,'failed');assert.match(result.summary,/identity changed/);assert.equal(existsSync(trace),false);assert.deepEqual(store.load(run.runId).operatorCodexProvider,identity);console.log('provider-binding-pass');`;
  const r=spawnSync(process.execPath,['--input-type=module','-e',script,f.manifest,f.provider,f.trace],{env:{PATH:process.env.PATH},cwd:f.dir,encoding:'utf8',timeout:15000});
  assert.equal(r.status,0,r.stderr+r.stdout);assert.equal(r.stdout.trim(),'provider-binding-pass');
});

test('library invocation binds provider once and flushes file plus directories before success',t=>{
  const f=fresh(t);
  const script=`import assert from 'node:assert/strict';import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';let flushes=0;const original=fs.fsyncSync;fs.fsyncSync=fd=>{flushes++;return original(fd);};syncBuiltinESMExports();const {loadManifest}=await import(${JSON.stringify(new URL('../src/manifest.mjs',import.meta.url).href)});const {createRun,driveRun,resolveKnobs,RunStore}=await import(${JSON.stringify(new URL('../src/run.mjs',import.meta.url).href)});const [manifest,provider,trace]=process.argv.slice(1);const m=loadManifest(manifest),run=createRun(m),store=new RunStore(manifest),identity=JSON.parse(fs.readFileSync(provider));const result=await driveRun(run,{store,knobs:resolveKnobs(m.settings),operatorCodexProvider:identity});assert.equal(result.status,'success');assert.deepEqual(store.load(run.runId).operatorCodexProvider,identity);assert.ok(flushes>=4);assert.equal(result.steps[0].provider.requestedModel,identity.model);console.log('durable-identity-pass');`;
  const r=spawnSync(process.execPath,['--input-type=module','-e',script,f.manifest,f.provider,f.trace],{env:{PATH:process.env.PATH},cwd:f.dir,encoding:'utf8',timeout:15000});
  assert.equal(r.status,0,r.stderr+r.stdout);assert.equal(r.stdout.trim(),'durable-identity-pass');
});

test('interrupted native model row holds without repeating inference',t=>{
  const f=fresh(t);
  const script=`import assert from 'node:assert/strict';import {loadManifest} from ${JSON.stringify(new URL('../src/manifest.mjs',import.meta.url).href)};import {createRun,driveRun,resolveKnobs} from ${JSON.stringify(new URL('../src/run.mjs',import.meta.url).href)};import {readFileSync,existsSync} from 'node:fs';const [manifest,provider,trace]=process.argv.slice(1);const m=loadManifest(manifest),run=createRun(m);run.steps[0].status='running';run.steps[0].costUsd=null;run.costUsd=null;const result=await driveRun(run,{knobs:resolveKnobs(m.settings),operatorCodexProvider:JSON.parse(readFileSync(provider))});assert.equal(result.status,'needs_human');assert.equal(existsSync(trace),false);assert.equal(result.costUsd,null);console.log('interruption-pass');`;
  const r=spawnSync(process.execPath,['--input-type=module','-e',script,f.manifest,f.provider,f.trace],{env:{PATH:process.env.PATH},cwd:f.dir,encoding:'utf8',timeout:15000});
  assert.equal(r.status,0,r.stderr+r.stdout);assert.equal(r.stdout.trim(),'interruption-pass');
});

test('deadline stops a hanging model with unknown cost and no retry',t=>{
  const f=fresh(t,{model:'timeout'});const start=Date.now(),r=f.run();assert.equal(r.status,1,r.stderr+r.stdout);const run=JSON.parse(r.stdout);
  assert.equal(run.status,'failed');assert.equal(run.costUsd,null);assert.ok(Date.now()-start<12000);assert.equal(readFileSync(f.trace,'utf8').trim().split('\n').length,3);
});
