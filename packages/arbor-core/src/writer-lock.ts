/**
 * writer-lock.ts — one writer process per persistence directory.
 *
 * WHY THIS EXISTS. `saveLedger` performs a read-modify-append against a
 * campaign's JSONL evidence ledger with no coordination of any kind: it reads
 * the persisted chain, verifies it, computes what to append relative to that
 * read, and appends. Two processes doing that concurrently against one
 * directory interleave, and the loser's append is refused by the chain's own
 * integrity check with "cannot append a discontinuous audit chain".
 *
 * That refusal keeps the ledger CORRECT — the file is never corrupted — but it
 * is a liveness failure, not a safe outcome: none of the call sites catch it,
 * retry it, or rebase onto the new tip, so the losing process's evidence is
 * silently discarded. Evidence that was recorded and then dropped is worse than
 * evidence never taken, because the ledger reads as complete either way.
 *
 * An audit established this is REACHABLE, not hypothetical: `arbor-mcp serve`
 * and `webui` each construct a fresh runtime against a caller-supplied
 * persistence directory, `campaign_id` is client-supplied free text, and the
 * only two "already running" guards in the system are in-memory maps private to
 * one process. Nothing stops a second server — a leftover from a prior session,
 * or a second editor's MCP client — from being pointed at the same directory.
 *
 * THE DECISION THIS IMPLEMENTS is ADR-029: one writer process per persistence
 * directory, enforced rather than assumed. This lock is the enforcement. It
 * makes a second writer fail loudly at startup instead of silently losing
 * evidence at some later append.
 *
 * WHAT THIS IS NOT. It is an advisory lock between cooperating revoy2
 * processes, not a security control and not a filesystem-level guarantee. It
 * cannot stop a process that ignores it, edits the ledger directly, or runs as
 * a user able to remove the lock file. Per ADR-025's ladder that is PREVENTED
 * for the case it covers (a second revoy2 server) and nothing at all for an
 * arbitrary writer — which is the honest ceiling, and the same ceiling the
 * tip sentinel and repair log already operate under.
 */

import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeSync } from "node:fs";
import { join } from "node:path";

/** Marker file naming the process that currently owns a persistence directory. */
export const WRITER_LOCK_FILENAME = ".arbor-writer.lock";

export interface WriterLockRecord {
  readonly pid: number;
  readonly acquired_at: string;
  /** Free-form, for an operator reading the file: which entry point took it. */
  readonly holder: string;
}

export interface WriterLockHandle {
  readonly path: string;
  readonly record: WriterLockRecord;
  /** Idempotent, and only ever removes a lock this handle still owns. */
  release(): void;
}

export type WriterLockResult =
  | { readonly ok: true; readonly lock: WriterLockHandle; readonly reclaimed_stale: boolean }
  | { readonly ok: false; readonly held_by: WriterLockRecord | null; readonly detail: string };

/**
 * Is a process alive? `kill(pid, 0)` performs the permission and existence
 * check without delivering a signal. EPERM means it exists but belongs to
 * another user — alive for our purposes, and deliberately NOT reclaimable.
 */
function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function readLock(path: string): WriterLockRecord | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
    if (!parsed || typeof parsed !== "object") return null;
    const record = parsed as Record<string, unknown>;
    if (typeof record.pid !== "number" || typeof record.acquired_at !== "string") return null;
    return { pid: record.pid, acquired_at: record.acquired_at, holder: typeof record.holder === "string" ? record.holder : "unknown" };
  } catch {
    // Unreadable or malformed: treated as held by an unidentifiable owner
    // rather than as absent. Refusing on a lock we cannot parse is the
    // fail-closed direction; deleting it would be the fail-open one.
    return null;
  }
}

/**
 * Take the writer lock for `dir`, or refuse.
 *
 * Acquisition is atomic: `openSync(path, "wx")` fails when the file already
 * exists, so two processes racing here cannot both succeed regardless of how
 * their checks interleave. There is no check-then-create window.
 *
 * A lock whose recorded pid is no longer running is STALE — the owner crashed
 * or was killed without releasing — and is reclaimed, because refusing forever
 * on a dead process would make a hard kill permanently disable the directory.
 * An unparseable lock file is never reclaimed: we cannot show its owner is
 * gone, so refusing is the fail-closed answer.
 */
export function acquireWriterLock(
  dir: string,
  options: { holder?: string; now?: () => string; pid?: number } = {},
): WriterLockResult {
  // Taking ownership of a directory includes bringing it into existence: a
  // server's first run has no persistence directory yet, and refusing there
  // would make the lock break the very startup it is meant to protect.
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    // Left to the open below to report as an unwritable directory.
  }
  const path = join(dir, WRITER_LOCK_FILENAME);
  const record: WriterLockRecord = {
    pid: options.pid ?? process.pid,
    acquired_at: (options.now ?? (() => new Date().toISOString()))(),
    holder: options.holder ?? "unknown",
  };

  const write = (): WriterLockHandle | null => {
    let descriptor: number;
    try {
      descriptor = openSync(path, "wx");
    } catch {
      return null;
    }
    try {
      writeSync(descriptor, JSON.stringify(record, null, 2));
    } finally {
      closeSync(descriptor);
    }
    let released = false;
    return {
      path,
      record,
      release(): void {
        if (released) return;
        released = true;
        // Only remove a lock still recording OUR pid: if it was reclaimed as
        // stale by another process, that process owns it now and this handle
        // must not delete someone else's lock.
        const current = readLock(path);
        if (current !== null && current.pid !== record.pid) return;
        rmSync(path, { force: true });
      },
    };
  };

  const first = write();
  if (first) return { ok: true, lock: first, reclaimed_stale: false };

  if (!existsSync(path)) {
    return { ok: false, held_by: null, detail: `could not create ${path}, and no lock file is present — the directory is likely not writable` };
  }
  const held = readLock(path);
  if (held === null) {
    return { ok: false, held_by: null, detail: `${path} exists but could not be parsed; refusing rather than assuming it is abandoned` };
  }
  if (processAlive(held.pid)) {
    return {
      ok: false,
      held_by: held,
      detail: `persistence directory is already owned by pid ${held.pid} (${held.holder}, since ${held.acquired_at}). `
        + "Two writers on one directory silently drop the loser's evidence (ADR-029); stop that process or use a different --dir.",
    };
  }

  // Stale: the recorded owner is gone. Remove and retry once. A concurrent
  // reclaimer may win the retry, in which case we refuse normally.
  rmSync(path, { force: true });
  const second = write();
  if (second) return { ok: true, lock: second, reclaimed_stale: true };
  const winner = readLock(path);
  return { ok: false, held_by: winner, detail: `stale lock from pid ${held.pid} was reclaimed by another process first` };
}
