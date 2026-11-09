/**
 * child-registry — one owner for every `opencode` process this package spawns.
 *
 * WHY THIS IS SHARED AND NOT THREE PRIVATE COPIES. There are three spawn sites,
 * and each leaked independently:
 *   - `opencode-executor.ts`      — `opencode run`, one per specialist dispatch
 *   - `opencode-server-executor.ts` — `opencode serve`, one per campaign
 *   - `cli.ts`'s `spawnCapabilityServer` — `opencode serve`, to query /provider
 *
 * Measured on this box 2026-08-08: 146 orphaned `opencode` processes holding
 * 40.3 GB, every one with PPID 1 — reparented to init after the spawning Node
 * process died without killing them. A full `vitest run` reproducibly left 5
 * more behind, ~2.3 GB, which is how the population grew across sessions.
 *
 * WHAT THIS CAN AND CANNOT DO — stated plainly, because a safety net believed
 * to be stronger than it is, is worse than none:
 *   - It CAN reap on normal exit and on SIGINT/SIGTERM.
 *   - It CANNOT survive SIGKILL. That is kernel design, not an oversight; no
 *     in-process handler runs. Orphans from a SIGKILLed parent need the
 *     out-of-band reaper (`scripts/reap-orphaned-opencode.mjs`).
 *   - It is DEFENCE IN DEPTH, not a substitute for each call site releasing its
 *     own child on its own settle path. A campaign that only reaped at process
 *     exit would hold every dispatch's child for the whole run.
 *
 * The `exit` hook is registered ONCE for the module, not per child: a campaign
 * with many dispatches registering per-child `process.once` handlers would trip
 * Node's MaxListeners warning while being no more effective.
 */

import type { ChildProcess } from "node:child_process";

const activeChildren = new Set<ChildProcess>();
let hooksInstalled = false;

/** Kill every tracked child. Safe to call repeatedly; a child already gone is not an error. */
export function reapTrackedChildren(): void {
  for (const child of activeChildren) {
    try { child.kill("SIGKILL"); } catch { /* already gone */ }
  }
  activeChildren.clear();
}

function installHooks(): void {
  if (hooksInstalled) return;
  hooksInstalled = true;
  // `exit` covers a clean drain. It does NOT fire on an unhandled signal, which
  // is why SIGINT/SIGTERM are registered explicitly — verified 2026-08-08: a
  // parent killed with either signal orphaned its child to PPID 1 even with an
  // `exit` handler installed.
  process.once("exit", reapTrackedChildren);
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      reapTrackedChildren();
      // Re-raise so the default disposition (and any other handler's intent)
      // still applies — swallowing the signal here would turn a Ctrl-C into a
      // hang, trading one defect for another.
      process.kill(process.pid, signal);
    });
  }
}

/**
 * Track `child` until it settles. Returns nothing: the child unregisters itself
 * on `exit`/`error`, so callers never need to remember to untrack.
 */
export function trackChild(child: ChildProcess): void {
  installHooks();
  activeChildren.add(child);
  const untrack = (): void => { activeChildren.delete(child); };
  child.once("exit", untrack);
  child.once("error", untrack);
}
