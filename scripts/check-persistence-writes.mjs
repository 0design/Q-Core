#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Syntax-aware lexical analysis: inspect every import declaration and member
// capability, including aliases. No source is evaluated and no parser package is
// needed at install/prepack time. Mutation capabilities are banned even when
// unused or passed elsewhere: path checks belong inside the guarded wrappers.
// Unknown computed access on an output capability
// fails closed instead of trusting one selected spelling of `write`.
const MUTATORS = new Set([
  'writeFile', 'writeFileSync', 'appendFile', 'appendFileSync',
  'createWriteStream', 'WriteStream', 'FileWriteStream',
  // Read-stream constructors accept write flags too; no runtime caller needs
  // their unrestricted constructor/options capability outside the boundary.
  'createReadStream', 'ReadStream', 'FileReadStream', 'write', 'writeSync', 'writev', 'writevSync',
  'copyFile', 'copyFileSync', 'cp', 'cpSync',
  'truncate', 'truncateSync', 'ftruncate', 'ftruncateSync',
  'mkdir', 'mkdirSync', 'mkdtemp', 'mkdtempSync', 'mkdtempDisposable', 'mkdtempDisposableSync',
  'open', 'openSync', 'rename', 'renameSync', 'link', 'linkSync', 'symlink', 'symlinkSync',
  'unlink', 'unlinkSync', 'rm', 'rmSync', 'rmdir', 'rmdirSync',
  'chmod', 'chmodSync', 'chown', 'chownSync', 'lchmod', 'lchmodSync', 'lchown', 'lchownSync',
  'fchmod', 'fchmodSync', 'fchown', 'fchownSync',
  'utimes', 'utimesSync', 'lutimes', 'lutimesSync', 'futimes', 'futimesSync',
  'fsync', 'fsyncSync', 'fdatasync', 'fdatasyncSync', 'promises',
  // A named default binding still exposes the entire filesystem namespace.
  'default',
]);
// Unknown/new fs exports fail closed too, so adding a Node mutation API does
// not silently expand the capabilities available to runtime callers.
const READ_ONLY_FS_IMPORTS = new Set([
  'access', 'accessSync', 'exists', 'existsSync', 'close', 'closeSync',
  'read', 'readSync', 'readv', 'readvSync', 'readFile', 'readFileSync',
  'readdir', 'readdirSync', 'readlink', 'readlinkSync', 'realpath', 'realpathSync',
  'lstat', 'lstatSync', 'fstat', 'fstatSync', 'stat', 'statSync', 'statfs', 'statfsSync',
  'glob', 'globSync', 'opendir', 'opendirSync', 'openAsBlob',
  'watch', 'watchFile', 'unwatchFile', 'constants', 'F_OK', 'R_OK', 'W_OK', 'X_OK',
  'Dir', 'Dirent', 'Stats', '_toUnixTimestamp',
]);
const READERS_WITH_FLAGS = new Set(['readFile', 'readFileSync']);
const CONSOLE_WRITERS = new Set([
  'assert', 'clear', 'count', 'countReset', 'debug', 'dir', 'dirxml', 'error',
  'group', 'groupCollapsed', 'groupEnd', 'info', 'log', 'table', 'time',
  'timeEnd', 'timeLog', 'trace', 'warn', 'Console',
]);
const FS_MODULES = new Set(['fs', 'node:fs', 'fs/promises', 'node:fs/promises']);
const LOADER_MODULES = new Set(['module', 'node:module']);
const lineAt = (source, offset) => source.slice(0, offset).split('\n').length;

