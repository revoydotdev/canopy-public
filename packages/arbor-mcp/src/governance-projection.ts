/**
 * governance-projection.ts — a pure, deterministic governance snapshot
 * projected from the real `decisions/` corpus and repository state, via
 * `@arbor/governance` (ADR-027 Decision point 4's first real consumer).
 *
 * Mirrors metrics-projector.ts / memory-projector.ts's idiom: a pure
 * function of its explicit inputs (no `Date.now()`, no `process.env`
 * reads, no randomness — see `GovernanceSnapshotOptions.at`, which is
 * caller-supplied for exactly the reason `obligation/proof.ts`'s
 * `ResolveProofOptions.at` is: the impurity of "what time is it" stays
 * visible at the call site instead of hiding inside a function this
 * package's tests assert is deterministic). Same repository content + same
 * `at` => byte-identical `buildGovernanceSnapshot()` output.
 *
 * NO FABRICATED DATA. Every field here is derived from a real
 * `@arbor/governance` call over the real `decisions/*.md` corpus (27 files
 * as of this writing) — obligation coverage is zero across the board
 * because that is the corpus's true current state (no legacy ADR has ever
 * declared an "## Obligations" section), not a placeholder. `unknown`,
 * `unverifiable`, and "malformed input" are never collapsed into a success
 * value: a directory that cannot be read, or a corpus larger than this
 * projection's bound, comes back as a typed `GovernanceResult` error, and
 * this function never throws — it runs behind a CLI/TUI, where a corpus
 * glitch must degrade to a reported error, not a crash.
 *
 * Scope note (why some of `@arbor/governance`'s exports are NOT used here):
 * the artifact-identity/lineage/scan subsystem (`artifact/identity.ts`,
 * `artifact/lineage.ts`, `artifact/scan.ts`) tracks code-artifact identity
 * across the whole `packages/*\/src` tree, and `verify/chain.ts` verifies
 * ledger hash chains — both genuinely different concerns from "a snapshot
 * of the decisions corpus's governance state", so calling them here would
 * be ceremony (calling a function only to mark it reachable), which this
 * lane's brief explicitly forbids. `validateTransition` is similarly
 * unused: it validates an explicit `(from, to)` status-transition pair, and
 * this corpus records only a record's current status, never a transition
 * history, so there is no real `(from, to)` pair for a snapshot projection
 * to check.
 */

import { compareCodeUnits, canonicalizeForHash } from "@arbor/core";
import { checkStatusTransitions, type StatusBaseline } from "@arbor/governance";
import { resolve as resolvePath } from "node:path";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { AuditIntegrityError, type EvidenceLedger } from "@arbor/audit";
import {
  scanDecisionsCorpus,
  buildObligationCoverageReport,
  deriveRepositoryCounts,
  deriveCountDriftDocuments,
  checkCounts,
  parseGapRegister,
  checkGapStatusConsistency,
  deriveGapStatusScanDocuments,
  GAP_REGISTER_DOCUMENT,
  extractExceptions,
  buildIntentGraph,
  deriveRepositoryBaseline,
  findExemptedClaims,
  type ExemptedClaim,
  recordContentHash,
  deriveRecordId,
  deriveBacklog,
  selectNextBacklogItem,
  type DecisionStatus,
  type ImplementationStatus,
  type VerificationStatus,
  type PolicyFinding,
  type GovernanceError,
  type GovernanceResult,
  type Confidence,
  type Backlog,
  type BacklogItem,
} from "@arbor/governance";

const CAPABILITY = "governance.projection.snapshot";

/**
 * This used to be three hand-picked paths, chosen because they were already
 * known to be drifted. That is a sample, not a gate: a 2026-08-06 sweep found
 * 57 drifted claims across 117 markdown files while this list checked three
 * of them, and every document corrected that day (README, AGENTS, ROADMAP,
 * release-readiness) was outside it.
 *
 * The set is now derived from the repository — see
 * `deriveCountDriftDocuments` for what is scanned, and for why test fixtures
 * and dated audit ledgers are excluded by construction rather than by
 * line-marking. Callers may still override with `count_drift_documents`.
 */
export function defaultCountDriftDocuments(repoRoot: string): readonly string[] {
  return deriveCountDriftDocuments(repoRoot);
}

/** Derived fresh from the repository on every call (`counts/derive.ts`'s own purity guarantee). */
export type RepositoryCounts = ReturnType<typeof deriveRepositoryCounts>;

export type LegacyClassification = "parsed" | "parsed_with_warnings" | "unparseable";

export interface GovernanceRecordSummary {
  /** Namespaced RecordId ("revoy2:ADR-026"), or the bare filename when the record failed to parse and no id could be derived. */
  readonly id: string;
  readonly record_number: number | null;
  readonly title: string | null;
  readonly source_path: string;
  readonly classification: LegacyClassification;
  readonly decision: DecisionStatus | null;
  /** `recordContentHash()` of the parsed record; null when unparseable (there is no canonical record to hash). */
  readonly content_hash: string | null;
  /** From the obligation coverage report, joined by RecordId; null when no coverage entry matched. */
  readonly obligation_count: number | null;
  readonly implementation: ImplementationStatus | null;
  readonly verification: VerificationStatus | null;
  readonly parse_warnings: readonly string[];
  readonly unparseable_reasons: readonly string[];
}

export type DecisionStatusDistribution = Readonly<Record<DecisionStatus, number>>;

export interface LegacyClassificationBreakdown {
  readonly total: number;
  readonly parsed: number;
  readonly parsed_with_warnings: number;
  readonly unparseable: number;
}

export interface ObligationCoverageSummary {
  readonly total_records: number;
  /** Sum of `obligation_count` across every record. The true current state of this corpus is 0. */
  readonly total_obligations: number;
  /** Records that declare a "## Obligations" heading at all (distinct from declaring zero obligations under one — see obligation/parse.ts's own doc comment on this distinction). */
  readonly records_with_obligations_section: number;
  readonly records_fully_covered: number;
}

