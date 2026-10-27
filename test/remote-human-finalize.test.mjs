import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const fixture=fileURLToPath(new URL('./fixtures/remote-human-finalize-case.mjs',import.meta.url));
for(const scenario of ['before-stop','after-stop','after-lease','after-publish','after-archive','interrupted-finalizer','live-owner','mutations','confirmation','concurrent','expired','consumed-effect','guard']){
 test(`finish interrupted human STOP in a new disposable fixture: ${scenario}`,()=>{
  const child=spawnSync(process.execPath,[fixture,scenario],{env:{PATH:process.env.PATH,...(scenario==='guard'?{AI_AGENT:'new-disposable-refusal'}:{})},encoding:'utf8',timeout:25000});
  assert.equal(child.status,0,child.stderr||child.stdout||child.error?.message);const value=JSON.parse(child.stdout);
  assert.equal(value.passed,true);assert.ok(value.probes>=3);assert.equal(value.real_social_posted,false);
 });
}
