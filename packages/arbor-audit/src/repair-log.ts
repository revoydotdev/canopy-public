// arbor-audit — sanctioned-repair log for `EvidenceLedger` (Track D2,
// roadmap §24.2 P2, §24.6 Track D).
//
// §13.5 of the architecture doc names the existing recovery path for a
// corrupted ledger: "truncate-and-replay from the last valid packet". That
// path exists today (`persist.ts`'s `loadLedgerResult` already quarantines a
// tampered file and returns an empty projection), but nothing stops an
// operator — or an attacker with the same filesystem access — from replacing
// the quarantined file with a shorter, hand-edited one and leaving no trace
// of why. A legitimate repair and an attack are indistinguishable after the
// fact. This module closes that gap the way revoy-spec's
// `reseal_tracked_file()` does (idea, not code): a repair requires
// `reason` + `actor` + `git_head`, the repair record is written and fsynced
// BEFORE the ledger file is touched, and the repair log is itself an
// append-only hash chain — never a plain, editable JSON blob.
//
// `performSanctionedRepair` is the ONLY exported way this package can ever
// replace an existing ledger file. `saveLedger` (persist.ts) can only
// append, and throws if asked to overwrite a persisted packet with
// different content — so there is no other path in this package's public
// surface capable of shrinking or replacing a campaign's ledger file
// without going through the reason/actor/git_head gate below. That is a
// deliberate design invariant, not an incidental one: a repair without a
// recorded reason and actor must be impossible through the sanctioned API,
// not merely discouraged by convention.

