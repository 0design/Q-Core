import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { checkPersistenceWrites, inspectPersistenceSource } from '../scripts/check-persistence-writes.mjs';

// Every path/content/metadata mutation capability is rejected at import,
// before aliases, data-derived pathnames or callback styles can hide its use.
const mutationApis = [
  'writeFile', 'writeFileSync', 'appendFile', 'appendFileSync',
  'createWriteStream', 'WriteStream', 'FileWriteStream',
  'createReadStream', 'ReadStream', 'FileReadStream',
  'write', 'writeSync', 'writev', 'writevSync',
  'copyFile', 'copyFileSync', 'cp', 'cpSync',
  'truncate', 'truncateSync', 'ftruncate', 'ftruncateSync',
  'mkdir', 'mkdirSync', 'mkdtemp', 'mkdtempSync', 'mkdtempDisposable', 'mkdtempDisposableSync',
  'open', 'openSync', 'rename', 'renameSync', 'link', 'linkSync', 'symlink', 'symlinkSync',
  'unlink', 'unlinkSync', 'rm', 'rmSync', 'rmdir', 'rmdirSync',
  'chmod', 'chmodSync', 'chown', 'chownSync', 'lchmod', 'lchmodSync', 'lchown', 'lchownSync',
  'fchmod', 'fchmodSync', 'fchown', 'fchownSync',
  'utimes', 'utimesSync', 'lutimes', 'lutimesSync', 'futimes', 'futimesSync',
  'fsync', 'fsyncSync', 'fdatasync', 'fdatasyncSync',
];

