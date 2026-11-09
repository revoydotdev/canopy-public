/**
 * scripts/lib/adr-claims.mjs — the ADR claim ledger: advisory records, NOT locks.
 *
 * WHY THIS EXISTS (ADR-CLAIM manifest, §1). The originating idea for decision
 * traceability was a write lock: an agent "checks out" an ADR, and writes to
 * files it did not declare are blocked. That was rejected — a declared file
 * list is a prediction that drifts, cardinality collapses the lock (a few ADRs
 * would own nearly every hot file), and write-time blocking gets bypassed
 * (`--no-verify`, measured twice on 2026-08-15 alone). The mechanism kept from
 * that idea is only the CLAIM step: an agent names the ADR(s) it believes
 * govern its work, recorded for anyone reconciling history later. Nothing here
 * ever refuses a claim, and nothing here ever blocks a write. Two holders MAY
 * claim the same ADR number; the ledger records both. Reconciliation against
 * what actually happened is `scripts/adr-trace.mjs`'s job, not this file's.
 *
 * REUSE, NOT REINVENTION. `scripts/lib/adr-registry.mjs`'s
 * `readSharedReservations` / `recordSharedReservation` already solved the
 * exact concurrency problem a claim ledger would otherwise fall back into: a
 * per-worktree file (`decisions/registry.json`, or here `decisions/*.md`) is
 * tracked and therefore forked once per `git worktree add`, so writing "the"
 * ledger there only ever produces N private ledgers that never see each
 * other. adr-registry.mjs's fix — store the shared file OUTSIDE any
 * worktree's tracked tree, at `git rev-parse --git-common-dir`, which is the
 * one directory every worktree of one clone actually shares — is followed
 * here exactly, at a sibling path (`adr-claims.json`, not
 * `adr-reservations.json`; a different fact, not a different mechanism).
 * Every write is best-effort (a filesystem that refuses it loses cross-
 * worktree visibility, never the operation), matching `recordSharedReservation`.
 *
 * STALE-CLAIM DETECTION (`scripts/worktree-hygiene.mjs`'s hard-won lesson).
 * That gate's header records a locked worktree whose lock reason named a PID
 * that "looked obviously stale" and, on inspection, was alive and actively
 * working — a false "safe to remove" costs a live session its work, while a
 * false "leave it" only costs someone a look. This module applies the exact
 * same asymmetry: `activeClaims` reports whether a claim's recording PID is
 * currently alive (`isPidAlive`, `/proc/<pid>` on Linux — the same objective,
 * unfakeable-by-a-live-process signal worktree-hygiene.mjs uses) and NEVER
 * auto-removes an entry on that basis. Age is a DIFFERENT, weaker fact — an
 * old timestamp does not prove abandonment, only elapsed time — so the
 * age-based prune here exists purely to bound the ledger's file size (mirrors
 * `RESERVATION_MAX_ENTRIES`/`RESERVATION_MAX_AGE_MS`), not to decide
 * liveness. The only way an entry is ever removed on purpose is an explicit
 * `releaseClaim` by its own holder.
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { git } from "./conductor/git.mjs";
import { readRegistry } from "./adr-registry.mjs";

const CLAIM_MAX_ENTRIES = 512;
const CLAIM_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // pure housekeeping bound, see module header

export function claimsPath(repo) {
  const raw = git(repo, ["rev-parse", "--git-common-dir"]).stdout;
  const common = isAbsolute(raw) ? raw : resolve(repo, raw);
  return join(common, "adr-claims.json");
}

/** Never throws: a missing, unreadable, or corrupt ledger is an empty ledger. */
export function readSharedClaims(repo) {
  try {
    const parsed = JSON.parse(readFileSync(claimsPath(repo), "utf8"));
    if (parsed?.schema_version !== 1 || !Array.isArray(parsed.entries)) return [];
    return parsed.entries.filter((entry) => Number.isSafeInteger(entry?.adr) && typeof entry?.holder === "string");
  } catch {
    return [];
  }
}

