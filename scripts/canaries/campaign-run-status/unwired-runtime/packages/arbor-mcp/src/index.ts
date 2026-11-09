// Canary barrel. It re-exports the runtime but never the attempt index, the
// status projector, or the terminal-state predicate — so the gate's export leg
// has three named absences to report.
export { ArborRuntime } from "./runtime.js";
