// arbor-audit — external, per-campaign tip sentinel for `EvidenceLedger`.
//
// WHY THIS EXISTS (Track D1 / roadmap §24.2 P1, §24.6 Track D). A hash chain
// where every record carries `previous_hash`/`content_hash` (the shape
// `EvidenceLedger` already has) proves CONTINUITY of whatever bytes are
// present, but proves nothing about COMPLETENESS: dropping the tail of the
// chain leaves a perfectly self-consistent, shorter chain. See
// `packages/arbor-governance/tests/redteam/audit-ledger-attacks.test.ts`
// attack 12 for the empirical demonstration — `verifyIntegrity()` reports
// `valid: true` on a ledger truncated from 5 records to 3.
//
// The fix has to be an anchor the chain's own bytes cannot forge on their
// own: a record count + tip hash captured OUTSIDE the file being protected,
// so that truncating the ledger file does not also truncate the anchor.
// `@arbor/kb`'s sealed stream format (`kb.ts`'s `KBStreamSeal`: `entry_count`
// + `tip_hash`, computed with the same `previous_hash`/`content_hash` chain
// recipe) is the shape this generalizes — but KB's seal is the LAST LINE of
// the very file it protects, which only defeats NAIVE truncation (chopping
// bytes off the end also destroys the seal); a resourceful attacker who
// rewrites the whole file, including a freshly recomputed seal for a smaller
// set of records, defeats it too (documented as a shared structural limit in
// `kb-chain-attacks.test.ts` attack 12's second case). `EvidenceLedger`'s
// ledger and this sentinel are two SEPARATE files for exactly that reason:
// an attacker who can only touch `audit/<campaign>.jsonl` cannot also
// silently rewrite `audit-tips/<campaign>.json` to match.
//
// FOUR VERIFICATION OUTCOMES (deliberately not collapsed into fewer):
//   - "intact"                — ledger tip and sentinel agree.
//   - "tail_truncated"        — ledger has FEWER records than its sentinel
//                                attests to. The attack this feature exists
//                                to catch.
//   - "sentinel_missing"      — no sentinel file exists for this campaign.
//                                This is NOT reported as "intact": a caller
//                                that only checked `valid` on the combined
//                                report would otherwise be told completeness
//                                was confirmed when it was never checked at
//                                all (fail-open at exactly the boundary this
//                                whole audit rejects). It is also NOT
//                                reported as tampered: every ledger written
//                                before this feature shipped has no
//                                sentinel, and treating that as tampering
//                                would break every existing ledger. The
//                                combined report (see verify.ts) therefore
//                                keeps `valid: true` for a missing sentinel
//                                (so legacy ledgers keep verifying) but
//                                surfaces `tip_status: "sentinel_missing"` as
//                                its own distinct, visible value rather than
//                                silently folding it into either extreme.
//   - "sentinel_inconsistent" — a sentinel exists but disagrees with the
//                                ledger's actual tip in some way OTHER than
//                                "ledger is shorter" (e.g. the sentinel file
//                                itself is corrupt/tampered, or the ledger
//                                is somehow AHEAD of its sentinel — the
//                                signature of a crash between the ledger's
//                                own fsync and the sentinel's, since
//                                `saveLedger` writes the ledger first).

import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { acquireWriterLock, assertValidCampaignId, canonicalizeForHash as canonicalJson } from "@arbor/core";
import { atomicOverwriteFile } from "./atomic-write.js";

export const TIP_SENTINEL_VERSION = 2 as const;
/** v1 sealed the ledger only; v2 also seals the repair log. Both are readable. */
export type TipSentinelVersion = 1 | 2;

export interface TipSentinel {
  kind: "arbor_audit_tip_sentinel";
  version: TipSentinelVersion;
  campaign_id: string;
  /** Number of records this campaign's ledger held as of the last durable save. */
  record_count: number;
  /** content_hash of the last record, or null iff record_count is 0. */
  tip_hash: string | null;
  /**
   * v2: the repair log's own sealed length and tip. The repair log was itself
   * a self-describing chain with no external anchor, so deleting the file
   * returned a repaired ledger to a literal "intact" verdict and erasing its
   * tail dropped repairs silently — defeating D2's whole point, that a
   * repaired chain must never report as pristine. Undefined on a v1 sentinel.
   */
  repair_count?: number;
  repair_tip_hash?: string | null;
  /** SHA-256 over every field above. */
  content_hash: string;
}

