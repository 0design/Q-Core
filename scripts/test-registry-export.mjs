// Exercise the actual exported catalog and package, without rewriting its pins.
import assert from 'node:assert/strict';
import {readFileSync, writeFileSync, mkdtempSync, rmSync} from 'node:fs';
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
const assets = new Map();
for (const line of readFileSync(join(exported, 'SHA256SUMS'), 'utf8').trim().split('\n')) {
  const match = /^([a-f0-9]{64})  ([a-zA-Z0-9./_-]+)$/.exec(line);
  assert.ok(match && !match[2].split('/').includes('..'));
  const body = readFileSync(join(exported, match[2]));
  assert.equal(hash(body), match[1]);
  assets.set('/registry/' + match[2], body);
}
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
  console.log(JSON.stringify({core:catalog.core.version,registry:catalog.releaseVersion,
    catalogSha256:hash(bytes),coreSha256:catalog.core.artifactSha256,
    checks:['export checksums','clean install','HTTP download','validate','local source/sink run',
      'overwrite rejected','wrong hash rejected','wrong version rejected'],deliveries,
    scope:'Exact candidate transport proof; not live Digest/SDD acceptance'}));
} finally {
  await new Promise(r => server.close(r));
  rmSync(cwd,{recursive:true,force:true});
}
