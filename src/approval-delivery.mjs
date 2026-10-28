import { join } from 'node:path';
import { insist } from './contracts.mjs';
import { previewApiRequest } from './steps.mjs';
import { resolveTemplateValue } from './template.mjs';
import { assertUnredactedOutput } from './persistence.mjs';

// Steps that produce no outside effect of their own; they may precede a sibling lane's human gate.
const PASSIVE_KINDS = new Set(['fetch', 'llm-call', 'parse-web', 'deduplicate', 'verify-sources', 'workspace-read',
  'specification', 'verify-artifact', 'determined']);

/** 'gated' when every path stops at a human gate before any effect, 'clear' when no path reaches an effect,
 *  'unsafe' otherwise. Nested calls, fan-outs and repeating steps are not walked and count as unsafe. */
function effectBoundary(steps) {
  for (const step of steps ?? []) {
    if (step.kind === 'approval-gate' && (step.config?.reviewer ?? 'human') === 'human') return 'gated';
    if (step.kind === 'approval-gate' || PASSIVE_KINDS.has(step.kind)) continue;
    if (step.kind !== 'if' && step.kind !== 'switch') return 'unsafe';
    const branches = step.kind === 'if' ? [step.then, step.else] : [...Object.values(step.cases ?? {}), step.default];
    const exhaustive = step.kind === 'if' ? Array.isArray(step.else) : Array.isArray(step.default);
    const results = branches.map(effectBoundary);
    if (results.includes('unsafe')) return 'unsafe';
    if (exhaustive && results.every(result => result === 'gated')) return 'gated';
  }
  return 'clear';
}

/** After a lane's return, only further lanes of the same pinned material may follow, each stopping at its
 *  own human gate before any effect (or having none). Anything else would run unseen after this approval. */
function assertSiblingLanesOnly(run, gate, rest) {
  const frame = run.invocations?.[gate.invocationId];
  const parent = run.invocations?.[frame?.parent];
  const boundary = effectBoundary(run.materialGraph?.[frame?.key]?.manifest?.steps);
  const sibling = row => row.kind === 'workflow-call' && (row.invocationId ?? 'root') === frame.parent &&
    run.materialGraph?.[parent?.key]?.resolved?.[row.config?.ref] === frame.key;
  insist(frame && parent && boundary !== 'unsafe' && rest.every(sibling),
    'Steps after this branch would run without their own human gate. Place a human gate before every later delivery.', 'DELIVERY_NOT_READY');
}

export function deliveryFor(run, gate, store) {
  const shadow = structuredClone(run);
  shadow.steps.find(row => row.seq === gate.seq).status = 'success';
  const branch = gate.invocationId ?? 'root';
  const deliveries = [];
  const pending = shadow.steps.filter(row => row.seq > gate.seq && row.status === 'pending');
  for (const [index, row] of pending.entries()) {
    const invocation = row.invocationId ?? 'root';
    insist(invocation === branch, 'Delivery content depends on a step outside this gate branch.', 'DELIVERY_NOT_READY');
    if (row.kind === 'approval-gate') break;
    if (row.kind === 'workflow-return' && branch !== 'root') {
      // The end of this branch: what this approval releases ends here.
      assertSiblingLanesOnly(run, gate, pending.slice(index + 1));
      break;
    }
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
