import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,randomUUID,sign} from 'node:crypto';
import {canonical} from '../src/contracts.mjs';
import {createRemoteApprovalRequest,remoteApprovalKeyId,verifyRemoteApprovalReceipt} from '../src/remote-human-receipt.mjs';

// Offline cryptographic fixtures only; no user decision, account or gate is applied.
function fixture() {
  const pair=generateKeyPairSync('ed25519');
  const pem=pair.publicKey.export({type:'spki',format:'pem'});
  const current={runId:randomUUID(),gateId:'1000:review',approvalHash:'a'.repeat(64),
    manifestHash:'b'.repeat(64),reviewerId:'12345678',issuerKeyId:remoteApprovalKeyId(pem)};
  const request=createRemoteApprovalRequest(current,{nowMs:1000,ttlMs:10000});
  function receipt(edit={},key=pair.privateKey) {
    const {issuedAt,requestHash,...requestFields}=request;
    const body={...requestFields,protocol:'qf.remote-human-receipt/v1',requestHash,
      receiptId:randomUUID(),decision:'approve',decidedAt:1500,...edit};
    return canonical({body,signature:sign(null,Buffer.from(canonical(body)),key).toString('base64')});
  }
  const args={request,current,trustedPublicKey:pem,consumedReceiptIds:[],nowMs:2000};
  return {pair,pem,current,request,receipt,args};
}
const invalid=(fn)=>assert.throws(fn,error=>error.code==='REMOTE_APPROVAL_INVALID');

test('signed approve/reject verifies as evidence without applying a human gate',()=>{
  const f=fixture();
  for(const decision of ['approve','reject']) {
    const value=verifyRemoteApprovalReceipt({...f.args,receiptJson:f.receipt({decision})});
    assert.equal(value.decision,decision);assert.equal(value.authorizationApplied,false);
    assert.equal(value.transport,'telegram');assert.equal(value.channel,undefined);
    assert.equal(value.approved,undefined);assert.ok(Object.isFrozen(value));
  }
});

test('every current run/gate/manifest/subject/reviewer/issuer binding must still match',()=>{
  const f=fixture(),json=f.receipt();
  const changed={runId:randomUUID(),gateId:'1001:review',approvalHash:'c'.repeat(64),
    manifestHash:'d'.repeat(64),reviewerId:'99999999',issuerKeyId:'e'.repeat(64)};
  for(const [field,value] of Object.entries(changed))
    invalid(()=>verifyRemoteApprovalReceipt({...f.args,current:{...f.current,[field]:value},receiptJson:json}));
});

test('a different signing key and changes to a signed body do not verify',()=>{
  const f=fixture(),other=generateKeyPairSync('ed25519');
  invalid(()=>verifyRemoteApprovalReceipt({...f.args,receiptJson:f.receipt({},other.privateKey)}));
  const e=JSON.parse(f.receipt());e.body.decision='reject';
  invalid(()=>verifyRemoteApprovalReceipt({...f.args,receiptJson:canonical(e)}));
  const wrongPem=other.publicKey.export({type:'spki',format:'pem'});
  invalid(()=>verifyRemoteApprovalReceipt({...f.args,trustedPublicKey:wrongPem,receiptJson:f.receipt()}));
});

test('clock and lifetime boundaries reject expired and impossible decisions',()=>{
  const f=fixture(),json=f.receipt();
  invalid(()=>verifyRemoteApprovalReceipt({...f.args,nowMs:11000,receiptJson:json}));
  invalid(()=>verifyRemoteApprovalReceipt({...f.args,nowMs:999,receiptJson:json}));
  invalid(()=>verifyRemoteApprovalReceipt({...f.args,receiptJson:f.receipt({decidedAt:2001})}));
  invalid(()=>verifyRemoteApprovalReceipt({...f.args,receiptJson:f.receipt({decidedAt:999})}));
  for(const ttlMs of [0,-1,86400001,Infinity,0.5])
    invalid(()=>createRemoteApprovalRequest(f.current,{nowMs:1000,ttlMs}));
});

