import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, chmodSync, symlinkSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { telegramOneShot } from '../src/telegram-one-shot.mjs';

const payload = 'Synthetic test only';
const payloadSha256 = createHash('sha256').update(payload).digest('hex');
const plan = { campaignId: 'synthetic-one-test', chatId: '-1001234567890', chatTitle: 'Synthetic channel',
  username: 'synthetic_channel', botId: 1234, payloadSha256 };
const token = '1234:syntheticToken';

function fixture(t) {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'qf-telegram-one-shot-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return join(root, 'journal');
}

function fakeTelegram(overrides = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const method = url.split('/').at(-1);
    calls.push(method);
    if (overrides[method] === 'throw') throw Error('synthetic transport failure');
    const defaults = {
      getMe: { id: plan.botId, is_bot: true },
      getChat: { id: Number(plan.chatId), type: 'channel', title: plan.chatTitle, username: plan.username },
      getChatMember: { user: { id: plan.botId }, status: 'administrator', can_post_messages: true },
      sendMessage: { chat: { id: Number(plan.chatId) }, text: payload, message_id: 77, date: 123 },
    };
    assert.equal(init.method, 'POST');
    return { ok: true, json: async () => ({ ok: true, result: overrides[method] ?? defaults[method] }) };
  };
  return { calls, fetchImpl };
}

async function approved(journalDir, fetchImpl) {
  const dry = await telegramOneShot({ plan, payload, journalDir, fetchImpl });
  return { plan, payload, journalDir, token, fetchImpl, send: true,
    approval: { decision: 'approve', binding: dry.approvalBinding,
      commentUrl: 'https://linear.app/0dhaus/issue/0D-358/test-owner-approval' } };
}

test('dry run binds exact target and body with zero provider calls or writes', async (t) => {
  const journalDir = fixture(t), telegram = fakeTelegram();
  const result = await telegramOneShot({ plan, payload, journalDir, fetchImpl: telegram.fetchImpl });
  assert.equal(result.mode, 'dry-run');
  assert.equal(result.payloadSha256, payloadSha256);
  assert.equal(result.journalPhase, 'absent');
  assert.deepEqual(telegram.calls, []);
  await assert.rejects(telegramOneShot({ plan, payload: payload + '!', journalDir,
    fetchImpl: telegram.fetchImpl }), /Payload hash differs/);
});

test('approval hash and receiver changes fail before send', async (t) => {
  const journalDir = fixture(t), telegram = fakeTelegram();
  const args = await approved(journalDir, telegram.fetchImpl);
  await assert.rejects(telegramOneShot({ ...args, approval: { ...args.approval, binding: '0'.repeat(64) } }), /approval receipt/);
  await assert.rejects(telegramOneShot({ ...args, plan: { ...plan, chatId: '-1001234567891' } }), /approval receipt/);
  assert.deepEqual(telegram.calls, []);
  const changed = fakeTelegram({ getChat: { id: Number(plan.chatId), type: 'channel', title: plan.chatTitle, username: 'changed' } });
  await assert.rejects(telegramOneShot({ ...args, fetchImpl: changed.fetchImpl }), /receiver identity/);
  assert.equal(changed.calls.includes('sendMessage'), false);
});

test('one claim yields receiver receipt and prevents duplicate send', async (t) => {
  const journalDir = fixture(t), telegram = fakeTelegram();
  const args = await approved(journalDir, telegram.fetchImpl);
  const first = await telegramOneShot(args);
  assert.equal(first.status, 'delivered');
  assert.equal(first.receipt.chatId, plan.chatId);
  assert.equal(first.receipt.messageId, 77);
  const second = await telegramOneShot(args);
  assert.equal(second.status, 'duplicate-prevented');
  assert.equal(telegram.calls.filter((x) => x === 'sendMessage').length, 1);
});

test('uncertain send and mismatched receiver receipt never retry', async (t) => {
  for (const override of ['throw', { chat: { id: -100999 }, text: payload, message_id: 77 }]) {
    const journalDir = fixture(t), telegram = fakeTelegram({ sendMessage: override });
    const args = await approved(journalDir, telegram.fetchImpl);
    await assert.rejects(telegramOneShot(args), /outcome uncertain/);
    await assert.rejects(telegramOneShot(args), /reconcile manually/);
    assert.equal(telegram.calls.filter((x) => x === 'sendMessage').length, 1);
  }
});

test('symlink parent and world-readable journal fail before any provider call', async (t) => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'qf-journal-path-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const privateParent = join(root, 'private');
  mkdirSync(privateParent, { mode: 0o700 });
  symlinkSync(privateParent, join(root, 'link'));
  symlinkSync(join(root, 'missing'), join(root, 'dangling'));
  const telegram = fakeTelegram();
  await assert.rejects(telegramOneShot({ plan, payload, journalDir: join(root, 'link', 'journal'),
    fetchImpl: telegram.fetchImpl }), /Unsafe journal parent/);
  await assert.rejects(telegramOneShot({ plan, payload, journalDir: join(root, 'dangling', 'journal'),
    fetchImpl: telegram.fetchImpl }), /Unsafe journal parent/);
  const readable = join(root, 'readable');
  mkdirSync(readable, { mode: 0o700 });
  chmodSync(readable, 0o755);
  await assert.rejects(telegramOneShot({ plan, payload, journalDir: readable,
    fetchImpl: telegram.fetchImpl }), /owner-only/);
  assert.deepEqual(telegram.calls, []);
});

test('forged delivered claim cannot suppress send with a false receipt', async (t) => {
  const journalDir = fixture(t), telegram = fakeTelegram();
  mkdirSync(journalDir, { mode: 0o700 });
  const args = await approved(journalDir, telegram.fetchImpl);
  const file = join(journalDir, `${createHash('sha256').update(plan.campaignId).digest('hex')}.json`);
  writeFileSync(file, JSON.stringify({ campaignId: plan.campaignId, chatId: plan.chatId,
    payloadSha256, approvalBinding: args.approval.binding, phase: 'delivered', mac: '0'.repeat(64),
    receipt: { chatId: plan.chatId, payloadSha256, messageId: 999, date: 123 } }), { mode: 0o600 });
  await assert.rejects(telegramOneShot(args), /integrity failed/);
  assert.deepEqual(telegram.calls, []);
});
