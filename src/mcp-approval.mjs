import { hash, insist } from './contracts.mjs';
import { RunStore } from './state.mjs';
import { pendingApprovalGate, resumeRun } from './run.mjs';
import { elicitConfirmation } from './elicitation-confirmation.mjs';
import { deliveryFor } from './approval-delivery.mjs';
import { loadApprovalAnchor, issueApprovalChallenge } from './approval-anchor.mjs';
import { persistenceEnvironment } from './persistence.mjs';

/** The form previews work; only a registered human-presence anchor confirms it. */
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
  const preview = await elicitConfirmation(client, {
    runId: run.runId, gateId: gate.rowId ?? gate.stepId, runHash: hash(run), delivery, deliveryHash,
    approvalHash: hash(gate.output?.subject ?? null),
  });
  if (!preview) return { run_id: run.runId, gate_id: args.gate_id, status: 'waiting_human', decision: null };
  const current = store.load(args.run_id);
  const currentGate = pendingApprovalGate(current, args.gate_id);
  insist(hash(current) === hash(run) && hash(deliveryFor(current, currentGate, store)) === deliveryHash &&
    hash(persistenceEnvironment(current)) === environmentHash,
  'Approval does not match the current delivery; request a new human decision.', 'STALE_APPROVAL');
  client.assertActive?.();
  const anchor = loadApprovalAnchor();
  const payload = issueApprovalChallenge(store, {
    runId: run.runId, gateId: gate.rowId ?? gate.stepId, runHash: hash(run),
    deliveryHash, environmentHash,
  }, preview.decision);
  const confirmation = await anchor.confirm(payload);
  client.assertActive?.();
  const result = await resumeRun(current, {
    decision: confirmation.decision, confirmation, approvalHash: currentGate.output?.approvalHash,
    store, knobs: current.executionKnobs, callerProvider: current.callerProvider,
    apiKey: process.env.OPENROUTER_API_KEY ?? null,
  });
  store.saveLastRun(result);
  return { run_id: result.runId, gate_id: args.gate_id, decision: confirmation.decision, delivery_hash: deliveryHash, status: result.status };
}
