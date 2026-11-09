import { randomUUID } from "node:crypto";
import { link, lstat, readFile, rename, rm, writeFile } from "node:fs/promises";

const MAX_LOCK_WAIT_MS = 10 * 60_000;
const POLL_MS = 100;

interface LockOwner {
  readonly pid: number;
  readonly token: string;
}

function pidIsLive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(new Error("Codex auth lock wait was aborted"));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, ms);
    const abort = () => { clearTimeout(timer); signal.removeEventListener("abort", abort); reject(new Error("Codex auth lock wait was aborted")); };
    function done() { signal.removeEventListener("abort", abort); resolve(); }
    signal.addEventListener("abort", abort, { once: true });
  });
}

async function readOwner(path: string): Promise<LockOwner | null> {
  try {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || (typeof process.getuid === "function" && stat.uid !== process.getuid())) return null;
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    const value = parsed as Record<string, unknown>;
    return Number.isSafeInteger(value.pid) && (value.pid as number) > 0 && typeof value.token === "string" && value.token.length > 0
      ? { pid: value.pid as number, token: value.token }
      : null;
  } catch { return null; }
}

/** Publish a complete owner record atomically. A crash cannot leave an empty lock. */
async function claim(path: string, owner: LockOwner): Promise<boolean> {
  const candidate = `${path}.candidate-${randomUUID()}`;
  try {
    await writeFile(candidate, JSON.stringify(owner), { encoding: "utf8", mode: 0o600, flag: "wx" });
    try { await link(candidate, path); return true; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw error;
    }
  } finally {
    await rm(candidate, { force: true });
  }
}

type ReclaimResult = { readonly reclaimed: true } | { readonly reclaimed: false; readonly blocker: string };

async function reclaimDeadOwner(lockPath: string): Promise<ReclaimResult> {
  const reaperPath = `${lockPath}.reaper`;
  const reaper: LockOwner = { pid: process.pid, token: randomUUID() };
  // Do not try to take over a stale reaper. A waiter that observed an old
  // generation cannot safely unlink or rename this path after another process
  // may have installed a live generation. A stale reaper therefore fails
  // closed and is reported after the bounded wait.
  if (!await claim(reaperPath, reaper)) {
    const owner = await readOwner(reaperPath);
    return { reclaimed: false, blocker: owner === null
      ? `recovery lock ${reaperPath} has indeterminate ownership`
      : `recovery lock ${reaperPath} is held by pid ${owner.pid}${pidIsLive(owner.pid) ? " (live)" : " (confirmed dead; manual recovery required)"}` };
  }
  try {
    const owner = await readOwner(lockPath);
    if (owner === null) return { reclaimed: false, blocker: `auth lock ${lockPath} has indeterminate ownership` };
    if (pidIsLive(owner.pid)) return { reclaimed: false, blocker: `auth lock ${lockPath} is held by live pid ${owner.pid}` };
    const stalePath = `${lockPath}.stale-${randomUUID()}`;
    try {
      // This rename is serialized by the uniquely claimed reaper record. A
      // second process cannot perform a competing stale observation/reclaim.
      await rename(lockPath, stalePath);
      const moved = await readOwner(stalePath);
      if (moved?.pid !== owner.pid || moved.token !== owner.token) {
        try {
          await link(stalePath, lockPath);
          await rm(stalePath, { force: true });
        } catch {
          // Never delete a moved record when it could belong to a live owner.
          // Leave the uniquely named file for operator recovery instead.
        }
        return { reclaimed: false, blocker: `auth lock ${lockPath} changed during serialized recovery; preserved ${stalePath}` };
      }
      if (pidIsLive(moved.pid)) {
        try {
          await link(stalePath, lockPath);
          await rm(stalePath, { force: true });
        } catch { /* preserve stalePath when it could still be the only owner record */ }
        return { reclaimed: false, blocker: `auth lock ${lockPath} now belongs to live pid ${moved.pid}` };
      }
      await rm(stalePath, { force: true });
      return { reclaimed: true };
    } catch { return { reclaimed: false, blocker: `auth lock ${lockPath} could not be safely reclaimed` }; }
  } finally {
    const current = await readOwner(reaperPath);
    if (current?.pid === reaper.pid && current.token === reaper.token) await rm(reaperPath, { force: true });
  }
}

/**
 * Serialize native Canopy Codex calls across processes while the first-party
 * CLI reads and refreshes the durable auth.json. Owner data is atomically
 * published before the lock name appears, so initialization crashes are
 * recoverable by the same dead-PID path. A crashed reaper is likewise reclaimed
 * only the current reaper may remove. A process that crashes while holding
 * the reaper leaves a manual-recovery condition rather than an unsafe takeover.
 */
export async function withCodexAuthStoreLock<T>(
  authPath: string,
  signal: AbortSignal,
  operation: () => Promise<T>,
  options: { readonly max_wait_ms?: number } = {},
): Promise<T> {
  const lockPath = `${authPath}.canopy-lock`;
  const deadline = Date.now() + (options.max_wait_ms ?? MAX_LOCK_WAIT_MS);
  let blocker = `auth lock ${lockPath} is busy`;
  while (Date.now() < deadline) {
    if (signal.aborted) throw new Error("Codex auth lock wait was aborted");
    const owner: LockOwner = { pid: process.pid, token: randomUUID() };
    if (await claim(lockPath, owner)) {
      try {
        if (signal.aborted) throw new Error("Codex auth lock wait was aborted");
        return await operation();
      } finally {
        const current = await readOwner(lockPath);
        if (current?.pid === owner.pid && current.token === owner.token) await rm(lockPath, { force: true });
      }
    }
    const held = await readOwner(lockPath);
    if (held === null) blocker = `auth lock ${lockPath} has indeterminate ownership`;
    else if (!pidIsLive(held.pid)) {
      const recovery = await reclaimDeadOwner(lockPath);
      if (recovery.reclaimed) continue;
      blocker = recovery.blocker;
    } else blocker = `auth lock ${lockPath} is held by live pid ${held.pid}`;
    await delay(Math.min(POLL_MS, deadline - Date.now()), signal);
  }
  throw new Error(`Codex auth store lock wait expired: ${blocker}. No credential was copied or discarded. Check the recorded PID and process owner; remove the named lock file only after confirming its recorded owner is no longer running.`);
}
