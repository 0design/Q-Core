// Operational metadata is derived from the validated manifest, never hand-kept.
export function loopMetadata(manifest) {
  const steps = [];
  function walk(branch) {
    for (const step of branch ?? []) {
      steps.push(step);
      walk(step.then); walk(step.else); walk(step.default);
      for (const branch of Object.values(step.cases ?? {})) walk(branch);
    }
  }
  walk(manifest.steps);
  const refs = [];
  for (const step of steps) for (const value of Object.values(step.config ?? {})) {
    for (const match of String(value).matchAll(/\{\{\s*env\.([A-Z][A-Z0-9_]*)\s*\}\}/g)) {
      if (!refs.includes(match[1])) refs.push(match[1]);
    }
  }
  const gates = steps.filter(step => step.kind === 'approval-gate');
  const openrouter = steps.some(step => step.kind === 'llm-call' && step.config?.provider !== 'cli') || gates.some(step => step.config?.reviewer === 'agent');
  return {
    steps: steps.length,
    kinds: [...new Set(steps.map(step => step.kind))],
    humanGate: gates.some(step => (step.config?.reviewer ?? 'human') === 'human'),
    agentGate: gates.some(step => step.config?.reviewer === 'agent'),
    needsEnv: openrouter && !refs.includes('OPENROUTER_API_KEY') ? ['OPENROUTER_API_KEY', ...refs] : refs,
  };
}
