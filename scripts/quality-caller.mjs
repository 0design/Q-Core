// Copied into a clean package caller by test-quality-package.mjs.
import {readFileSync,mkdirSync,cpSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import assert from 'node:assert/strict';
import {qualityCheck,loadAindf,loadUnslop,upstreamDigest,designSystemDigest,hash} from 'q-core';
const config=JSON.parse(readFileSync(process.argv[2]));
const aPin={root:config.aindfRoot,packageVersion:'0.5.0-rc.1',sha256:upstreamDigest(config.aindfRoot,['cli','schemas','package.json'])};
const a=await loadAindf(aPin),ds={path:config.dsPath,sha256:designSystemDigest(config.dsPath)};
const aRequest={kind:'aindf-check',mode:'ds-readiness',upstream:{version:a.frameworkVersion,sha256:aPin.sha256},designSystem:ds,
  artifact:{revision:1,sha256:ds.sha256},requiredRules:['AINDF-AgentReady']};
const readiness=await qualityCheck(aRequest,a);assert.equal(readiness.status,'success');
mkdirSync(config.emptyDs,{recursive:true});
const empty={path:config.emptyDs,sha256:designSystemDigest(config.emptyDs)};
const emptyReadiness=await qualityCheck({...aRequest,designSystem:empty,artifact:{revision:1,sha256:empty.sha256}},a);
assert.equal(emptyReadiness.status,'needs_human');
// Corrupt only a copy of the caller's synthetic DS, never upstream source.
const badPath=join(config.emptyDs,'invalid-copy');cpSync(config.dsPath,badPath,{recursive:true});
writeFileSync(join(badPath,'src/contracts/tokens.json'),JSON.stringify({tokens:'invalid shape'}));
const badDs={path:badPath,sha256:designSystemDigest(badPath)};
const malformedReadiness=await qualityCheck({...aRequest,designSystem:badDs,artifact:{revision:1,sha256:badDs.sha256}},a);
assert.equal(malformedReadiness.status,'needs_human');
const tokens=JSON.parse(readFileSync(join(config.dsPath,'src/contracts/tokens.json')));
tokens.tokens[0].alias='missing/token';
writeFileSync(join(badPath,'src/contracts/tokens.json'),JSON.stringify(tokens));
const invalidDs={path:badPath,sha256:designSystemDigest(badPath)};
const badReadiness=await qualityCheck({...aRequest,designSystem:invalidDs,artifact:{revision:1,sha256:invalidDs.sha256}},a);
assert.equal(badReadiness.status,'failed');
const missing=await qualityCheck({...aRequest,designSystem:null},a);assert.equal(missing.status,'needs_human');
const composition=[];
for(const component of ['hero','missing-component']){
  const sections=[{component}],request={...aRequest,mode:'ui-compliance',designSystem:{...ds,sections},
    artifact:{revision:1,sha256:hash({designSystemSha256:ds.sha256,sections})},requiredRules:['composition-contract']};
  const native=await a.evaluate(request);assert.equal(native.findings[0].outcome,component==='hero'?'pass':'fail');
  const quality=await qualityCheck(request,a);assert.equal(quality.status,'needs_human');
  composition.push({component,native,quality});
}
await assert.rejects(a.evaluate({...aRequest,designSystem:{...ds,sha256:hash('stale DS')}}));
await assert.rejects(a.evaluate({...aRequest,artifact:{revision:1,sha256:hash('unrelated subject')}}));
if (config.aindfOnly) {
  console.log(JSON.stringify({evidenceKind:'clean installed Core with local native AINDF on controlled DS fixtures; no browser or full design-system acceptance',
    aindf:{pin:aPin,frameworkVersion:a.frameworkVersion,readiness,badReadiness,malformedReadiness,emptyReadiness,missing,composition}}));
  process.exit(0);
}
const uPin={root:config.unslopRoot,packageVersion:'0.1.0',sha256:upstreamDigest(config.unslopRoot,['scripts','references','package.json'])};
const u=await loadUnslop(uPin),observations=JSON.parse(readFileSync(join(config.browserRoot,'observations.json')));
const unslop=[];
for(const name of ['good','bad']){
  const css=join(config.fixtureRoot,name+'.css'),page=join(config.fixtureRoot,name+'.html');
  const captured=observations[name];
  assert.equal(hash(readFileSync(css)),captured.cssSha256);assert.equal(hash(readFileSync(page)),captured.pageSha256);
  const screenshot=join(config.browserRoot,'quality-'+name+'.png');
  assert.equal(hash(readFileSync(screenshot)),captured.screenshotSha256);
  const artifact={path:css,revision:1,sha256:captured.cssSha256};
  const request={kind:'unslop',upstream:{version:uPin.packageVersion,sha256:uPin.sha256},artifact,requiredRules:['B-1'],
    browserEvidence:{artifactHash:artifact.sha256,revision:1,sha256:captured.screenshotSha256,pageSha256:captured.pageSha256,url:captured.url}};
  const result=await qualityCheck(request,u);assert.equal(result.status,name==='good'?'success':'failed');
  const missingBrowser=await qualityCheck({...request,browserEvidence:null},u);assert.equal(missingBrowser.status,'needs_human');
  const unknownRule=await qualityCheck({...request,requiredRules:['nonexistent-rule']},u);assert.equal(unknownRule.status,'needs_human');
  const html=await u.evaluate({...request,artifact:{path:page,sha256:captured.pageSha256,revision:1}});
  assert.equal(html.findings[0].outcome,'unknown');
  unslop.push({name,result,missingBrowser,unknownRule,inapplicableHtml:html});
}
console.log(JSON.stringify({evidenceKind:'clean installed Core with actual local native upstream execution; screenshot receipts from separately observed synthetic CSS pages; no AINDF browser/full-canon acceptance',
  aindf:{pin:aPin,frameworkVersion:a.frameworkVersion,readiness,badReadiness,malformedReadiness,emptyReadiness,missing,composition},unslop:{pin:uPin,observations,results:unslop}}));
