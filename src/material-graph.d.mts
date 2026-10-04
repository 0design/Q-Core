import type { WorkflowManifest } from './manifest.d.mts';
export declare const MAX_CALL_DEPTH: number;
export declare const MAX_MATERIALS: number;
export declare const MAX_MANIFEST_BYTES: number;
export declare function loadManifestGraph(file: string): WorkflowManifest;
export interface MaterialBundle { protocolVersion: 'q-core.bundle/v1'; entry: string; executable?: false; files: Array<{ path: string; sha256: string; id: string; version: string | null; kind: 'workflow' | 'component'; format?: 'descriptor' }> }
export declare function exportMaterialBundle(file: string, destination: string): MaterialBundle;
