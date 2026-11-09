import { createHash } from "node:crypto";
import type { CapabilityContext } from "@arbor/core";
import { compareCodeUnits } from "@arbor/core";
import { AuditIntegrityError, type EvidenceLedger, type MemoryFactRecord, type TracePacket } from "@arbor/audit";
import type { KBEntry } from "@arbor/kb";

export interface ProjectedMemoryEntry extends KBEntry {
  /** Stable pointer to the authoritative fact record, not a second authority. */
  evidence_pointer: string;
  source_evidence_pointer: string;
  source_campaign_id: string;
  source_node_id: string;
  scope: MemoryFactRecord["fact"]["scope"];
  /** Immutable source identity for an explicitly imported fact. */
  imported_from?: NonNullable<MemoryFactRecord["fact"]["imported_from"]>;
}

export interface MemoryProjectionRequest {
  /** Campaign receiving the projection. Source identity remains on each entry. */
  campaign_id: string;
  /** Selected node followed by its ancestors. Required for subtree-scoped facts. */
  node_ancestry: readonly string[];
  capability: CapabilityContext;
  limit?: number;
  /** Legacy latest-first page offset. Prefer `projectMemoryFactsPage` for rebuilds. */
  offset?: number;
}

export interface MemoryProjectionPageRequest extends Omit<MemoryProjectionRequest, "offset"> {
  /** Opaque cursor bound to the exact ledger snapshot and projection request. */
  cursor?: string;
}

export interface MemoryProjectionPage {
  /** Entries retain ledger order within this latest-first page window. */
  entries: ProjectedMemoryEntry[];
  next_cursor: string | null;
  has_more: boolean;
  snapshot_id: string;
}

interface MemoryCandidate {
  record: MemoryFactRecord;
  source?: TracePacket;
}

/**
 * Rebuild a bounded KB view from ledger authority. This compatibility helper
 * preserves the original offset semantics; rebuild callers should use the page
 * API so a full page cannot be mistaken for completion.
 */
export function projectMemoryFacts(
  ledgers: EvidenceLedger | readonly EvidenceLedger[],
  request: MemoryProjectionRequest,
): ProjectedMemoryEntry[] {
  const candidates = collectCandidates(ledgers, request);
  const limit = validateLimit(request.limit);
  const offset = request.offset ?? 0;
  if (!Number.isSafeInteger(offset) || offset < 0) throw new AuditIntegrityError("memory projection offset must be a non-negative safe integer");
  return sliceLatest(candidates, limit, offset).map((candidate) => toProjectedEntry(candidate, request.campaign_id));
}

/**
 * Bounded, snapshot-bound pagination across one or more ledgers. `has_more` and
 * `next_cursor` make truncation explicit, while the snapshot binding refuses a
 * cursor after any source ledger or request scope changes.
 */
export function projectMemoryFactsPage(
  ledgers: EvidenceLedger | readonly EvidenceLedger[],
  request: MemoryProjectionPageRequest,
): MemoryProjectionPage {
  const candidates = collectCandidates(ledgers, request);
  const limit = validateLimit(request.limit);
  const snapshotId = projectionSnapshotId(candidates, request);
  const offset = decodeCursor(request.cursor, snapshotId);
  const records = sliceLatest(candidates, limit, offset);
  const hasMore = candidates.length > offset + records.length;
  return {
    entries: records.map((record) => toProjectedEntry(record, request.campaign_id)),
    next_cursor: hasMore ? `${snapshotId}:${offset + records.length}` : null,
    has_more: hasMore,
    snapshot_id: snapshotId,
  };
}

function collectCandidates(
  input: EvidenceLedger | readonly EvidenceLedger[],
  request: Pick<MemoryProjectionRequest, "campaign_id" | "node_ancestry" | "capability">,
): MemoryCandidate[] {
  if (!request.campaign_id.trim() || !Array.isArray(request.node_ancestry)
    || request.node_ancestry.some((id) => !id.trim())) {
    throw new AuditIntegrityError("memory projection requires a campaign and valid ancestry");
  }
  const ledgers: readonly EvidenceLedger[] = Array.isArray(input) ? input as readonly EvidenceLedger[] : [input as EvidenceLedger];
  if (ledgers.length === 0) return [];
  const candidates: MemoryCandidate[] = [];
  for (const ledger of ledgers) {
    const integrity = ledger.verifyIntegrity();
    if (!integrity.valid) throw new AuditIntegrityError(`cannot project untrusted memory ledger: ${integrity.error}`);
    const ledgerRecords = ledger.getRecords();
    for (const record of ledgerRecords) {
      if (record.kind !== "memory_fact") continue;
      const source = ledgerRecords.find((candidate): candidate is TracePacket =>
        (candidate.kind === "trace" || candidate.kind === undefined) && candidate.id === record.fact.source_evidence_id);
      candidates.push({ record, source });
    }
  }

  const visible = candidates.filter(({ record }) => {
    if (record.fact.tier === "critic_only" && request.capability.tier === "specialist") return false;
    if (record.fact.scope.kind === "cross_campaign") return true;
    if (record.campaign_id !== request.campaign_id) return false;
    return record.fact.scope.kind === "campaign" || request.node_ancestry.includes(record.fact.scope.root_node_id);
  });

  // Campaign/subtree facts remain isolated authorities. Explicitly promoted
  // facts deduplicate by semantics, independent of campaign-local IDs.
  const deduplicated = new Map<string, MemoryCandidate>();
  for (const candidate of visible.sort((left, right) => compareFacts(left.record, right.record))) {
    const { record } = candidate;
    const key = record.fact.scope.kind === "cross_campaign"
      ? `promoted:${semanticFactHash(record)}`
      : `scoped:${record.campaign_id}:${record.fact.idempotency_key}`;
    if (!deduplicated.has(key)) deduplicated.set(key, candidate);
  }
  return [...deduplicated.values()].sort((left, right) => compareFacts(left.record, right.record));
}

