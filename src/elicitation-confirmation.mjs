import { insist } from './contracts.mjs';

export async function elicitConfirmation(client, snapshot) {
  const response = await client.elicit({
    message: `Review this exact delivery for run ${snapshot.runId}, gate ${snapshot.gateId}.\n` +
      `Delivery SHA-256: ${snapshot.deliveryHash}\nSubject SHA-256: ${snapshot.approvalHash}\n${JSON.stringify(snapshot.delivery, null, 2)}\n` +
      'Choose approve or reject to request Touch ID confirmation. This form is a preview, not approval. Dismissing or declining leaves the gate waiting.',
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
  return { decision: response.content.decision };
}
