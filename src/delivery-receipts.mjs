import { mkdirSync, existsSync, lstatSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { hash, insist } from './contracts.mjs';
import { atomicJson } from './workspace.mjs';

/** Claim before any outbound effect. An interrupted/failed claim is deliberately
 * not retried: a receiver may have accepted the request before the error. */
export async function deliverOnce({ store, destination, key, payloadHash }, send) {
  insist(store && typeof store.dir === 'string', 'Idempotent delivery requires persistent run storage');
  insist(typeof key === 'string' && /^[a-f0-9]{64}$/.test(key), 'Delivery key must be a resolved SHA-256');
  for (const directory of [store.dir, join(store.dir, 'receipts')]) {
    if (existsSync(directory)) insist(lstatSync(directory).isDirectory() && !lstatSync(directory).isSymbolicLink(), 'Unsafe receipt directory');
    else mkdirSync(directory, { recursive: true, mode: 0o700 });
  }
  const receiptKey = hash({ destination, key });
  const file = join(store.dir, 'receipts', `${receiptKey}.json`);
  const claim = { receiptKey, sourceKey: key, payloadHash, phase: 'sending' };
  try { writeFileSync(file, JSON.stringify(claim), { flag: 'wx', mode: 0o600 }); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    insist(lstatSync(file).isFile() && !lstatSync(file).isSymbolicLink(), 'Unsafe delivery receipt');
    const previous = JSON.parse(readFileSync(file, 'utf8'));
    insist(previous.receiptKey === receiptKey && previous.sourceKey === key, 'Delivery receipt identity mismatch');
    insist(previous.phase === 'delivered', 'Delivery outcome is uncertain; reconcile receipt before another attempt', 'RECONCILE_REQUIRED');
    return { output: { ...previous.output, duplicatePrevented: true, receiptKey, originalPayloadHash: previous.payloadHash } };
  }
  try {
    const result = await send();
    insist(result?.output?.dispatched === true, 'Delivery did not produce a receiver receipt');
    const output = { ...result.output, receiptKey, payloadHash, duplicatePrevented: false };
    atomicJson(file, { ...claim, phase: 'delivered', output });
    return { ...result, output };
  } catch (error) {
    atomicJson(file, { ...claim, phase: 'uncertain' });
    throw error;
  }
}
