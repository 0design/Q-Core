import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hash } from "../src/contracts.mjs";
import { installPinned } from "../src/registry-release.mjs";
test("independent pinned catalog -> checksum -> validate -> install; corruption rejected", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "q-core-registry-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, "workflows"));
  const body =
    "manifest: q-core.workflow/v1\nid: synthetic\nversion: 1.0.0\nsteps:\n  - id: gate\n    kind: approval-gate\n    config: { reviewer: human }\n";
  writeFileSync(join(dir, "workflows/synthetic.yaml"), body);
  const catalog = JSON.stringify({
    releaseVersion: "fixture.1",
    core: {
      package: "q-core",
      version: JSON.parse(
        readFileSync(new URL("../package.json", import.meta.url)),
      ).version,
      manifest: "q-core.workflow/v1",
    },
    workflows: [
      {
        id: "synthetic",
        version: "1.0.0",
        file: "workflows/synthetic.yaml",
        sha256: hash(body),
        dependencies: [],
      },
    ],
  });
  writeFileSync(join(dir, "catalog.json"), catalog);
  const request = {
    base: dir,
    catalogSha256: hash(catalog),
    id: "synthetic",
    version: "1.0.0",
    destination: join(dir, "installed.yaml"),
  };
  assert.equal((await installPinned(request)).sha256, hash(body));
  assert.equal(readFileSync(request.destination, "utf8"), body);
  await assert.rejects(installPinned(request), /Destination exists/);
  await assert.rejects(installPinned({ ...request, version: "2.0.0" }), {
    code: "VERSION_NOT_FOUND",
  });
  await assert.rejects(
    installPinned({ ...request, catalogSha256: "0".repeat(64) }),
    { code: "CHECKSUM_MISMATCH" },
  );
  writeFileSync(join(dir, "workflows/synthetic.yaml"), body + "# tamper");
  await assert.rejects(installPinned(request), { code: "CHECKSUM_MISMATCH" });
});

test("localhost catalog transport verifies exact bytes and refuses remote plaintext", async (t) => {
  const { createServer } = await import("node:http");
  const { readAsset } = await import("../src/registry-release.mjs");
  const server = createServer((req, res) => res.end("fixture catalog"));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => server.close(r)));
  assert.equal(
    (
      await readAsset(
        `http://127.0.0.1:${server.address().port}`,
        "catalog.json",
      )
    ).toString(),
    "fixture catalog",
  );
  await assert.rejects(
    readAsset("http://example.com", "catalog.json"),
    /HTTPS/,
  );
  await assert.rejects(readAsset("http://127.0.0.1", "../secret"), /Unsafe/);
});

