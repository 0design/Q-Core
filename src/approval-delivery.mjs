import { join } from 'node:path';
import { insist } from './contracts.mjs';
import { previewApiRequest } from './steps.mjs';
import { resolveTemplateValue } from './template.mjs';
import { assertUnredactedOutput } from './persistence.mjs';

export function deliveryFor(run, gate, store) {
  const shadow = structuredClone(run);
  shadow.steps.find(row => row.seq === gate.seq).status = 'success';
  const deliveries = [];
  for (const row of shadow.steps.filter(row => row.seq > gate.seq && row.status === 'pending')) {
    if (row.kind === 'approval-gate') break;
    const invocation = row.invocationId ?? 'root';
    const previous = shadow.steps.filter(prior => prior.seq < row.seq && (prior.invocationId ?? 'root') === invocation &&
      prior.status === 'success' && prior.output != null && prior.kind !== 'workflow-return');
    const priorOutputs = Object.fromEntries(previous.map(prior => [prior.stepId, prior.output]));
    const priorStepNames = Object.fromEntries(previous.map(prior => [prior.stepId, prior.name]));
    const ctx = { runId: run.runId, templateId: run.materialGraph?.[run.invocations?.[invocation]?.key]?.manifest.id ?? run.workflowId, priorOutputs, priorStepNames,
      inputs: run.invocations?.[invocation]?.inputs ?? run.inputs ?? {}, item: row.item, itemIndex: row.itemIndex,
      lastOutput: previous.at(-1)?.output ?? null, sinkFile: join(store.outDir, `${run.runId}.txt`),
      spentUsd: run.steps.some(step => step.costUsd === null) ? null : run.steps.reduce((sum, step) => sum + (step.costUsd ?? 0), 0) };
    if (row.kind === 'api-request') {
      // A response from an earlier pending request is not yet known.
      insist(!deliveries.length || row.config.body, 'A subsequent delivery needs an explicit body or another human gate.', 'DELIVERY_NOT_READY');
      deliveries.push({ step: row.stepId, ...previewApiRequest(row, ctx) });
    } else if (row.kind === 'workspace-apply') {
      const proposal = resolveTemplateValue(row.config.source, ctx);
      insist(proposal && typeof proposal === 'object', 'The exact workspace proposal is not available yet.', 'DELIVERY_NOT_READY');
      deliveries.push({ step: row.stepId, destination: run.workspacePolicy?.workspace, proposal });
    } else {
      insist(false, 'Delivery content depends on a pending step. Place the human gate after content generation.', 'DELIVERY_NOT_READY');
    }
  }
  const delivery = { subject: gate.output?.subject ?? null, deliveries };
  const serialized = JSON.stringify(delivery);
  insist(!/\{\{\s*(?:steps\.|inputs\.|item\b|index\b)/.test(serialized), 'Delivery content has unresolved inputs.', 'DELIVERY_NOT_READY');
  assertUnredactedOutput(serialized);
  return delivery;
}

