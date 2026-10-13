export interface ComponentDescriptor { id: string; name: string; kind?: 'step' | 'trigger' | 'composite'; version?: string; input?: Record<string, { type: string; required?: boolean; [key: string]: unknown }>; output?: Record<string, { type: string; [key: string]: unknown }>; needsEnv?: string[]; [key: string]: unknown }
export declare function validateComponentDescriptor(value: unknown): ComponentDescriptor;
export declare function loadComponentDescriptor(file: string): ComponentDescriptor;
