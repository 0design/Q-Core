// Operational metadata is derived from the validated workflow manifest, never hand-kept.
export function workflowMetadata(manifest) {
  const steps = [];
  function walk(branch) {
    for (const step of branch ?? []) {
      steps.push(step);
      walk(step.then); walk(step.else); walk(step.default);
      for (const branch of Object.values(step.cases ?? {})) walk(branch);
    }
  }
  walk(manifest.steps);
  // needsEnv: names read without a default (the run cannot start without them).
  // optionalEnv: names read only as {{env.NAME:-default}} (the run uses the default).
  const refs = [], defaulted = [];
  for (const step of steps) for (const value of Object.values(step.config ?? {})) {
    for (const match of String(value).matchAll(/\{\{\s*env\.([A-Z][A-Z0-9_]*)\s*(:-[^}]*)?\}\}/g)) {
      const list = match[2] === undefined ? refs : defaulted;
      if (!list.includes(match[1])) list.push(match[1]);
    }
  }
  const gates = steps.filter(step => step.kind === 'approval-gate');
  // An OpenRouter step needs the key in the environment unless it reads it from the Keychain (secretSource: keychain).
  const envKey = step => step.config?.secretSource !== 'keychain';
  const routed = steps.filter(step => (step.kind === 'llm-call' && step.config?.provider !== 'cli') || (step.kind === 'approval-gate' && step.config?.reviewer === 'agent'));
  const openrouter = routed.some(envKey);
  // An OpenRouter step without a model in the manifest (step or settings) only runs with OPENROUTER_MODEL.
  const needsModel = routed.some(step => !step.config?.model && !manifest.settings?.model);
  return {
    steps: steps.length,
    kinds: [...new Set(steps.map(step => step.kind))],
    humanGate: gates.some(step => (step.config?.reviewer ?? 'human') === 'human'),
    agentGate: gates.some(step => step.config?.reviewer === 'agent'),
    needsEnv: [
      ...(openrouter && !refs.includes('OPENROUTER_API_KEY') ? ['OPENROUTER_API_KEY'] : []),
      ...refs,
      ...(needsModel && !refs.includes('OPENROUTER_MODEL') ? ['OPENROUTER_MODEL'] : []),
    ],
    optionalEnv: defaulted.filter(name => !refs.includes(name)),
  };
}
