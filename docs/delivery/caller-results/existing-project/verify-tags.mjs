import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {normalizeTags,projectLabel} from './tags.mjs';
const input=[' JS ', 'js',' ЇЖАК ','київ','КИЇВ','',42,null];const before=structuredClone(input);
assert.deepEqual(normalizeTags(input),['js','їжак','київ']);assert.deepEqual(input,before);assert.deepEqual(normalizeTags([]),[]);assert.equal(projectLabel,'existing-project');assert.ok(readFileSync(new URL('./tags.mjs',import.meta.url),'utf8').includes('// User uncommitted note: keep this note.'));
console.log('Existing project checks passed');
