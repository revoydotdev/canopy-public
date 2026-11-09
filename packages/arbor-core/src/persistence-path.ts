// Governing record: ADR-029 (one writer process per persistence directory; containment is single-sourced here).
import { relative, resolve } from "node:path";

/**
 * Resolve CLI persistence under the declared working directory, never by an implicit home/global path.
 *
 * Lives in its own module (re-exported from `cli.ts`, which still owns the symbol because
 * `scheduler-command.ts` injects it by dynamic import) so that the modules which must WRITE INSIDE
 * the resolved persistence root — `setup.ts`, `project-env.ts` — can share this one guard instead of
 * re-deriving `.arbor` and drifting from it. Containment is a single-sourced property, not a
 * convention each sink re-implements.
 */
export function resolvePersistenceDir(cwd: string, configured?: string): string {
  const root = resolve(cwd);
  const requested = configured ?? ".arbor";
  // Containment, not shape, is the property worth enforcing. A blanket refusal
  // of absolute paths used to sit here, and it rejected `/repo/.arbor` — a path
  // INSIDE the working directory — which broke scripts/demo-window.sh: the
  // live TUI pane failed to start with "must be relative to the working
  // directory" while pointing at the repo's own .arbor. The check below already
  // refuses every escape, absolute or relative, because `resolve` returns an
  // absolute `requested` unchanged and `relative` then reports the "..".
  const target = resolve(root, requested);
  if (relative(root, target).startsWith("..")) throw new Error("ARBOR_PERSISTENCE_DIR must remain within the working directory");
  return target;
}
