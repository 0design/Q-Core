/**
 * Candidate protocol utility for a remote human-decision transport.
 * Verifies evidence only. It cannot enroll a key, consume a decision, resume a
 * human gate or publish. Callers must persist/consume atomically and retain the
 * existing human-only runtime boundary.
 */
import { createPublicKey, randomBytes, randomUUID, verify } from 'node:crypto';
import { canonical, CoreError, hash } from './contracts.mjs';

const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const HEX=/^[a-f0-9]{64}$/;
const BINDINGS=['runId','gateId','approvalHash','manifestHash','reviewerId','issuerKeyId'];
const REQUEST=[...BINDINGS,'protocol','requestId','channel','nonce','issuedAt','expiresAt','requestHash'];
const RECEIPT=[...BINDINGS,'protocol','requestId','requestHash','channel','nonce','expiresAt','receiptId','decision','decidedAt'];
const MAX_TTL=86_400_000;
const fail=()=>{throw new CoreError('REMOTE_APPROVAL_INVALID','Remote approval evidence is invalid, stale or already consumed.');};
const need=(value)=>{if(!value)fail();};
const object=(value)=>value!==null && typeof value==='object' && !Array.isArray(value) &&
  [Object.prototype,null].includes(Object.getPrototypeOf(value));
const keys=(value,expected)=>object(value) && Object.keys(value).length===expected.length &&
  expected.every(key=>Object.hasOwn(value,key));
const integer=(value)=>Number.isSafeInteger(value) && value>=0;
function bindings(value) {
  need(keys(value,BINDINGS));
  need(typeof value.runId==='string' && UUID.test(value.runId));
  need(typeof value.gateId==='string' && /^[a-z0-9][a-z0-9:.-]{0,199}$/.test(value.gateId));
  need(['approvalHash','manifestHash','issuerKeyId'].every(k=>typeof value[k]==='string' && HEX.test(value[k])));
  need(typeof value.reviewerId==='string' && /^[1-9][0-9]{0,19}$/.test(value.reviewerId));
}
function publicKey(pem) {
  need(typeof pem==='string' && Buffer.byteLength(pem)<=4096 &&
    /^-----BEGIN PUBLIC KEY-----\n[A-Za-z0-9+/=\n]+\n-----END PUBLIC KEY-----\n?$/.test(pem));
  try { const key=createPublicKey(pem);need(key.asymmetricKeyType==='ed25519');return key; }
  catch { fail(); }
}
export function remoteApprovalKeyId(pem) {
  return hash(publicKey(pem).export({type:'spki',format:'der'}));
}
function validateRequest(request,nowMs) {
  need(keys(request,REQUEST) && integer(nowMs));
  bindings(Object.fromEntries(BINDINGS.map(k=>[k,request[k]])));
  need(request.protocol==='qf.remote-human-request/v1' && request.channel==='telegram');
  need(typeof request.requestId==='string' && UUID.test(request.requestId));
  need(typeof request.nonce==='string' && HEX.test(request.nonce));
  need(integer(request.issuedAt) && integer(request.expiresAt) &&
    request.issuedAt<=nowMs && nowMs<request.expiresAt &&
    request.expiresAt>request.issuedAt && request.expiresAt-request.issuedAt<=MAX_TTL);
  const {requestHash,...body}=request;
  need(typeof requestHash==='string' && HEX.test(requestHash) && hash(body)===requestHash);
}
export function createRemoteApprovalRequest(current,{nowMs=Date.now(),ttlMs=900_000}={}) {
  bindings(current);
  need(integer(nowMs) && Number.isSafeInteger(ttlMs) && ttlMs>0 && ttlMs<=MAX_TTL &&
    Number.isSafeInteger(nowMs+ttlMs));
  const body={...current,protocol:'qf.remote-human-request/v1',requestId:randomUUID(),
    channel:'telegram',nonce:randomBytes(32).toString('hex'),issuedAt:nowMs,expiresAt:nowMs+ttlMs};
  return Object.freeze({...body,requestHash:hash(body)});
}

/**
 * receiptJson is canonical UTF-8 JSON {body,signature}; the provider signs the
 * canonical body with its independently held Ed25519 key. current and request
 * come from the trusted host's current gate, not model/source output.
 * consumedReceiptIds is a bounded snapshot, not an atomic replay ledger.
 */
export function verifyRemoteApprovalReceipt({receiptJson,request,current,trustedPublicKey,
  consumedReceiptIds,nowMs=Date.now()}) {
  validateRequest(request,nowMs);bindings(current);
  need(BINDINGS.every(k=>current[k]===request[k]));
  need(Array.isArray(consumedReceiptIds) && consumedReceiptIds.length<=10000 &&
    consumedReceiptIds.every(id=>typeof id==='string' && UUID.test(id)));
  need(typeof receiptJson==='string' && Buffer.byteLength(receiptJson)<=8192);
  let envelope;
  try {envelope=JSON.parse(receiptJson);}catch {fail();}
  need(keys(envelope,['body','signature']) && keys(envelope.body,RECEIPT));
  const body=envelope.body;
  need(body.protocol==='qf.remote-human-receipt/v1');
  for(const field of [...BINDINGS,'requestId','requestHash','channel','nonce','expiresAt'])
    need(body[field]===request[field]);
  need(typeof body.receiptId==='string' && UUID.test(body.receiptId) &&
    !consumedReceiptIds.includes(body.receiptId));
  need(['approve','reject'].includes(body.decision));
  need(integer(body.decidedAt) && body.decidedAt>=request.issuedAt &&
    body.decidedAt<=nowMs && body.decidedAt<request.expiresAt);
  need(typeof envelope.signature==='string' && /^[A-Za-z0-9+/]{86}==$/.test(envelope.signature));
  const signature=Buffer.from(envelope.signature,'base64');
  need(signature.length===64 && signature.toString('base64')===envelope.signature);
  need(canonical(envelope)===receiptJson);
  const key=publicKey(trustedPublicKey);
  need(hash(key.export({type:'spki',format:'der'}))===current.issuerKeyId);
  try {need(verify(null,Buffer.from(canonical(body)),key,signature));}catch {fail();}
  // Deliberately not a resumeRun confirmation: no "channel" or applied approval.
  return Object.freeze({protocol:'qf.remote-human-evidence/v1',transport:body.channel,
    receiptId:body.receiptId,requestId:body.requestId,requestHash:body.requestHash,
    runId:body.runId,gateId:body.gateId,approvalHash:body.approvalHash,
    manifestHash:body.manifestHash,reviewerId:body.reviewerId,issuerKeyId:body.issuerKeyId,
    decision:body.decision,decidedAt:body.decidedAt,receiptHash:hash(receiptJson),
    authorizationApplied:false});
}
