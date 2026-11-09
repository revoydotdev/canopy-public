/**
 * contracts.ts — the shared type surface every governance component builds against.
 *
 * WHY THIS FILE IS FIRST. Four workstreams implement against these types in
 * parallel. If each invented its own record id, artifact id, event envelope, or
 * finding shape, integration would produce four incompatible dialects and the
 * "duplicate infrastructure" failure the implementation brief forbids. This file
 * is the contract; it is owned by the orchestrator and changes only by explicit
 * handoff, never by a sub-agent editing it directly.
 *
 * Governing decision: ADR-027 (draft, this branch).
 * Canonicalization: @arbor/core's canonicalizeForHash. There is no other.
 */

// ---------------------------------------------------------------- identifiers

/**
 * Namespaced record id, e.g. "revoy2:ADR-026" | "revoy-spec:ADR-086".
 *
 * The namespace exists because the audit found eight source locations citing
 * revoy-spec's ADR numbering in the same unqualified `ADR-NNN` token space as
 * revoy2's own, and one citation (`ADR-036`) that was recorded as permanently
 * unresolvable. A bare `ADR-NNN` is not a valid RecordId anywhere in this system.
 */
export type RecordId = string;

/** Namespace component of a RecordId. `local: false` namespaces are expected to be unresolvable here. */
export type RecordNamespace = "revoy2" | "revoy-spec";

/** Record classes. AHR authority is strictly weaker than ADR authority — see AuthorityDecision. */
export type RecordClass = "adr" | "ahr";

/** "revoy2:ADR-026-O3" — the addressable unit an implementation claim attaches to. */
export type ObligationId = string;

/** Stable governance event id, matching the ledger's existing `trace_<n>` convention. */
export type GovernanceEventId = string;

// ---------------------------------------------------------------- status vector

/** Only `accepted` grants authority. Everything else is diagnostic. */
export type DecisionStatus = "draft" | "proposed" | "accepted" | "rejected" | "superseded";

/** COMPUTED from obligation proof resolution — never hand-set. */
export type ImplementationStatus = "not_applicable" | "none" | "partial" | "complete";

/** COMPUTED. Attests a named test exists and ran; NOT that it exercises the obligation. */
export type VerificationStatus = "not_applicable" | "unverified" | "partial" | "verified";

/** COMPUTED by comparing graph planes. */
export type ComplianceStatus = "unknown" | "consistent" | "drifted" | "violated";

export interface StatusVector {
  decision: DecisionStatus;
  implementation: ImplementationStatus;
  verification: VerificationStatus;
  compliance: ComplianceStatus;
}

/** AHR lifecycle. Six states — APPROVED_FOR_RESEARCH and ABANDONED were cut as doing no enforcement work. */
export type ResearchStatus = "draft" | "active" | "evidence_ready" | "promoted" | "rejected" | "expired";

// ---------------------------------------------------------------- artifact identity

export type ArtifactKind =
  | "file" | "symbol" | "catalog_kind" | "ledger_record_kind"
  | "config_key" | "test" | "script" | "ci_job" | "doc" | "package";

/**
 * No single element is authoritative.
 *
 * `path` is cheap and usually right; `symbol_id` survives a pure move;
 * `content_hash` distinguishes a rename from a rename-plus-edit.
 *
 * `symbol_id` is `"<package>::<export>"` and deliberately does NOT embed the
 * file. Embedding it would make `moved` structurally impossible to detect,
 * because the path is exactly what a move changes. Two same-named exports in
 * different files of one package therefore collide by design; that collision is
 * surfaced as an `IdentityAmbiguity` by `duplicateSymbolIds` rather than being
 * silently resolved.
 *
 * All three components are needed because same-named exports really do exist
 * here: `PHASE_DURATION_BUCKETS_MS` is declared byte-identically in BOTH
 * `packages/arbor-mcp/src/metrics-projector.ts:3` and
 * `packages/arbor-tui/src/telemetry-widgets.ts:10`, and both are barrel-exported.
 * That duplication is itself forced by ADR-011 (arbor-tui may depend on core
 * only, never on mcp), so it is duplicated knowledge with an architectural
 * cause, not an oversight — and a symbol-name-only identity would conflate the
 * two. (An earlier draft of this comment cited `stepToAction`; that example was
 * stale — `arbor-opencode/src/planning-markdown.ts` was deleted in `c028333`.)
 */
export interface ArtifactIdentity {
  kind: ArtifactKind;
  /** POSIX-normalized, repo-relative. A path containing "\" is rejected, not converted. */
  path: string;
  /** "<package>::<export>" — see the block comment above for why the file is deliberately excluded. Null for non-code artifacts. */
  symbol_id: string | null;
  content_hash: string;
  schema_version: number;
  /** Generated artifacts match on path + generator, never on content_hash. */
  generated?: { by: string };
}