function writeSharedClaims(repo, entries) {
  try {
    writeFileSync(claimsPath(repo), `${JSON.stringify({ schema_version: 1, entries }, null, 2)}\n`);
    return true;
  } catch {
    // Best effort by construction, exactly like recordSharedReservation: a
    // filesystem that refuses this write loses cross-worktree visibility for
    // this claim, never the ability to keep working.
    return false;
  }
}

function pruneByAge(entries, now = Date.now()) {
  return entries
    .filter((entry) => !Number.isSafeInteger(entry.at) || now - entry.at < CLAIM_MAX_AGE_MS)
    .slice(-CLAIM_MAX_ENTRIES);
}

function existingAdrNumbers(repo) {
  return new Set(readRegistry(repo).allocations.map((entry) => entry.number));
}

/**
 * Records `holder` as claiming every ADR in `adrs`. Advisory: an ADR already
 * claimed by a different holder is claimed again, not refused — the ledger
 * ends up with two entries, which is the intended, honest representation of
 * "two agents both believe this ADR governs their work" rather than a
 * fabricated exclusivity neither agent actually has.
 *
 * Fails loudly (throws) only for a request that cannot be satisfied at all:
 * an empty `adrs` list, or an ADR number absent from `decisions/registry.json`
 * — claiming a decision that does not exist is a typo, not a valid claim.
 */
export function claimAdrs({ repo, adrs, holder, at = Date.now(), pid = process.pid }) {
  if (!holder || typeof holder !== "string") throw new Error("claimAdrs requires a non-empty string holder");
  const numbers = [...new Set((adrs ?? []).map((n) => Number(n)))];
  if (numbers.length === 0) throw new Error("claimAdrs requires at least one ADR number");
  if (numbers.some((n) => !Number.isSafeInteger(n) || n <= 0)) throw new Error(`claimAdrs received a non-numeric or invalid ADR: ${JSON.stringify(adrs)}`);

  const known = existingAdrNumbers(repo);
  const unknown = numbers.filter((n) => !known.has(n));
  if (unknown.length > 0) {
    throw new Error(`cannot claim ADR-${unknown.map((n) => String(n).padStart(3, "0")).join(", ADR-")}: no matching allocation in decisions/registry.json`);
  }

  const recorded = numbers.map((adr) => ({ adr, holder, at, pid: Number.isSafeInteger(pid) ? pid : null }));
  const kept = pruneByAge(readSharedClaims(repo), at);
  const entries = pruneByAge([...kept, ...recorded], at);
  writeSharedClaims(repo, entries);
  return { ok: true, holder, adrs: numbers, recorded };
}

/** Removes every entry recorded by `holder`, regardless of which ADR it names. */
export function releaseClaim({ repo, holder }) {
  if (!holder || typeof holder !== "string") throw new Error("releaseClaim requires a non-empty string holder");
  const before = readSharedClaims(repo);
  const released = before.filter((entry) => entry.holder === holder);
  const kept = before.filter((entry) => entry.holder !== holder);
  writeSharedClaims(repo, kept);
  return { ok: true, holder, released };
}

function isPidAlive(pid) {
  if (pid === null || pid === undefined) return null; // unknown, not "dead" — an entry recorded without a pid makes no liveness claim
  if (process.platform === "linux") return existsSync(`/proc/${pid}`);
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Every currently-recorded claim, pruned by age and annotated with whether
 * its recording process is still alive. `pid_alive: null` means the entry
 * predates PID recording or ran on a platform this check cannot evaluate —
 * distinct from `false`, which is the one condition worktree-hygiene.mjs's
 * incident establishes as trustworthy evidence. `pid_alive` is reported only;
 * this function removes nothing on the strength of it.
 */
export function activeClaims({ repo }) {
  const now = Date.now();
  const pruned = pruneByAge(readSharedClaims(repo), now);
  if (pruned.length !== readSharedClaims(repo).length) writeSharedClaims(repo, pruned);
  return pruned
    .map((entry) => ({ ...entry, pid_alive: isPidAlive(entry.pid) }))
    .sort((a, b) => (a.adr - b.adr) || (a.at - b.at));
}