import {
  appendFileSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { assertValidCampaignId, canonicalizeForHash as canonicalJson, quarantinePersistenceFile, type PersistenceLoadResult } from "@arbor/core";
import { AuditIntegrityError, type EvidenceLedger } from "./audit.js";
import { atomicOverwriteFile } from "./atomic-write.js";
import { writeTipSentinel } from "./tip-sentinel.js";

export interface LedgerRepairTip {
  record_count: number;
  tip_hash: string | null;
}

export interface LedgerRepair {
  campaign_id: string;
  /** Why the repair was necessary. Required, non-empty — enforced, not conventional. */
  reason: string;
  /** Who performed it. Required, non-empty. */
  actor: string;
  /** The git commit the repairing process ran at. Required, non-empty. */
  git_head: string;
  /** Best-effort evidence of the ledger's on-disk state immediately before the repair, even if that state was itself corrupt. */
  before: LedgerRepairTip;
  /** The replacement ledger's tip for this campaign after the repair. */
  after: LedgerRepairTip;
  performed_at: string;
}

export interface LedgerRepairRecord {
  kind: "arbor_audit_repair";
  id: string;
  previous_hash: string | null;
  content_hash: string;
  campaign_id: string;
  repair: LedgerRepair;
}

export interface SanctionedRepairInput {
  reason: string;
  actor: string;
  git_head: string;
}

function repairLogPath(dir: string, campaignId: string): string {
  assertValidCampaignId(campaignId);
  return join(dir, "audit-repairs", `${campaignId}.jsonl`);
}

function ledgerPath(dir: string, campaignId: string): string {
  assertValidCampaignId(campaignId);
  return join(dir, "audit", `${campaignId}.jsonl`);
}

function hashRepairRecord(record: object): string {
  return createHash("sha256").update(canonicalJson(record)).digest("hex");
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function validRepairTip(value: unknown): value is LedgerRepairTip {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const tip = value as LedgerRepairTip;
  return Number.isSafeInteger(tip.record_count) && tip.record_count >= 0
    && (typeof tip.tip_hash === "string" || tip.tip_hash === null)
    && ((tip.record_count === 0) === (tip.tip_hash === null));
}

function validateRepairRecord(record: LedgerRepairRecord, campaignId: string): void {
  const repair = record.repair;
  if (!nonEmpty(record.id) || !nonEmpty(record.content_hash) || (record.previous_hash !== null && !nonEmpty(record.previous_hash))
    || !repair || repair.campaign_id !== campaignId || !nonEmpty(repair.reason) || !nonEmpty(repair.actor)
    || !nonEmpty(repair.git_head) || !nonEmpty(repair.performed_at) || Number.isNaN(Date.parse(repair.performed_at))
    || !validRepairTip(repair.before) || !validRepairTip(repair.after)) {
    throw new AuditIntegrityError("repair log record has an invalid repair payload");
  }
}

/**
 * Load and verify the repair log's own hash chain. Never throws — a broken
 * chain is reported via `diagnostics`, mirroring `loadLedgerResult`'s
 * quarantine-on-corrupt behavior (reusing the "audit_ledger" artifact kind:
 * the repair log is an auxiliary structure of the audit ledger and
 * `@arbor/core`'s `PersistenceArtifact` union has no dedicated variant for
 * it; adding one is out of this lane's file scope, which is arbor-audit's
 * own `src/`/`tests/`, not `@arbor/core`).
 */
export function loadRepairLogResult(dir: string, campaignId: string): PersistenceLoadResult<LedgerRepairRecord[]> {
  const filePath = repairLogPath(dir, campaignId);
  if (!existsSync(filePath)) return { value: [], diagnostics: [] };
  try {
    const lines = readFileSync(filePath, "utf-8").split("\n").map((line) => line.trim()).filter(Boolean);
    const records: LedgerRepairRecord[] = [];
    let previousHash: string | null = null;
    for (let index = 0; index < lines.length; index++) {
      const record = JSON.parse(lines[index]) as LedgerRepairRecord;
      if (record.kind !== "arbor_audit_repair" || record.campaign_id !== campaignId) {
        throw new AuditIntegrityError(`repair log record ${index + 1} has an invalid kind or campaign_id`);
      }
      validateRepairRecord(record, campaignId);
      if (record.previous_hash !== previousHash) {
        throw new AuditIntegrityError(`repair log record ${index + 1} has an invalid predecessor hash`);
      }
      const { content_hash, ...unhashed } = record;
      if (content_hash !== hashRepairRecord(unhashed)) {
        throw new AuditIntegrityError(`repair log record ${index + 1} content hash does not match`);
      }
      records.push(record);
      previousHash = content_hash;
    }
    return { value: records, diagnostics: [] };
  } catch (error) {
    const syntax = error instanceof SyntaxError;
    return {
      value: [],
      diagnostics: [quarantinePersistenceFile(
        filePath, dir, "audit_ledger", syntax ? "invalid_json" : "integrity_failure",
        `repair log for campaign ${campaignId} could not be trusted: ${error instanceof Error ? error.message : String(error)}`,
      )],
    };
  }
}

/** Append one repair record to the campaign's chained repair log. Module-private: only reachable via `performSanctionedRepair`. */
function appendRepairRecord(dir: string, campaignId: string, repair: LedgerRepair): LedgerRepairRecord {
  const existing = loadRepairLogResult(dir, campaignId);
  if (existing.diagnostics.length > 0) {
    throw new AuditIntegrityError(
      `cannot append to a repair log that fails its own integrity check: ${existing.diagnostics.map((d) => d.message).join("; ")}`,
    );
  }
  const previousRecords = existing.value ?? [];
  const previous_hash = previousRecords.length > 0 ? previousRecords[previousRecords.length - 1].content_hash : null;
  const id = `repair_${previousRecords.length + 1}_${hashRepairRecord(repair).slice(0, 12)}`;
  const unhashed = {
    kind: "arbor_audit_repair" as const,
    id,
    previous_hash,
    campaign_id: campaignId,
    repair,
  };
  const record: LedgerRepairRecord = { ...unhashed, content_hash: hashRepairRecord(unhashed) };

  const filePath = repairLogPath(dir, campaignId);
  mkdirSync(dirname(filePath), { recursive: true });
  appendFileSync(filePath, `${JSON.stringify(record)}\n`, "utf-8");
  const descriptor = openSync(filePath, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  return record;
}

/** Best-effort tip extraction from whatever bytes are currently on disk, tolerating exactly the corruption a repair exists to fix. */
function rawLedgerTip(filePath: string): LedgerRepairTip {
  if (!existsSync(filePath)) return { record_count: 0, tip_hash: null };
  const lines = readFileSync(filePath, "utf-8").split("\n").map((line) => line.trim()).filter(Boolean);
  let count = 0;
  let lastHash: string | null = null;
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line) as { content_hash?: unknown };
      if (typeof parsed.content_hash === "string") {
        count++;
        lastHash = parsed.content_hash;
      }
    } catch {
      // benign-catch: capturing "before" evidence for a repair must not
      // itself require the corrupt file to be well-formed -- a malformed
      // line is skipped from the tip count, never crashes the repair that
      // exists to fix exactly this corruption.
    }
  }
  return { record_count: count, tip_hash: lastHash };
}

