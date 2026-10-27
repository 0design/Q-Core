import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const fixture=fileURLToPath(new URL('./fixtures/remote-human-recovery-case.mjs',import.meta.url));
for(const scenario of ['requested','consumed','running','held','expired','guard','mutations','tty','faults','stopped-mutations']){
  test(`human STOP on a fresh disposable interrupted run: ${scenario}`,()=>{
    const child=spawnSync(process.execPath,[fixture,scenario],{env:{PATH:process.env.PATH,...(scenario==='guard'?{AI_AGENT:'disposable-negative-fixture'}:{})},encoding:'utf8',timeout:20000});
    assert.equal(child.status,0,child.stderr||child.error?.message);const value=JSON.parse(child.stdout);
    assert.equal(value.passed,true);assert.ok(value.probes>=3);assert.equal(value.real_social_posted,false);
  });
}
