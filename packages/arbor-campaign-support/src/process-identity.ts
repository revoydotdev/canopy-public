/**
 * Linux `/proc`-backed process identity, used to defeat PID reuse when
 * judging whether a lease's recorded owner is still the process that
 * acquired it (item 4 hardening — see `worktree.ts`'s `WorktreeLease.
 * owner_start_ticks`/`owner_boot_id` and `recovery-lease.ts`'s liveness
 * check).
 *
 * A bare PID check cannot distinguish "the original owner is still running"
 * from "some unrelated process was later assigned the same PID after a
 * reboot or after the OS's PID counter wrapped" — both look identical to
 * `kill(pid, 0)`. Process start time (ticks since boot, from
 * `/proc/<pid>/stat` field 22) plus the boot id (`/proc/sys/kernel/random/
 * boot_id`, regenerated every boot) together identify one specific process
 * lifetime: PID reuse changes the start time even when the PID collides, and
 * a reboot changes the boot id even when both PID and (by coincidence) start
 * time collide.
 */

import { readFileSync } from "node:fs";

export interface ProcessIdentity {
  /** Field 22 of /proc/<pid>/stat: process start time, in clock ticks since boot. */
  start_ticks: string;
  /** /proc/sys/kernel/random/boot_id: regenerated every boot. */
  boot_id: string;
}

/**
 * Read the current identity of a live PID. Returns null when the PID is
 * gone, `/proc` is unavailable (non-Linux), or the stat line cannot be
 * parsed — callers must treat null as "cannot prove or disprove identity",
 * never as "process is dead" (see the fail-safe liveness rule in
 * `recovery-lease.ts`).
 */
export function readProcessIdentity(pid: number): ProcessIdentity | null {
  if (process.platform !== "linux") return null;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf-8");
    // Field 2 (comm, the executable name) is parenthesised and may itself
    // contain spaces or parentheses, so the only robust split point is the
    // LAST ')' in the line — everything before it is fields 1-2, everything
    // after is fields 3 onward, space-separated.
    const lastParen = stat.lastIndexOf(")");
    if (lastParen === -1) return null;
    const fieldsFrom3 = stat.slice(lastParen + 1).trim().split(/\s+/);
    // fieldsFrom3[0] is field 3 (state); field 22 (starttime) is therefore
    // at index 22 - 3 = 19.
    const startTicks = fieldsFrom3[19];
    if (startTicks === undefined || !/^\d+$/.test(startTicks)) return null;

    const bootId = readFileSync("/proc/sys/kernel/random/boot_id", "utf-8").trim();
    if (bootId.length === 0) return null;

    return { start_ticks: startTicks, boot_id: bootId };
  } catch {
    return null;
  }
}

/** Whether `pid` currently exists. EPERM (owned by another user) counts as alive — ADR-012. */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/**
 * Fail-safe "is this still the same process lifetime" check, shared by
 * every owner-liveness judgment in this package (recovery's dead-owner
 * check, the worktree lease slot lock's stale-holder check, and
 * `reconcileLeases`' in-flight-claim check): a plain PID check alone cannot
 * rule out reuse. `recorded` is the identity captured at acquisition time
 * (absent on legacy records); `readers` lets callers inject deterministic
 * fakes in tests while production always passes the real `isProcessAlive`/
 * `readProcessIdentity`.
 *
 * Returns true (i.e. "still alive, cannot disprove it") whenever the PID
 * exists and either no identity was recorded, or identity can't be read
 * right now — this function must never report a genuinely live process as
 * dead.
 */
export function identityStillMatches(
  pid: number,
  recorded: { start_ticks?: string; boot_id?: string },
  readers: { processAlive: (pid: number) => boolean; processIdentity: (pid: number) => ProcessIdentity | null },
): boolean {
  if (!readers.processAlive(pid)) return false;
  if (recorded.start_ticks === undefined || recorded.boot_id === undefined) return true;
  const current = readers.processIdentity(pid);
  if (current === null) return true;
  if (current.boot_id !== recorded.boot_id) return false;
  return current.start_ticks === recorded.start_ticks;
}
