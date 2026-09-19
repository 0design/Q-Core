import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:http';
import {createLocalHost,cronMatches} from '../src/host.mjs';
import {hash} from '../src/contracts.mjs';

test('cron uses UTC, ranges/steps, Sunday alias and conventional day OR; invalid stride refuses',()=>{
  assert.equal(cronMatches('*/5 9 * * 1-5',new Date('2026-09-21T09:10:00Z')),true);
  assert.equal(cronMatches('*/5 9 * * 1-5',new Date('2026-09-21T09:11:00Z')),false);
  assert.equal(cronMatches('0 9 1 * 7',new Date('2026-09-20T09:00:00Z')),true);
  assert.throws(()=>cronMatches('*/0 * * * *',new Date()),/positive/);
  assert.throws(()=>cronMatches('8-2 * * * *',new Date()),/ascend/);
});

test('real local manual/schedule/webhook run records receipts; replay/auth/tampering refuse',async t=>{
  const root=mkdtempSync(join(tmpdir(),'qf-host-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  let calls=0;const source=createServer((req,res)=>{calls++;res.end('host result');});
  await new Promise(r=>source.listen(0,'127.0.0.1',r));t.after(()=>source.close());
  const file=join(root,'loop.yaml');
  writeFileSync(file,`manifest: qloops.loop/v1\nid: hosted-test\nname: Host acceptance\nversion: 1.0.0\nowner: test\nenabled: true\ntriggers:\n  - kind: manual\n  - kind: webhook\n  - kind: schedule\n    cron: "* * * * *"\nsteps:\n  - id: read\n    kind: fetch\n    config:\n      url: "http://127.0.0.1:${source.address().port}/"\n      format: text\n`);
  const config={manifest:file,manifestSha256:hash(readFileSync(file))};
  const host=createLocalHost(config);
  assert.equal((await host.dispatch('manual','first')).status,'success');
  assert.equal((await createLocalHost(config).dispatch('manual','first')).duplicate,true);
  assert.equal(calls,1);
  assert.equal((await host.tick(new Date('2026-09-21T09:10:00Z'))).status,'success');
  assert.equal((await host.tick(new Date('2026-09-21T09:10:59Z'))).duplicate,true);
  const token='a'.repeat(32),server=host.webhookServer(token);
  await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>server.close());
  const url=`http://127.0.0.1:${server.address().port}/trigger`;
  assert.equal((await fetch(url,{method:'POST'})).status,401);
  const options={method:'POST',headers:{authorization:`Bearer ${token}`,'x-qfactory-event-id':'network-event'},body:'ignored'};
  assert.equal((await (await fetch(url,options)).json()).status,'success');
  assert.equal((await (await fetch(url,options)).json()).duplicate,true);
  assert.equal(calls,3);
  writeFileSync(file,readFileSync(file,'utf8')+'\n# modified\n');
  await assert.rejects(host.dispatch('manual','second'),/Manifest changed/);
});

test('waiting approval blocks later host events and is never implicitly approved',async t=>{
  const root=mkdtempSync(join(tmpdir(),'qf-host-gate-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  const file=join(root,'loop.yaml');
  writeFileSync(file,'manifest: qloops.loop/v1\nid: host-gate\nname: Host gate\nversion: 1.0.0\nowner: test\nenabled: true\ntriggers:\n  - kind: manual\nsteps:\n  - id: approval\n    kind: approval-gate\n    config:\n      mode: human\n');
  const host=createLocalHost({manifest:file,manifestSha256:hash(readFileSync(file))});
  assert.equal((await host.dispatch('manual','first')).status,'waiting_human');
  await assert.rejects(host.dispatch('manual','second'),/still active or waiting/);
});