export interface GovernanceSnapshot {
  readonly schema_version: 1;
  readonly at: string;
  readonly decisions_dir: string;
  readonly records: readonly GovernanceRecordSummary[];
  readonly decision_status_distribution: DecisionStatusDistribution;
  readonly legacy_classification: LegacyClassificationBreakdown;
  readonly obligation_coverage: ObligationCoverageSummary;
  /**
   * POL-04 (accepted, zero obligations) + M-B (bad proof field) + SUR-05
   * (repo-count doc drift) + SUR-06 (gap-register status drift) + POL-05
   * (unlawful status transition, only when `status_baseline` was supplied)
   * + waiver findings (unresolved authority / unowned / expired allowlist
   * entries) + intent-graph mismatches (orphan/test-only-governed ADRs,
   * dangling citations), deterministically sorted.
   */
  readonly policy_findings: readonly PolicyFinding[];
  /**
   * False when no status baseline was supplied, meaning POL-05 did not run.
   * Distinct from "ran and found nothing": a reader must be able to tell
   * "no lifecycle violations" from "the lifecycle was never checked".
   */
  readonly status_baseline_available: boolean;
  readonly repository_counts: RepositoryCounts;
  /**
   * Lines excluded from the SUR-05 count check because they carry
   * `HISTORICAL_CLAIM_MARKER` — a dated measurement rather than a claim about
   * today. Reported rather than silently dropped: "no drift found" and "no
   * drift found, having skipped these 7 lines" are different statements, and
   * a reader must be able to tell them apart. Empty means nothing was
   * exempted, never that exemptions were not looked for.
   */
  readonly count_claim_exemptions: readonly ExemptedClaim[];
  /**
   * Waivers ingested from `scripts/reachability/allowlist.json`, and intent
   * drift between the ADR corpus and the code that cites it.
   *
   * These were computed by standalone `.mjs` scripts that nothing in the
   * product ever called, so their findings reached a human only when someone
   * ran the script by hand. They are governance findings — an unresolvable
   * waiver authority and a superseded record still governing live code are
   * exactly what this snapshot exists to report — so they are merged into
   * `policy_findings` alongside POL-04 and SUR-05 rather than kept in a
   * parallel channel nobody reads.
   */
  readonly waiver_total: number;
  readonly intent_dangling_citations: number;
  readonly intent_orphan_records: number;
  /** Probes that report UNMEASURED rather than a number they cannot stand behind. */
  readonly repository_baseline: ReturnType<typeof deriveRepositoryBaseline>;
  /**
   * ADR-027 Decision point 2: count of governance events witnessed into the
   * ledger's reserved "governance" campaign on this call. `null` when no
   * `ledger` was supplied — distinct from `0` (a ledger WAS supplied and
   * genuinely had nothing new to witness, e.g. every event this call would
   * derive was already witnessed by a prior call and deduped by idempotency
   * key). This function stays pure for every existing caller that omits
   * `ledger` (see `GovernanceSnapshotOptions.ledger`'s own doc comment).
   */
  readonly governance_events_witnessed: number | null;
  /**
   * ADR-027 Decision point 3: the governance graph, projected from the
   * ledger's witnessed governance event stream after this call's witnessing
   * step. `null` under the same condition as `governance_events_witnessed`.
   */
  readonly graph: GovernanceGraphProjection | null;
  /**
   * E-8: direct-tier (review-waived) outcome totals across every campaign
   * `ledger` holds in memory. `null` under the same condition as
   * `governance_events_witnessed`/`graph` — no `ledger` was supplied, so
   * this stays the pure, ledger-free function every existing caller gets.
   */
  readonly waiver_outcome_totals: WaiverOutcomeTotals | null;
}

/** E-8 rollup: adopted vs. unadjudicated (no `later_failed` determination yet) waiver outcomes. */
export interface WaiverOutcomeTotals {
  readonly total: number;
  readonly adopted: number;
  readonly unadjudicated: number;
}

/**
 * Fold every `waiver_outcome` record `ledger` holds — across every campaign
 * it has in memory, not just the reserved "governance" stream — into
 * adopted/unadjudicated totals. Pure given `ledger`'s current in-memory
 * content; callers persist/refresh `ledger` themselves, same as every other
 * consumer of `EvidenceLedger` in this codebase.
 */
export function computeWaiverOutcomeTotals(ledger: EvidenceLedger): WaiverOutcomeTotals {
  const campaignIds = new Set(
    ledger.getRecords().filter((record) => record.kind === "waiver_outcome").map((record) => record.campaign_id),
  );
  let total = 0;
  let adopted = 0;
  let unadjudicated = 0;
  for (const campaignId of campaignIds) {
    for (const entry of ledger.getFoldedWaiverOutcomes(campaignId)) {
      total += 1;
      if (entry.adopted) adopted += 1;
      if (entry.later_failed === null) unadjudicated += 1;
    }
  }
  return { total, adopted, unadjudicated };
}

