#!/usr/bin/env node
import { readFileSync, lstatSync } from 'node:fs';
import { telegramOneShot } from '../src/telegram-one-shot.mjs';

function options(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--send') { out.send = true; continue; }
    if (!['--plan', '--payload', '--journal', '--approval', '--token-file'].includes(flag) || !argv[i + 1])
      throw new Error('Invalid command arguments');
    if (out[flag]) throw new Error('Duplicate command argument');
    out[flag] = argv[++i];
  }
  if (!out['--plan'] || !out['--payload'] || !out['--journal']) throw new Error('Plan, payload and journal required');
  if (out.send !== true && (out['--approval'] || out['--token-file']))
    throw new Error('Approval and credential are used only with --send');
  if (out.send === true && (!out['--approval'] || !out['--token-file']))
    throw new Error('Approval and credential required for --send');
  return out;
}

function safeRead(path, credential = false) {
  const info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 65536)
    throw new Error('Unsafe input file');
  if (credential && (info.mode & 0o077)) throw new Error('Credential file must be private');
  return readFileSync(path, 'utf8');
}

try {
  const args = options(process.argv.slice(2));
  const result = await telegramOneShot({
    plan: JSON.parse(safeRead(args['--plan'])),
    payload: safeRead(args['--payload']),
    journalDir: args['--journal'],
    send: args.send === true,
    approval: args.send ? JSON.parse(safeRead(args['--approval'])) : undefined,
    token: args.send ? safeRead(args['--token-file'], true).trim() : undefined,
  });
  process.stdout.write(JSON.stringify(result) + '\n');
} catch (error) {
  // Errors intentionally omit input contents and Telegram URLs, which contain the bot token.
  process.stderr.write(`telegram-one-shot: ${error.message}\n`);
  process.exitCode = 1;
}
