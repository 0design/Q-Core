/**
 * Recipe tree → linear execution order. The runner's copy of
 * `lib/processes/flatten.ts`, decision for decision:
 *
 * 1. Triggers are not steps. They are input nodes; materialising them as step
 *    runs would start every run with a step that does nothing and always
 *    succeeds — noise somebody later reads as work. The manifest keeps them in
 *    `triggers:`, so nothing to skip here, but the rule is the same.
 *
 * 2. A CONFIGURED fan-out (one with `over`) does not contribute its lane here.
 *    How many items the source holds is known only after the step that produced
 *    it has run, so the lane rows are created at runtime.
 *
 *    A fan-out WITHOUT `over` keeps the pre-0034 behaviour: the lane is inlined
 *    and runs ONCE, and the node says so out loud instead of pretending to expand.
 *
 * 3. `seq` advances by SEQ_STRIDE, not 1 — expanded lane rows have to land
 *    BETWEEN the fan-out node and the next top-level step, and seq is an integer.
 */

export const SEQ_STRIDE = 1000;

export const isExpandingFanOut = (s) => s.kind === "fan-out" && !!String(s.config?.over ?? "").trim();

export function flattenLoopSteps(steps) {
  const out = [];
  const walk = (list, depth, laneOf) => {
    for (const s of list) {
      out.push({ step: s, seq: out.length * SEQ_STRIDE, depth, laneOf });
      if (isExpandingFanOut(s)) continue;
      if (s.then?.length) walk(s.then, depth + 1, s.kind === "fan-out" ? s.id : laneOf);
    }
  };
  walk(steps, 0, null);
  return out;
}
