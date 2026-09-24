import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, openSync, closeSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const hex64 = /^[a-f0-9]{64}$/;
const chatIdPattern = /^-100[0-9]+$/;
const botTokenPattern = /^[0-9]+:[A-Za-z0-9_-]+$/;

function requireThat(condition, message) {
  if (!condition) throw new Error(message);
}

function planFields(plan) {
  requireThat(plan && typeof plan === 'object' && !Array.isArray(plan), 'Plan required');
  requireThat(Object.keys(plan).sort().join(',') === 'botId,campaignId,chatId,chatTitle,payloadSha256,username', 'Unexpected plan fields');
  requireThat(typeof plan.campaignId === 'string' && /^[A-Za-z0-9:._-]{1,100}$/.test(plan.campaignId), 'Invalid campaign ID');
  requireThat(typeof plan.chatId === 'string' && chatIdPattern.test(plan.chatId), 'Invalid numeric channel ID');
  requireThat(typeof plan.chatTitle === 'string' && plan.chatTitle.length > 0, 'Channel title required');
  requireThat(typeof plan.username === 'string' && /^[A-Za-z0-9_]{5,32}$/.test(plan.username), 'Public username required');
  requireThat(Number.isSafeInteger(plan.botId) && plan.botId > 0, 'Bot ID required');
  requireThat(typeof plan.payloadSha256 === 'string' && hex64.test(plan.payloadSha256), 'Payload SHA-256 required');
  return { campaignId: plan.campaignId, chatId: plan.chatId, chatTitle: plan.chatTitle,
    username: plan.username, botId: plan.botId, payloadSha256: plan.payloadSha256 };
}

function approvalBinding(plan) {
  return sha256(JSON.stringify([plan.campaignId, plan.chatId, plan.chatTitle,
    plan.username, plan.botId, plan.payloadSha256]));
}

function journalFile(dir, campaignId) {
  return join(resolve(dir), `${sha256(campaignId)}.json`);
}

function safeJournalDir(dir, create) {
  requireThat(typeof dir === 'string' && dir.startsWith('/'), 'Absolute journal directory required');
  if (!existsSync(dir)) {
    if (!create) return false;
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  const info = lstatSync(dir);
  requireThat(info.isDirectory() && !info.isSymbolicLink(), 'Unsafe journal directory');
  return true;
}

function readClaim(file, plan) {
  if (!existsSync(file)) return null;
  const info = lstatSync(file);
  requireThat(info.isFile() && !info.isSymbolicLink(), 'Unsafe delivery claim');
  const claim = JSON.parse(readFileSync(file, 'utf8'));
  requireThat(claim.campaignId === plan.campaignId &&
    claim.chatId === plan.chatId && claim.payloadSha256 === plan.payloadSha256,
    'Campaign identity conflicts with delivery claim');
  return claim;
}

function replaceClaim(file, claim) {
  const temp = `${file}.${process.pid}.tmp`;
  const fd = openSync(temp, 'wx', 0o600);
  try { writeFileSync(fd, JSON.stringify(claim) + '\n'); }
  finally { closeSync(fd); }
  renameSync(temp, file);
}

async function api(fetchImpl, token, method, params) {
  requireThat(['getMe', 'getChat', 'getChatMember', 'sendMessage'].includes(method), 'Unsupported Telegram method');
  let response;
  try {
    response = await fetchImpl(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST', redirect: 'error', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(params),
    });
  } catch { throw new Error('Telegram transport failed; outcome may be uncertain'); }
  requireThat(response?.ok === true, 'Telegram request failed; outcome may be uncertain');
  let data;
  try { data = await response.json(); }
  catch { throw new Error('Telegram response invalid; outcome may be uncertain'); }
  requireThat(data?.ok === true, 'Telegram request rejected; outcome may be uncertain');
  return data.result;
}

/** One campaign permits one outbound attempt. Dry run reads no credential and makes no request. */
export async function telegramOneShot({ plan: rawPlan, payload, journalDir, approval, token, send = false, fetchImpl = fetch }) {
  const plan = planFields(rawPlan);
  requireThat(typeof payload === 'string' && payload.length > 0 && Buffer.byteLength(payload) <= 4096, 'Invalid Telegram payload');
  requireThat(sha256(Buffer.from(payload, 'utf8')) === plan.payloadSha256, 'Payload hash differs from plan');
  const binding = approvalBinding(plan);
  const exists = safeJournalDir(journalDir, false);
  const file = journalFile(journalDir, plan.campaignId);
  const prior = exists ? readClaim(file, plan) : null;
  if (!send) return { mode: 'dry-run', campaignId: plan.campaignId, target: { chatId: plan.chatId,
    chatTitle: plan.chatTitle, username: plan.username, botId: plan.botId },
    payloadSha256: plan.payloadSha256, approvalBinding: binding, journalPhase: prior?.phase ?? 'absent' };

  requireThat(approval?.decision === 'approve' && approval?.binding === binding &&
    typeof approval?.commentUrl === 'string' && /^https:\/\/linear\.app\/0dhaus\/issue\/0D-358\//.test(approval.commentUrl),
  'Exact owner approval receipt required');
  // The caller must independently verify that commentUrl is an actual owner decision in Linear.
  requireThat(typeof token === 'string' && botTokenPattern.test(token), 'Valid local Telegram token required');
  if (prior?.phase === 'delivered') return { status: 'duplicate-prevented', receipt: prior.receipt };
  requireThat(!prior, 'Prior send outcome uncertain; reconcile manually');

  const me = await api(fetchImpl, token, 'getMe', {});
  const chat = await api(fetchImpl, token, 'getChat', { chat_id: plan.chatId });
  const member = await api(fetchImpl, token, 'getChatMember', { chat_id: plan.chatId, user_id: plan.botId });
  requireThat(me?.id === plan.botId && me?.is_bot === true &&
    chat?.id === Number(plan.chatId) && chat?.type === 'channel' &&
    chat?.title === plan.chatTitle && chat?.username === plan.username &&
    member?.user?.id === plan.botId && member?.status === 'administrator' &&
    member?.can_post_messages === true, 'Telegram receiver identity or posting rights changed');

  safeJournalDir(journalDir, true);
  const claim = { campaignId: plan.campaignId, chatId: plan.chatId,
    payloadSha256: plan.payloadSha256, approvalBinding: binding, phase: 'sending' };
  try {
    const fd = openSync(file, 'wx', 0o600);
    try { writeFileSync(fd, JSON.stringify(claim) + '\n'); }
    finally { closeSync(fd); }
  } catch (error) {
    if (error?.code === 'EEXIST') throw new Error('Delivery claim already exists; reconcile before retry');
    throw error;
  }
  try {
    const result = await api(fetchImpl, token, 'sendMessage', {
      chat_id: plan.chatId, text: payload, disable_web_page_preview: true,
    });
    requireThat(result?.chat?.id === Number(plan.chatId) && result?.text === payload &&
      Number.isSafeInteger(result?.message_id) && result.message_id > 0,
    'Telegram receipt does not match approved target and payload');
    const receipt = { chatId: plan.chatId, messageId: result.message_id,
      date: result.date ?? null, payloadSha256: plan.payloadSha256 };
    replaceClaim(file, { ...claim, phase: 'delivered', receipt });
    return { status: 'delivered', receipt };
  } catch {
    replaceClaim(file, { ...claim, phase: 'uncertain' });
    throw new Error('Delivery outcome uncertain; never retry automatically');
  }
}