function compareFacts(left: MemoryFactRecord, right: MemoryFactRecord): number {
  // compareCodeUnits, not localeCompare: this projector's whole contract is
  // that the same ledger replays to the same rows anywhere. campaign_id and id
  // can carry mixed case, where ICU and code-unit order genuinely disagree.
  return compareCodeUnits(left.timestamp, right.timestamp)
    || compareCodeUnits(left.campaign_id, right.campaign_id)
    || compareCodeUnits(left.id, right.id)
    || compareCodeUnits(left.content_hash, right.content_hash);
}

function semanticFactHash(record: MemoryFactRecord): string {
  return createHash("sha256").update(JSON.stringify({
    type: record.fact.type,
    content: record.fact.content,
    tier: record.fact.tier,
    tags: [...record.fact.tags].sort(),
  })).digest("hex");
}

function projectionSnapshotId(
  records: readonly MemoryCandidate[],
  request: Pick<MemoryProjectionRequest, "campaign_id" | "node_ancestry" | "capability">,
): string {
  return createHash("sha256").update(JSON.stringify({
    campaign_id: request.campaign_id,
    node_ancestry: request.node_ancestry,
    capability: request.capability,
    records: records.map(({ record }) => [record.campaign_id, record.id, record.content_hash]),
  })).digest("hex");
}

function decodeCursor(cursor: string | undefined, snapshotId: string): number {
  if (cursor === undefined) return 0;
  const separator = cursor.lastIndexOf(":");
  const cursorSnapshot = cursor.slice(0, separator);
  const offset = Number(cursor.slice(separator + 1));
  if (separator < 1 || cursorSnapshot !== snapshotId || !Number.isSafeInteger(offset) || offset < 0) {
    throw new AuditIntegrityError("memory projection cursor is invalid or belongs to a different snapshot");
  }
  return offset;
}

function validateLimit(value: number | undefined): number {
  const limit = value ?? 100;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
    throw new AuditIntegrityError("memory projection limit must be from 1 to 1000");
  }
  return limit;
}

function sliceLatest(records: readonly MemoryCandidate[], limit: number, offset: number): MemoryCandidate[] {
  const end = Math.max(0, records.length - offset);
  const start = Math.max(0, end - limit);
  return records.slice(start, end);
}

function toProjectedEntry(candidate: MemoryCandidate, targetCampaignId: string): ProjectedMemoryEntry {
  const { record, source } = candidate;
  const evidencePointer = `audit:${record.campaign_id}:${record.id}`;
  const projected: ProjectedMemoryEntry = {
    id: `memory_${createHash("sha256").update(`${targetCampaignId}\0${record.campaign_id}\0${record.id}\0${record.content_hash}`).digest("hex")}`,
    campaign_id: targetCampaignId,
    type: record.fact.type,
    value: record.fact.content,
    provenance: structuredClone(record.fact.provenance),
    as_of: evidencePointer,
    tier: record.fact.tier,
    created_at: record.timestamp,
    tags: [...record.fact.tags],
    evidence_pointer: evidencePointer,
    source_evidence_pointer: `audit:${record.campaign_id}:${record.fact.source_evidence_id}`,
    source_campaign_id: record.campaign_id,
    source_node_id: record.node_id,
    scope: structuredClone(record.fact.scope),
    ...(record.fact.imported_from === undefined ? {} : { imported_from: structuredClone(record.fact.imported_from) }),
  };
  if (record.fact.type === "failure_mode") {
    projected.failure_mode = source?.action_description;
    projected.root_cause = source?.critic_root_cause ?? undefined;
  }
  return projected;
}
