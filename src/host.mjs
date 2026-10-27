import { assertPersistencePath, guardedWriteFileSync, registerPersistenceSecret, guardedMkdirSync, guardedRenameSync, guardedUnlinkSync } from './persistence.mjs';
/** Explicit local host for installed workflows. No daemon installation or remote shell. */
import { readFileSync, lstatSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { assertCron } from './manifest.mjs';
import { loadWorkflow as loadManifest } from './workflow-policy.mjs';
import { createRun, driveRun, resolveKnobs } from './run.mjs';
import { RunStore } from './state.mjs';
import { hash, insist } from './contracts.mjs';
import { validateCallerInput } from './caller-inference.mjs';
import { validateWorkspacePolicy } from './registry-workspace-steps.mjs';
import { withWorkflowLease } from './workflow-lease.mjs';
import { bindInputs } from './material-io.mjs';

function jsonInputs(value) {
  let nodes = 0;
  const visit = (v, depth = 0) => {
    insist(++nodes <= 50000 && depth <= 20, 'Host inputs exceed JSON bounds');
    if (v === null || typeof v === 'string' || typeof v === 'boolean') return v;
    if (typeof v === 'number') { insist(Number.isFinite(v), 'Host inputs require finite JSON numbers'); return v; }
    insist(v && typeof v === 'object' && (Array.isArray(v) || [Object.prototype, null].includes(Object.getPrototypeOf(v))), 'Host inputs must be JSON data');
    insist(!Object.getOwnPropertySymbols(v).length, 'Host inputs cannot contain symbol fields');
    const keys = Object.keys(v), result = Array.isArray(v) ? [] : Object.create(null);
    if (Array.isArray(v)) insist(keys.length === v.length && keys.every((k, i) => k === String(i)), 'Host input arrays must be dense JSON arrays');
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(v, key);
      insist(descriptor && Object.hasOwn(descriptor, 'value'), 'Host inputs cannot contain getters');
      result[key] = visit(descriptor.value, depth + 1);
    }
    return result;
  };
  const body = JSON.stringify(visit(value));
  insist(Buffer.byteLength(body) <= 1048576, 'Host inputs exceed one MiB');
  return JSON.parse(body);
}

export function cronMatches(expression, date) {
  assertCron(expression);
  insist(date instanceof Date && Number.isFinite(+date), 'Invalid schedule time');
  const fields = expression.trim().split(/\s+/), values = [date.getUTCMinutes(), date.getUTCHours(), date.getUTCDate(), date.getUTCMonth()+1, date.getUTCDay()];
  const bounds = [[0,59],[0,23],[1,31],[1,12],[0,7]];
  const matches = fields.map((field, i) => field.split(',').map(part => {
    const [range, stride] = part.split('/'), step = stride === undefined ? 1 : Number(stride);
    insist(Number.isInteger(step) && step > 0, 'Cron step must be positive');
    const [lo, hi] = range === '*' ? bounds[i] : range.includes('-') ? range.split('-').map(Number) : [Number(range), stride ? bounds[i][1] : Number(range)];
    insist(lo <= hi, 'Cron range must ascend');
    return [values[i], ...(i === 4 && values[i] === 0 ? [7] : [])].some(v => v >= lo && v <= hi && (v-lo)%step === 0);
  }).some(Boolean));
  // Conventional cron OR semantics when both day fields are restricted.
  const day = fields[2] !== '*' && fields[4] !== '*' ? matches[2] || matches[4] : matches[2] && matches[4];
  return matches[0] && matches[1] && matches[3] && day;
}