const rejected = [
  ...mutationApis.map(api => [`fs ${api} mutation capability`, `import { ${api} as mutate } from 'node:fs'; mutate(secret);`]),
  ['reviewer mkdirSync secret path', "import { mkdirSync } from 'node:fs'; mkdirSync(secret);"],
  ['reviewer openSync secret path', "import { openSync } from 'node:fs'; openSync(secret, 'w');"],
  ['write-mode open flag alias', "import { openSync as acquire } from 'node:fs'; const flags = 'a+'; acquire(secret, flags);"],
  ['read-only direct open capability also stays guarded', "import { openSync } from 'node:fs'; openSync(path, 'r');"],
  ['dynamic import with options', "const fs = await import('node:fs', {}); fs.mkdirSync(secret);"],
  ['dynamic import with trailing comma', "const fs = await import('node:fs',); fs.openSync(secret, 'w');"],
  ['dynamic promises import with options', "const fsp = await import('node:fs/promises', { with: {} }); await fsp.rename(source, secret);"],
  ['require with extra argument', "const fs = require('fs', 1); fs.linkSync(source, secret);"],
  ['unknown future fs capability', "import { futureMutation } from 'node:fs'; futureMutation(secret);"],
  ...['fs', 'node:fs', 'fs/promises', 'node:fs/promises'].flatMap(module => [
    [`mkdir alias from ${module}`, `import {mkdir as make} from '${module}'; make(secret);`],
    [`open write flag from ${module}`, `import {open as acquire} from '${module}'; acquire(secret, 'w');`],
    [`rename into secret from ${module}`, `import {rename as move} from '${module}'; move(source, secret);`],
    [`copy secret filename from ${module}`, `import {copyFile as copy} from '${module}'; copy(source, secret);`],
    [`recursive copy from ${module}`, `import {cp as copy} from '${module}'; copy(source, secret);`],
    [`link secret destination from ${module}`, `import {link as bind} from '${module}'; bind(source, secret);`],
    [`symlink secret target from ${module}`, `import {symlink as bind} from '${module}'; bind(secret, destination);`],
    [`truncate secret path from ${module}`, `import {truncate as cut} from '${module}'; cut(secret, 0);`],
    [`append secret path from ${module}`, `import {appendFile as add} from '${module}'; add(secret, data);`],
    [`data-derived removal from ${module}`, `import {rm as remove} from '${module}'; remove(join(root, secret));`],
    [`namespace mkdir from ${module}`, `import * as disk from '${module}'; disk.mkdir(secret);`],
    [`default rename from ${module}`, `import disk from '${module}'; disk.rename(source, secret);`],
    [`dynamic destructured link from ${module}`, `const {link: bind} = await import('${module}'); bind(source, secret);`],
    [`require destructured unlink from ${module}`, `const {unlink: remove} = require('${module}'); remove(secret);`],
  ]),
  ['reader inherited empty options flag', "import { readFileSync as read } from 'node:fs'; Object.prototype.flag='w'; read(secret, {});"],
  ['reader inherited options flag', "import { readFileSync as read } from 'node:fs'; Object.prototype.flag='w'; read(secret, {encoding:'utf8'});"],
  ['reader shadowed undefined options', "import { readFileSync as read } from 'node:fs'; function f(undefined){read(secret, undefined);} f({flag:'w'});"],
  ['reader spread args', "import {readFileSync} from 'node:fs'; const args=[secret,{flag:'w'}]; readFileSync(...args);"],
  ['reader spread followed by encoding', "import {readFileSync} from 'node:fs'; readFileSync(...[secret,{flag:'w'}], 'utf8');"],
  ['readFileSync writable flag', "import { readFileSync } from 'node:fs'; readFileSync(secret, {flag:'w'});"],
  ['readFileSync numeric write flag', "import { readFileSync } from 'node:fs'; readFileSync(secret, {flag:1});"],
  ['readFileSync numeric read-write flag', "import { readFileSync } from 'node:fs'; readFileSync(secret, {flag:2});"],
  ['readFileSync read-write flag', "import { readFileSync } from 'node:fs'; readFileSync(secret, {flag:'r+'});"],
  ['readFileSync unknown options', "import { readFileSync } from 'node:fs'; readFileSync(secret, options);"],
  ['readFileSync spread options', "import { readFileSync } from 'node:fs'; readFileSync(secret, {...options});"],
  ['readFileSync computed flag', "import { readFileSync } from 'node:fs'; readFileSync(secret, {['flag']:'w'});"],
  ['readFileSync getter flag', "import { readFileSync } from 'node:fs'; readFileSync(secret, {get flag(){return 'w';}});"],
  ['readFileSync prototype flag', "import { readFileSync } from 'node:fs'; readFileSync(secret, {__proto__:options});"],
  ['readFileSync escaped capability', "import { readFileSync } from 'node:fs'; const read = readFileSync; read(secret, options);"],
  ['readFileSync bound capability', "import { readFileSync as read } from 'node:fs'; const bound = read.bind(null, secret);"],
  ['readFileSync reassigned flag', "import { readFileSync } from 'node:fs'; let flag = 'r'; flag += '+'; readFileSync(secret, {flag});"],
  ['readFileSync flag expression', "import { readFileSync } from 'node:fs'; let flag = 'r'; flag += '+'; readFileSync(secret, {flag: flag});"],
  ['reader export', "export { readFileSync } from 'node:fs';"],
  ['promise readFile writable flag', "import { readFile as read } from 'node:fs/promises'; await read(secret, {flag:'w'});"],
  ['callback readFile writable flag', "import { readFile as read } from 'node:fs'; read(secret, {flag:'w'}, callback);"],
  ['second import on same line', "import { readFileSync } from 'node:fs'; import { writeFileSync as save } from 'node:fs'; save(path, secret);"],
  ['quoted import name', 'import { "writeFileSync" as save } from "node:fs"; save(path, secret);'],
  ['escaped fs module name', String.raw`import { writeFileSync as save } from 'node:\u0066s'; save(path, secret);`],
  ['fs re-export alias', "export { writeFileSync as save } from 'node:fs';"],
  ['fs namespace re-export', "export * from 'node:fs';"],
  ...['fs', 'node:fs', 'fs/promises', 'node:fs/promises'].flatMap(module => [
    [`named default namespace from ${module}`, `import {default as disk} from '${module}'; disk.writeFile(path, secret);`],
    [`quoted default namespace from ${module}`, `import {'default' as disk} from '${module}'; disk.writeFile(path, secret);`],
    [`named default re-export from ${module}`, `export {default as disk} from '${module}';`],
    [`quoted default re-export from ${module}`, `export {'default' as disk} from '${module}';`],
  ]),
  ['stdout termination', 'process.stdout.end(secret);'],
  ['stderr termination', 'process.stderr.end(secret);'],
  ['injected stream termination', 'out.end(secret);'],
  ['computed write', 'process.stdout["write"](secret);'],
  ['computed termination', 'process.stderr["end"](secret);'],
  ['optional computed write', 'process?.stdout?.["write"]?.(secret);'],
  ['concatenated computed write', 'process.stdout["wr" + "ite"](secret);'],
  ['escaped computed write', String.raw`process.stdout["\u0077rite"](secret);`],
  ['escaped process identifier', String.raw`\u0070rocess.stdout.end(secret);`],
  ['static computed method alias', 'const method = "write"; process.stdout[method](secret);'],
  ['reassigned computed method alias', 'let method = "isTTY"; method = "write"; process.stdout[method](secret);'],
  ['unknown computed output', 'process.stdout[method](secret);'],
  ['stdout alias', 'const output = process.stdout; output.end(secret);'],
  ['process alias chain', 'const p = process; const output = p["stderr"]; const other = output; other["end"](secret);'],
  ['destructured stdout alias', 'const { stdout: output } = process; output.end(secret);'],
  ['nested destructured output method', 'const { stdout: {end: finish} } = process; finish(secret);'],
  ['unknown computed process member', 'process[streamName][method](secret);'],
  ['unknown computed global member', 'globalThis[processName][streamName][method](secret);'],
  ['computed destructured stdout alias', 'const {["stdout"]: output} = process; output.end(secret);'],
  ['destructured method alias', 'const { end: finish } = process.stdout; finish(secret);'],
  ['extracted method alias', 'const finish = process.stdout.end; finish(secret);'],
  ['bound method alias', 'const finish = process.stdout.end.bind(process.stdout); finish(secret);'],
  ['namespace process alias', 'import * as p from "node:process"; p.stdout.end(secret);'],
  ['default process alias', 'import p from "node:process"; p.stdout.end(secret);'],
  ['imported stdout alias', 'import { stdout as output } from "node:process"; output.end(secret);'],
  ...['assert', 'trace', 'timeLog', 'timeEnd', 'count', 'countReset', 'group', 'groupCollapsed', 'dirxml'].map(method => [`console ${method} output`, `console.${method}(secret);`]),
  ['console constructor output capability', 'import {Console as Output} from "node:console"; const output = new Output(sink);'],
  ['console method alias', 'const output = console; const {error: report} = output; report(secret);'],
  ['computed console output', 'console["err" + "or"](secret);'],
  ['imported console method alias', 'import { error as report } from "node:console"; report(secret);'],
  ['aliased require', 'const load = require; const disk = load("node:fs");'],
  ['require.call filesystem loader', 'const disk = require.call(null, "node:fs"); disk.writeFileSync(path, secret);'],
  ['require.apply filesystem loader', 'const disk = require.apply(null, ["node:fs"]); disk.writeFileSync(path, secret);'],
  ['require.bind filesystem loader', 'const load = require.bind(null, "node:fs"); const disk = load(); disk.writeFileSync(path, secret);'],
  ['aliased require.call loader', 'const load = require; const disk = load.call(null, "node:fs");'],
  ['createRequire alias', 'import {createRequire as makeLoader} from "node:module"; const load = makeLoader(import.meta.url); load("node:fs");'],
  ['module namespace loader', 'import * as modules from "node:module"; const load = modules.createRequire(import.meta.url); load("node:fs");'],
  ['dynamic module loader', 'const {createRequire} = await import("node:module"); const load = createRequire(import.meta.url); load("node:fs");'],
  ['builtin filesystem loader', 'const disk = process.getBuiltinModule("fs"); disk.writeFileSync(path, secret);'],
  ['dynamic module constant', 'const moduleName = "node:" + "fs"; const disk = await import(moduleName);'],
  ['template interpolation writer', '`text ${process.stdout.end(secret)} text`;'],
  ['nested template interpolation writer', '`text ${`more ${process.stdout["write"](secret)}`} text`;'],
];
for (const [name, source] of rejected) {
  test(`persistence syntax check rejects ${name}`, () => {
    const findings = inspectPersistenceSource(source, 'src/review-example.mjs');
    assert.ok(findings.length, source);
    assert.ok(findings.every(finding => !finding.reason.startsWith('Cannot analyze')), `Must detect the capability structurally: ${source}`);
  });
}