export type TipStatus =
  | "intact"
  | "tail_truncated"
  | "sentinel_missing"
  | "sentinel_deleted"
  | "sentinel_inconsistent"
  | "repair_log_truncated"
  | "repair_seal_missing";

export interface TipSentinelReadResult {
  value: TipSentinel | null;
  /** True iff a sentinel file exists but failed validation (distinct from simply absent). */
  corrupt: boolean;
  /**
   * True iff the store's manifest attests that a sentinel was once established
   * for this campaign. This is what separates a legacy ledger that never had
   * one (`sentinel_missing`, benign) from one whose sentinel was deleted
   * (`sentinel_deleted`, tampering). Without it, `unlink` on a single file
   * silently downgraded a ledger to the pre-feature state and laundered any
   * truncation — found by the independent audit, attack 19.
   */
  registered: boolean;
  error: string | null;
}

function tipSentinelPath(dir: string, campaignId: string): string {
  return join(dir, "audit-tips", `${campaignId}.json`);
}

// --------------------------------------------------------------- manifest
//
// THREAT MODEL, STATED PLAINLY. The manifest raises the cost of the deletion
// attack from "remove one file" to "remove the whole audit-tips/ directory".
// An earlier version of this comment claimed the cost was "remove one file and
// edit or remove a second, hash-sealed one" — that was FALSE, and an
// independent audit demonstrated it: removing the manifest required no forging
// at all, because an absent manifest read as benign. See readManifest.
// It does NOT make the mechanism unbreakable: an
// attacker who can delete the entire `audit-tips/` directory returns the store
// to its indistinguishable-from-legacy state, and nothing inside the store can
// detect that. That is a real structural limit, not an oversight — this
// repository's enforcement ceiling is REPORTED, not PREVENTED (ADR-025), and
// defeating an attacker with arbitrary write access to the evidence directory
// requires an anchor outside it (a signed remote, or a commit hash in git).
// Recorded here so the limit is witnessed rather than implied.

const MANIFEST_VERSION = 1 as const;

interface TipManifest {
  kind: "arbor_audit_tip_manifest";
  version: typeof MANIFEST_VERSION;
  /** Campaign ids that have ever had a sentinel written. Sorted; append-only in practice. */
  campaigns: string[];
  content_hash: string;
}

function manifestPath(dir: string): string {
  return join(dir, "audit-tips", "manifest.json");
}

/** The manifest lock lives beside the manifest it guards, never in the store root — it is a different lock from the persistence directory's own writer lock and must not be mistaken for it. */
function manifestLockDir(dir: string): string {
  return join(dir, "audit-tips");
}

function readManifest(dir: string): { campaigns: Set<string>; corrupt: boolean } {
  const filePath = manifestPath(dir);
  if (!existsSync(filePath)) {
    // THE ASYMMETRY THAT MAKES THIS DETECTABLE. A store that never sealed
    // anything has no audit-tips/ directory at all — writeTipSentinel is what
    // creates it. So "directory present, manifest absent" cannot arise
    // innocently: something wrote a sentinel here and the manifest that
    // vouched for it is gone.
    //
    // Treating that as benign was a real, demonstrated bypass. The manifest
    // was introduced to raise the cost of attack 19 (delete one sentinel) —
    // but deleting the manifest TOO cost one more plain `unlink`, no forging
    // and no hash recomputation, and because the manifest is shared across
    // every campaign in the store it silently deregistered all of them at
    // once. A 5-record ledger truncated to 2 read back as
    // `{valid: true, tip_status: "sentinel_missing"}`.
    //
    // Failing closed here restores the cost to what this file's header always
    // CLAIMED it was: an attacker must remove the whole audit-tips/ directory,
    // which is the acknowledged structural limit (no anchor outside the store)
    // rather than a two-file shortcut around it.
    return { campaigns: new Set(), corrupt: existsSync(join(dir, "audit-tips")) };
  }
  try {
    const raw = JSON.parse(readFileSync(filePath, "utf-8")) as unknown;
    if (
      !isRecord(raw)
      || raw.kind !== "arbor_audit_tip_manifest"
      || raw.version !== MANIFEST_VERSION
      || !Array.isArray(raw.campaigns)
      || !raw.campaigns.every((id) => typeof id === "string")
      || typeof raw.content_hash !== "string"
    ) {
      return { campaigns: new Set(), corrupt: true };
    }
    const { content_hash, ...unhashed } = raw as { content_hash: string } & Record<string, unknown>;
    if (content_hash !== hashSentinel(unhashed)) return { campaigns: new Set(), corrupt: true };
    return { campaigns: new Set(raw.campaigns as string[]), corrupt: false };
  } catch {
    return { campaigns: new Set(), corrupt: true };
  }
}