function atomic(file, data) {
  const tmp = file + '.tmp';
  assertPersistencePath(file); assertPersistencePath(tmp);
  guardedWriteFileSync(tmp, JSON.stringify(data), {mode:0o600, receipt:data});
  assertPersistencePath(tmp); assertPersistencePath(file);
  guardedRenameSync(tmp,file);
}
function safeJson(file) { insist(lstatSync(file).isFile() && !lstatSync(file).isSymbolicLink(), 'Unsafe host state'); return JSON.parse(readFileSync(file,'utf8')); }
export function createLocalHost(config) {
  insist(config && Object.keys(config).every(k=>['manifest','manifestSha256','callerProvider','workspacePolicy'].includes(k)), 'Unsupported host configuration');
  const file = resolve(config.manifest);
  insist(/^[a-f0-9]{64}$/.test(config.manifestSha256), 'Pinned manifest SHA256 required');
  const verify = () => { insist(hash(readFileSync(file)) === config.manifestSha256, 'Manifest changed; explicitly configure the new version'); return loadManifest(file); };
  verify();
  if(config.callerProvider) {
    insist(config.callerProvider.kind === 'caller' && Object.keys(config.callerProvider).every(k=>['kind','agent','model','payerScope'].includes(k)), 'Caller host configuration accepts identity only, never credentials');
    validateCallerInput({provider:config.callerProvider});
  }
  const policy = config.workspacePolicy ? validateWorkspacePolicy(config.workspacePolicy) : null;
  const store = new RunStore(file), dir = join(store.dir,'host',hash(file));
  const lock = join(dir,'lock'), active = join(dir,'active.json');
  for (const path of [dir, lock, active, active + '.tmp']) assertPersistencePath(path);
  guardedMkdirSync(dir,{recursive:true,mode:0o700});
  for(const path of [store.dir,join(store.dir,'host'),dir]) insist(!lstatSync(path).isSymbolicLink(),'Unsafe host directory');
  async function dispatch(kind,eventId,inputs = {}) {
    const snapshot = jsonInputs(inputs);
    return withWorkflowLease(file, () => dispatchLeased(kind,eventId,snapshot));
  }
  async function dispatchLeased(kind,eventId,inputs) {
    insist(['manual','schedule','webhook'].includes(kind),'Unsupported host trigger');
    insist(typeof eventId === 'string' && /^[a-zA-Z0-9_.:-]{1,128}$/.test(eventId),'Bounded event ID required');
    const manifest=verify();
    insist(manifest.enabled,'Workflow is disabled');
    insist(manifest.triggers.some(t=>t.kind===kind),'Trigger is not declared by this workflow');
    const boundInputs = bindInputs(manifest.inputs, inputs), inputsHash = hash(boundInputs);
    const receipt=join(dir,hash({kind,eventId})+'.json');
    for (const path of [receipt, receipt + '.tmp', active, active + '.tmp', lock]) assertPersistencePath(path);
    guardedWriteFileSync(lock,'',{flag:'wx',mode:0o600});
    try {
      if(existsSync(receipt)) {
        const prior=safeJson(receipt);
        insist(prior.inputsHash === inputsHash || (!Object.hasOwn(prior,'inputsHash') && !Object.keys(boundInputs).length && !Object.keys(manifest.inputs).length), 'Host event inputs changed; use a new event ID');
        insist(prior.phase==='completed','Prior trigger outcome is uncertain; reconcile before retry'); return {...prior,duplicate:true};
      }
      if(existsSync(active)) { const prior=safeJson(active), run=store.load(prior.runId); insist(run && ['success','failed','cancelled','needs_human'].includes(run.status),'Previous run is still active or waiting; resume it before starting another'); }
      const run=createRun(manifest,{trigger:kind,inputs:boundInputs});
      run.hostEvent={id:eventId,manifestSha256:config.manifestSha256};
      run.executionKnobs=resolveKnobs(manifest.settings);
      if(config.callerProvider) run.callerProvider=config.callerProvider;
      if(policy) run.workspacePolicy=policy;
      store.save(run);
      insist(hash(store.load(run.runId).inputs) === inputsHash, 'Persisted host inputs changed');
      atomic(receipt,{phase:'claimed',runId:run.runId,kind,eventId,inputsHash});
      atomic(active,{runId:run.runId});
      const result=await driveRun(run,{store,knobs:run.executionKnobs,callerProvider:run.callerProvider,apiKey:process.env.OPENROUTER_API_KEY??null});
      const output={phase:'completed',runId:run.runId,kind,eventId,inputsHash,status:result.status};
      atomic(receipt,output);
      return output;
    } finally { guardedUnlinkSync(lock); }
  }
  async function tick(date=new Date()) {
    const manifest=verify();
    if(!manifest.triggers.some(t=>t.kind==='schedule' && cronMatches(t.cron,date))) return null;
    return dispatch('schedule',date.toISOString().slice(0,16).replace('T','-'));
  }
  function webhookServer(token) {
    insist(typeof token==='string' && token.length>=32 && token.length<=512,'Webhook token must contain 32–512 characters');
    registerPersistenceSecret(token);
    return createServer(async(req,res)=>{
      const send=(status,body)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(body));};
      if(req.method!=='POST' || req.url!=='/trigger') {req.resume();return send(404,{error:'Not found'});}
      const actual=Buffer.from(req.headers.authorization??''), expected=Buffer.from('Bearer '+token);
      if(actual.length!==expected.length || !timingSafeEqual(actual,expected)) {req.resume();return send(401,{error:'Unauthorized'});}
      // The webhook starts a pinned workflow; its body cannot inject instructions/config.
      let bytes=0; try { for await(const chunk of req) {bytes+=chunk.length;if(bytes>1024) throw Error('Body exceeds 1024 bytes');}
        const result=await dispatch('webhook',req.headers['x-qfactory-event-id']);send(202,result);
      } catch(e) {send(409,{error:e.message});}
    });
  }
  return {dispatch,tick,webhookServer};
}