/**
 * Perform a sanctioned repair: replace one campaign's on-disk ledger with
 * `replacement`'s records for that campaign. Requires a non-empty
 * `reason`, `actor`, and `git_head` — there is no parameter-less overload
 * and no other exported function in this package that can replace an
 * existing ledger file, so this gate cannot be routed around through the
 * sanctioned API.
 *
 * Ordering (so a crash mid-repair leaves evidence, never a silent gap):
 *   1. Validate inputs and the replacement's own integrity.
 *   2. Append+fsync the repair record to the chained repair log.
 *   3. Only then atomically replace the ledger file.
 *   4. Only then refresh the tip sentinel to match the repaired ledger.
 */
export function performSanctionedRepair(
  dir: string,
  campaignId: string,
  replacement: EvidenceLedger,
  input: SanctionedRepairInput,
): LedgerRepairRecord {
  try { assertValidCampaignId(campaignId); }
  catch (error) { throw new AuditIntegrityError(error instanceof Error ? error.message : String(error)); }
  if (!nonEmpty(input.reason) || !nonEmpty(input.actor) || !nonEmpty(input.git_head)) {
    throw new AuditIntegrityError(
      "a sanctioned ledger repair requires a non-empty reason, actor, and git_head — "
      + "the sanctioned API refuses to perform an unattributed repair",
    );
  }
  const replacementIntegrity = replacement.verifyIntegrity();
  if (!replacementIntegrity.valid) {
    throw new AuditIntegrityError(
      `refusing to install a replacement ledger that does not itself pass verifyIntegrity(): ${replacementIntegrity.error}`,
    );
  }

  const filePath = ledgerPath(dir, campaignId);
  const before = rawLedgerTip(filePath);
  const afterRecords = replacement.getRecords(campaignId);
  const after: LedgerRepairTip = {
    record_count: afterRecords.length,
    tip_hash: afterRecords.length > 0 ? afterRecords[afterRecords.length - 1].content_hash : null,
  };

  const repair: LedgerRepair = {
    campaign_id: campaignId,
    reason: input.reason,
    actor: input.actor,
    git_head: input.git_head,
    before,
    after,
    performed_at: new Date().toISOString(),
  };

  // Step 1: evidence of intent, durable, before the tip moves.
  const repairRecord = appendRepairRecord(dir, campaignId, repair);

  // Step 2: only now replace the durable ledger file for this campaign.
  const serialized = afterRecords.length > 0
    ? `${afterRecords.map((record) => JSON.stringify(record)).join("\n")}\n`
    : "";
  atomicOverwriteFile(filePath, serialized);

  // Step 3: bring the external tip sentinel back into agreement with the
  // repaired ledger, or the next verification would misreport this
  // legitimate repair as tail truncation against the stale, pre-repair tip.
  // Seal the repair log alongside the ledger, including the record just
  // appended — otherwise the sentinel would attest to a repair count of zero
  // immediately after a repair, and deleting the log would restore a pristine
  // verdict (attack 20).
  const repairs = loadRepairLogResult(dir, campaignId).value ?? [];
  writeTipSentinel(dir, campaignId, after.record_count, after.tip_hash, {
    count: repairs.length,
    tip_hash: repairs.length > 0 ? repairs[repairs.length - 1].content_hash : null,
  });

  return repairRecord;
}
