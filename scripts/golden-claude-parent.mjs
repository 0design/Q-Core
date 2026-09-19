// Live parent-agent acceptance harness. It supplies no QFactory implementation
// hints: initial text is copied byte-for-byte from the Site candidate; subsequent
// inputs are explicit synthetic owner decisions reviewed by the supervising agent.
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, appendFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { hash } from '../src/contracts.mjs';
import { scopedEnvironment } from '../src/subprocess.mjs';
const mode=process.argv[2], reply=process.argv[3];
if(!['start','use','customize','create'].includes(mode)) throw Error('Explicit entry required');
const caseName=process.env.QF_GOLDEN_CASE??mode+'-claude';
if(caseName!==mode&&!new RegExp('^'+mode+'-[a-z0-9-]+$').test(caseName)) throw Error('Invalid case name');
const root=resolve('.'), evidence=resolve('docs/delivery/golden-parent',caseName);
const workspace=resolve('.qf/golden-parent',caseName);
mkdirSync(evidence,{recursive:true});mkdirSync(workspace,{recursive:true});
const stateFile=join(evidence,'session.json');
const prior=existsSync(stateFile)?JSON.parse(readFileSync(stateFile)):null;
if(prior&&!reply) throw Error('Existing session: supply explicit reply file');
if(!prior&&reply) throw Error('Initial run must use unmodified Site prompt');
const source=resolve(process.env.QF_GOLDEN_PROMPTS??'/Users/oleg.design/PORN/projects/QFactory.io/repo/QFactory.io/docs/delivery/golden-path-2026-09-10');
const prompt=readFileSync(reply?resolve(reply):join(source,mode+'.txt'),'utf8');
if(!prior){
  const pins=JSON.parse(readFileSync(join(source,'prompts.json')));
  if(pins.entries.find(e=>e.mode===mode)?.sha256!==hash(prompt)) throw Error('Prompt hash mismatch');
}
const turn=prior?prior.turn+1:0;
writeFileSync(join(evidence,`${turn}-input.txt`),prompt);
const dev='This is a controlled synthetic acceptance session in the current workspace only. Fetch QFactory material through the supplied HTTP origin, never sibling source or other sessions. Preserve existing files. No credential reads, public sends, purchases, deployments, remote Git mutations, permission bypass, subagents, or nested model CLI. Existing authenticated Claude caller inference is authorized; exact spec and publication approval require a separate synthetic owner reply. Ask genuine missing questions and stop. Do not fabricate evidence. Your actual caller agent is Claude; unknown model identity must remain current-session/null in Core. Only bounded local test effects are authorized.';
const settings={disableAllHooks:true,autoMemoryEnabled:false,claudeMdExcludes:['**/CLAUDE.md','**/CLAUDE.local.md','**/.claude/rules/**'],sandbox:{enabled:true,autoAllowBashIfSandboxed:true,network:{allowedDomains:['localhost','127.0.0.1']}}};
const args=['--print',...(prior?['--resume',prior.threadId]:[]),'--output-format','stream-json','--verbose','--setting-sources','','--settings',JSON.stringify(settings),'--strict-mcp-config','--mcp-config','{"mcpServers":{}}','--disable-slash-commands','--no-chrome','--permission-mode','dontAsk','--tools','Bash,Read,Write,Edit,Glob,Grep','--allowedTools','Bash,Read,Write,Edit,Glob,Grep','--append-system-prompt',dev];
const out=join(evidence,`${turn}-events.jsonl`),err=join(evidence,`${turn}-stderr.txt`);
writeFileSync(out,'');writeFileSync(err,'');
const child=spawn('/usr/local/bin/claude',args,{cwd:workspace,env:scopedEnvironment(),shell:false,detached:true,stdio:['pipe','pipe','pipe']});
let timedOut=false,bytes=0;
const kill=()=>{try{process.kill(-child.pid,'SIGTERM');}catch{}setTimeout(()=>{try{process.kill(-child.pid,'SIGKILL');}catch{}},300);};
const timer=setTimeout(()=>{timedOut=true;kill();},300000);
child.stdout.on('data',x=>{bytes+=x.length;if(bytes>8000000)kill();else appendFileSync(out,x);});
child.stderr.on('data',x=>appendFileSync(err,x));
child.stdin.on('error',()=>{});child.stdin.end(prompt);
const exit=await new Promise((res,rej)=>{child.on('error',rej);child.on('close',res);});clearTimeout(timer);
const events=readFileSync(out,'utf8').split('\n').filter(Boolean).flatMap(x=>{try{return[JSON.parse(x)];}catch{return[];}});
const threadId=events.find(e=>e.session_id)?.session_id??prior?.threadId;
const result=events.findLast(e=>e.type==='result');
const last=result?.result??events.filter(e=>e.type==='assistant').flatMap(e=>e.message?.content??[]).filter(c=>c.type==='text').map(c=>c.text).join('\n');
writeFileSync(join(evidence,`${turn}-response.md`),last);
writeFileSync(stateFile,JSON.stringify({mode,turn,threadId,workspace,date:new Date().toISOString(),exit,timedOut,promptSha256:hash(prompt),initialPromptSha256:prior?.initialPromptSha256??hash(prompt),environment:'Claude Code2.1.156; explicit allowed local test tools; sandbox enabled, dontAsk; no user/project settings/hooks/MCP/skills/auto-memory; existing claude.ai subscription auth; actual model from CLI event only',reportedModel:events.find(e=>e.type==='system'&&e.subtype==='init')?.model??null,resultSubtype:result?.subtype??null,isError:result?.is_error??null},null,2)+'\n');
console.log(JSON.stringify({mode,turn,threadId,exit,timedOut,last}));
