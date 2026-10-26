import { hash, insist } from './contracts.mjs';

// These receipts never cross the tool boundary. Copying their public fields
// cannot create a human decision; only the connected client's response can.
const receipts = new WeakMap();

export const hasElicitationConfirmation = confirmation => receipts.has(confirmation);

export async function elicitConfirmation(client, snapshot) {
  const response = await client.elicit({
    message: `Review this exact delivery for run ${snapshot.runId}, gate ${snapshot.gateId}.\n` +
      `Delivery SHA-256: ${snapshot.deliveryHash}\nSubject SHA-256: ${snapshot.approvalHash}\n${JSON.stringify(snapshot.delivery, null, 2)}\n` +
      'Choose approve or reject and submit. Dismissing or declining leaves the gate waiting.',
    requestedSchema: {
      type: 'object', properties: { decision: { type: 'string', title: 'Decision', enum: ['approve', 'reject'] } },
      required: ['decision'],
    },
  });
  client.assertActive?.();
  if (['cancel', 'decline'].includes(response?.action)) return null;
  insist(response?.action === 'accept' && response.content &&
    Object.keys(response.content).join(',') === 'decision' && ['approve', 'reject'].includes(response.content.decision),
  'The client did not return an explicit approval or rejection.', 'INVALID_ELICITATION_RESPONSE');
  const confirmation = { channel: 'mcp-elicitation', decision: response.content.decision, confirmedAt: new Date().toISOString() };
  receipts.set(confirmation, { ...snapshot, decision: confirmation.decision });
  return confirmation;
}

export function consumeElicitationConfirmation(confirmation, run, gate, decision) {
  const receipt = receipts.get(confirmation);
  receipts.delete(confirmation);
  insist(receipt && receipt.decision === decision && receipt.runId === run.runId &&
    receipt.gateId === (gate.rowId ?? gate.stepId) && receipt.runHash === hash(run),
  'Approval does not match this pending run and delivery, or was already used.', 'STALE_APPROVAL');
  return { runId: receipt.runId, gateId: receipt.gateId, deliveryHash: receipt.deliveryHash };
}
