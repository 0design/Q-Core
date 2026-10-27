export interface ApprovalPayload {
  run_id: string;
  gate_id: string;
  content_hash: string;
  decision: 'approve' | 'reject';
  nonce: string;
  issued_at: string;
}
export interface SignedApprovalDecision { payload: ApprovalPayload; signature: string }
/** Implementations are registered by trusted server code, never by tool arguments. */
export interface ApprovalAnchor { readonly id: string; verify(decision: SignedApprovalDecision): boolean }
export declare class ApprovalAnchorRegistry {
  register(anchor: ApprovalAnchor): this;
  get(id: string): ApprovalAnchor;
}
export declare const APPROVAL_TTL_MS: number;
export declare function canonicalApprovalPayload(payload: ApprovalPayload): string;
export declare class P256ApprovalAnchor implements ApprovalAnchor {
  readonly id: string;
  constructor(id: string, publicKey: string);
  verify(decision: SignedApprovalDecision): boolean;
}
export declare class TouchIdAnchor extends P256ApprovalAnchor {
  constructor(publicKey: string);
  confirm(payload: ApprovalPayload): Promise<SignedApprovalDecision & { channel: 'approval-anchor'; anchor_id: string; decision: 'approve' | 'reject' }>;
}
export declare function loadApprovalAnchor(id?: string): ApprovalAnchor;
