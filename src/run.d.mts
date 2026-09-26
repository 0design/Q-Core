/** Types for the driver. Hand-written — see manifest.d.mts on why. */
import type { WorkflowManifest, WorkflowManifestSettings, WorkflowManifestStep } from "./manifest.d.mts";

export type RunStatus = "running" | "success" | "failed" | "cancelled" | "waiting_human" | "waiting_inference" | "needs_human";
export type StepStatus = "pending" | "running" | "success" | "failed" | "waiting_human" | "planned";

export interface RunStep {
  seq: number;
  stepId: string;
  kind: string;
  name: string;
  depth: number;
  laneOf: string | null;
  config: Record<string, string>;
  then: WorkflowManifestStep[] | null;
  else?: WorkflowManifestStep[] | null;
  cases?: Record<string, WorkflowManifestStep[]> | null;
  default?: WorkflowManifestStep[] | null;
  status: StepStatus;
  decision: string | null;
  gateReason: string | null;
  output: unknown;
  errorText: string | null;
  tokensIn: number | null;
  tokensOut: number | null;
  costUsd: number | null;
  /** Where a model step's cost came from; absent on steps that call no model. */
  costSource?: "provider" | "rate-table" | "unknown";
  item?: unknown;
  itemIndex: number | null;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface Run {
  runId: string;
  workflowId: string;
  workflowName: string;
  manifestFile: string | null;
  trigger: string;
  status: RunStatus;
  summary: string;
  startedAt: string;
  finishedAt: string | null;
  costUsd: number | null;
  tokensIn: number | null;
  tokensOut: number | null;
  steps: RunStep[];
  pendingInference?: { protocolVersion: string; jobId: string; hash: string; runId: string; phase: string; inputHash: string; expiresAt: number; messages: Array<{ role: string; content: string }>; outputKind: string };
  pendingClarification?: { hash: string; questions: Array<{ id: string; question: string }>; seq: number; stepId: string; inferenceJobId: string };
  clarificationContext?: { hash: string; questions: Array<{ id: string; question: string }>; answers: Array<{ id: string; answer: string }> };
  clarificationHistory?: Array<{ hash: string; questions: Array<{ id: string; question: string }>; seq: number; stepId: string; inferenceJobId: string; answers: Array<{ id: string; answer: string }>; answerHash: string; answeredAt: string }>;
  callerProvider?: DriveOptions['callerProvider'];
  executionKnobs?: Knobs;
  workspacePolicy?: { workspace: string; allowedPaths: string[]; intent: string; verifier: { command: string; args: string[]; timeoutMs: number }; maxRepairAttempts?: number; specification?: { summary: string; criteria: string[]; plan: string[] } };
  repairAttempt?: number;
  repairHistory?: unknown[];
}

export interface Knobs {
  model: string | null;
  budgetUsd: number | null;
  sensitivity: unknown;
  limits: unknown;
  exit: { kind?: string };
  provenance: { model: string; budget: string };
}

export interface DriveOptions {
  store?: unknown;
  knobs?: Knobs;
  settings?: WorkflowManifestSettings;
  apiKey?: string | null;
  callerProvider?: { kind: 'caller'; agent: 'codex' | 'claude'; model: string; payerScope: 'local-cli' };
  inferenceReply?: { jobId: string; hash: string; output: { text: string } };
  clarification?: { hash: string; answers: Array<{ id: string; answer: string }> };
  maxInferenceJobs?: number;
  inferenceTtlMs?: number;
  dryRun?: boolean;
  onStep?: (step: RunStep) => void;
  signal?: AbortSignal;
}

export declare const DEFAULT_RUN_BUDGET_USD: number;
export declare const DEFAULT_MAX_TOKENS: number;
export declare const MAX_EXPANDED_RUN_ROWS: number;

export declare function resolveKnobs(settings?: WorkflowManifestSettings): Knobs;
export declare function createRun(manifest: WorkflowManifest, opts?: { trigger?: string }): Run;
export declare function driveRun(run: Run, opts?: DriveOptions): Promise<Run>;
export declare function resumeRun(run: Run, opts: DriveOptions & { decision: "approve" | "reject"; approvalHash?: string }): Promise<Run>;
export declare function cancelWaitingRun(run: Run, opts?: DriveOptions): Run;
export declare function resumeCancelledRun(run: Run, opts?: DriveOptions): Promise<Run>;
