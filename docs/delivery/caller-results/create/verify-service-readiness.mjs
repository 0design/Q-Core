import { readFile } from 'node:fs/promises';

const [mode, filename] = process.argv.slice(2);
if (!mode || !filename || !['success', 'negative'].includes(mode)) {
  console.error('usage: node verify-service-readiness.mjs <success|negative> <run-record.json>');
  process.exit(2);
}

const record = JSON.parse(await readFile(filename, 'utf8'));
const fail = (message) => {
  console.error(`independent verification failed: ${message}`);
  process.exit(1);
};

if (mode === 'success') {
  if (record.status !== 'success') fail(`expected success, got ${record.status}`);
  const health = record.steps?.find((step) => step.stepId === 'health');
  const data = record.steps?.find((step) => step.stepId === 'data');
  if (health?.status !== 'success') fail('health fetch did not succeed');
  if (health.output?.status !== 200) fail(`health HTTP status was ${health.output?.status}`);
  if (health.output?.json?.status !== 'ready') fail('health JSON status was not ready');
  if (data?.status !== 'success') fail('data fetch did not succeed');
  if (data.output?.status !== 200) fail(`data HTTP status was ${data.output?.status}`);
  if (data.output?.json?.total !== 6) fail(`data JSON total was ${data.output?.json?.total}`);
  console.log(`independent verification passed: health.status=ready, data.total=6, runId=${record.runId}`);
} else {
  if (record.status !== 'failed') fail(`expected failure, got ${record.status}`);
  const failed = record.steps?.find((step) => step.stepId === 'fail');
  if (failed?.status !== 'failed') fail('negative fetch did not fail');
  if (!String(failed.errorText ?? '').includes('422')) fail(`negative error did not identify HTTP 422: ${failed.errorText}`);
  console.log(`independent verification passed: negative run visibly failed with HTTP 422, runId=${record.runId}`);
}
