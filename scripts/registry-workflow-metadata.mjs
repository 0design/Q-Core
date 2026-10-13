// Operational metadata is derived from the validated workflow manifest, never hand-kept.
export function workflowMetadata(manifest) {
  const steps = [];
  // Pinned child workflows count as part of the workflow: their steps, gates and env.
  const graph = manifest.materialGraph;
  function walk(branch, key, seen) {
    for (const step of branch ?? []) {
      steps.push(step);
      walk(step.then, key, seen); walk(step.else, key, seen); walk(step.default, key, seen);
      for (const cases of Object.values(step.cases ?? {})) walk(cases, key, seen);
      const child = step.kind === 'workflow-call' ? graph?.[key]?.resolved?.[step.config?.ref] : null;
      if (child && !seen.includes(child)) walk(graph[child].manifest.steps, child, [...seen, child]);
    }
  }
  walk(manifest.steps, manifest.materialKey, [manifest.materialKey]);
  const refs = [];
  for (const step of steps) for (const value of Object.values(step.config ?? {})) {
    for (const match of String(value).matchAll(/\{\{\s*env\.([A-Z][A-Z0-9_]*)\s*\}\}/g)) {
      if (!refs.includes(match[1])) refs.push(match[1]);
    }
  }
  const gates = steps.filter(step => step.kind === 'approval-gate');
  // An OpenRouter step needs the key in the environment unless it reads it from the Keychain (secretSource: keychain).
  const envKey = step => step.config?.secretSource !== 'keychain';
  const openrouter = steps.some(step => step.kind === 'llm-call' && step.config?.provider !== 'cli' && envKey(step)) || gates.some(step => step.config?.reviewer === 'agent' && envKey(step));
  return {
    steps: steps.length,
    kinds: [...new Set(steps.map(step => step.kind))],
    humanGate: gates.some(step => (step.config?.reviewer ?? 'human') === 'human'),
    agentGate: gates.some(step => step.config?.reviewer === 'agent'),
    needsEnv: openrouter && !refs.includes('OPENROUTER_API_KEY') ? ['OPENROUTER_API_KEY', ...refs] : refs,
  };
}
