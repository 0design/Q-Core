import assert from 'node:assert/strict';
import { normalizeTags } from './tags.mjs';

const input = ['  JavaScript ', 'JAVASCRIPT', ' Їжак ', '', '   ', 42, null, 'КИЇВ', 'київ'];
const snapshot = structuredClone(input);

assert.deepEqual(normalizeTags(input), ['javascript', 'їжак', 'київ']);
assert.deepEqual(input, snapshot, 'normalizeTags must not mutate the input');
assert.equal(typeof normalizeTags, 'function');
assert.deepEqual(normalizeTags([]), []);
assert.deepEqual(normalizeTags(['  Ґрунт  ', 'ЄДНІСТЬ', 'ІСТОРІЯ', 'ЇЖА']), [
  'ґрунт',
  'єдність',
  'історія',
  'їжа',
]);

console.log('normalizeTags independent verification passed');
