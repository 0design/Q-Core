/**
 * Types for the manifest loader.
 *
 * Hand-written, because this package has no build step on purpose — `npm pack`
 * produces files you can run, not files you have to compile first. The one place
 * that consumes it from TypeScript is the product-engine parity test, and it should be
 * type-checked like everything else rather than cast to any at the border.
 */

/** A step exactly as the product engine stores it for a workflow. */
export interface WorkflowManifestStep {
  id: string;
  kind: string;
  /** Always strings — the manifest loader normalises numbers and booleans. */
  config: Record<string, string>;
  then?: WorkflowManifestStep[];
  else?: WorkflowManifestStep[];
  cases?: Record<string, WorkflowManifestStep[]>;
  default?: WorkflowManifestStep[];
}

export interface WorkflowManifestTrigger {
  kind: string;
  cron?: string;
  [key: string]: unknown;
}

export interface WorkflowManifestSettings {
  model?: string;
  /** null means the ceiling was lifted on purpose; absent means "take the default". */
  budgetUsd?: number | null;
  limits?: Record<string, Record<string, number>>;
  sensitivity?: unknown;
  exit?: { kind?: string; [key: string]: unknown };
}

export interface WorkflowManifest {
  id: string;
  name: string;
  version: string;
  description: string;
  owner: string;
  enabled: boolean;
  triggers: WorkflowManifestTrigger[];
  settings: WorkflowManifestSettings;
  steps: WorkflowManifestStep[];
  file?: string;
}

export declare const MANIFEST_TAG: string;
export declare const ENGINE_KINDS: string[];
export declare const TRIGGER_KINDS: string[];
export declare const RESERVED_KINDS: Record<string, string>;

export declare class ManifestError extends Error {
  constructor(message: string, path?: string);
  path: string | null;
}

export declare function validateManifest(doc: unknown): WorkflowManifest;
export declare function loadManifest(file: string): WorkflowManifest;
export declare function assertCron(expr: string, path?: string): void;