for (const [name, source] of [
  ['reader names in plain strings', 'import { readFileSync } from "node:fs"; const text = "readFileSync"; readFileSync(path);'],
  ['reader default flags', 'import { readFileSync as read } from "node:fs"; read(path);'],
  ['reader null options', 'import { readFileSync as read } from "node:fs"; read(path, null);'],
  ['reader literal encoding', 'import { readFileSync as read } from "node:fs"; read(path, "utf8");'],
  ['reader literal encoding options', 'import { readFileSync as read } from "node:fs"; read(path, {encoding:"utf8", flag:"r"});'],
  ...['r', 'rs', 'sr'].map(flag => [`reader literal ${flag} flag`, `import { readFileSync as read } from 'node:fs'; read(path, {flag:'${flag}'});`]),
  ['reader literal zero flag', 'import { readFileSync as read } from "node:fs"; read(path, {flag:0});'],
  ['promise reader literal read-only flag', 'import { readFile as read } from "node:fs/promises"; await read(path, {flag:"r", encoding:"utf8"});'],
  ['named read-only imports', 'import { readFileSync as read, statSync } from "node:fs"; read(path);'],
  ['writer text in strings and comments', 'const example = "process.stdout.end(secret)"; /* import {writeFileSync} from "node:fs"; */ // out.write(secret)\n'],
  ['writer text in regex', 'const example = /process.stdout.end(secret)/; const other = true || /out.write(secret)/;'],
  ['numeric end property', 'const length = item.end + 1; const items = list.slice(0, item.end);'],
  ['safe process property alias', 'const p = process; const output = p.stdout; const tty = output.isTTY;'],
  ['static local dynamic import', 'const module = await import("./safe.mjs");'],
]) {
  test(`persistence syntax check preserves ${name}`, () => {
    assert.deepEqual(inspectPersistenceSource(source, 'src/review-example.mjs'), []);
  });
}

test('persistence syntax check fails closed on unanalyzable source', () => {
  assert.match(inspectPersistenceSource('process.stdout[', 'src/broken.mjs')[0].reason, /fails closed/);
});

test('persistence syntax check scans the complete runtime tree', () => {
  const result = checkPersistenceWrites();
  assert.ok(result.files > 20);
  assert.deepEqual(result.findings, []);
});

test('terminal exception cannot leak its imported writer through an alias', () => {
  const source = readFileSync(new URL('../src/human-confirmation.mjs', import.meta.url), 'utf8');
  assert.deepEqual(inspectPersistenceSource(source, 'src/human-confirmation.mjs'), []);
  assert.ok(inspectPersistenceSource(`${source}\nconst writeDisk = writeSync; writeDisk(fd, secret);`, 'src/human-confirmation.mjs').length > 0);
});