test('dependency graph rejects ambiguity, cycles, malformed sections and mismatched paths before writing',async t=>{
  const {existsSync}=await import('node:fs');
  const dir=mkdtempSync(join(tmpdir(),'q-core-graph-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  mkdirSync(join(dir,'workflows'));mkdirSync(join(dir,'components'));
  const body='manifest: q-core.workflow/v1\nid: target\nversion: 1.0.0\nsteps:\n  - id: gate\n    kind: approval-gate\n    config: { reviewer: human }\n';
  writeFileSync(join(dir,'workflows/target.yaml'),body);
  const pkg=JSON.parse(readFileSync(new URL('../package.json',import.meta.url)));
  const workflow={id:'target',version:'1.0.0',file:'workflows/target.yaml',sha256:hash(body),dependencies:[]};
  const base={releaseVersion:'test.1',core:{package:'q-core',version:pkg.version,manifest:'q-core.workflow/v1'},workflows:[workflow],components:[]};
  const cases=[
    [{...base,workflows:[{...workflow,dependencies:[{id:'target',version:'1.0.0'}]}]},/cycle/],
    [{...base,workflows:[{...workflow,dependencies:[{id:'target',version:'1.0.0'}]}],components:[{...workflow,file:'components/target.json'}]},/Ambiguous/],
    [{...base,workflows:[{...workflow,dependencies:[{id:'missing',version:'1.0.0'}]}]},/Unresolved/],
    [{...base,components:{}},/section/],
    [{...base,workflows:[{...workflow,dependencies:{}}]},/Dependencies/],
    [{...base,workflows:[{...workflow,dependencies:[{id:'missing',version:'latest'}]}]},/Dependencies/],
    [{...base,workflows:[{...workflow,file:'components/target.json'}]},/section and identity/],
    [{...base,workflows:[{...workflow,engine:{...base.core,version:'different'}}]},/engine differs/],
  ];
  for(const [catalog,error] of cases){
    const bytes=JSON.stringify(catalog);writeFileSync(join(dir,'catalog.json'),bytes);
    const destination=join(dir,'result.yaml');
    await assert.rejects(installPinned({base:dir,catalogSha256:hash(bytes),id:'target',version:'1.0.0',destination}),error);
    assert.equal(existsSync(destination),false);assert.equal(existsSync(destination+'.lock.json'),false);
  }
});

function releaseFixture(t, releaseDir, releaseVersion) {
  const root = mkdtempSync(join(tmpdir(), "q-core-release-pin-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = join(root, "releases", releaseDir);
  mkdirSync(join(dir, "workflows"), { recursive: true });
  const body =
    "manifest: q-core.workflow/v1\nid: synthetic\nversion: 1.0.0\nsteps:\n  - id: gate\n    kind: approval-gate\n    config: { reviewer: human }\n";
  writeFileSync(join(dir, "workflows/synthetic.yaml"), body);
  const catalog = JSON.stringify({
    releaseVersion,
    core: { package: "q-core", version: JSON.parse(readFileSync(new URL("../package.json", import.meta.url))).version, manifest: "q-core.workflow/v1" },
    workflows: [{ id: "synthetic", version: "1.0.0", file: "workflows/synthetic.yaml", sha256: hash(body), dependencies: [] }],
  });
  writeFileSync(join(dir, "catalog.json"), catalog);
  return { dir, catalog, request: { base: dir, catalogSha256: hash(catalog), id: "synthetic", version: "1.0.0", destination: join(root, "installed.yaml") } };
}

test("release version is pinned separately from the catalog hash", async (t) => {
  // A foreign release catalog with its own valid hash, served under another release path, is refused.
  const foreign = releaseFixture(t, "fixture.14", "fixture.13");
  await assert.rejects(installPinned(foreign.request), { code: "RELEASE_MISMATCH" });
  await assert.rejects(installPinned({ ...foreign.request, releaseVersion: "fixture.14" }), { code: "RELEASE_MISMATCH" });
  await assert.rejects(installPinned({ ...foreign.request, releaseVersion: "fixture.13" }), { code: "RELEASE_MISMATCH" }, "flag must agree with the release path");
  // The matching release installs; an explicit --release must equal it.
  const own = releaseFixture(t, "fixture.14", "fixture.14");
  await assert.rejects(installPinned({ ...own.request, releaseVersion: "fixture.15" }), { code: "RELEASE_MISMATCH" });
  await assert.rejects(installPinned({ ...own.request, releaseVersion: "fixture.14-candidate" }), { code: "RELEASE_MISMATCH" });
  assert.equal((await installPinned({ ...own.request, releaseVersion: "fixture.14" })).id, "synthetic");
  // A remote non-localhost base must name its release; this is refused before any request is made.
  await assert.rejects(installPinned({ ...own.request, base: "https://registry.example.invalid", destination: join(own.dir, "x.yaml") }), { code: "RELEASE_REQUIRED" });
});

test("truncated or corrupt catalog with its own hash fails with a stable code", async (t) => {
  const { dir, catalog, request } = releaseFixture(t, "fixture.14", "fixture.14");
  for (const bytes of [catalog.slice(0, Math.floor(catalog.length / 2)), Buffer.from([0xff, 0xfe, 0x7b]), "[]", "null"]) {
    writeFileSync(join(dir, "catalog.json"), bytes);
    await assert.rejects(installPinned({ ...request, catalogSha256: hash(Buffer.from(bytes)) }), { code: "CATALOG_INVALID" });
  }
});