export interface GovernanceSnapshotOptions {
  /** Repository root, passed explicitly rather than resolved from cwd/env so this stays a pure function of its inputs. */
  repo_root: string;
  /** ISO-8601 timestamp stamped on every EvidenceRef this snapshot's findings carry. Never read from a clock inside this function — see module header. */
  at: string;
  /** Repo-relative documents scanned for SUR-05 numeric-claim drift. Defaults to `defaultCountDriftDocuments(repo_root)`. */
  count_drift_documents?: readonly string[];
  /**
   * POL-05: the integration branch's decision statuses, keyed by RecordId.
   * Reading it is git IO and belongs to the caller, so this function stays a
   * pure function of its inputs. Absent means the baseline could not be
   * resolved — the lifecycle is simply not judged, and the snapshot says so
   * via `status_baseline_available` rather than reporting a clean result it
   * did not actually verify.
   */
  status_baseline?: StatusBaseline;
  /**
   * Defensive bound on corpus size (mirrors metrics-projector.ts's
   * `bounded()` idiom) — but reported as a typed error, never thrown: this
   * projection is used behind a CLI/TUI and must degrade to a reported
   * failure, not a crash, per this lane's brief.
   */
  max_records?: number;
  /**
   * ADR-027 Decision points 2 & 3, opt-in. When supplied, this call
   * ADDITIONALLY (a) derives governance events from what it computes anyway
   * (record status, POL-04/POL-05/M-B/SUR-05 findings, obligation coverage,
   * resolved citations) and witnesses each one into `ledger` under the
   * reserved "governance" campaign via `EvidenceLedger.recordGovernanceEvent`
   * (idempotent — re-witnessing identical content is a no-op, never a
   * duplicate), and (b) projects the resulting governance graph. Persisting
   * `ledger` to disk (`saveLedger`) remains the CALLER's responsibility, same
   * as every other ledger mutation in this codebase — this function mutates
   * only the in-memory ledger instance it was handed.
   *
   * Omitted (every caller today, including `arbor-mcp governance`): this
   * function is unchanged and fully pure, exactly as documented above —
   * `governance_events_witnessed`/`graph` come back `null`, never computed.
   */
  ledger?: EvidenceLedger;
}

const DEFAULT_MAX_RECORDS = 2_000;
const GOVERNANCE_CAMPAIGN_ID = "governance";

function internalError(message: string): GovernanceError {
  return { code: "internal", message };
}

// ============================================================================
// ADR-027 Decision point 2 — the governance event stream
//
// Governance events append to the EXISTING `EvidenceLedger` (`@arbor/audit`)
// under `campaign_id: "governance"` via its `recordGovernanceEvent` method —
// never a parallel ledger class (the ADR rejects that explicitly: it would
// duplicate tested hashing, verification, and persistence for no functional
// gain). `EvidenceLedger` itself enforces the reservation: every OTHER
// campaign-scoped write refuses this exact campaign id, so `recordGovernanceEvent`
// is the only path onto it (see `assertOrdinaryCampaignId` in
// `packages/arbor-audit/src/audit.ts`).
//
// Every event kind here is derived from something this file already computes
// for `GovernanceSnapshot` — no invented event nothing produces:
//   - record_status_observed: `records[].decision` / `.content_hash`.
//   - policy_finding_observed: `policy_findings[]` (POL-04, POL-05, M-B, SUR-05
//     uniformly — one event shape for every rule id, since PolicyFinding
//     already carries rule_id/severity/subject/detail/evidence).
//   - obligation_coverage_observed: `records[].obligation_count/implementation/verification`.
//   - citation_observed: `scanDecisionsCorpus`'s own `citations.facts` (the
//     migration honesty triad's resolved "ADR-NNN" cross-references), which
//     this file already computes via `corpus.value.citations` but discarded
//     before this change.
// ============================================================================

export type GovernanceEventKind =
  | "record_status_observed"
  | "policy_finding_observed"
  | "obligation_coverage_observed"
  | "citation_observed";

export interface RecordStatusObservedEvent {
  readonly kind: "record_status_observed";
  readonly record_id: string;
  readonly source_path: string;
  readonly decision: DecisionStatus;
  readonly content_hash: string;
}

export interface PolicyFindingObservedEvent {
  readonly kind: "policy_finding_observed";
  readonly finding: PolicyFinding;
}

export interface ObligationCoverageObservedEvent {
  readonly kind: "obligation_coverage_observed";
  readonly record_id: string;
  readonly obligation_count: number;
  readonly implementation: ImplementationStatus;
  readonly verification: VerificationStatus;
}

export interface CitationObservedEvent {
  readonly kind: "citation_observed";
  readonly source_record_id: string;
  readonly target_record_id: string;
  readonly citation_token: string;
  readonly confidence: Confidence;
}

export type GovernanceEvent =
  | RecordStatusObservedEvent
  | PolicyFindingObservedEvent
  | ObligationCoverageObservedEvent
  | CitationObservedEvent;

const GOVERNANCE_EVENT_KINDS: readonly GovernanceEventKind[] = [
  "record_status_observed", "policy_finding_observed", "obligation_coverage_observed", "citation_observed",
];

/** Structural shape this file needs from a citation fact; avoids importing `@arbor/governance`'s unexported `CitationFact` type. */
export interface CitationFactLike {
  readonly source_record_id: string;
  readonly citation_token: string;
  readonly method: string;
  readonly confidence: Confidence | null;
  readonly target: string | null;
}

/**
 * Derive governance events from an already-built `GovernanceSnapshot` plus
 * the corpus's own resolved citation facts. Pure: reads no clock, no
 * filesystem, no ledger — every event's identity is fully determined by its
 * own content, which is what makes `governanceEventIdempotencyKey` sound.
 */
export function deriveGovernanceEvents(
  snapshot: Pick<GovernanceSnapshot, "records" | "policy_findings">,
  citationFacts: readonly CitationFactLike[],
): readonly GovernanceEvent[] {
  const events: GovernanceEvent[] = [];
  for (const record of snapshot.records) {
    if (record.decision === null || record.content_hash === null) continue; // unparseable — nothing to witness
    events.push({
      kind: "record_status_observed",
      record_id: record.id,
      source_path: record.source_path,
      decision: record.decision,
      content_hash: record.content_hash,
    });
    if (record.obligation_count !== null && record.implementation !== null && record.verification !== null) {
      events.push({
        kind: "obligation_coverage_observed",
        record_id: record.id,
        obligation_count: record.obligation_count,
        implementation: record.implementation,
        verification: record.verification,
      });
    }
  }
  for (const finding of snapshot.policy_findings) {
    events.push({ kind: "policy_finding_observed", finding });
  }
  for (const fact of citationFacts) {
    if (fact.method === "none" || fact.target === null || fact.confidence === null) continue; // never witness a guess
    events.push({
      kind: "citation_observed",
      source_record_id: fact.source_record_id,
      target_record_id: fact.target,
      citation_token: fact.citation_token,
      confidence: fact.confidence,
    });
  }
  return events;
}