/** Emitted when identity continuity cannot be established automatically. Never guessed silently. */
export interface IdentityAmbiguity {
  reason: "content_and_path_both_changed" | "duplicate_symbol_id" | "split_candidate" | "merge_candidate";
  candidates: readonly ArtifactIdentity[];
  requires_explicit_resolution: true;
}

// ---------------------------------------------------------------- graph

/**
 * The four planes are never merged into one edge set. `observed` is NOT
 * implemented; any code claiming to populate it must say so explicitly rather
 * than leaving the plane silently empty and implying absence of behaviour.
 */
export type GraphPlane = "intended" | "declared" | "derived" | "observed";

export type EdgeType =
  | "GOVERNS" | "IMPLEMENTS" | "CONSTRAINS" | "PROHIBITS" | "VERIFIES"
  | "DEPENDS_ON" | "SUPERSEDES" | "AMENDS" | "GENERATES" | "CONSUMES"
  | "PRODUCES" | "CALLS" | "READS_STATE" | "WRITES_STATE"
  | "EMITS_EVENT" | "CONSUMES_EVENT" | "EXPOSES" | "INVOKES" | "OWNS" | "EXEMPTS";

export type Confidence = "authoritative" | "high" | "medium" | "low";

/** How an edge was obtained. An edge without this is not representable. */
export type DiscoveryMethod = "declared" | "derived" | "observed";

export interface EvidenceRef {
  kind: "test" | "gate_run" | "code_location" | "graph_path" | "migration_report" | "ledger_event";
  ref: string;
  /** Tool identity + version, so a result can be reproduced or invalidated on upgrade. */
  producer: string;
  at: string;
  content_hash?: string;
}

export interface GovernanceEdge {
  source: RecordId | ArtifactIdentity;
  target: RecordId | ArtifactIdentity;
  type: EdgeType;
  plane: GraphPlane;
  discovery: DiscoveryMethod;
  confidence: Confidence;
  scope: "whole" | "partial";
  first_seen_event: GovernanceEventId;
  valid_from: string;
  valid_to: string | null;
  evidence: readonly EvidenceRef[];
  schema_version: number;
}

// ---------------------------------------------------------------- authority

/**
 * The result of asking "may this artifact exist under this authority?"
 *
 * `unknown` and `unverifiable` are DISTINCT from `denied` and must never be
 * collapsed into `allowed`. Collapsing them is the fail-open failure the brief
 * prohibits at authority boundaries.
 */
export type AuthorityVerdict =
  | "allowed"
  | "allowed_with_marking"
  | "denied"
  | "waived"
  | "unknown"
  | "unverifiable";

export interface AuthorityDecision {
  verdict: AuthorityVerdict;
  /** Which record was consulted; null when none could be resolved. */
  authority: RecordId | null;
  /** Populated for `waived`; a waiver without a resolving authority_ref is itself invalid. */
  waiver_id?: string;
  reason: string;
  evidence: readonly EvidenceRef[];
}

// ---------------------------------------------------------------- policy findings

export type Severity = "blocker" | "warning" | "informational";


export interface PolicyFinding {
  /** Stable id from the policy registry, e.g. "POL-03" / mismatch class "M-B". */
  rule_id: string;
  severity: Severity;
  subject: ArtifactIdentity | { record_id: RecordId };
  detail: string;
  remediation: string;
  evidence: readonly EvidenceRef[];
  waiver_eligible: boolean;
  /** True when the finding pre-dates the baseline and is grandfathered debt, not a new violation. */
  is_legacy_debt: boolean;
}

// ---------------------------------------------------------------- errors

/** Closed union, mirroring RuntimeError.code in arbor-mcp so the MCP surface is consistent. */
export type GovernanceErrorCode = "validation" | "permission" | "conflict" | "unavailable" | "internal";

export interface GovernanceError {
  code: GovernanceErrorCode;
  message: string;
  /** Machine-readable pointer to what failed, e.g. a RecordId or a JSON path. */
  at?: string;
}

/** Mirrors RuntimeRouterResult<T> so CLI and MCP can share one envelope. */
export type GovernanceResult<T> =
  | { ok: true; value: T; capability: string }
  | { ok: false; error: GovernanceError; capability: string | null };

// ---------------------------------------------------------------- queries

export interface QueryBudget {
  /** Deterministic truncation: rank, then cut at a field boundary, never mid-record. */
  max_tokens: number;
}

export interface QueryPage<T> {
  items: readonly T[];
  /** "<snapshot_id>:<offset>" — rejected if the snapshot no longer matches. */
  next_cursor: string | null;
  has_more: boolean;
  /** Set when the budget forced truncation, so a caller can tell "none" from "not shown". */
  truncated: boolean;
}
