import { appendFileSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { assertValidCampaignId, quarantinePersistenceFile, type PersistenceDiagnostic, type PersistenceLoadResult } from "@arbor/core";
import {
  AuditIntegrityError,
  EvidenceLedger,
  type GateCheckpointInput,
  type RecoveryDecisionInput,
  type TerminalProfileInput,
  type TerminalNotificationInput,
  type ScopeIntentBindInput,
} from "./audit.js";
import { classifyTipStatus, readTipSentinelResult, writeTipSentinel, type TipStatus } from "./tip-sentinel.js";
import { loadRepairLogResult } from "./repair-log.js";

/**
 * Record into a throwaway copy, fsync it, and only then merge it back.
 *
 * WHY NOT RECORD DIRECTLY. These wrappers used to record straight into the
 * caller's ledger and then call `saveLedger`, which can throw — a stale on-disk
 * chain, a discontinuous chain, or plain I/O (ENOSPC, EACCES). When it did, the
 * packet stayed resident in the caller's ledger for the life of the process
 * while nothing of it reached disk.
 *
 * That is not a theoretical ordering nit. Reproduced against a real ledger with
 * a real EACCES on the ledger file:
 *
 *     op-2 persist threw           -> YES: EACCES: permission denied
 *     in-memory checkpoints        -> ["op-1","op-2"]
 *     records actually on disk     -> 1
 *     governed transition on op-2  -> PERMITTED
 *
 * `EvidenceLedger.recordGovernedTransition` resolves its prerequisite through
 * the in-memory `getGateCheckpoints`, and refuses with "missing DURABLE ...
 * gate checkpoint". So a failed fsync on a gate checkpoint left the process
 * authorizing an ADR-006 governed transition against evidence a restart would
 * erase — the checkpoint being the very thing that gates the transition.
 *
 * Merging back rather than returning the copy keeps the signature unchanged, so
 * no caller can forget to adopt it: `fromJSONL` merges by id, so a caller that
 * calls twice with the same input still gets the ledger's own idempotent
 * dedup. `manager.ts` already derived the staging discipline independently for
 * node_communication, compaction_lifecycle and interruption ("Stage persistent
 * writes so a failed fsync cannot make evidence observable only in memory");
 * these three wrappers were the sites it was never applied to.
 *
 * A fourth wrapper, `persistCompactionLifecycle`, existed briefly alongside
 * these but was never adopted by `manager.ts`'s `recordCompactionLifecycle`
 * (which keeps its own hand-inlined copy of this same staging discipline,
 * plus idempotent-emit logic this wrapper's signature has no room for) and
 * had zero callers anywhere. Its reachability waiver (gap G-04) was due to
 * expire with no wiring in sight. Wiring `manager.ts` to call it instead of
 * hand-inlining is the DRY-correct fix, but `manager.ts` is out of scope for
 * the change that retired this waiver; recommended follow-up for whoever
 * next touches `manager.ts::recordCompactionLifecycle`. Absent that, an
 * unreachable, un-waived export is worse than one that doesn't exist, so it
 * was deleted rather than the waiver renewed.
 *
 * O(n) in ledger size, matching the clone those safe `manager.ts` sites already
 * pay. `saveLedger` is itself O(n) per append (it re-reads and re-verifies the
 * whole campaign file), so this is a constant factor, not a new complexity class.
 */
function persistStaged(ledger: EvidenceLedger, dir: string, campaignId: string, record: (staged: EvidenceLedger) => string): string {
  const staged = new EvidenceLedger();
  staged.fromJSONL(ledger.toJSONL());
  const evidenceId = record(staged);
  saveLedger(staged, dir, campaignId);
  // Reached only when the write is durable.
  ledger.fromJSONL(staged.toJSONL());
  return evidenceId;
}

/**
 * Record and fsync a gate checkpoint before its governed state transition is
 * made visible. This is the preferred manager boundary; `saveLedger` remains
 * available for batch persistence of ordinary trace packets.
 */
export function persistGateCheckpoint(
  ledger: EvidenceLedger,
  dir: string,
  checkpoint: GateCheckpointInput,
): string {
  return persistStaged(ledger, dir, checkpoint.campaign_id, (staged) => staged.recordGateCheckpoint(checkpoint));
}

/** Record and fsync immutable recovery authority evidence. */
export function persistRecoveryDecision(
  ledger: EvidenceLedger,
  dir: string,
  decision: RecoveryDecisionInput,
): string {
  return persistStaged(ledger, dir, decision.campaign_id, (staged) => staged.recordRecoveryDecision(decision));
}

/** Record and fsync one phase of a fork reopen before the campaign's halt flag changes. */
export function persistCampaignReopen(
  ledger: EvidenceLedger,
  dir: string,
  reopen: import("./audit.js").CampaignReopenInput,
): string {
  return persistStaged(ledger, dir, reopen.campaign_id, (staged) => staged.recordCampaignReopen(reopen));
}

/** Record and fsync a bounded telemetry observation after its source evidence is durable. */
export function persistTelemetryObservation(
  ledger: EvidenceLedger,
  dir: string,
  observation: import("./audit.js").TelemetryObservationInput,
): string {
  return persistStaged(ledger, dir, observation.campaign_id, (staged) => staged.recordTelemetryObservation(observation));
}

/** Persist a renderer-observed terminal profile through the same staged/fsync boundary. */
export function persistTerminalProfile(ledger: EvidenceLedger, dir: string, profile: TerminalProfileInput): string {
  return persistStaged(ledger, dir, profile.campaign_id, (staged) => staged.recordTerminalProfile(profile));
}

/** Persist a renderer-observed terminal notification result without its message text. */
export function persistTerminalNotification(ledger: EvidenceLedger, dir: string, notification: TerminalNotificationInput): string {
  return persistStaged(ledger, dir, notification.campaign_id, (staged) => staged.recordTerminalNotification(notification));
}

/**
 * ADR-119 O3: record and fsync a scope-intent bind through the same
 * staged/fsync boundary as every other durable evidence write here. A
 * failed fsync throws (never leaves the bind resident only in memory), so
 * `manager.ts`'s caller can treat a thrown error the same as `bind_intent`
 * returning false -- refuse the call rather than authorize an unjournaled
 * execution.
 */
export function persistScopeIntentBind(ledger: EvidenceLedger, dir: string, bind: ScopeIntentBindInput): string {
  return persistStaged(ledger, dir, bind.campaign_id, (staged) => staged.recordScopeIntentBind(bind));
}

export function saveLedger(ledger: EvidenceLedger, dir: string, campaignId: string): void {
  assertValidCampaignId(campaignId);
  const auditDir = join(dir, "audit");
  mkdirSync(auditDir, { recursive: true });
  const filePath = join(auditDir, `${campaignId}.jsonl`);
  const persisted = existsSync(filePath) ? loadLedger(dir, campaignId) : new EvidenceLedger();
  const persistedPackets = persisted.getPackets();
  const persistedById = new Map(persistedPackets.map((packet) => [packet.id, packet.content_hash]));
  const packetsToAppend = ledger.getRecords(campaignId).filter((packet) => {
    const existingHash = persistedById.get(packet.id);
    if (existingHash !== undefined && existingHash !== packet.content_hash) {
      throw new AuditIntegrityError(`cannot overwrite persisted trace packet ${packet.id}`);
    }
    return existingHash === undefined;
  });
  if (packetsToAppend.length === 0) return;

  // `persisted` is a local, throwaway EvidenceLedger (built fresh by `loadLedger`
  // above, never returned to the caller) that already holds every persisted
  // packet, parsed and integrity-checked once. Re-serializing those same
  // packets back to JSON and re-parsing them into a second ledger — merely to
  // reach the same content again — is pure waste: reuse `persisted` as
  // `combined` directly and only round-trip the genuinely new packets through
  // `fromJSONL` (which still does its own id-dedup and clone, unchanged).
  const combined = persisted;
  combined.fromJSONL(packetsToAppend.map((packet) => JSON.stringify(packet)).join("\n"));
  const combinedIntegrity = combined.verifyIntegrity();
  if (!combinedIntegrity.valid) {
    throw new AuditIntegrityError(`cannot append a discontinuous audit chain: ${combinedIntegrity.error}`);
  }

  // JSONL is append-only by ADR-007. fsync before returning so the caller can
  // treat a successful save as a durable evidence checkpoint.
  const data = `${packetsToAppend.map((packet) => JSON.stringify(packet)).join("\n")}\n`;
  appendFileSync(filePath, data, "utf-8");
  const descriptor = openSync(filePath, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }

  // Track D1: refresh the external tip sentinel to match the now-durable
  // full chain. Written AFTER the ledger itself is fsynced, so a crash
  // between the two leaves the sentinel merely stale (ledger ahead of its
  // sentinel — reported as "sentinel_inconsistent", never misread as
  // truncation, which is specifically "ledger behind its sentinel").
  const campaignRecords = combined.getRecords(campaignId);
  const tipHash = campaignRecords.length > 0 ? campaignRecords[campaignRecords.length - 1].content_hash : null;
  // The sentinel seals BOTH chains. Re-sealing the repair log at its current
  // state on every save is what upgrades a v1 sentinel in place and keeps the
  // repair seal from drifting behind the log it protects.
  const repairs = loadRepairLogResult(dir, campaignId).value ?? [];
  writeTipSentinel(dir, campaignId, campaignRecords.length, tipHash, {
    count: repairs.length,
    tip_hash: repairs.length > 0 ? repairs[repairs.length - 1].content_hash : null,
  });
}

/** The exact pre-Track-D `loadLedgerResult` behavior, unchanged. Kept private so the public function below can layer D1/D2 reporting on top without altering this core contract. */
function loadLedgerCore(dir: string, campaignId: string): PersistenceLoadResult<EvidenceLedger> {
  assertValidCampaignId(campaignId);
  const ledger = new EvidenceLedger();
  const filePath = join(dir, "audit", `${campaignId}.jsonl`);
  if (!existsSync(filePath)) return { value: ledger, diagnostics: [] };
  try {
    const data = readFileSync(filePath, "utf-8");
    // EvidenceLedger.fromJSONL is intentionally tolerant for import callers;
    // durable recovery must account for every non-empty row instead.
    for (const line of data.split("\n")) if (line.trim()) JSON.parse(line);
    ledger.fromJSONL(data);
    const integrity = ledger.verifyIntegrity();
    if (!integrity.valid) throw new AuditIntegrityError(`audit ledger integrity failure: ${integrity.error}`);
    return { value: ledger, diagnostics: [] };
  } catch (error) {
    const syntax = error instanceof SyntaxError;
    return {
      value: new EvidenceLedger(),
      diagnostics: [quarantinePersistenceFile(
        filePath, dir, "audit_ledger", syntax ? "invalid_json" : "integrity_failure",
        `audit ledger ${campaignId} could not be trusted: ${error instanceof Error ? error.message : String(error)}`,
      )],
    };
  }
}

/** `loadLedgerResult`'s enriched shape: continuity (`value`/`diagnostics`, unchanged) plus Track D1/D2 reporting. */
export interface LedgerLoadResult extends PersistenceLoadResult<EvidenceLedger> {
  /**
   * Overall verdict, folding in D1's completeness check: false if continuity
   * failed OR the tip is tail-truncated, deleted, or inconsistent.
   * Deliberately true when `tip_status` is "sentinel_missing" — a legacy
   * ledger predating this feature must keep verifying (see tip-sentinel.ts's
   * header for the full reasoning) — but that case is never silently folded
   * into "intact": check `tip_status` explicitly to see it.
   *
   * "sentinel_missing" is reserved for a ledger that never had a sentinel.
   * A campaign whose sentinel was established and then removed reports
   * "sentinel_deleted" and is NOT valid — without that split, deleting one
   * file downgraded any ledger to the benign legacy state and laundered a
   * truncation completely (independent audit, attack 19).
   */
  readonly valid: boolean;
  /** D1: one of "intact" | "tail_truncated" | "sentinel_missing" | "sentinel_deleted" | "sentinel_inconsistent" — see tip-sentinel.ts. */
  readonly tip_status: TipStatus;
  readonly tip_detail: string | null;
  /** D2: count of sanctioned repairs recorded for this campaign. A verified chain with repairs is never reported as pristine. */
  readonly repairs_recorded: number;
  /** Human-readable rollup, e.g. "intact", "intact, with 2 recorded repairs", "tail truncated: ...". */
  readonly summary: string;
}

function summarizeLedgerStatus(diagnostics: readonly PersistenceDiagnostic[], tipStatus: TipStatus, repairsRecorded: number): string {
  // Prefer the specific continuity diagnostic (tamper/reorder/corruption) over
  // the coarser tip-status label when both fired — the diagnostic already
  // names the exact root cause; the tip status alone could otherwise mislabel
  // "content was mutated" as "tail truncated" merely because the quarantined
  // projection ends up shorter than its sentinel.
  if (diagnostics.length > 0) {
    return `invalid: ${diagnostics.map((diagnostic) => diagnostic.message).join("; ")}`;
  }
  if (tipStatus === "tail_truncated") return "tail truncated: the ledger has fewer records than its external tip sentinel attests to";
  if (tipStatus === "repair_log_truncated") return "repair log truncated: sanctioned repairs were removed after being sealed";
  if (tipStatus === "repair_seal_missing") return "repair seal missing: recorded repairs predate repair sealing and cannot be verified";
  if (tipStatus === "sentinel_deleted") return "sentinel deleted: this campaign's tip sentinel was established and has since been removed";
  if (tipStatus === "sentinel_inconsistent") return "sentinel inconsistent: the external tip sentinel does not agree with the ledger's actual tip";
  const repairSuffix = repairsRecorded > 0 ? `, with ${repairsRecorded} recorded repair${repairsRecorded === 1 ? "" : "s"}` : "";
  if (tipStatus === "sentinel_missing") {
    return `intact (tip sentinel not yet established — completeness against tail truncation is unverified)${repairSuffix}`;
  }
  return `intact${repairSuffix}`;
}

/**
 * Load a campaign's ledger and verify it, including Track D1's tip-sentinel
 * completeness check and Track D2's repair-log reporting. `.value` and
 * `.diagnostics` behave exactly as before (existing callers that only read
 * those two fields, e.g. arbor-mcp's manager, are unaffected); the added
 * fields are purely additive.
 */
export function loadLedgerResult(dir: string, campaignId: string): LedgerLoadResult {
  const core = loadLedgerCore(dir, campaignId);
  const ledger = core.value ?? new EvidenceLedger();

  const campaignRecords = ledger.getRecords(campaignId);
  const actualCount = campaignRecords.length;
  const actualTip = actualCount > 0 ? campaignRecords[actualCount - 1].content_hash : null;
  const sentinelResult = readTipSentinelResult(dir, campaignId);

  const repairLog = loadRepairLogResult(dir, campaignId);
  const repairRecords = repairLog.value ?? [];
  const repairsRecorded = repairRecords.length;
  const { status: tipStatus, detail: tipDetail } = classifyTipStatus(actualCount, actualTip, sentinelResult, {
    count: repairsRecorded,
    tip_hash: repairsRecorded > 0 ? repairRecords[repairsRecorded - 1].content_hash : null,
  });

  const diagnostics: PersistenceDiagnostic[] = [...core.diagnostics, ...repairLog.diagnostics];
  const tipFailed = tipStatus === "tail_truncated" || tipStatus === "sentinel_deleted"
    || tipStatus === "sentinel_inconsistent" || tipStatus === "repair_log_truncated" || tipStatus === "repair_seal_missing";

  return {
    value: core.value,
    diagnostics,
    valid: diagnostics.length === 0 && !tipFailed,
    tip_status: tipStatus,
    tip_detail: tipDetail,
    repairs_recorded: repairsRecorded,
    summary: summarizeLedgerStatus(diagnostics, tipStatus, repairsRecorded),
  };
}

/**
 * Compatibility API retaining fail-closed behavior after recoverable
 * quarantine. Track D1: also fails closed on `tip_status: "tail_truncated"`
 * or `"sentinel_inconsistent"` — without this, `saveLedger` (which calls
 * this function to fetch the persisted base before appending) would happily
 * append new packets onto a truncated chain and re-seal the sentinel to
 * match the truncated-plus-appended result, laundering the truncation
 * invisibly instead of refusing to build on it. `sentinel_missing` never
 * throws here — a legacy ledger predating this feature must keep working.
 */
export function loadLedger(dir: string, campaignId: string): EvidenceLedger {
  const result = loadLedgerResult(dir, campaignId);
  if (result.diagnostics.length > 0) throw new AuditIntegrityError(result.diagnostics.map((item) => item.message).join("; "));
  if (result.tip_status !== "intact" && result.tip_status !== "sentinel_missing") {
    throw new AuditIntegrityError(`audit ledger ${campaignId} failed its tip sentinel check: ${result.tip_detail ?? result.tip_status}`);
  }
  return result.value ?? new EvidenceLedger();
}
