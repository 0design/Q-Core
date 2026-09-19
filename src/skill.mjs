/** A pinned authored skill is accepted only through its explicit criteria contract. */
import { readFileSync, lstatSync, realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { hash, insist } from './contracts.mjs';
import { determined } from './determined.mjs';
import { scopedPath, snapshot, contextFiles, applyFiles, lockWorkspace } from './workspace.mjs';
import { subprocess, scopedEnvironment } from './subprocess.mjs';

function bytes(file) { const s=lstatSync(file); insist(s.isFile()&&!s.isSymbolicLink()&&s.size<=128000,'Skill inputs must be bounded regular files'); return readFileSync(file); }
export function loadSkill({file,sha256}) {
  insist(typeof file==='string'&&/^[a-f0-9]{64}$/.test(sha256),'Pinned skill contract required');
  const contractFile=realpathSync(file),root=dirname(contractFile),body=bytes(file);
  insist(hash(body)===sha256,'Skill contract pin mismatch');
  const contract=JSON.parse(body);
  insist(contract.schema==='qf.skill/v1'&&typeof contract.id==='string'&&/^[a-z0-9-]{1,100}$/.test(contract.id)&&typeof contract.version==='string'&&contract.version.length<=100,'Invalid skill identity');
  insist(Object.keys(contract).every(k=>['schema','id','version','instructions','criteria'].includes(k)),'Unsupported skill fields');
  const sources={[contractFile]:sha256};
  function pinned(p){insist(p&&typeof p.file==='string'&&/^[a-f0-9]{64}$/.test(p.sha256),'Pinned skill source required');const path=scopedPath(root,p.file),b=bytes(path);insist(hash(b)===p.sha256,'Skill source pin mismatch');sources[path]=p.sha256;return {path,body:b};}
  const instructions=pinned(contract.instructions).body.toString('utf8');
  insist(instructions.trim()&&instructions.length<=32000,'Bounded skill instructions required');
  insist(Array.isArray(contract.criteria)&&contract.criteria.length>0&&contract.criteria.length<=100,'Required criteria must be explicit');
  const ids=new Set();
  const criteria=contract.criteria.map(c=>{
    insist(c&&Object.keys(c).every(k=>['id','rule','verifier'].includes(k))&&typeof c.id==='string'&&/^[a-z0-9-]{1,100}$/.test(c.id)&&!ids.has(c.id),'Unique criterion IDs required');ids.add(c.id);
    insist(typeof c.rule==='string'&&c.rule.trim()&&c.rule.length<=2000,'Criterion rule required');
    insist(c.verifier&&['node','human'].includes(c.verifier.type),'Rule needs a machine verifier or explicit human review');
    if(c.verifier.type==='human'){insist(Object.keys(c.verifier).length===1,'Human verifier accepts no executable');return structuredClone(c);}
    insist(Object.keys(c.verifier).every(k=>['type','file','sha256','args','timeoutMs'].includes(k)),'Unsupported verifier fields');
    const source=pinned(c.verifier);
    insist(Array.isArray(c.verifier.args)&&c.verifier.args.length<=20&&c.verifier.args.every(a=>typeof a==='string'&&a.length<=2000),'Bounded verifier args required');
    insist(Number.isInteger(c.verifier.timeoutMs)&&c.verifier.timeoutMs>0&&c.verifier.timeoutMs<=30000,'Verifier timeout must be 1..30000ms');
    return {...structuredClone(c),verifier:{...c.verifier,file:source.path}};
  });
  return {id:contract.id,version:contract.version,sha256,root,instructions,criteria,sources};
}

/** propose returns files, never evidence. Its implementation is a trusted caller. */
export async function runSkill(request,{propose}={}) {
  insist(request&&Object.keys(request).every(k=>['skill','workspace','allowedPaths','maxRepairAttempts','approval','signal'].includes(k)),'Unsupported skill request');
  const skill=loadSkill(request.skill), workspace=realpathSync(request.workspace), paths=structuredClone(request.allowedPaths);
  insist(Array.isArray(paths)&&paths.length>0&&paths.length<=30&&new Set(paths).size===paths.length&&paths.every(p=>typeof p==='string'),'Unique scoped artifact paths required');
  for(const path of paths){const file=scopedPath(workspace,path);insist(!Object.hasOwn(skill.sources,file),'Skill/verifier files cannot be writable artifacts');}
  insist(propose===undefined||typeof propose==='function','Invalid skill caller');
  const approval=request.approval?structuredClone(request.approval):null;
  if(approval)insist(Object.keys(approval).sort().join(',')==='decision,hash'&&['approve','reject'].includes(approval.decision)&&/^[a-f0-9]{64}$/.test(approval.hash),'Explicit version-bound human decision required');
  const lock=lockWorkspace(workspace);
  let revision=0,lastHash=hash(snapshot(workspace,paths));
  const fresh=()=>{for(const [file,sha]of Object.entries(skill.sources))insist(hash(bytes(file))===sha,'Pinned skill or verifier changed');};
  const artifact=()=>{fresh();const sha256=hash(snapshot(workspace,paths));if(sha256!==lastHash){revision++;lastHash=sha256;}return {sha256,revision};};
  const binding=artifactHash=>hash({skill:skill.sha256,workspace,paths,artifactHash});
  let humanRejected=false;
  try {
    const result=await determined({criteria:skill.criteria.map(c=>({...c,verifier:{...c.verifier,type:c.verifier.type==='human'?'human-approval':'node'}})),maxRepairAttempts:request.maxRepairAttempts??0,signal:request.signal},{
      execute:async({attempt,previous,signal})=>{
        fresh();if(!propose)return;
        const before=snapshot(workspace,paths);
        const proposal=await propose({attempt,previous,signal,skill:{id:skill.id,version:skill.version,sha256:skill.sha256,instructions:skill.instructions},criteria:structuredClone(skill.criteria),files:contextFiles(workspace,paths)});
        fresh();insist(proposal&&Object.keys(proposal).join(',')==='files','Skill caller may return files only, never completion/evidence');
        applyFiles(workspace,paths,proposal.files,before);
      },
      getArtifact:async()=>artifact(),
      verify:async({criterion,artifact:current,signal})=>{
        fresh();let outcome;
        if(criterion.verifier.type==='human-approval'){
          if(approval?.hash===binding(current.sha256)){humanRejected=approval.decision==='reject';outcome=humanRejected?'unknown':'pass';}else outcome='unknown';
        }else{
          const v=criterion.verifier;const check=await subprocess(process.execPath,[v.file,...v.args],{cwd:workspace,env:scopedEnvironment(),timeoutMs:v.timeoutMs,maxBytes:16000,signal});
          fresh();outcome=check.code===0?'pass':'fail';
        }
        return {outcome,artifactHash:current.sha256,revision:current.revision};
      },
    });
    const current=artifact();
    const humanRules=skill.criteria.filter(c=>c.verifier.type==='human').map(c=>({id:c.id,rule:c.rule}));
    return {...result,skill:{id:skill.id,version:skill.version,sha256:skill.sha256},artifact:current,accepted:result.status==='success',...(result.status==='needs_human'&&humanRules.length?{nextAction:{type:humanRejected?'rejected':'review_skill_artifact',hash:binding(current.sha256),criteria:humanRules,artifactHash:current.sha256}}:{})};
  } finally {lock.release();}
}