/** Content-derived idempotency key: identical events (any field but nothing time-dependent) dedupe to one ledger record on re-witnessing. */
/**
 * Recursively drop observation-time fields, so an event's identity is WHAT was
 * observed rather than WHEN.
 *
 * Policy findings carry an `at` stamp. Hashing it made every run of
 * `arbor-mcp governance` mint fresh keys for an unchanged corpus, so the
 * stream grew by ~29 records per invocation while reporting itself idempotent.
 * Observed directly: 124 records became 153 on a second run against identical
 * decisions/. A governance stream that grows when nothing governed changed is
 * not a witness, it is noise that buries the moment something did change.
 */
function withoutObservationTime(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutObservationTime);
  if (value === null || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
    if (key === "at" || key === "observed_at" || key === "timestamp") continue;
    out[key] = withoutObservationTime(inner);
  }
  return out;
}

function governanceEventIdempotencyKey(event: GovernanceEvent): string {
  const identity = canonicalizeForHash(withoutObservationTime(event));
  return `governance:${createHash("sha256").update(identity).digest("hex")}`;
}

function governanceEventNodeId(event: GovernanceEvent): string {
  switch (event.kind) {
    case "record_status_observed": return event.record_id;
    case "obligation_coverage_observed": return event.record_id;
    case "citation_observed": return event.source_record_id;
    case "policy_finding_observed":
      return "record_id" in event.finding.subject
        ? event.finding.subject.record_id
        : `${event.finding.subject.kind}:${event.finding.subject.path}`;
  }
}

function describeGovernanceEvent(event: GovernanceEvent): string {
  switch (event.kind) {
    case "record_status_observed": return `${event.record_id} decision status observed: ${event.decision}`;
    case "obligation_coverage_observed":
      return `${event.record_id} obligation coverage observed: ${event.obligation_count} obligation(s), `
        + `implementation=${event.implementation}, verification=${event.verification}`;
    case "policy_finding_observed": return `${event.finding.rule_id} (${event.finding.severity}) observed: ${event.finding.detail}`;
    case "citation_observed": return `${event.source_record_id} cites ${event.target_record_id} (${event.citation_token})`;
  }
}

function isGovernanceEvent(value: unknown): value is GovernanceEvent {
  if (typeof value !== "object" || value === null) return false;
  const kind = (value as { kind?: unknown }).kind;
  return typeof kind === "string" && (GOVERNANCE_EVENT_KINDS as readonly string[]).includes(kind);
}

export interface WitnessGovernanceEventsResult {
  /** Count of NEWLY appended ledger records — dedup-aware. An event whose idempotency key was already witnessed by a prior call does not increment this. */
  readonly recorded: number;
  /** One id per input event, new or pre-existing, in input order — always the same length as `events`. */
  readonly ids: readonly string[];
}

/**
 * Witness derived governance events into `ledger`'s reserved "governance"
 * campaign. Idempotent per event (content-derived key — see
 * `governanceEventIdempotencyKey`): calling this twice with the same derived
 * events appends nothing the second time. Mutates `ledger` in place;
 * persisting it (`saveLedger`) is the caller's responsibility.
 */
export function witnessGovernanceEvents(
  ledger: EvidenceLedger,
  events: readonly GovernanceEvent[],
  options: { readonly at: string },
): WitnessGovernanceEventsResult {
  const ids: string[] = [];
  let recorded = 0;
  const existingKeys = new Set(
    ledger.getCampaign(GOVERNANCE_CAMPAIGN_ID)
      .map((record) => record.idempotency_key)
      .filter((key): key is string => key !== undefined),
  );
  for (const event of events) {
    const idempotencyKey = governanceEventIdempotencyKey(event);
    const isNew = !existingKeys.has(idempotencyKey);
    const id = ledger.recordGovernanceEvent({
      node_id: governanceEventNodeId(event),
      timestamp: options.at,
      idempotency_key: idempotencyKey,
      action_description: describeGovernanceEvent(event),
      action_category: event.kind,
      specialist_agent: "governance-projection",
      critic_agent: null,
      node_state_before: "pending",
      // `claimed`, not `verified`: `tree.ts`'s `verifyNode` never retires a
      // node as `verified` from anything but `tag: "verified"` provenance
      // (ADR-134 — a `verified` node_state must not outrun its provenance).
      // This is a machine-computed projection over real repository state,
      // not a run command's exit code, so `provenance` below is `generated`
      // — and `node_state_after` has to agree with it, or a reader counting
      // "verified" ledger records would count these as more verified than
      // they are.
      node_state_after: "claimed",
      provenance: { tag: "generated", generator: "arbor-mcp/governance-projection@1", input_hash: idempotencyKey },
      specialist_output: JSON.stringify(event),
      critic_verdict_approved: null,
      critic_root_cause: null,
      score_before: 0,
      score_after: 0,
      gates: [],
      kb_entries_written: [],
    });
    ids.push(id);
    if (isNew) {
      recorded += 1;
      existingKeys.add(idempotencyKey);
    }
  }
  return { recorded, ids };
}

/**
 * `getX` accessor matching `recordTelemetryObservation`/`getTelemetryObservations`'s
 * pairing: read every governance event durably witnessed in `ledger`,
 * refusing to trust a ledger whose hash chain does not verify.
 */
