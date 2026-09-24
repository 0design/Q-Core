// Exercise the actual exported catalog and package, without rewriting its pins.
import assert from 'node:assert/strict';
import {readFileSync, writeFileSync, mkdtempSync, rmSync, unlinkSync} from 'node:fs';
import {resolve, join} from 'node:path';
import {tmpdir} from 'node:os';
import {createServer} from 'node:http';
import {createHash} from 'node:crypto';
import {hash} from '../src/contracts.mjs';
import {subprocess, scopedEnvironment} from '../src/subprocess.mjs';

const exported = resolve(process.argv[2]);
const bytes = readFileSync(join(exported, 'catalog.json'));
const catalog = JSON.parse(bytes);
assert.match(catalog.core.artifact, /^vendor\/q-core-[a-zA-Z0-9.-]+\.tgz$/);
const archive = join(exported, catalog.core.artifact);
assert.equal(hash(readFileSync(archive)), catalog.core.artifactSha256);
assert.equal(`sha512-${createHash('sha512').update(readFileSync(archive)).digest('base64')}`, catalog.core.integrity);
function readVerifiedExport(root) {
  const assets = new Map();
  const entries = new Set();
  for (const line of readFileSync(join(root, 'SHA256SUMS'), 'utf8').trim().split('\n')) {
    const match = /^([a-f0-9]{64})  ([a-zA-Z0-9./_-]+)$/.exec(line);
    assert.ok(match && !match[2].split('/').includes('..'));
    assert.equal(entries.has(match[2]), false, `duplicate checksum entry: ${match[2]}`);
    entries.add(match[2]);
    const body = readFileSync(join(root, match[2]));
    assert.equal(hash(body), match[1], `checksum mismatch: ${match[2]}`);
    assets.set('/registry/' + match[2], body);
  }
  assert.ok(entries.has('planned.json'), 'planned classification must be checksummed in an exported Registry');
  return assets;
}
const assets = readVerifiedExport(exported);
let deliveries = 0;
const server = createServer(async (req, res) => {
  if (req.url === '/source') return res.end('{"message":"registry transport proof"}');
  if (req.url === '/sink') {
    let body = ''; for await (const chunk of req) body += chunk;
    assert.match(body, /registry transport proof/); deliveries++;
    return res.end('{"received":true}');
  }
  const body = assets.get(req.url);
  if (!body) res.statusCode = 404;
  res.end(body ?? 'Not found');
});
const cwd = mkdtempSync(join(tmpdir(), 'qfactory-exact-registry-'));
try {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const env = {...scopedEnvironment(), QF_NO_UPDATE_CHECK:'1',
    QCORE_SOURCE_URL: base + '/source', QCORE_WEBHOOK_URL: base + '/sink'};
  const run = (exe, args) => subprocess(exe, args, {cwd, env, timeoutMs:30000});
  writeFileSync(join(cwd, 'package.json'), '{"private":true}');
  const installed = await run('npm', ['install','--ignore-scripts','--no-audit','--no-fund',archive]);
  assert.equal(installed.code, 0, installed.stderr);
  const cli = args => run(process.execPath, [join(cwd,'node_modules/q-core/bin/q-core.mjs'), ...args]);
  const registryCli = args => subprocess(process.execPath, [join(cwd,'node_modules/q-core/bin/q-core.mjs'), ...args], {
    cwd,
    env: {...env, QFACTORY_REGISTRY: exported},
    timeoutMs: 30000,
  });
  for (const [section, id, reason] of [
    ['components', 'agentation', 'No verified raw component contract exists yet'],
    ['demos', 'annotation-review', 'No verified raw demo contract or proof exists yet'],
  ]) {
    const listed = await registryCli(['catalog', '--section', section]);
    assert.equal(listed.code, 0, listed.stderr);
    assert.match(listed.stdout, new RegExp(`${id}.*planned.*launch forbidden`, 'i'));
    assert.match(listed.stdout, new RegExp(reason));
    const blocked = await registryCli(['init', id, '--offline']);
    assert.equal(blocked.code, 64, blocked.stderr);
    assert.match(`${blocked.stdout}${blocked.stderr}`, new RegExp(`${id} is planned in this registry and cannot be initialized or run`));
  }
  const destination = join(cwd, 'relay.yaml');
  const install = (digest, version, target) => cli(['install',base+'/registry',digest,'webhook-relay',version,target]);
  const result = await install(hash(bytes),'1.1.0',destination);
  assert.equal(result.code,0,result.stderr);
  assert.equal((await cli(['validate',destination])).code,0);
  const executed = await cli(['run',destination]);
  assert.equal(executed.code,0,executed.stderr);
  assert.equal(deliveries,1);
  assert.notEqual((await install(hash(bytes),'1.1.0',destination)).code,0);
  assert.notEqual((await install('0'.repeat(64),'1.1.0',join(cwd,'bad-hash.yaml'))).code,0);
  assert.notEqual((await install(hash(bytes),'999.0.0',join(cwd,'bad-version.yaml'))).code,0);
  const planned = join(exported, 'planned.json');
  const originalPlanned = readFileSync(planned);
  unlinkSync(planned);
  assert.throws(() => readVerifiedExport(exported), /planned\.json|ENOENT/);
  writeFileSync(planned, originalPlanned);
  writeFileSync(planned, Buffer.concat([originalPlanned, Buffer.from('\n ')]));
  assert.throws(() => readVerifiedExport(exported), /checksum mismatch: planned\.json/);
  writeFileSync(planned, originalPlanned);
  assert.doesNotThrow(() => readVerifiedExport(exported));
  console.log(JSON.stringify({core:catalog.core.version,registry:catalog.releaseVersion,
    catalogSha256:hash(bytes),coreSha256:catalog.core.artifactSha256,
    checks:['export checksums','clean install','HTTP download','validate','local source/sink run',
      'planned catalog/init refusal','planned checksum missing/tamper rejected',
      'overwrite rejected','wrong hash rejected','wrong version rejected'],deliveries,
    scope:'Exact candidate transport proof; not live Digest/SDD acceptance'}));
} finally {
  await new Promise(r => server.close(r));
  rmSync(cwd,{recursive:true,force:true});
}
