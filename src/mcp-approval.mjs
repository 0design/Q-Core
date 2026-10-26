import { join } from 'node:path';
import { hash, insist } from './contracts.mjs';
import { RunStore } from './state.mjs';
import { pendingApprovalGate, resumeRun } from './run.mjs';
import { previewApiRequest } from './steps.mjs';
import { resolveTemplateValue } from './template.mjs';
import { elicitConfirmation } from './elicitation-confirmation.mjs';
import { persistenceEnvironment, assertUnredactedOutput } from './persistence.mjs';

function deliveryFor(run, gate, store) {
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

/** Tool arguments identify work only; the connected client supplies the decision. */
export async function requestApproval(args, client) {
  insist(args && typeof args === 'object' && !Array.isArray(args) &&
    Object.keys(args).sort().join(',') === 'gate_id,run_id' &&
    typeof args.run_id === 'string' && args.run_id && typeof args.gate_id === 'string' && args.gate_id,
  'request_approval accepts only run_id and gate_id; approval values are never tool arguments.');
  const capability = client.capabilities?.elicitation;
  insist(capability && typeof capability === 'object' && !Array.isArray(capability) &&
    (!Object.keys(capability).length || capability.form && typeof capability.form === 'object') && typeof client.elicit === 'function',
  'This MCP client does not support form elicitation. A human decision cannot be supplied by the model.', 'ELICITATION_UNSUPPORTED');
  const store = new RunStore(client.manifestFile);
  const run = store.load(args.run_id);
  const gate = pendingApprovalGate(run, args.gate_id);
  const delivery = deliveryFor(run, gate, store);
  const deliveryHash = hash(delivery), environmentHash = hash(persistenceEnvironment(run));
  const confirmation = await elicitConfirmation(client, {
    runId: run.runId, gateId: gate.rowId ?? gate.stepId, runHash: hash(run), delivery, deliveryHash,
    approvalHash: hash(gate.output?.subject ?? null),
  });
  if (!confirmation) return { run_id: run.runId, gate_id: args.gate_id, status: 'waiting_human', decision: null };
  const current = store.load(args.run_id);
  const currentGate = pendingApprovalGate(current, args.gate_id);
  insist(hash(current) === hash(run) && hash(deliveryFor(current, currentGate, store)) === deliveryHash &&
    hash(persistenceEnvironment(current)) === environmentHash,
  'Approval does not match the current delivery; request a new human decision.', 'STALE_APPROVAL');
  client.assertActive?.();
  const result = await resumeRun(current, {
    decision: confirmation.decision, confirmation, approvalHash: currentGate.output?.approvalHash,
    store, knobs: current.executionKnobs, callerProvider: current.callerProvider,
    apiKey: process.env.OPENROUTER_API_KEY ?? null,
  });
  store.saveLastRun(result);
  return { run_id: result.runId, gate_id: args.gate_id, decision: confirmation.decision, delivery_hash: deliveryHash, status: result.status };
}
