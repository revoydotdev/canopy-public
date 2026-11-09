import { readFileSync, readdirSync } from "node:fs";
import type { RepoFlightProcessObservation } from "./repo-flight-session.js";

export interface RepoFlightHostProcessIdentity {
  readonly pid: number;
  readonly process_start_token: string;
  readonly host_boot_id: string;
  readonly pgid: number;
  readonly child_pids: readonly number[];
}

/** Linux PID identity bound to boot UUID and /proc start ticks, not PID alone. */
export function probeRepoFlightHostProcess(pid: number): RepoFlightHostProcessIdentity {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("process pid must be a positive safe integer");
  const boot = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
  if (!/^[a-f0-9-]{16,64}$/i.test(boot)) throw new Error("host boot identity is unavailable");
  const own = parseStat(readFileSync(`/proc/${pid}/stat`, "utf8"), pid);
  const processes = new Map<number, number>();
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    const childPid = Number(entry);
    if (childPid === pid) continue;
    try { const stat = parseStat(readFileSync(`/proc/${entry}/stat`, "utf8"), childPid); processes.set(childPid, stat.parent_pid); }
    catch { /* a process may exit or become unreadable during the bounded scan */ }
  }
  const children = [...processes.keys()].filter((candidate) => descendantOf(candidate, pid, processes));
  return Object.freeze({ pid, process_start_token: `linux-proc-start:${own.start_ticks}`, host_boot_id: `linux-boot:${boot.toLowerCase()}`, pgid: own.pgid, child_pids: Object.freeze(children.sort((a, b) => a - b).slice(0, 256)) });
}

export function observeRepoFlightHostProcess(pid: number, observedAt = new Date().toISOString(), controlChannel: RepoFlightProcessObservation["control_channel"] = "unknown"): RepoFlightProcessObservation {
  try {
    const identity = probeRepoFlightHostProcess(pid);
    return Object.freeze({ observed_at: observedAt, pid_exists: true, process_start_token: identity.process_start_token, host_boot_id: identity.host_boot_id, control_channel: controlChannel });
  } catch (error) {
    const absent = error instanceof Error && /ENOENT|no such file/i.test(`${error.message} ${(error as NodeJS.ErrnoException).code ?? ""}`);
    let boot: string | null = null;
    try { boot = `linux-boot:${readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim().toLowerCase()}`; } catch { /* absence cannot be host-bound */ }
    return Object.freeze({ observed_at: observedAt, pid_exists: absent ? false : null, process_start_token: null, host_boot_id: boot, control_channel: controlChannel });
  }
}

function parseStat(value: string, expectedPid: number): { readonly parent_pid: number; readonly pgid: number; readonly start_ticks: string } {
  const close = value.lastIndexOf(")");
  if (close < 2) throw new Error("process stat is malformed");
  const parsedPid = Number(value.slice(0, value.indexOf(" "))), fields = value.slice(close + 2).trim().split(/\s+/u);
  // fields[0] is kernel field 3 (state), so ppid=1, pgrp=2, starttime=19.
  const parent = Number(fields[1]), group = Number(fields[2]), start = fields[19];
  if (parsedPid !== expectedPid || !Number.isSafeInteger(parent) || parent < 0 || !Number.isSafeInteger(group) || group <= 0 || typeof start !== "string" || !/^\d+$/.test(start)) throw new Error("process stat identity fields are malformed");
  return { parent_pid: parent, pgid: group, start_ticks: start };
}

function descendantOf(candidate: number, ancestor: number, parents: ReadonlyMap<number, number>): boolean {
  let current = candidate;
  const seen = new Set<number>();
  while (!seen.has(current)) { seen.add(current); const parent = parents.get(current); if (parent === undefined || parent <= 1) return false; if (parent === ancestor) return true; current = parent; }
  return false;
}
