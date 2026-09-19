/**
 * Types for the manifest loader.
 *
 * Hand-written, because this package has no build step on purpose — `npm pack`
 * produces files you can run, not files you have to compile first. The one place
 * that consumes it from TypeScript is `scripts/loop-parity.ts`, and it should be
 * type-checked like everything else rather than cast to any at the border.
 */

/** A step exactly as `qf_loop_template.steps` stores it. */
export interface LoopManifestStep {
  id: string;
  kind: string;
  /** Always strings — the manifest loader normalises numbers and booleans. */
  config: Record<string, string>;
  then?: LoopManifestStep[];
  else?: LoopManifestStep[];
  cases?: Record<string, LoopManifestStep[]>;
  default?: LoopManifestStep[];
}

export interface LoopManifestTrigger {
  kind: string;
  cron?: string;
  [key: string]: unknown;
}

export interface LoopManifestSettings {
  model?: string;
  /** null means the ceiling was lifted on purpose; absent means "take the default". */
  budgetUsd?: number | null;
  limits?: Record<string, Record<string, number>>;
  sensitivity?: unknown;
  exit?: { kind?: string; [key: string]: unknown };
}

export interface LoopManifest {
  id: string;
  name: string;
  version: string;
  description: string;
  owner: string;
  enabled: boolean;
  triggers: LoopManifestTrigger[];
  settings: LoopManifestSettings;
  steps: LoopManifestStep[];
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

export declare function validateManifest(doc: unknown): LoopManifest;
export declare function loadManifest(file: string): LoopManifest;
export declare function assertCron(expr: string, path?: string): void;
