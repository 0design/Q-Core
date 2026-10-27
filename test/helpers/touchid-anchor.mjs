// Test-only software signer. Production code only invokes the native helper.
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { canonicalApprovalPayload } from '../../src/approval-anchor.mjs';

const fixtures = new WeakMap();

/** Never imported by CLI/MCP; substitutes a software key only in node:test. */
export function createTestTouchIdAnchor(t, dir) {
  if (fixtures.has(t)) return fixtures.get(t);
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const approvers = join(dir, '.q-core', 'approvers');
  mkdirSync(approvers, { recursive: true });
  const publicPem = publicKey.export({ type: 'spki', format: 'pem' });
  writeFileSync(join(approvers, 'touchid.json'), JSON.stringify({ id: 'touchid', public_key: publicPem }));
  const helper = join(approvers, 'touchid-approve');
  const fixture = {
    privateKey, publicKey, publicPem, payloads: [], helper,
    transformPayload: payload => payload,
    transformSignature: signature => signature,
    sign: payload => sign('sha256', Buffer.from(canonicalApprovalPayload(payload)), privateKey).toString('base64'),
  };
  t.mock.method(os, 'homedir', () => dir);
  t.mock.method(childProcess, 'execFile', (file, args, options, callback) => {
    assert.equal(file, helper, 'only the fixed registered helper can be invoked');
    assert.deepEqual(args, ['approve']);
    assert.equal(options.encoding, 'utf8');
    const stdin = new PassThrough();
    let input = '';
    stdin.on('data', chunk => { input += chunk.toString(); });
    stdin.on('finish', () => {
      queueMicrotask(() => {
        try {
          const payload = JSON.parse(input);
          fixture.payloads.push(payload);
          const signed = fixture.transformPayload(payload);
          const signature = fixture.transformSignature(fixture.sign(signed), payload);
          callback(null, JSON.stringify({ signature }), '');
        } catch (error) { callback(error, '', ''); }
      });
    });
    return { stdin };
  });
  fixtures.set(t, fixture);
  return fixture;
}
