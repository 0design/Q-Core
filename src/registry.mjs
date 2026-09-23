/**
 * Load and validate the hand-written registry: components and demos.
 *
 * These files are the source. `catalog.json` is generated from them plus the
 * workflows, and must never be the place a contract is edited. A component that
 * invents engine behaviour would be a lie the site then repeats — so validation
 * is shape only; the words come from SPEC-MANIFEST.md.
 */
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

const COMPONENT_KINDS = new Set(["step", "trigger", "composite"]);

export class RegistryError extends Error {
  constructor(message) {
    super(message);
    this.name = "RegistryError";
  }
}

function readJsonFile(file) {
  let raw;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    throw new RegistryError(`${file}: not valid JSON — ${e instanceof Error ? e.message : e}`);
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new RegistryError(`${file}: root must be an object`);
  }
  return raw;
}

function assertString(value, label, file) {
  if (typeof value !== "string" || !value.trim()) {
    throw new RegistryError(`${file}: ${label} must be a non-empty string`);
  }
}

function assertStringArray(value, label, file) {
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string" || !v.trim())) {
    throw new RegistryError(`${file}: ${label} must be an array of strings`);
  }
}

function assertFieldMap(map, label, file, { requireRequired = false } = {}) {
  if (!map || typeof map !== "object" || Array.isArray(map)) {
    throw new RegistryError(`${file}: ${label} must be an object of fields`);
  }
  for (const [name, spec] of Object.entries(map)) {
    if (!spec || typeof spec !== "object" || Array.isArray(spec)) {
      throw new RegistryError(`${file}: ${label}.${name} must be { type, notes${requireRequired ? ", required" : ""} }`);
    }
    assertString(spec.type, `${label}.${name}.type`, file);
    assertString(spec.notes, `${label}.${name}.notes`, file);
    if (requireRequired && typeof spec.required !== "boolean") {
      throw new RegistryError(`${file}: ${label}.${name}.required must be a boolean`);
    }
  }
}

function uniqueIds(items, label) {
  const seen = new Set();
  for (const item of items) {
    if (seen.has(item.id)) {
      throw new RegistryError(`duplicate ${label} id "${item.id}"`);
    }
    seen.add(item.id);
  }
}

/** Validate one component contract. Does not invent usedBy — that is derived. */
export function validateComponent(raw, file = "component") {
  assertString(raw.id, "id", file);
  assertString(raw.name, "name", file);
  assertString(raw.kind, "kind", file);
  if (!COMPONENT_KINDS.has(raw.kind)) {
    throw new RegistryError(`${file}: kind must be step, trigger, or composite (got "${raw.kind}")`);
  }
  assertString(raw.description, "description", file);
  assertFieldMap(raw.input, "input", file, { requireRequired: true });
  assertFieldMap(raw.output, "output", file);
  assertStringArray(raw.needsEnv ?? [], "needsEnv", file);
  if (raw.usedBy != null) assertStringArray(raw.usedBy, "usedBy", file);
  if (raw.kind === "composite") {
    assertStringArray(raw.builtFrom, "builtFrom", file);
    if (!raw.builtFrom.length) {
      throw new RegistryError(`${file}: a composite must name the step kinds it is built from`);
    }
  }
  if (raw.kind === "trigger" && raw.id === "schedule" && !/not a (runner )?step/i.test(raw.description)) {
    throw new RegistryError(`${file}: schedule must say it is not a runner step — SPEC-MANIFEST.md §5.6`);
  }
  return {
    id: raw.id,
    name: raw.name,
    kind: raw.kind,
    description: raw.description.trim().replace(/\s+/g, " "),
    input: raw.input,
    output: raw.output,
    needsEnv: raw.needsEnv ?? [],
    ...(raw.kind === "composite" ? { builtFrom: raw.builtFrom } : {}),
    usedBy: raw.usedBy ?? [],
  };
}

/** Validate one demo. workflowId is checked against workflows at catalog build. */
export function validateDemo(raw, file = "demo") {
  assertString(raw.id, "id", file);
  assertString(raw.workflowId, "workflowId", file);
  assertString(raw.name, "name", file);
  assertString(raw.description, "description", file);
  assertString(raw.proof, "proof", file);
  if (raw.resultUrl != null && typeof raw.resultUrl !== "string") {
    throw new RegistryError(`${file}: resultUrl must be a string or null`);
  }
  if (typeof raw.live !== "boolean") {
    throw new RegistryError(`${file}: live must be a boolean`);
  }
  return {
    id: raw.id,
    workflowId: raw.workflowId,
    name: raw.name,
    description: raw.description.trim().replace(/\s+/g, " "),
    proof: raw.proof,
    resultUrl: raw.resultUrl ?? null,
    live: raw.live,
  };
}

function loadJsonDir(dir, validate) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => {
      const file = join(dir, f);
      return validate(readJsonFile(file), file);
    });
}

export function loadComponents(dir) {
  const items = loadJsonDir(dir, validateComponent);
  uniqueIds(items, "component");
  return items;
}

export function loadDemos(dir) {
  const items = loadJsonDir(dir, validateDemo);
  uniqueIds(items, "demo");
  return items;
}

export function loadRegistry(registryDir) {
  return {
    components: loadComponents(join(registryDir, "components")),
    demos: loadDemos(join(registryDir, "demos")),
  };
}

/**
 * Workflows that use this component.
 *
 * step     → workflows whose flattened kinds include the id
 * trigger  → workflows that declare that trigger (schedule is not a step kind)
 * composite → workflows that already need every env var the recipe names
 */
export function deriveUsedBy(component, workflows) {
  if (component.kind === "trigger") {
    if (component.id === "schedule") {
      return workflows.filter((l) => l.schedule).map((l) => l.id);
    }
    return [];
  }
  if (component.kind === "composite") {
    const needed = component.needsEnv ?? [];
    if (needed.length) {
      return workflows.filter((l) => needed.every((e) => l.needsEnv.includes(e))).map((l) => l.id);
    }
    const parts = component.builtFrom ?? [];
    return workflows.filter((l) => parts.every((k) => l.kinds.includes(k))).map((l) => l.id);
  }
  return workflows.filter((l) => l.kinds.includes(component.id)).map((l) => l.id);
}

export function assertDemoWorkflowExists(demo, workflows) {
  if (!workflows.some((l) => l.id === demo.workflowId)) {
    throw new RegistryError(`demo "${demo.id}": workflowId "${demo.workflowId}" is not in workflows/`);
  }
}

export function enrichComponent(component, workflows) {
  return { ...component, usedBy: deriveUsedBy(component, workflows) };
}

export function enrichDemo(demo, workflows) {
  assertDemoWorkflowExists(demo, workflows);
  const loop = workflows.find((l) => l.id === demo.workflowId);
  return { ...demo, measured: loop.measured ?? null };
}