function escapedCharacter(source, position) {
  const char = source[position];
  if (char === 'u') {
    const braced = source[position + 1] === '{';
    const end = braced ? source.indexOf('}', position + 2) : position + 5;
    const digits = source.slice(position + (braced ? 2 : 1), end);
    if (!/^[\da-f]+$/i.test(digits) || (!braced && digits.length !== 4)) throw Error('Invalid Unicode escape');
    return { value: String.fromCodePoint(Number.parseInt(digits, 16)), end: end + (braced ? 1 : 0) };
  }
  if (char === 'x') {
    const digits = source.slice(position + 1, position + 3);
    if (!/^[\da-f]{2}$/i.test(digits)) throw Error('Invalid hexadecimal escape');
    return { value: String.fromCharCode(Number.parseInt(digits, 16)), end: position + 3 };
  }
  if (char === '\n') return { value: '', end: position + 1 };
  if (char === '\r') return { value: '', end: position + (source[position + 1] === '\n' ? 2 : 1) };
  return { value: ({ n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', 0: '\0' })[char] ?? char, end: position + 1 };
}

function tokenize(source) {
  const tokens = [];
  let position = source.startsWith('#!') ? Math.max(0, source.indexOf('\n')) : 0;
  const push = (value, start, type = 'punctuation') => tokens.push({ value, start, type });
  function scan(untilTemplateBrace = false) {
    let braces = 0;
    while (position < source.length) {
      const start = position, char = source[position], next = source[position + 1];
      if (/\s/.test(char)) { position++; continue; }
      if (char === '/' && next === '/') { position = source.indexOf('\n', position + 2); if (position < 0) position = source.length; continue; }
      if (char === '/' && next === '*') {
        const end = source.indexOf('*/', position + 2);
        if (end < 0) throw Error('Unterminated comment');
        position = end + 2; continue;
      }
      if (char === '"' || char === "'") {
        let value = ''; position++;
        while (position < source.length && source[position] !== char) {
          if (source[position] === '\\') {
            const escaped = escapedCharacter(source, position + 1); value += escaped.value; position = escaped.end;
          } else value += source[position++];
        }
        if (source[position++] !== char) throw Error('Unterminated string');
        push(value, start, 'string'); continue;
      }
      if (char === '`') {
        let value = '', interpolated = false; position++;
        while (position < source.length && source[position] !== '`') {
          if (source[position] === '\\') {
            const escaped = escapedCharacter(source, position + 1); value += escaped.value; position = escaped.end;
          } else if (source[position] === '$' && source[position + 1] === '{') {
            interpolated = true; push('<template>', start, 'template'); push('(', position); position += 2; scan(true); push(')', position - 1);
          } else value += source[position++];
        }
        if (source[position++] !== '`') throw Error('Unterminated template');
        push(interpolated ? '<template>' : value, start, interpolated ? 'template' : 'string'); continue;
      }
      if (char === '/' && next !== '=') {
        const previous = tokens.at(-1);
        // Expression-start slash is a regex literal. Division remains punctuation.
        if (!previous || /^(?:[({[=,:;!?&|]|&&|\|\||\?\?|=>|return|throw|case|yield|typeof|void|delete)$/.test(previous.value)) {
          position++; let inClass = false, closed = false;
          while (position < source.length) {
            const current = source[position++];
            if (current === '\\') position++;
            else if (current === '[') inClass = true;
            else if (current === ']') inClass = false;
            else if (current === '/' && !inClass) { closed = true; break; }
          }
          if (!closed) throw Error('Unterminated regex literal');
          while (/[a-z]/i.test(source[position] ?? '')) position++;
          push('<regex>', start, 'regex'); continue;
        }
      }
      if (/[\p{ID_Start}_$]/u.test(char) || (char === '\\' && next === 'u')) {
        let value = '';
        while (position < source.length) {
          if (source[position] === '\\' && source[position + 1] === 'u') {
            const escaped = escapedCharacter(source, position + 1); value += escaped.value; position = escaped.end;
          } else if (/[\p{ID_Continue}$]/u.test(source[position])) value += source[position++];
          else break;
        }
        push(value, start, 'identifier'); continue;
      }
      if (/\d/.test(char)) {
        position++; while (/[\w.]/.test(source[position] ?? '')) position++;
        push(source.slice(start, position), start, 'number'); continue;
      }
      if (char === '{') braces++;
      if (char === '}') {
        if (untilTemplateBrace && braces === 0) { position++; return; }
        braces--;
      }
      const operator = ['?.', '=>', '===', '!==', '==', '!=', '&&', '||', '??', '...'].find(value => source.startsWith(value, position));
      position += operator?.length ?? 1; push(operator ?? char, start);
    }
    if (untilTemplateBrace) throw Error('Unterminated template interpolation');
  }
  scan();
  return tokens;
}

function pairDelimiters(tokens) {
  const pairs = new Map(), stack = [];
  for (let index = 0; index < tokens.length; index++) {
    const value = tokens[index].value;
    if (tokens[index].type !== 'punctuation') continue;
    if (['(', '[', '{'].includes(value)) stack.push(index);
    if ([')', ']', '}'].includes(value)) {
      const start = stack.pop();
      if (start === undefined || ({ '(': ')', '[': ']', '{': '}' })[tokens[start].value] !== value) throw Error('Unbalanced delimiters');
      pairs.set(start, index); pairs.set(index, start);
    }
  }
  if (stack.length) throw Error('Unbalanced delimiters');
  return pairs;
}

export function inspectPersistenceSource(source, file) {
  const path = file.replaceAll('\\', '/');
  if (path === 'src/persistence.mjs') return [];
  const findings = [], found = new Set();
  const report = (index, reason) => {
    const line = lineAt(source, tokens[index]?.start ?? 0), key = `${line}:${reason}`;
    if (!found.has(key)) { found.add(key); findings.push({ file: path, line, reason }); }
  };
  let tokens, pairs;
  try { tokens = tokenize(source); pairs = pairDelimiters(tokens); }
  catch { return [{ file: path, line: 1, reason: 'Cannot analyze JavaScript syntax; persistence capability check fails closed' }]; }
  const aliases = new Map([['process', ['process']], ['console', ['console']], ['require', ['require']], ['globalThis', ['globalThis']]]);
  const constants = new Map();
  const flaggedReaders = new Map(), readerImportTokens = new Set();
  const value = index => tokens[index]?.value;
  function constant(start, end) {
    while (value(start) === '(' && pairs.get(start) === end - 1) { start++; end--; }
    let result = '', expectValue = true;
    for (let index = start; index < end; index++) {
      const token = tokens[index];
      if (expectValue && token.type === 'string') { result += token.value; expectValue = false; }
      else if (expectValue && token.type === 'identifier' && constants.get(token.value) != null) { result += constants.get(token.value); expectValue = false; }
      else if (!expectValue && token.value === '+') expectValue = true;
      else return null;
    }
    return !expectValue ? result : null;
  }
  function reference(start, limit = tokens.length) {
    let index = start, parts;
    if (value(index) === '(') {
      const end = pairs.get(index), inner = reference(index + 1, end);
      if (!inner || inner.end !== end) return null;
      parts = inner.parts; index = end + 1;
    } else if (tokens[index]?.type === 'identifier') {
      parts = aliases.get(value(index)) ?? [value(index)]; index++;
    } else return null;
    const members = [];
    while (index < limit) {
      if (['.', '?.'].includes(value(index)) && tokens[index + 1]?.type === 'identifier') {
        parts = [...parts, value(index + 1)]; members.push({ index, parts, end: index + 2 }); index += 2;
      } else if (value(index) === '[' || (value(index) === '?.' && value(index + 1) === '[')) {
        if (value(index) === '?.') index++;
        const end = pairs.get(index); if (end === undefined || end >= limit) break;
        parts = [...parts, constant(index + 1, end) ?? '<computed>']; members.push({ index, parts, end: end + 1 }); index = end + 1;
      } else break;
    }
    return { parts, end: index, members };
  }
  function memberFinding(parts, index, end) {
    while (parts[0] === 'globalThis') parts = parts.slice(1);
    const last = parts.at(-1), object = parts.slice(0, -1);
    const output = object[0] === 'process' && ['stdout', 'stderr'].includes(object[1]);
    const consoleOutput = object[0] === 'console';
    const terminalWrite = terminalOnly && object.join('.') === 'terminal' && last === 'write';
    // Existing stdin and HTTP response calls are not output/log destinations.
    const nonOutputEnd = (path === 'src/subprocess.mjs' && object.join('.') === 'child.stdin')
      || (path === 'src/host.mjs' && object.join('.') === 'res');
    if ((last === 'write' && !terminalWrite) || (last === 'end' && !nonOutputEnd && (output || value(end) === '(' || ['call', 'apply', 'bind'].includes(value(end + 1))))) {
      report(index, 'Direct stream output capability can persist through shell redirection; use guardedStreamWrite');
    } else if ((output || consoleOutput || object.join('.') === 'process' || object.length === 0) && last === '<computed>') {
      report(index, 'Unresolved computed output capability can bypass persistence; use guardedStreamWrite');
    } else if (consoleOutput && CONSOLE_WRITERS.has(last)) {
      report(index, 'Console output can persist through shell redirection; use guardedStreamWrite');
    }
  }
  // Keep the controlling-terminal exception narrow and independent of imported
  // aliases: one writeSync(wfd, text), with wfd opened exclusively as /dev/tty.
  const writeSyncCalls = tokens.flatMap((token, index) => token.value === 'writeSync' && value(index + 1) === '(' ? [index] : []);
  const ttyAssignment = tokens.some((token, index) => token.value === 'wfd'
    && value(index + 1) === '=' && value(index + 2) === 'guardedOpenSync' && value(index + 3) === '('
    && value(index + 4) === '/dev/tty' && value(index + 5) === ',' && value(index + 6) === 'w' && value(index + 7) === ')');
  const terminalOnly = path === 'src/human-confirmation.mjs' && ttyAssignment && writeSyncCalls.length === 1
    && tokens.filter(token => token.type === 'identifier' && token.value === 'writeSync').length === 2
    && ['writeSync', '(', 'wfd', ',', 'text', ')'].every((part, offset) => value(writeSyncCalls[0] + offset) === part);

  for (let index = 0; index < tokens.length; index++) {
    if (!['import', 'export'].includes(value(index)) || ['(', '.'].includes(value(index + 1))) continue;
    let from = index + 1;
    if (tokens[from]?.type !== 'string') {
      while (from < tokens.length && value(from) !== 'from' && value(from) !== ';') {
        if (value(from) === '{') from = pairs.get(from);
        from++;
      }
    }
    const specifier = tokens[from]?.type === 'string' ? tokens[from].value : value(from + 1);
    if (value(index) === 'import' && (specifier === 'node:process' || specifier === 'process' || specifier === 'node:console' || specifier === 'console')) {
      const capability = specifier.endsWith('process') ? ['process'] : ['console'];
      if (tokens[index + 1]?.type === 'identifier') aliases.set(value(index + 1), capability);
      if (value(index + 1) === '*' && value(index + 2) === 'as') aliases.set(value(index + 3), capability);
      if (value(index + 1) === '{') {
        const end = pairs.get(index + 1);
        for (let part = index + 2; part < end; part++) {
          if (tokens[part].type !== 'identifier' && tokens[part].type !== 'string') continue;
          const imported = value(part), local = value(part + 1) === 'as' ? value(part + 2) : imported;
          aliases.set(local, [...capability, imported]);
          while (part < end && value(part) !== ',') part++;
        }
      }
    }
    if (LOADER_MODULES.has(specifier)) {
      const clauseEnd = pairs.get(index + 1);
      if (value(index + 1) !== '{' || tokens.slice(index + 2, clauseEnd).some(token => token.value === 'createRequire')) {
        report(index, 'Module loader capability can bypass persistence; use named read-only imports');
      }
      continue;
    }
    if (!FS_MODULES.has(specifier)) continue;
    if (value(index + 1) !== '{' || pairs.get(index + 1) !== from - 1) {
      report(index, 'Use named read-only fs imports; namespace/default fs imports can bypass persistence'); continue;
    }
    for (let part = index + 2; part < from - 1; part++) {
      if (value(part) === ',') continue;
      const imported = value(part), aliased = value(part + 1) === 'as';
      if (MUTATORS.has(imported) && !(imported === 'writeSync' && !aliased && terminalOnly)) {
        report(part, `Direct fs ${imported} bypasses the guarded persistence writer`);
      }
      if (!MUTATORS.has(imported) && !READ_ONLY_FS_IMPORTS.has(imported)) {
        report(part, `Unknown fs ${imported} capability; use named read-only imports or a guarded wrapper`);
      }
      if (READERS_WITH_FLAGS.has(imported)) {
        if (value(index) === 'export') report(part, 'Exported fs reader exposes writable open flags; keep options statically read-only');
        else {
          const localIndex = aliased ? part + 2 : part;
          flaggedReaders.set(value(localIndex), imported);
          readerImportTokens.add(localIndex);
          readerImportTokens.add(part);
        }
      }
      if (aliased) part += 2;
    }
  }
  function bindPattern(start, end, parts) {
    let changed = false;
    for (let index = start + 1; index < end; index++) {
      if (value(index) === ',') continue;
      if (value(index) === '...') {
        const local = value(index + 1);
        if (!aliases.has(local)) { aliases.set(local, parts); changed = true; }
        index++; continue;
      }
      let property = value(index);
      if (property === '[') {
        const close = pairs.get(index); property = constant(index + 1, close) ?? '<computed>'; index = close;
      }
      let target = index;
      if (value(index + 1) === ':') target = index + 2;
      const capability = [...parts, property];
      if (value(target) === '{') {
        const close = pairs.get(target);
        changed = bindPattern(target, close, capability) || changed; index = close;
      } else if (tokens[target]?.type === 'identifier') {
        const local = value(target);
        if (!aliases.has(local)) { aliases.set(local, capability); changed = true; }
        index = target;
      }
      // Skip an optional default value; any capabilities in it are still
      // inspected by the main member-expression walk.
      while (index < end && value(index) !== ',') {
        if (['(', '[', '{'].includes(value(index))) index = pairs.get(index);
        index++;
      }
    }
    return changed;
  }
  // Flow-insensitive alias union is deliberately conservative: reassignment or
  // shadowing cannot erase a previously observed output capability.
  for (let pass = 0; pass < tokens.length; pass++) {
    let changed = false;
    for (let index = 0; index < tokens.length; index++) {
      if (tokens[index].type === 'identifier' && value(index + 1) === '=') {
        let end = index + 2;
        while (end < tokens.length && ![';', ','].includes(value(end))) {
          if (pairs.has(end) && ['(', '[', '{'].includes(value(end))) end = pairs.get(end);
          end++;
        }
        const literal = constant(index + 2, end);
        if (literal !== null && !constants.has(value(index))) { constants.set(value(index), literal); changed = true; }
        else if (constants.has(value(index)) && constants.get(value(index)) !== null && constants.get(value(index)) !== literal) { constants.set(value(index), null); changed = true; }
        const ref = reference(index + 2, end);
        if (ref && !aliases.has(value(index)) && ['process', 'console', 'require', 'globalThis'].includes(ref.parts[0])) {
          aliases.set(value(index), ref.parts); changed = true;
        }
      }
      if (value(index) === '{' && value(pairs.get(index) + 1) === '=') {
        const end = pairs.get(index), ref = reference(end + 2);
        if (!ref) continue;
        if (['process', 'console', 'require', 'globalThis'].includes(ref.parts[0])) {
          changed = bindPattern(index, end, ref.parts) || changed;
        }
      }
    }
    if (!changed) break;
  }
  for (let index = 0; index < tokens.length; index++) {
    if (['.', '?.'].includes(value(index - 1))) continue;
    const ref = reference(index);
    if (!ref) continue;
    for (const member of ref.members) memberFinding(member.parts, member.index, member.end);
    // Imported/destructured/assigned methods also carry the writer capability.
    if (aliases.has(value(index)) && ref.parts.length > 1) memberFinding(ref.parts, index, ref.end);
    const loader = ref.parts[0] === 'globalThis' ? ref.parts.slice(1) : ref.parts;
    const builtinLoader = loader.join('.') === 'process.getBuiltinModule';
    if ((value(index) === 'import' || loader[0] === 'require' || builtinLoader) && value(ref.end) === '(') {
      const end = pairs.get(ref.end);
      // The specifier is the first argument only: import('node:fs', {}) and a trailing comma must not hide it.
      let specifierEnd = ref.end + 1;
      while (specifierEnd < end && value(specifierEnd) !== ',') {
        if (['(', '[', '{'].includes(value(specifierEnd))) specifierEnd = pairs.get(specifierEnd);
        specifierEnd++;
      }
      const module = constant(ref.end + 1, specifierEnd);
      // An unresolved specifier (spread, interpolated template, computed value) could name a filesystem module:
      // fail closed rather than chase each spelling. call/apply/bind keep their own argument inspection below.
      // pathToFileURL(...) always yields a file: URL, never a builtin specifier such as node:fs.
      const directCall = !(loader[0] === 'require' && loader.length > 1);
      const fileUrl = value(ref.end + 1) === 'pathToFileURL' && value(ref.end + 2) === '(' && pairs.get(ref.end + 2) + 1 === specifierEnd
        || value(ref.end + 1) === 'pathToFileURL' && value(ref.end + 2) === '(' && value(pairs.get(ref.end + 2) + 1) === '.' && value(pairs.get(ref.end + 2) + 2) === 'href' && pairs.get(ref.end + 2) + 3 === specifierEnd;
      let unsafeModule = FS_MODULES.has(module) || LOADER_MODULES.has(module) || (directCall && module === null && !fileUrl);
      // call/apply/bind retain the filesystem-loading capability. Inspect their
      // argument expressions (including apply's array) instead of matching one
      // spelling of require('fs').
      if (loader[0] === 'require' && loader.length > 1) {
        for (let argument = ref.end + 1; argument < end; argument++) {
          let argumentEnd = argument;
          while (argumentEnd < end && value(argumentEnd) !== ',') {
            if (['(', '[', '{'].includes(value(argumentEnd))) argumentEnd = pairs.get(argumentEnd);
            argumentEnd++;
          }
          const moduleName = constant(argument, argumentEnd);
          if (FS_MODULES.has(moduleName) || LOADER_MODULES.has(moduleName)) unsafeModule = true;
          if (value(argument) === '[') {
            const arrayEnd = pairs.get(argument);
            const firstEnd = tokens.findIndex((token, at) => at > argument && at < arrayEnd && token.value === ',');
            const first = constant(argument + 1, firstEnd < 0 ? arrayEnd : firstEnd);
            if (FS_MODULES.has(first) || LOADER_MODULES.has(first)) unsafeModule = true;
          }
          argument = argumentEnd;
        }
      }
      if (unsafeModule) report(index, 'Dynamic filesystem/module loaders can bypass persistence; use named read-only imports');
    }
  }
  // readFile's innocuous name still exposes open flags (`flag: 'w'` can create
  // or truncate). Permit only direct calls whose options cannot contain one.
  function safeReadOptions(start, end) {
    if (start === end) return true;
    if (tokens[start]?.type === 'string' && start + 1 === end) return true;
    if (value(start) === 'null' && start + 1 === end) return true;
    if (value(start) !== '{' || pairs.get(start) !== end - 1) return false;
    let ownReadFlag = false;
    for (let index = start + 1; index < end - 1; index++) {
      if (value(index) === ',') continue;
      const key = value(index);
      if (!['identifier', 'string'].includes(tokens[index]?.type) || key === '__proto__' || value(index + 1) !== ':') return false;
      const expression = index + 2;
      let expressionEnd = expression;
      while (expressionEnd < end - 1 && value(expressionEnd) !== ',') {
        if (['(', '[', '{'].includes(value(expressionEnd))) expressionEnd = pairs.get(expressionEnd);
        expressionEnd++;
      }
      if (key === 'flag') {
        if (!(expression + 1 === expressionEnd
            && ((tokens[expression]?.type === 'string' && ['r', 'rs', 'sr'].includes(value(expression)))
              || value(expression) === '0'))) return false;
        ownReadFlag = true;
      }
      index = expressionEnd;
    }
    // An own flag also defeats an inherited writable Object.prototype.flag.
    return ownReadFlag;
  }
  for (let index = 0; index < tokens.length; index++) {
    if (tokens[index].type !== 'identifier' || !flaggedReaders.has(value(index)) || readerImportTokens.has(index)) continue;
    if (value(index + 1) !== '(') {
      report(index, 'Escaped fs reader capability exposes writable open flags; use a direct statically read-only call');
      continue;
    }
    const end = pairs.get(index + 1);
    if (value(index + 2) === '...') {
      report(index, 'Spread fs reader arguments can hide writable open flags; use a direct statically read-only call');
      continue;
    }
    let argument = index + 2;
    while (argument < end && value(argument) !== ',') {
      if (['(', '[', '{'].includes(value(argument))) argument = pairs.get(argument);
      argument++;
    }
    if (argument === end) continue;
    const optionsStart = argument + 1;
    argument = optionsStart;
    while (argument < end && value(argument) !== ',') {
      if (['(', '[', '{'].includes(value(argument))) argument = pairs.get(argument);
      argument++;
    }
    if (!safeReadOptions(optionsStart, argument)) report(index, 'fs reader options can mutate paths through open flags; keep options statically read-only');
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