export function getGovernanceEvents(ledger: EvidenceLedger): readonly GovernanceEvent[] {
  const integrity = ledger.verifyIntegrity();
  if (!integrity.valid) throw new AuditIntegrityError(`cannot read untrusted governance ledger: ${integrity.error}`);
  const events: GovernanceEvent[] = [];
  for (const record of ledger.getCampaign(GOVERNANCE_CAMPAIGN_ID)) {
    if (record.specialist_output === null) continue;
    try {
      const parsed: unknown = JSON.parse(record.specialist_output);
      if (isGovernanceEvent(parsed)) events.push(parsed);
    } catch {
      // Not a governance-projection-authored record — skip rather than fail
      // the whole read (mirrors fromJSONL's own tolerance of malformed lines).
    }
  }
  return events;
}

// ============================================================================
// ADR-027 Decision point 3 — the governance graph
//
// A third pure projector beside `metrics-projector.ts`'s `projectTelemetry`
// and `memory-projector.ts`'s `projectMemoryFactsPage`, with the same shape:
// integrity-gated (`ledger.verifyIntegrity()`), deterministically sorted
// (`compareCodeUnits`, never `localeCompare`), snapshot-cursored (bounded
// pages over a content-hashed snapshot id), and never authoritative — it is
// rebuilt entirely from `getGovernanceEvents`, so losing it is a non-event.
// ============================================================================

export interface GovernanceGraphEdge {
  readonly source: string;
  readonly target: string;
  readonly type: "DEPENDS_ON";
  readonly plane: "derived";
  readonly confidence: Confidence;
  /** The real ledger record id that first witnessed this edge — unlike `graph/projector.ts`'s corpus-only sibling, this one has a real event to point to. */
  readonly first_seen_event: string;
  readonly evidence_pointer: string;
}

export interface GovernanceGraphProjection {
  readonly edges: readonly GovernanceGraphEdge[];
  readonly source_event_count: number;
  readonly snapshot_id: string;
  readonly next_cursor: string | null;
  readonly has_more: boolean;
}

export interface ProjectGovernanceGraphOptions {
  readonly cursor?: string;
  readonly limit?: number;
  readonly max_edges?: number;
}

function boundedGraphOption(value: number, minimum: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new AuditIntegrityError(`${label} must be from ${minimum} to ${maximum}`);
  }
  return value;
}

function decodeGraphCursor(cursor: string | undefined, snapshotId: string): number {
  if (cursor === undefined) return 0;
  const separator = cursor.lastIndexOf(":");
  const cursorSnapshot = cursor.slice(0, separator);
  const offset = Number(cursor.slice(separator + 1));
  if (separator < 1 || cursorSnapshot !== snapshotId || !Number.isSafeInteger(offset) || offset < 0) {
    throw new AuditIntegrityError("governance graph projection cursor is invalid or belongs to a different snapshot");
  }
  return offset;
}

/**
 * Project the governance graph from `ledger`'s witnessed event stream.
 * Currently derives edges from `citation_observed` events only (the one
 * relationship kind this witnessing layer produces real facts for —
 * supersession/amendment edges would need obligation/schema data this
 * corpus does not yet declare; see `record/status.ts`'s own honesty about
 * `compliance: "unknown"` for the same reason). Bounded: throws rather than
 * silently drops when `max_edges` is exceeded.
 */
export function projectGovernanceGraph(
  ledger: EvidenceLedger,
  options: ProjectGovernanceGraphOptions = {},
): GovernanceGraphProjection {
  const limit = boundedGraphOption(options.limit ?? 500, 1, 5_000, "governance graph projection limit");
  const maxEdges = boundedGraphOption(options.max_edges ?? 10_000, 1, 100_000, "governance graph projection max_edges");

  // Integrity-gated via `getGovernanceEvents` itself (it refuses an
  // unverified ledger before returning anything) — this projector's real
  // `getX` counterpart, not a second, duplicate parse of the same records.
  const events = getGovernanceEvents(ledger);
  const records = ledger.getCampaign(GOVERNANCE_CAMPAIGN_ID);
  const recordByIdempotencyKey = new Map(
    records.filter((record) => record.idempotency_key !== undefined)
      .map((record) => [record.idempotency_key as string, record] as const),
  );

  const edges: GovernanceGraphEdge[] = [];
  for (const event of events) {
    if (event.kind !== "citation_observed") continue;
    const record = recordByIdempotencyKey.get(governanceEventIdempotencyKey(event));
    if (!record) continue; // defensive: every witnessed event carries its own idempotency key
    edges.push({
      source: event.source_record_id,
      target: event.target_record_id,
      type: "DEPENDS_ON",
      plane: "derived",
      confidence: event.confidence,
      first_seen_event: record.id,
      evidence_pointer: `audit:${record.campaign_id}:${record.id}`,
    });
    if (edges.length > maxEdges) throw new AuditIntegrityError(`governance graph projection exceeds ${maxEdges} edges`);
  }

  edges.sort((a, b) =>
    compareCodeUnits(a.source, b.source)
    || compareCodeUnits(a.target, b.target)
    || compareCodeUnits(a.first_seen_event, b.first_seen_event));

  const snapshotId = createHash("sha256")
    .update(JSON.stringify(edges.map((e) => [e.source, e.target, e.first_seen_event])))
    .digest("hex");
  const offset = decodeGraphCursor(options.cursor, snapshotId);
  const page = edges.slice(offset, offset + limit);
  const hasMore = edges.length > offset + page.length;

  return {
    edges: page,
    source_event_count: records.length,
    snapshot_id: snapshotId,
    next_cursor: hasMore ? `${snapshotId}:${offset + page.length}` : null,
    has_more: hasMore,
  };
}

/** Discriminates a PolicyFinding's subject into a stable sort key without assuming either shape is authoritative over the other. */
function findingSubjectKey(finding: PolicyFinding): string {
  const subject = finding.subject;
  return "record_id" in subject ? `record:${subject.record_id}` : `${subject.kind}:${subject.path}`;
}

function compareFindings(a: PolicyFinding, b: PolicyFinding): number {
  return (
    // `detail` carries ADR titles authored by humans — mixed case and
    // accents both occur, and that is exactly where ICU and code-unit
    // ordering diverge. See @arbor/core's ordering.ts.
    compareCodeUnits(a.rule_id, b.rule_id) ||
    compareCodeUnits(findingSubjectKey(a), findingSubjectKey(b)) ||
    compareCodeUnits(a.detail, b.detail)
  );
}

