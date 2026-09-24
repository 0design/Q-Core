import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { lstatSync, mkdirSync, openSync, closeSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, parse, resolve, sep } from 'node:path';

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

const fileInfo = (path) => lstatSync(path, { throwIfNoEntry: false });

function safeJournalDir(dir, create) {
  requireThat(typeof dir === 'string' && isAbsolute(dir), 'Absolute journal directory required');
  const target = resolve(dir);
  let part = parse(target).root;
  const segments = target.slice(part.length).split(sep).filter(Boolean);
  let complete = true;
  for (let i = 0; i < segments.length; i++) {
    part = join(part, segments[i]);
    let info = fileInfo(part);
    if (!info) {
      requireThat(i === segments.length - 1, 'Journal parent must exist');
      if (!create) { complete = false; break; }
      mkdirSync(part, { mode: 0o700 });
      info = lstatSync(part);
    }
    requireThat(info.isDirectory() && !info.isSymbolicLink(), 'Unsafe journal parent or directory');
    requireThat(info.uid === 0 || info.uid === process.getuid(), 'Journal parent has foreign owner');
    if (i === segments.length - 1) {
      requireThat(info.uid === process.getuid() && (info.mode & 0o077) === 0,
        'Journal directory must be owner-only');
    } else {
      requireThat((info.mode & 0o022) === 0 || (info.mode & 0o1000) !== 0,
        'Journal parent is writable by others');
    }
  }
  return complete;
}

function signClaim(claim, token) {
  const { mac, ...unsigned } = claim;
  return createHmac('sha256', token).update(JSON.stringify(unsigned)).digest('hex');
}

function readClaim(file, plan, token) {
  const info = fileInfo(file);
  if (!info) return null;
  requireThat(info.isFile() && !info.isSymbolicLink() && info.uid === process.getuid() &&
    (info.mode & 0o077) === 0 && info.size <= 4096, 'Unsafe delivery claim');
  const claim = JSON.parse(readFileSync(file, 'utf8'));
  const fields = Object.keys(claim).sort().join(',');
  requireThat(fields === (claim.phase === 'delivered'
    ? 'approvalBinding,campaignId,chatId,mac,payloadSha256,phase,receipt'
    : 'approvalBinding,campaignId,chatId,mac,payloadSha256,phase'), 'Invalid delivery claim schema');
  requireThat(claim.campaignId === plan.campaignId &&
    claim.chatId === plan.chatId && claim.payloadSha256 === plan.payloadSha256 &&
    claim.approvalBinding === approvalBinding(plan) &&
    ['sending', 'uncertain', 'delivered'].includes(claim.phase),
    'Campaign identity conflicts with delivery claim');
  requireThat(typeof claim.mac === 'string' && hex64.test(claim.mac) &&
    timingSafeEqual(Buffer.from(claim.mac, 'hex'), Buffer.from(signClaim(claim, token), 'hex')),
    'Delivery claim integrity failed');
  if (claim.phase === 'delivered') {
    requireThat(claim.receipt && Object.keys(claim.receipt).sort().join(',') ===
      'chatId,date,messageId,payloadSha256' && claim.receipt.chatId === plan.chatId &&
      claim.receipt.payloadSha256 === plan.payloadSha256 &&
      Number.isSafeInteger(claim.receipt.messageId) && claim.receipt.messageId > 0 &&
      (claim.receipt.date === null || Number.isSafeInteger(claim.receipt.date)),
      'Invalid delivery receipt');
  }
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
  if (!send) return { mode: 'dry-run', campaignId: plan.campaignId, target: { chatId: plan.chatId,
    chatTitle: plan.chatTitle, username: plan.username, botId: plan.botId },
    payloadSha256: plan.payloadSha256, approvalBinding: binding,
    journalPhase: exists && fileInfo(file) ? 'present-unverified' : 'absent' };

  requireThat(approval?.decision === 'approve' && approval?.binding === binding &&
    typeof approval?.commentUrl === 'string' && /^https:\/\/linear\.app\/0dhaus\/issue\/0D-358\//.test(approval.commentUrl),
  'Exact owner approval receipt required');
  // The caller must independently verify that commentUrl is an actual owner decision in Linear.
  requireThat(typeof token === 'string' && botTokenPattern.test(token), 'Valid local Telegram token required');
  const prior = exists ? readClaim(file, plan, token) : null;
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
  const signedClaim = { ...claim, mac: signClaim(claim, token) };
  try {
    const fd = openSync(file, 'wx', 0o600);
    try { writeFileSync(fd, JSON.stringify(signedClaim) + '\n'); }
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
    const delivered = { ...claim, phase: 'delivered', receipt };
    replaceClaim(file, { ...delivered, mac: signClaim(delivered, token) });
    return { status: 'delivered', receipt };
  } catch {
    const uncertain = { ...claim, phase: 'uncertain' };
    replaceClaim(file, { ...uncertain, mac: signClaim(uncertain, token) });
    throw new Error('Delivery outcome uncertain; never retry automatically');
  }
}
