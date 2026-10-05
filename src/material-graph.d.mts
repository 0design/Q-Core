import type { WorkflowManifest } from './manifest.d.mts';
export declare const MAX_CALL_DEPTH: number;
export declare const MAX_MATERIALS: number;
export declare const MAX_MANIFEST_BYTES: number;
/** Load errors retain their original class/name and fields; consumers must not infer a source when null/absent. */
export interface MaterialDiagnostic { name: string; message: string; materialPath: string | null; path?: string | null; line?: number | null; code?: string }
export declare function loadManifestGraph(file: string): WorkflowManifest;
export interface MaterialBundle { protocolVersion: 'q-core.bundle/v1'; entry: string; executable?: false; files: Array<{ path: string; sha256: string; id: string; version: string | null; kind: 'workflow' | 'component'; format?: 'descriptor' }> }
export declare function exportMaterialBundle(file: string, destination: string): MaterialBundle;
