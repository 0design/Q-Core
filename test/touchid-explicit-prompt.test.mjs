// Static and Node-side checks for the explicit Touch ID prompt. They never run
// the native helper, create a key, or open a Touch ID window.
import assert from 'node:assert/strict';
import test from 'node:test';
import childProcess from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { APPROVAL_TTL_MS, TouchIdAnchor, touchIdHelper } from '../src/approval-anchor.mjs';

const helperSource = readFileSync(fileURLToPath(new URL('../tools/touchid-approve/main.swift', import.meta.url)), 'utf8');

/** Body of `func <name>(` up to its matching brace, skipping string literals. */
function functionBody(source, name) {
  const start = source.indexOf(`func ${name}(`);
  if (start < 0) return null;
  const open = source.indexOf('{', start);
  let depth = 0;
  for (let index = open; index < source.length; index++) {
    const character = source[index];
    if (character === '"') {
      for (index++; index < source.length && source[index] !== '"'; index++) if (source[index] === '\\') index++;
      continue;
    }
    if (character === '{') depth++;
    if (character === '}' && --depth === 0) return source.slice(open, index + 1);
  }
  return null;
}

/** Returns every reason the helper could sign without an explicit, bounded, biometric-only prompt. */
function explicitPromptViolations(source) {
  const problems = [];
  const authenticate = functionBody(source, 'authenticate');
  if (!authenticate) problems.push('authenticate(_:reason:) is missing');
  else {
    if (!authenticate.includes('context.evaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, localizedReason: reason)'))
      problems.push('authenticate must evaluate the biometric-only policy with the prompt reason');
    const wait = authenticate.indexOf('finished.wait(timeout: .now() + .seconds(authenticationTimeoutSeconds))');
    if (wait < 0) problems.push('authenticate must wait for the result with a timeout');
    if (!authenticate.includes('context.invalidate()')) problems.push('a timed-out prompt must be invalidated');
    const lock = authenticate.indexOf('context.interactionNotAllowed = true');
    if (lock < 0 || lock < wait) problems.push('the evaluated context must become non-interactive after the prompt');
  }
  const timeout = Number(source.match(/^let authenticationTimeoutSeconds = (\d+)$/m)?.[1]);
  const deadline = Number(source.match(/^let operationDeadlineSeconds = (\d+)$/m)?.[1]);
  if (!(timeout > 0 && timeout < deadline && deadline * 1000 < APPROVAL_TTL_MS))
    problems.push('prompt timeout < operation deadline < approval TTL is required');
  if (!/armOperationDeadline\(\)\n\s+switch CommandLine\.arguments\[1\]/.test(source))
    problems.push('the operation deadline must be armed before setup or approve');
  for (const name of ['approve', 'setup']) {
    const body = functionBody(source, name);
    if (!body) { problems.push(`${name}() is missing`); continue; }
    const prompt = body.indexOf('try authenticate(authentication, reason: reason)');
    if (prompt < 0) { problems.push(`${name}() must call authenticate before using the key`); continue; }
    for (const use of ['PrivateKey(dataRepresentation:', 'createPrivateKey(', '.signature(for:']) {
      const at = body.indexOf(use);
      if (at >= 0 && at < prompt) problems.push(`${name}() uses ${use} before the explicit prompt`);
    }
  }
  for (const required of [
    'context.touchIDAuthenticationAllowableReuseDuration = 0',
    'context.localizedFallbackTitle = ""',
    '[.biometryCurrentSet, .privateKeyUsage]',
    'let reason = "Decision: \\(payload["decision"]!.uppercased())\\nSHA-256: \\(payload["content_hash"]!)\\nRun: \\(promptLabel(payload["run_id"]!))\\nGate: \\(promptLabel(payload["gate_id"]!))"',
    'let reason = "Set up the Touch ID approval key"',
  ]) if (!source.includes(required)) problems.push(`missing unchanged requirement: ${required}`);
  if (/\.deviceOwnerAuthentication\b(?!WithBiometrics)/.test(source)) problems.push('a password-capable policy is not permitted');
  return problems;
}

test('approve and setup show an explicit, bounded, biometric-only prompt before using the key', () => {
  assert.deepEqual(explicitPromptViolations(helperSource), []);
});

test('the static prompt check refuses helpers that rely on an implicit prompt or weaken the policy', () => {
  const mutations = {
    'no explicit prompt in approve': helperSource.replace(/(func approve\(\)[\s\S]*?)    try authenticate\(authentication, reason: reason\)\n/, '$1'),
    'no explicit prompt in setup': helperSource.replace(/(func setup\(\)[\s\S]*?)    try authenticate\(authentication, reason: reason\)\n/, '$1'),
    'prompt after key use': helperSource.replace(/(func approve\(\)[\s\S]*?)    try authenticate\(authentication, reason: reason\)\n(    let key = .*\n)/, '$1$2    try authenticate(authentication, reason: reason)\n'),
    'password policy': helperSource.replace('evaluatePolicy(.deviceOwnerAuthenticationWithBiometrics,', 'evaluatePolicy(.deviceOwnerAuthentication,'),
    'interactive after prompt': helperSource.replace('    context.interactionNotAllowed = true\n', ''),
    'unbounded wait': helperSource.replace('finished.wait(timeout: .now() + .seconds(authenticationTimeoutSeconds))', 'finished.wait()'),
    'timeout beyond approval TTL': helperSource.replace('let operationDeadlineSeconds = 110', 'let operationDeadlineSeconds = 130'),
    'password fallback title': helperSource.replace('context.localizedFallbackTitle = ""', 'context.localizedFallbackTitle = "Use Password"'),
    'biometric reuse': helperSource.replace('AllowableReuseDuration = 0', 'AllowableReuseDuration = 30'),
    'changed prompt text': helperSource.replace('\\nSHA-256: ', '\\nHash: '),
  };
  for (const [name, mutated] of Object.entries(mutations)) {
    assert.notEqual(mutated, helperSource, `mutation did not apply: ${name}`);
    assert.notDeepEqual(explicitPromptViolations(mutated), [], `check accepted: ${name}`);
  }
});

test('a failing helper returns its own stderr in the Node approval error', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'q-core-touchid-stderr-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const failing = join(directory, 'failing-helper');
  writeFileSync(failing, "#!/bin/sh\ncat >/dev/null\necho 'touchid-approve: Touch ID was cancelled. Nothing was signed.' >&2\nexit 1\n");
  chmodSync(failing, 0o700);
  const realExecFile = childProcess.execFile;
  t.mock.method(childProcess, 'execFile', (file, args, options, callback) => {
    assert.equal(file, touchIdHelper());
    assert.deepEqual(args, ['approve']);
    return realExecFile(failing, args, options, callback);
  });
  const { publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const anchor = new TouchIdAnchor(publicKey.export({ type: 'spki', format: 'pem' }));
  const payload = { run_id: 'run', gate_id: 'gate', content_hash: 'a'.repeat(64), decision: 'approve',
    nonce: 'b'.repeat(64), issued_at: new Date().toISOString() };
  await assert.rejects(anchor.confirm(payload), error => {
    assert.match(error.message, /Touch ID was cancelled\. Nothing was signed\./);
    assert.equal(error.code, 1);
    return true;
  });
});
