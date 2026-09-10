import { createServer } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
const dir=resolve('docs/delivery/golden-parent/receiver');mkdirSync(dir,{recursive:true});
const events=[],receipts=new Map();
const save=()=>writeFileSync(join(dir,'events.json'),JSON.stringify(events,null,2)+'\n');
const server=createServer(async(req,res)=>{
  events.push({method:req.method,url:req.url,date:new Date().toISOString()});save();
  res.setHeader('Content-Type','application/json');
  if(req.method==='GET'){
    if(req.url==='/fail'){res.writeHead(422);return res.end(JSON.stringify({error:'synthetic negative case'}));}
    if(req.url==='/health')return res.end(JSON.stringify({status:'ready',synthetic:true}));
    if(req.url==='/data')return res.end(JSON.stringify({project:'synthetic-qf',items:[1,2,3],total:6}));
    if(req.url==='/source/1'){res.setHeader('Content-Type','text/plain');return res.end('SYNTHETIC TEST NEWS: The fictional Orchard team added three independent checks to its local release process. This is authored test data, not real news or owner editorial input.');}
    res.writeHead(404);return res.end('{}');
  }
  if(req.method==='POST'&&req.url==='/receipt'){
    let body='';for await(const part of req)body+=part;
    const value=JSON.parse(body),key=req.headers['idempotency-key'];
    if(!key||typeof value.text!=='string'){res.writeHead(400);return res.end('{}');}
    if(!receipts.has(key))receipts.set(key,{id:'synthetic-'+(receipts.size+1),delivered:true});
    const receipt=receipts.get(key);events.at(-1).delivery={text:value.text,idempotencyKey:key,receipt};save();
    return res.end(JSON.stringify(receipt));
  }
  res.writeHead(405);res.end('{}');
});
server.listen(0,'127.0.0.1',()=>{const origin=`http://127.0.0.1:${server.address().port}`;writeFileSync(join(dir,'server.json'),JSON.stringify({origin,pid:process.pid,synthetic:true})+'\n');console.log(origin);});
process.on('SIGTERM',()=>server.close(()=>process.exit(0)));
