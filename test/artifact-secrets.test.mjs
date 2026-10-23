import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { assertNoSecretShapes, checkArtifacts } from "../scripts/check-no-secrets-in-artifacts.mjs";

const credential = ["sk", "ant", "runtime", "fixture", "a".repeat(24)].join("-");
const fixture = t => {
  const root = mkdtempSync(join(tmpdir(), "q-core-artifact-secrets-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const directory of ["dist", "examples"]) mkdirSync(join(root, directory));
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "artifact-fixture", version: "1.0.0", files: ["dist/"] }));
  writeFileSync(join(root, "dist", "index.mjs"), "export const normal = 'Звичайний результат';\n");
  writeFileSync(join(root, "examples", "normal.run.json"), JSON.stringify({ output: "Normal output", receipt: { success: true } }));
  return root;
};

test("exact npm package files and unpackaged example output are scanned without modifying normal bytes", t => {
  const root = fixture(t);
  const file = join(root, "examples", "normal.run.json");
  const before = readFileSync(file);
  const result = checkArtifacts({ root });
  assert.deepEqual(result, { files: 3, packageFiles: 2, exampleFiles: 1, archives: 0, secretShapes: 0 });
  assert.deepEqual(readFileSync(file), before);
});

const encodings = {
  raw: value => value,
  "JSON unicode": value => [...value].map(character => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`).join(""),
  "URL encoded": value => [...value].map(character => `%${character.charCodeAt(0).toString(16)}`).join(""),
  base64: value => Buffer.from(value).toString("base64"),
  base64url: value => Buffer.from(value).toString("base64url"),
};

for (const [encoding, encode] of Object.entries(encodings)) {
  test(`${encoding} secret shape fails for a packed file and an unpackaged example output`, t => {
    const root = fixture(t);
    for (const file of [join(root, "dist", "index.mjs"), join(root, "examples", "normal.run.json")]) {
      const before = readFileSync(file);
      writeFileSync(file, JSON.stringify({ output: encode(credential) }));
      assert.throws(() => checkArtifacts({ root }), error => {
        assert.match(error.message, /Secret-shaped string/);
        assert.equal(error.message.includes(credential), false);
        assert.equal(error.message.includes(encode(credential)), false);
        return true;
      });
      writeFileSync(file, before);
    }
  });
}

test("secret-shaped provider, GitHub, AWS, Google and bot credentials are rejected", () => {
  for (const value of [
    ["sk", "or", "v1", "a".repeat(32)].join("-"),
    ["sk", "proj", "a".repeat(32)].join("-"),
    ["sk", "a".repeat(32)].join("-"),
    "gsk_" + "a".repeat(32),
    "ghp_" + "a".repeat(32),
    "github_pat_" + "a".repeat(32),
    "AKIA" + "A".repeat(16),
    "AIza" + "a".repeat(32),
    "123456789:" + "a".repeat(32),
  ]) assert.throws(() => assertNoSecretShapes(Buffer.from(value)), /Secret-shaped string/);
});

test("actual npm archive bytes are scanned even when the working source is clean", t => {
  const root = fixture(t);
  const file = join(root, "dist", "index.mjs");
  const before = readFileSync(file);
  writeFileSync(file, credential);
  const packed = JSON.parse(execFileSync("npm", ["pack", "--ignore-scripts", "--json", "--offline", "--cache", join(root, "npm-cache")], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }))[0];
  writeFileSync(file, before);
  assert.throws(() => checkArtifacts({ root, archive: packed.filename }), /Secret-shaped string/);
});

test("release wiring retains existing gates and adds artifact and persistence guards", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url)));
  for (const script of ["prepack", "test:package"]) {
    assert.match(pkg.scripts[script], /npm run check:public-surface/);
    assert.match(pkg.scripts[script], /npm run check:product-names/);
    assert.match(pkg.scripts[script], /npm run check:persistence-writes/);
    assert.match(pkg.scripts[script], /npm run check:artifact-secrets/);
  }
  const validate = readFileSync(new URL("../.github/workflows/validate.yml", import.meta.url), "utf8");
  assert.match(validate, /npm run check:persistence-writes/);
  assert.match(validate, /npm run check:artifact-secrets -- --archive/);
});
