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
const caseName=process.env.QF_GOLDEN_CASE??mode;
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
const dev='This is a controlled synthetic acceptance session. Work only in your current workspace. Read QFactory material via the user-provided HTTP origin, never neighboring project source or other sessions. Preserve existing files. Do not read or print credentials. No public sends, purchases, deployments, remote Git mutations, or permissions/nesting bypass. Existing authenticated Codex inference is authorized, but exact text publication and specification approval require the explicit synthetic owner response. Ask genuine missing questions and stop for the answer. Do not fabricate evidence. No subagents. Use shell tools for local HTTP access; unrelated apps, plugins and hooks are disabled. Your explicit model is gpt-5.6-luna and configured executable is /Applications/ChatGPT.app/Contents/Resources/codex. Do not use an unrelated global CLI.';
const config=['model_provider="openai"','forced_login_method="chatgpt"','approval_policy="never"','sandbox_mode="workspace-write"','sandbox_workspace_write.network_access=true','web_search="disabled"','project_doc_max_bytes=0','skills.include_instructions=false','include_apps_instructions=false','model_reasoning_effort="medium"','developer_instructions='+JSON.stringify(dev)];
const disabled=['apps','plugins','hooks','multi_agent','multi_agent_v2','browser_use','browser_use_external','computer_use','in_app_browser','image_generation','memories','skill_search','skill_mcp_dependency_install','tool_suggest','workspace_dependencies','goals','request_permissions_tool','enable_mcp_apps'];
const args=['exec',...(prior?['resume',prior.threadId]:[]),'--json','--ignore-user-config','--skip-git-repo-check','--model','gpt-5.6-luna',...config.flatMap(x=>['-c',x]),...disabled.flatMap(x=>['--disable',x]),'-'];
const out=join(evidence,`${turn}-events.jsonl`),err=join(evidence,`${turn}-stderr.txt`);
writeFileSync(out,'');writeFileSync(err,'');
const child=spawn('/Applications/ChatGPT.app/Contents/Resources/codex',args,{cwd:workspace,env:scopedEnvironment(),shell:false,detached:true,stdio:['pipe','pipe','pipe']});
let timedOut=false,bytes=0;
const kill=()=>{try{process.kill(-child.pid,'SIGTERM');}catch{}setTimeout(()=>{try{process.kill(-child.pid,'SIGKILL');}catch{}},300);};
const timer=setTimeout(()=>{timedOut=true;kill();},300000);
child.stdout.on('data',x=>{bytes+=x.length;if(bytes>8000000)kill();else appendFileSync(out,x);});
child.stderr.on('data',x=>appendFileSync(err,x));
child.stdin.on('error',()=>{});child.stdin.end(prompt);
const exit=await new Promise((res,rej)=>{child.on('error',rej);child.on('close',res);});clearTimeout(timer);
const events=readFileSync(out,'utf8').split('\n').filter(Boolean).flatMap(x=>{try{return[JSON.parse(x)];}catch{return[];}});
const threadId=events.find(e=>e.type==='thread.started')?.thread_id??prior?.threadId;
const last=events.filter(e=>e.type==='item.completed'&&e.item?.type==='agent_message').at(-1)?.item.text??'';
writeFileSync(join(evidence,`${turn}-response.md`),last);
writeFileSync(stateFile,JSON.stringify({mode,turn,threadId,workspace,date:new Date().toISOString(),exit,timedOut,promptSha256:hash(prompt),initialPromptSha256:prior?.initialPromptSha256??hash(prompt),environment:'Codex CLI0.153.4; workspace-write + local/network access, no user config/hooks/apps; existing ChatGPT auth, gpt-5.6-luna; ordinary policy rules retained'},null,2)+'\n');
console.log(JSON.stringify({mode,turn,threadId,exit,timedOut,last}));
