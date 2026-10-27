import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { validateManifest } from '../src/manifest.mjs';

const base = () => ({ manifest:'q-core.workflow/v1',id:'prepared-input',inputs:{subject:{type:'object'}},
  steps:[{id:'review',kind:'approval-gate',config:{reviewer:'human',bind:'sha256',source:'{{inputs.subject}}'}}] });

test('explicit gate source requires a declared required object input and exact human hash binding', () => {
  assert.equal(validateManifest(base()).steps[0].config.source,'{{inputs.subject}}');
  const changes = [
    x=>delete x.inputs, x=>x.inputs.subject.type='string', x=>x.inputs.subject.required=false,
    x=>x.steps[0].config.source='{{inputs.missing}}', x=>x.steps[0].config.source='{{steps.other.output}}',
    x=>x.steps[0].config.source='prefix {{inputs.subject}}', x=>x.steps[0].config.subject='previous',
    x=>delete x.steps[0].config.bind, x=>x.steps[0].config.reviewer='agent',
  ];
  for (const change of changes) { const value=base();change(value);assert.throws(()=>validateManifest(value),/source/); }
  assert.throws(()=>validateManifest({...base(),steps:[{id:'lane',kind:'if',config:{condition:'true'},then:base().steps}],inputs:{}}),/source/);
});

test('prepared input reaches a real native gate and local effect without inference or a source fetch', () => {
  // Only new temporary workflows/keys/simulated terminal. No existing state accepted.
  const fixture=fileURLToPath(new URL('./fixtures/host-input-native-case.mjs',import.meta.url));
  const child=spawnSync(process.execPath,[fixture],{env:{PATH:process.env.PATH},encoding:'utf8',timeout:20000});
  assert.equal(child.status,0,child.stderr||child.stdout||child.error?.message);
  const result=JSON.parse(child.stdout);assert.equal(result.passed,true);assert.equal(result.local_effects,2);
  assert.equal(result.model_calls,0);assert.equal(result.social_posted,false);
});
