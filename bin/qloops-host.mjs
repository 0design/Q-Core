#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { createLocalHost } from '../src/host.mjs';
const [mode,file,eventId]=process.argv.slice(2);
try {
  if(!['manual','schedule','webhook'].includes(mode)||!file) throw Error('Usage: qloops-host <manual|schedule|webhook> <config.json> [manual-event-id]');
  const host=createLocalHost(JSON.parse(readFileSync(file,'utf8')));
  const report=result=>{if(result)process.stdout.write(JSON.stringify(result)+'\n');};
  if(mode==='manual') report(await host.dispatch(mode,eventId));
  if(mode==='schedule') {
    let running=false;
    const tick=async()=>{if(running)return;running=true;try{report(await host.tick());}catch(e){process.stderr.write(e.message+'\n');}finally{running=false;}};
    await tick();const timer=setInterval(tick,1000);
    for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>clearInterval(timer));
  }
  if(mode==='webhook') {
    const server=host.webhookServer(process.env.QF_HOST_WEBHOOK_TOKEN);
    const port=Number(process.env.QF_HOST_PORT??8789);
    if(!Number.isInteger(port)||port<0||port>65535)throw Error('Invalid local port');
    server.listen(port,'127.0.0.1',()=>report({listening:`http://127.0.0.1:${server.address().port}/trigger`}));
    for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>server.close());
  }
} catch(e){process.stderr.write(e.message+'\n');process.exitCode=1;}