/**
 * Build one governance snapshot from the real `decisions/` corpus plus
 * repository-count/doc-drift checks. Never throws — every failure path
 * (an unreadable decisions directory, a corpus past `max_records`, or any
 * unexpected internal failure) returns a typed `GovernanceResult` error
 * instead.
 */
export function buildGovernanceSnapshot(options: GovernanceSnapshotOptions): GovernanceResult<GovernanceSnapshot> {
  try {
    const repoRoot = options.repo_root;
    const at = options.at;
    const maxRecords = options.max_records ?? DEFAULT_MAX_RECORDS;
    const countDriftDocuments = options.count_drift_documents ?? defaultCountDriftDocuments(repoRoot);
    const decisionsDir = resolvePath(repoRoot, "decisions");

    const corpus = scanDecisionsCorpus(decisionsDir);
    if (!corpus.ok) return { ok: false, error: corpus.error, capability: CAPABILITY };

    if (corpus.value.total > maxRecords) {
      return {
        ok: false,
        error: {
          code: "validation",
          message: `decisions corpus has ${corpus.value.total} records; snapshot bound is ${maxRecords}`,
          at: decisionsDir,
        },
        capability: CAPABILITY,
      };
    }

    const obligationReport = buildObligationCoverageReport({ repoRoot, at, decisionsDir });
    if (!obligationReport.ok) return { ok: false, error: obligationReport.error, capability: CAPABILITY };

    const coverageByRecordId = new Map<string, (typeof obligationReport.value.records)[number]>();
    for (const coverage of obligationReport.value.records) coverageByRecordId.set(coverage.record_id, coverage);

    const repositoryCounts = deriveRepositoryCounts(repoRoot);
    const countDriftFindings = checkCounts(repoRoot, countDriftDocuments, repositoryCounts, { at });

    // SUR-06 sits beside SUR-05 for the same reason SUR-05 sits here: the
    // check is a pure function of on-disk documents, and projecting it makes
    // its findings reachable from a product entry point rather than only from
    // its own gate script. A missing ROADMAP.md yields no register and no
    // findings -- absence of the register is not a contradiction.
    let gapStatusFindings: readonly PolicyFinding[] = [];
    try {
      const registerText = readFileSync(resolvePath(repoRoot, GAP_REGISTER_DOCUMENT), "utf8");
      const register = parseGapRegister(registerText);
      gapStatusFindings = checkGapStatusConsistency(
        repoRoot,
        deriveGapStatusScanDocuments(repoRoot),
        register,
        { at },
      );
    } catch {
      gapStatusFindings = [];
    }

    const records: GovernanceRecordSummary[] = [];
    const decisionStatusDistribution: Record<DecisionStatus, number> = {
      draft: 0,
      proposed: 0,
      accepted: 0,
      rejected: 0,
      superseded: 0,
    };

    for (const result of corpus.value.results) {
      const basename = result.source_path.split("/").pop() ?? result.source_path;
      const derivedId = deriveRecordId(basename);
      const coverage = derivedId ? (coverageByRecordId.get(derivedId) ?? null) : null;

      if (result.record) decisionStatusDistribution[result.record.status.decision] += 1;

      records.push({
        id: result.record?.id ?? derivedId ?? basename,
        record_number: result.record?.record_number ?? null,
        title: result.record?.title ?? null,
        source_path: result.source_path,
        classification: result.classification,
        decision: result.record?.status.decision ?? null,
        content_hash: result.record ? recordContentHash(result.record) : null,
        obligation_count: coverage?.obligation_count ?? null,
        implementation: coverage?.implementation ?? null,
        verification: coverage?.verification ?? null,
        parse_warnings: result.classification === "parsed_with_warnings" ? result.reasons : [],
        unparseable_reasons: result.classification === "unparseable" ? result.reasons : [],
      });
    }

    // POL-05 runs only when a baseline was supplied. A missing baseline must
    // not read as "no lifecycle violations" — see status_baseline_available.
    const transitionFindings = options.status_baseline
      ? checkStatusTransitions(options.status_baseline, corpus.value.results, { at })
      : [];
    // Waiver + intent findings (ADR-031's absorption). A failure to read
    // either (`exceptions.ok`/`intent.ok` false — e.g. a malformed
    // `allowlist.json`) collapses to zero findings AND zero totals, exactly
    // like a real, clean zero-waiver/zero-drift corpus: nothing on
    // `GovernanceSnapshot` distinguishes "checked, found nothing" from "the
    // read failed". Unlike `status_baseline_available` (which names this same
    // shape and closes it for POL-05), no such flag exists here yet — this is
    // a known gap, not a distinction this projection currently makes.
    const exceptions = extractExceptions(repoRoot, { today: at.slice(0, 10), at });
    const intent = buildIntentGraph(repoRoot);
    const exceptionFindings = exceptions.ok ? exceptions.value.findings : [];
    const intentFindings: PolicyFinding[] = intent.ok
      ? intent.value.findings.map((finding) => ({
          rule_id: finding.mismatch,
          severity: finding.severity === "critical" ? "blocker" : "warning",
          subject: { kind: "doc", path: finding.evidence, symbol_id: null, content_hash: "", schema_version: 1 },
          detail: finding.title,
          remediation: "Reconcile the record with the code that cites it, or amend the record.",
          evidence: [],
          waiver_eligible: true,
          is_legacy_debt: true,
        } as unknown as PolicyFinding))
      : [];

    const policyFindings = [
      ...obligationReport.value.findings,
      ...countDriftFindings,
      ...gapStatusFindings,
      ...transitionFindings,
      ...exceptionFindings,
      ...intentFindings,
    ].sort(compareFindings);

    const totalObligations = obligationReport.value.records.reduce((sum, r) => sum + r.obligation_count, 0);
    const recordsWithObligationsSection = obligationReport.value.records.filter((r) => r.has_obligations_section).length;
    const recordsFullyCovered = obligationReport.value.records.filter((r) => r.implementation === "complete").length;

    // Governance events witnessed / graph projected below (when a ledger is
    // supplied) need this snapshot's own `records`/`policy_findings` as
    // input, so they are computed AFTER it — but the fields still land on
    // the SAME returned `GovernanceSnapshot`, not a second object.
    let governanceEventsWitnessed: number | null = null;
    let graph: GovernanceGraphProjection | null = null;
    let waiverOutcomeTotals: WaiverOutcomeTotals | null = null;
    if (options.ledger) {
      const events = deriveGovernanceEvents(
        { records, policy_findings: policyFindings },
        corpus.value.citations.facts,
      );
      const witnessed = witnessGovernanceEvents(options.ledger, events, { at });
      governanceEventsWitnessed = witnessed.recorded;
      graph = projectGovernanceGraph(options.ledger, {});
      waiverOutcomeTotals = computeWaiverOutcomeTotals(options.ledger);
    }

    const snapshot: GovernanceSnapshot = {
      schema_version: 1,
      at,
      decisions_dir: corpus.value.decisions_dir,
      records,
      decision_status_distribution: decisionStatusDistribution,
      legacy_classification: {
        total: corpus.value.total,
        parsed: corpus.value.parsed,
        parsed_with_warnings: corpus.value.parsed_with_warnings,
        unparseable: corpus.value.unparseable,
      },
      obligation_coverage: {
        total_records: obligationReport.value.records.length,
        total_obligations: totalObligations,
        records_with_obligations_section: recordsWithObligationsSection,
        records_fully_covered: recordsFullyCovered,
      },
      policy_findings: policyFindings,
      status_baseline_available: options.status_baseline !== undefined,
      repository_counts: repositoryCounts,
      count_claim_exemptions: findExemptedClaims(repoRoot, countDriftDocuments),
      waiver_total: exceptions.ok ? exceptions.value.summary.total : 0,
      // The measured repository baseline (waiver ownership, dangling ADR
      // citations, proof-comment totals). `baseline.mjs` printed these to a
      // terminal nobody was watching; carrying them here puts them in the same
      // snapshot the TUI and `arbor governance` already render.
      repository_baseline: deriveRepositoryBaseline(repoRoot, { today: at.slice(0, 10) }),
      intent_dangling_citations: intent.ok ? intent.value.danglingCitations.length : 0,
      intent_orphan_records: intent.ok ? intent.value.orphanRecordIds.length : 0,
      governance_events_witnessed: governanceEventsWitnessed,
      graph,
      waiver_outcome_totals: waiverOutcomeTotals,
    };

    return { ok: true, value: snapshot, capability: CAPABILITY };
  } catch (err) {
    return {
      ok: false,
      error: internalError(`governance snapshot projection failed unexpectedly: ${err instanceof Error ? err.message : String(err)}`),
      capability: CAPABILITY,
    };
  }
}

