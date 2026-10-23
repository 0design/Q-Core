#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// The persistence module owns the only filesystem byte-writing capability.
// Require named fs imports elsewhere: that also makes aliases reviewable without
// depending on a JavaScript parser or overlooking fs.promises / FileHandle writes.
const MUTATORS = new Set([
  'writeFile', 'writeFileSync', 'appendFile', 'appendFileSync',
  'createWriteStream', 'write', 'writeSync', 'writev', 'writevSync',
  'copyFile', 'copyFileSync', 'cp', 'cpSync',
  'truncate', 'truncateSync', 'ftruncate', 'ftruncateSync', 'open',
  'promises',
]);
const lineAt = (source, offset) => source.slice(0, offset).split('\n').length;

export function inspectPersistenceSource(source, file) {
  const path = file.replaceAll('\\', '/');
  if (path === 'src/persistence.mjs') return [];
  const findings = [];
  // This is a terminal-only human confirmation channel, never a disk sink. Keep
  // the exception exact: another writeSync call in this file still fails.
  const terminalOnly = path === 'src/human-confirmation.mjs'
    && /wfd\s*=\s*openSync\(\s*["']\/dev\/tty["']\s*,\s*["']w["']\s*\)/.test(source)
    && [...source.matchAll(/\bwriteSync\s*\(/g)].length === 1
    && /\bwriteSync\(wfd, text\)/.test(source);
  const imports = /^\s*import\s+([^;]*?)\s+from\s*(["'])(?:node:)?fs(?:\/promises)?\2/gm;
  for (const match of source.matchAll(imports)) {
    const clause = match[1].replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '').trim();
    if (!/^\{[\s\S]*\}$/.test(clause)) {
      findings.push({ file: path, line: lineAt(source, match.index), reason: 'Use named read-only fs imports; namespace/default fs imports can bypass persistence' });
      continue;
    }
    for (const part of clause.slice(1, -1).split(',')) {
      const name = part.trim().split(/\s+as\s+/)[0];
      if (MUTATORS.has(name) && !(part.trim() === 'writeSync' && terminalOnly)) {
        findings.push({ file: path, line: lineAt(source, match.index), reason: `Direct fs ${name} bypasses the guarded persistence writer` });
      }
    }
  }
  const dynamic = /\b(?:import|require)\s*\(\s*(["'`])(?:node:)?fs(?:\/promises)?\1\s*\)/g;
  for (const match of source.matchAll(dynamic)) {
    findings.push({ file: path, line: lineAt(source, match.index), reason: 'Dynamic fs imports can bypass persistence; use named read-only imports' });
  }
  const streamWrites = /\b([a-zA-Z_$][\w$]*(?:\s*\.\s*[a-zA-Z_$][\w$]*)*)\s*\.\s*write\s*\(/g;
  for (const match of source.matchAll(streamWrites)) {
    if (terminalOnly && match[1] === 'terminal') continue;
    findings.push({ file: path, line: lineAt(source, match.index), reason: 'Direct stream.write can persist output through shell redirection; use guardedStreamWrite' });
  }
  for (const match of source.matchAll(/\bconsole\s*\.\s*(?:log|error|warn|info|debug|dir|table)\s*\(/g)) {
    findings.push({ file: path, line: lineAt(source, match.index), reason: 'Console output can persist through shell redirection; use guardedStreamWrite' });
  }
  return findings;
}

export function checkPersistenceWrites(root = resolve(dirname(fileURLToPath(import.meta.url)), '..')) {
  const findings = [];
  let files = 0;
  function visit(directory) {
    if (!existsSync(directory)) return;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const file = join(directory, entry.name);
      if (entry.isDirectory()) visit(file);
      else if (/\.[cm]?[jt]s$/.test(entry.name)) {
        files++;
        findings.push(...inspectPersistenceSource(readFileSync(file, 'utf8'), relative(root, file)));
      }
    }
  }
  for (const directory of ['src', 'bin']) visit(join(root, directory));
  return { files, findings };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = checkPersistenceWrites(process.argv[2] ? resolve(process.argv[2]) : undefined);
  for (const finding of result.findings) process.stderr.write(`${finding.file}:${finding.line}: ${finding.reason}\n`);
  if (result.findings.length) process.exitCode = 1;
  else process.stdout.write(`Persistence boundary: ${result.files} source files checked; no unguarded fs writes.\n`);
}