test('consumed decision IDs are refused and a replay ledger snapshot is mandatory',()=>{
  const f=fixture(),json=f.receipt(),receiptId=JSON.parse(json).body.receiptId;
  invalid(()=>verifyRemoteApprovalReceipt({...f.args,receiptJson:json,consumedReceiptIds:[receiptId]}));
  invalid(()=>verifyRemoteApprovalReceipt({...f.args,receiptJson:json,consumedReceiptIds:undefined}));
  invalid(()=>verifyRemoteApprovalReceipt({...f.args,receiptJson:json,consumedReceiptIds:['not-an-id']}));
  assert.equal(verifyRemoteApprovalReceipt({...f.args,receiptJson:json}).receiptId,receiptId);
});

test('strict canonical envelope refuses duplicate keys and extra provider claims',()=>{
  const f=fixture(),json=f.receipt(),e=JSON.parse(json);
  invalid(()=>verifyRemoteApprovalReceipt({...f.args,receiptJson:' '+json}));
  invalid(()=>verifyRemoteApprovalReceipt({...f.args,receiptJson:json.replace('"body":','"body":null,"body":')}));
  invalid(()=>verifyRemoteApprovalReceipt({...f.args,receiptJson:canonical({...e,approved:true})}));
  invalid(()=>verifyRemoteApprovalReceipt({...f.args,receiptJson:f.receipt({extra:'publish now'})}));
  invalid(()=>verifyRemoteApprovalReceipt({...f.args,receiptJson:'null'}));
  invalid(()=>verifyRemoteApprovalReceipt({...f.args,receiptJson:'{'}));
});

test('only public Ed25519 verification keys are accepted, never private key input',()=>{
  const f=fixture(),ec=generateKeyPairSync('ec',{namedCurve:'prime256v1'});
  invalid(()=>remoteApprovalKeyId(ec.publicKey.export({type:'spki',format:'pem'})));
  invalid(()=>remoteApprovalKeyId(f.pair.privateKey.export({type:'pkcs8',format:'pem'})));
  invalid(()=>remoteApprovalKeyId('not a public key'));
});

test('fresh requests have independent immutable nonces and request digest tampering is refused',()=>{
  const f=fixture(),next=createRemoteApprovalRequest(f.current,{nowMs:1000,ttlMs:10000});
  assert.notEqual(f.request.nonce,next.nonce);assert.notEqual(f.request.requestId,next.requestId);
  assert.ok(Object.isFrozen(f.request));
  invalid(()=>verifyRemoteApprovalReceipt({...f.args,request:{...f.request,requestHash:'f'.repeat(64)},receiptJson:f.receipt()}));
  invalid(()=>verifyRemoteApprovalReceipt({...f.args,request:{...f.request,nonce:'0'.repeat(64)},receiptJson:f.receipt()}));
  invalid(()=>verifyRemoteApprovalReceipt({...f.args,request:next,receiptJson:f.receipt()}));
});

test('body size, signature encoding and malformed identities fail closed',()=>{
  const f=fixture(),e=JSON.parse(f.receipt());
  invalid(()=>verifyRemoteApprovalReceipt({...f.args,receiptJson:'x'.repeat(8193)}));
  for(const signature of ['A'.repeat(88),e.signature+'\n',e.signature.slice(0,-1)])
    invalid(()=>verifyRemoteApprovalReceipt({...f.args,receiptJson:canonical({...e,signature})}));
  invalid(()=>createRemoteApprovalRequest({...f.current,reviewerId:'123\n456'}));
  invalid(()=>createRemoteApprovalRequest({...f.current,reviewerId:'0'}));
  invalid(()=>createRemoteApprovalRequest({...f.current,unexpected:'value'}));
});
