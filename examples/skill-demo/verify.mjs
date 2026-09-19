import {readFileSync} from 'node:fs';
const text=readFileSync('release.md','utf8');
const rules={heading:/^# Release note\n/,changes:/^## Changes\n/m,risks:/^## Risks\n/m};
const rule=process.argv[2];
if(!Object.hasOwn(rules,rule))throw Error('Unknown criterion');
if(!rules[rule].test(text)){console.error(`Missing required ${rule}`);process.exitCode=1;}