/** Compact, human-readable rendering of a GovernanceSnapshot for CLI output. */
export function formatGovernanceSnapshot(snapshot: GovernanceSnapshot): string {
  const lines: string[] = [];
  lines.push(`Governance snapshot — ${snapshot.decisions_dir} (as of ${snapshot.at})`);
  lines.push("");
  const { legacy_classification: lc } = snapshot;
  lines.push(`Records: ${lc.total} total (${lc.parsed} parsed, ${lc.parsed_with_warnings} parsed with warnings, ${lc.unparseable} unparseable)`);
  const dist = snapshot.decision_status_distribution;
  lines.push(
    `Decision status: draft=${dist.draft} proposed=${dist.proposed} accepted=${dist.accepted} rejected=${dist.rejected} superseded=${dist.superseded}`,
  );
  const oc = snapshot.obligation_coverage;
  lines.push(
    `Obligation coverage: ${oc.total_obligations} obligations across ${oc.total_records} records (${oc.records_with_obligations_section} declare an Obligations section, ${oc.records_fully_covered} fully covered)`,
  );
  const rc = snapshot.repository_counts;
  // `derive.ts`'s own contract: an entry in `rc.unmeasured` means that field's
  // `0` is "not known", never "none" — rendering it as a bare number here
  // would print a false measurement with the authority of a real one.
  const renderCount = (label: string, quantity: RepositoryCounts["unmeasured"][number], value: number): string =>
    rc.unmeasured.includes(quantity) ? `${label} UNMEASURED` : `${value} ${label}`;
  lines.push(
    "Repository counts: "
    + [
        renderCount("ADRs", "adr_total", rc.adr_total),
        renderCount("catalog kinds", "catalog_kinds", rc.catalog_kinds),
        renderCount("src files", "src_files", rc.src_files),
        renderCount("packages", "packages", rc.packages),
        renderCount("test files", "test_files", rc.test_files),
        renderCount("allowlist entries", "allowlist_entries", rc.allowlist_entries),
      ].join(", "),
  );
  if (snapshot.waiver_outcome_totals) {
    const w = snapshot.waiver_outcome_totals;
    lines.push(`Waived outcomes: ${w.adopted} adopted, ${w.unadjudicated} unadjudicated (${w.total} total)`);
  }
  if (snapshot.count_claim_exemptions.length === 0) {
    lines.push("Count-claim exemptions: none");
  } else {
    lines.push(`Count-claim exemptions (${snapshot.count_claim_exemptions.length}) — historical, excluded from SUR-05:`);
    for (const exemption of snapshot.count_claim_exemptions) {
      lines.push(`  ${exemption.document}:${exemption.line}`);
    }
  }
  lines.push("");
  if (snapshot.policy_findings.length === 0) {
    lines.push("Policy findings: none");
  } else {
    lines.push(`Policy findings (${snapshot.policy_findings.length}):`);
    for (const finding of snapshot.policy_findings) {
      const subject = "record_id" in finding.subject ? finding.subject.record_id : `${finding.subject.kind}:${finding.subject.path}`;
      lines.push(`  [${finding.rule_id}] ${finding.severity} — ${subject}: ${finding.detail}`);
    }
  }
  return lines.join("\n");
}