/** Record that this campaign has a sentinel. Idempotent; sorted so the file is byte-stable. */
/**
 * Bounded spin for the shared-manifest lock. Contention here is two campaigns
 * in sibling worktrees of one clone sealing at the same moment, so the wait is
 * microseconds in practice; the ceiling only bounds a pathological pile-up.
 */
const MANIFEST_LOCK_ATTEMPTS = 50;
const MANIFEST_LOCK_BACKOFF_MS = 20;

/** Synchronous backoff — `registerInManifest` is a sync API on the seal path and cannot await. */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Registers `campaignId` in the shared manifest under real mutual exclusion.
 *
 * WHY A LOCK, AND WHY NOT OPTIMISTIC RETRY. This is a read-modify-write over a
 * file shared by EVERY campaign in the store. `atomicOverwriteFile` guarantees
 * each write lands whole, but nothing stops two writers that both read the same
 * prior state from each producing a manifest missing the other's entry — and a
 * dropped entry silently DEREGISTERS a campaign, which is exactly the bypass
 * this manifest exists to prevent (see `readManifest`'s note on attack 19). A
 * barrier-raced concurrency test
 * (`scripts/tests/e2e-substrate-concurrency.test.mjs`) reliably lost entries.
 *
 * Optimistic verify-after-write was tried first and is NOT sufficient: the
 * verify is not atomic with the write, so a writer can confirm its own entry
 * and then be clobbered by a racer that read before that write landed. The
 * read, the write, and the verification have to be one critical section.
 *
 * `acquireWriterLock` is reused rather than re-implemented because it already
 * solves the part that makes locking dangerous on a hot path: a lock whose
 * owner died is detected via `process.kill(pid, 0)` and reclaimed, so a crashed
 * sealer cannot wedge sealing for the whole store (ADR-029).
 */
function registerInManifest(dir: string, campaignId: string): void {
  if (readManifest(dir).campaigns.has(campaignId)) return;
  for (let attempt = 0; attempt < MANIFEST_LOCK_ATTEMPTS; attempt += 1) {
    const acquired = acquireWriterLock(manifestLockDir(dir), { holder: "audit-tips-manifest" });
    if (!acquired.ok) {
      sleepSync(MANIFEST_LOCK_BACKOFF_MS);
      continue;
    }
    try {
      const { campaigns } = readManifest(dir);
      if (campaigns.has(campaignId)) return;
      campaigns.add(campaignId);
      const unhashed = {
        kind: "arbor_audit_tip_manifest" as const,
        version: MANIFEST_VERSION,
        campaigns: [...campaigns].sort(),
      };
      const manifest: TipManifest = { ...unhashed, content_hash: hashSentinel(unhashed) };
      atomicOverwriteFile(manifestPath(dir), `${JSON.stringify(manifest)}\n`);
      return;
    } finally {
      acquired.lock.release();
    }
  }
  throw new Error(`audit-tips manifest registration for ${campaignId} could not acquire the shared manifest lock after ${MANIFEST_LOCK_ATTEMPTS} attempts`);
}

function hashSentinel(record: object): string {
  return createHash("sha256").update(canonicalJson(record)).digest("hex");
}

/** Atomically (re)write the tip sentinel for one campaign to match its durable ledger state. */
export function writeTipSentinel(
  dir: string,
  campaignId: string,
  recordCount: number,
  tipHash: string | null,
  repairSeal: { count: number; tip_hash: string | null } = { count: 0, tip_hash: null },
): void {
  assertValidCampaignId(campaignId, "tip sentinel campaign_id");
  if (!Number.isSafeInteger(recordCount) || recordCount < 0) {
    throw new Error("tip sentinel record_count must be a non-negative safe integer");
  }
  if ((recordCount === 0) !== (tipHash === null)) {
    throw new Error("tip sentinel tip_hash must be null if and only if record_count is 0");
  }
  if (!Number.isSafeInteger(repairSeal.count) || repairSeal.count < 0) {
    throw new Error("tip sentinel repair_count must be a non-negative safe integer");
  }
  if ((repairSeal.count === 0) !== (repairSeal.tip_hash === null)) {
    throw new Error("tip sentinel repair_tip_hash must be null if and only if repair_count is 0");
  }
  const unhashed = {
    kind: "arbor_audit_tip_sentinel" as const,
    version: TIP_SENTINEL_VERSION,
    campaign_id: campaignId,
    record_count: recordCount,
    tip_hash: tipHash,
    repair_count: repairSeal.count,
    repair_tip_hash: repairSeal.tip_hash,
  };
  const sentinel: TipSentinel = { ...unhashed, content_hash: hashSentinel(unhashed) };
  atomicOverwriteFile(tipSentinelPath(dir, campaignId), `${JSON.stringify(sentinel)}\n`);
  // Registered AFTER the sentinel is durable. The reverse order would leave a
  // crash window where the manifest claims a sentinel that does not exist,
  // reporting a healthy store as tampered.
  registerInManifest(dir, campaignId);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Validate a parsed sentinel's shape and self-hash; throws with a descriptive reason on failure. */
function validateTipSentinel(raw: unknown, expectedCampaignId: string): TipSentinel {
  if (
    !isRecord(raw)
    || raw.kind !== "arbor_audit_tip_sentinel"
    || (raw.version !== 1 && raw.version !== 2)
    || typeof raw.campaign_id !== "string"
    || raw.campaign_id.length === 0
    || typeof raw.record_count !== "number"
    || !Number.isSafeInteger(raw.record_count)
    || raw.record_count < 0
    || (typeof raw.tip_hash !== "string" && raw.tip_hash !== null)
    || typeof raw.content_hash !== "string"
  ) {
    throw new Error("tip sentinel has an invalid or unrecognized shape");
  }
  if (raw.campaign_id !== expectedCampaignId) {
    throw new Error(`tip sentinel is for campaign ${raw.campaign_id}, expected ${expectedCampaignId}`);
  }
  if ((raw.record_count === 0) !== (raw.tip_hash === null)) {
    throw new Error("tip sentinel tip_hash must be null if and only if record_count is 0");
  }
  const { content_hash, ...unhashed } = raw as { content_hash: string } & Record<string, unknown>;
  if (content_hash !== hashSentinel(unhashed)) {
    throw new Error("tip sentinel content hash does not match — the sentinel file itself has been tampered with");
  }
  const version = raw.version as TipSentinelVersion;
  if (version === 2) {
    if (typeof raw.repair_count !== "number" || !Number.isSafeInteger(raw.repair_count) || raw.repair_count < 0) {
      throw new Error("v2 tip sentinel requires a non-negative integer repair_count");
    }
    if (typeof raw.repair_tip_hash !== "string" && raw.repair_tip_hash !== null) {
      throw new Error("v2 tip sentinel requires a string or null repair_tip_hash");
    }
  }
  return {
    kind: "arbor_audit_tip_sentinel",
    version,
    campaign_id: raw.campaign_id,
    record_count: raw.record_count,
    tip_hash: raw.tip_hash as string | null,
    ...(version === 2
      ? { repair_count: raw.repair_count as number, repair_tip_hash: raw.repair_tip_hash as string | null }
      : {}),
    content_hash,
  };
}

/** Read the sentinel for one campaign. Never throws — corruption is reported, not raised. */
export function readTipSentinelResult(dir: string, campaignId: string): TipSentinelReadResult {
  try {
    assertValidCampaignId(campaignId, "tip sentinel campaign_id");
  } catch (error) {
    return { value: null, corrupt: true, registered: false, error: error instanceof Error ? error.message : String(error) };
  }
  const manifest = readManifest(dir);
  // A corrupt manifest is treated as registering everything. It must fail
  // closed: if the record of what should exist is untrustworthy, "this
  // campaign was never registered" is exactly the claim an attacker would
  // forge, so it cannot be the benign default.
  const registered = manifest.corrupt || manifest.campaigns.has(campaignId);

  const filePath = tipSentinelPath(dir, campaignId);
  if (!existsSync(filePath)) return { value: null, corrupt: false, registered, error: null };
  try {
    const raw = JSON.parse(readFileSync(filePath, "utf-8")) as unknown;
    const sentinel = validateTipSentinel(raw, campaignId);
    return { value: sentinel, corrupt: false, registered, error: null };
  } catch (error) {
    return { value: null, corrupt: true, registered, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Compare a ledger's actual, freshly-computed tip against its recorded
 * sentinel. `actualCount`/`actualTip` must come from the caller's own replay
 * of the campaign's records (this module never reads the ledger file
 * itself, keeping the sentinel and ledger concerns separate).
 */
export function classifyTipStatus(
  actualCount: number,
  actualTip: string | null,
  sentinelResult: TipSentinelReadResult,
  actualRepairs: { count: number; tip_hash: string | null } = { count: 0, tip_hash: null },
): { status: TipStatus; detail: string | null } {
  if (sentinelResult.corrupt) {
    return { status: "sentinel_inconsistent", detail: `tip sentinel is corrupt: ${sentinelResult.error}` };
  }
  if (sentinelResult.value === null) {
    // The distinction attack 19 turned on. A campaign the manifest vouches for
    // must have a sentinel; its absence is evidence of removal, not of age.
    if (sentinelResult.registered) {
      return {
        status: "sentinel_deleted",
        detail: "the store's manifest attests that a tip sentinel was established for this campaign, "
          + "but the sentinel file is gone — it was deleted after being durably written",
      };
    }
    return { status: "sentinel_missing", detail: null };
  }
  const sentinel = sentinelResult.value;
  if (actualCount < sentinel.record_count) {
    return {
      status: "tail_truncated",
      detail: `ledger has ${actualCount} record(s) but its sentinel attests to ${sentinel.record_count} `
        + `(expected tip ${sentinel.tip_hash ?? "null"}) — records were removed after being durably sealed`,
    };
  }
  if (actualCount === sentinel.record_count && actualTip === sentinel.tip_hash) {
    // The ledger agrees. Now the repair log, which is the same
    // self-describing-chain problem one level down: erasing it returned a
    // repaired ledger to a literal "intact" verdict (attack 20).
    if (sentinel.version === 1) {
      // A v1 sentinel predates repair sealing. With no repairs recorded there
      // is nothing it could be hiding, so the store stays valid and upgrades
      // on its next save. With repairs present, completeness is unverifiable
      // and must not be reported as intact.
      if (actualRepairs.count === 0) return { status: "intact", detail: null };
      return {
        status: "repair_seal_missing",
        detail: `this campaign has ${actualRepairs.count} recorded repair(s) but its tip sentinel predates `
          + "repair sealing (v1), so their completeness cannot be verified — re-seal by saving the ledger",
      };
    }
    const sealedCount = sentinel.repair_count ?? 0;
    if (actualRepairs.count < sealedCount) {
      return {
        status: "repair_log_truncated",
        detail: `repair log has ${actualRepairs.count} record(s) but its sentinel attests to ${sealedCount} `
          + "— sanctioned repairs were removed after being durably sealed",
      };
    }
    if (actualRepairs.count === sealedCount && actualRepairs.tip_hash === (sentinel.repair_tip_hash ?? null)) {
      return { status: "intact", detail: null };
    }
    return {
      status: "sentinel_inconsistent",
      detail: `repair log tip (count=${actualRepairs.count}, hash=${actualRepairs.tip_hash ?? "null"}) does not `
        + `match its sentinel (count=${sealedCount}, hash=${sentinel.repair_tip_hash ?? "null"})`,
    };
  }
  return {
    status: "sentinel_inconsistent",
    detail: `ledger tip (count=${actualCount}, hash=${actualTip ?? "null"}) does not match its sentinel `
      + `(count=${sentinel.record_count}, hash=${sentinel.tip_hash ?? "null"})`,
  };
}