// ------------------------------------------------------- runtime query wiring

/**
 * `governance.snapshot` — the catalog query behind the `governance` TUI screen.
 *
 * The screen previously declared an empty `surface.queries`, so on the live
 * pane it would have shown "awaiting first projection" forever while the
 * roadmap described it as the first real consumer of `@arbor/governance`. An
 * independent audit found that gap. The snapshot builder was already real and
 * already driving `arbor-mcp governance --json`; only the round trip was
 * missing.
 */
export interface GovernanceQueryEnvelope {
  schema_version: 1;
  query_id: string;
  query: { kind: "governance.snapshot"; repo_root?: string; max_records?: number };
}

export function isGovernanceQueryEnvelope(value: unknown): value is GovernanceQueryEnvelope {
  return typeof value === "object" && value !== null
    && typeof (value as { query?: unknown }).query === "object"
    && (value as { query: { kind?: unknown } }).query !== null
    && (value as { query: { kind?: unknown } }).query.kind === "governance.snapshot";
}

export function validateGovernanceQuery(envelope: GovernanceQueryEnvelope): string[] {
  const failures: string[] = [];
  if (envelope.schema_version !== 1) failures.push("schema_version must be 1");
  if (typeof envelope.query_id !== "string" || envelope.query_id.trim().length === 0) {
    failures.push("query_id must be non-empty");
  }
  const { repo_root: repoRoot, max_records: maxRecords } = envelope.query;
  if (repoRoot !== undefined && (typeof repoRoot !== "string" || repoRoot.trim().length === 0)) {
    failures.push("query.repo_root must be a non-empty string when supplied");
  }
  if (maxRecords !== undefined && (!Number.isSafeInteger(maxRecords) || maxRecords <= 0)) {
    failures.push("query.max_records must be a positive safe integer");
  }
  return failures;
}

// -------------------------------------------------- governance.backlog wiring

const BACKLOG_CAPABILITY = "governance.projection.backlog";

/**
 * `governance.backlog` — the real work backlog `@arbor/governance`'s
 * `deriveBacklog` computes (finding 15, TUI-vs-backend observability gap
 * audit): the ranked, POL-04-derived queue `selfhost.ts` already drives a
 * self-host campaign's next task from (`formatBacklogSelection`, printed to
 * CLI stdout only). No `RuntimeQueryKind` existed to observe it in the
 * cockpit — this closes that gap the same way `governance.snapshot` closed
 * the ADR-snapshot one: a pure projection over the real `decisions/` corpus,
 * never a fabricated shape.
 *
 * Reuses `deriveBacklog`/`selectNextBacklogItem` directly — the exact
 * construction `selfhost.ts:516,519` already uses — rather than
 * reimplementing backlog derivation or selection here.
 */
export interface GovernanceBacklogSnapshot {
  readonly backlog: Backlog;
  /** The next `author_obligations` item a self-host campaign would work on, or `null` when the backlog holds none (mirrors `selectNextBacklogItem`). */
  readonly selected: BacklogItem | null;
}

export interface GovernanceBacklogOptions {
  readonly repo_root: string;
  /** ISO-8601 timestamp threaded straight through to `deriveBacklog` (never read internally — see `derive.ts`'s determinism note). */
  readonly at: string;
}

/**
 * Derives the real backlog projection. Never throws — matches every other
 * function in this module: a `deriveBacklog` failure (unreadable
 * `decisions/`, malformed corpus) comes back as a typed `GovernanceResult`
 * error, not a crash.
 */
export function buildGovernanceBacklog(options: GovernanceBacklogOptions): GovernanceResult<GovernanceBacklogSnapshot> {
  try {
    const result = deriveBacklog({ repoRoot: options.repo_root, at: options.at });
    if (!result.ok) return { ok: false, error: result.error, capability: BACKLOG_CAPABILITY };
    const selected = selectNextBacklogItem(result.value);
    return { ok: true, value: { backlog: result.value, selected }, capability: BACKLOG_CAPABILITY };
  } catch (error) {
    return {
      ok: false,
      error: { code: "internal", message: error instanceof Error ? error.message : String(error) },
      capability: BACKLOG_CAPABILITY,
    };
  }
}

export interface GovernanceBacklogQueryEnvelope {
  schema_version: 1;
  query_id: string;
  query: { kind: "governance.backlog"; repo_root?: string; at?: string };
}

export function isGovernanceBacklogQueryEnvelope(value: unknown): value is GovernanceBacklogQueryEnvelope {
  return typeof value === "object" && value !== null
    && typeof (value as { query?: unknown }).query === "object"
    && (value as { query: { kind?: unknown } }).query !== null
    && (value as { query: { kind?: unknown } }).query.kind === "governance.backlog";
}

export function validateGovernanceBacklogQuery(envelope: GovernanceBacklogQueryEnvelope): string[] {
  const failures: string[] = [];
  if (envelope.schema_version !== 1) failures.push("schema_version must be 1");
  if (typeof envelope.query_id !== "string" || envelope.query_id.trim().length === 0) {
    failures.push("query_id must be non-empty");
  }
  const { repo_root: repoRoot, at } = envelope.query;
  if (repoRoot !== undefined && (typeof repoRoot !== "string" || repoRoot.trim().length === 0)) {
    failures.push("query.repo_root must be a non-empty string when supplied");
  }
  if (at !== undefined && (typeof at !== "string" || Number.isNaN(Date.parse(at)))) {
    failures.push("query.at must be a valid ISO-8601 timestamp when supplied");
  }
  return failures;
}
