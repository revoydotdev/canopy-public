/**
 * graph/projector.ts — the corpus-declared/derived slice of ADR-027 Decision
 * point 3's governance graph: turns `record/migrate.ts`'s already-resolved
 * citation facts into `contracts.ts`'s `GovernanceEdge` shape.
 *
 * SCOPE, STATED HONESTLY. ADR-027 Decision point 3 describes the governance
 * graph as "a third pure projector beside the telemetry and memory
 * projectors" — reading the LEDGER's witnessed governance event stream
 * (`campaign_id: "governance"`, Decision point 2), integrity-gated,
 * snapshot-cursored, rebuildable from that stream. That literal,
 * ledger-authoritative projector lives in
 * `packages/arbor-mcp/src/governance-projection.ts::projectGovernanceGraph`,
 * for a structural reason, not a design preference: `@arbor/audit`'s
 * `EvidenceLedger` is reachable from here (this package already depends on
 * `@arbor/audit`), but arbor-mcp is the only package with a wired,
 * gate:reachability-satisfying call site for anything that reads it — this
 * package's own barrel (`index.ts`) is closed to new exports mid-branch (two
 * sibling workstreams are editing this same worktree on disjoint files), so a
 * ledger-reading function added here today would have no real caller and
 * would fail the reachability gate.
 *
 * What CAN live here, with a genuine, already-reachable caller, is narrower
 * but still real: `record/corpus.ts`'s `scanDecisionsCorpus` already computes
 * `record/migrate.ts`'s `CitationMigrationReport` on every call and, until
 * this module, discarded it. `projectCitationGraph` is the missing step that
 * turns those already-resolved facts into graph edges instead of leaving
 * them as a citation-shaped report nobody reads as a graph. This is the
 * corpus's own "derived" plane (`GraphPlane`) — never "observed" (this
 * package owns no runtime-observation source) and never "declared" (the
 * legacy ADR template this corpus uses has no structured citation field —
 * see migrate.ts's own header) — wired into `CorpusScanReport.citation_graph`
 * so `scanDecisionsCorpus` (already reachable) is this function's real
 * caller.
 *
 * `first_seen_event` on each edge is a real limitation, stated rather than
 * faked: `GovernanceEdge.first_seen_event` is typed as a
 * `GovernanceEventId` — the id of the ledger event that first observed the
 * edge. This projector has no ledger and mints no ledger events, so it
 * cannot honestly produce one. It reports the citation's own stable
 * identity (`"<source_record_id>#<citation_token>"`) instead, and this
 * value is NEVER a `trace_...`-shaped ledger id — a reader must not mistake
 * it for one. `governance-projection.ts`'s ledger-based projector supplies a
 * real `GovernanceEventId` for the same relationship once an equivalent
 * `citation_observed` event has actually been witnessed.
 */

import { compareCodeUnits } from "@arbor/core";
import type { Confidence, EvidenceRef, GovernanceEdge, RecordId } from "../contracts.js";
import type { CitationFact } from "../record/migrate.js";

export interface CitationGraphProjection {
  readonly schema_version: 1;
  readonly edges: readonly GovernanceEdge[];
  /** Count of resolved facts examined, independent of how many survived `max_edges`. */
  readonly source_fact_count: number;
  /** True when `max_edges` forced truncation — never a silent drop. */
  readonly truncated: boolean;
}

export interface ProjectCitationGraphOptions {
  /** Stamped on every edge's `valid_from`; this projector never reads a clock of its own. */
  readonly at: string;
  /** Defensive bound, mirroring `metrics-projector.ts`'s `bounded()` idiom. */
  readonly max_edges?: number;
}

const DEFAULT_MAX_EDGES = 10_000;

/**
 * Deterministically rebuild citation edges from an already-computed
 * `CitationMigrationReport.facts` list. Pure: no filesystem, no clock beyond
 * the caller-supplied `options.at`, no randomness. Only resolved facts
 * (`method !== "none"`) become edges — an unresolved bare "ADR-NNN" mention
 * is not a fact this package can stand behind as a real relationship (see
 * migrate.ts's own header on why an unresolved citation is never guessed).
 */
export function projectCitationGraph(
  facts: readonly CitationFact[],
  options: ProjectCitationGraphOptions,
): CitationGraphProjection {
  const maxEdges = options.max_edges ?? DEFAULT_MAX_EDGES;
  if (!Number.isSafeInteger(maxEdges) || maxEdges < 1) {
    throw new RangeError("projectCitationGraph max_edges must be a positive safe integer");
  }

  const resolved = facts.filter((fact): fact is CitationFact & { target: RecordId; confidence: Confidence } =>
    fact.method !== "none" && fact.target !== null && fact.confidence !== null);

  const edges: GovernanceEdge[] = resolved.slice(0, maxEdges).map((fact) => ({
    source: fact.source_record_id,
    target: fact.target,
    type: "DEPENDS_ON",
    plane: "derived",
    discovery: "derived",
    confidence: fact.confidence,
    scope: "whole",
    // Not a ledger event id — see this module's header. Stable per-citation
    // identity so re-running against the same corpus reproduces the same edge.
    first_seen_event: `citation:${fact.source_record_id}#${fact.citation_token}`,
    valid_from: options.at,
    valid_to: null,
    evidence: fact.evidence.map((ref) => ({ ...ref })) as readonly EvidenceRef[],
    schema_version: 1,
  }));

  edges.sort((a, b) =>
    compareCodeUnits(recordIdOf(a.source), recordIdOf(b.source))
    || compareCodeUnits(recordIdOf(a.target), recordIdOf(b.target))
    || compareCodeUnits(a.type, b.type));

  return {
    schema_version: 1,
    edges,
    source_fact_count: resolved.length,
    truncated: resolved.length > maxEdges,
  };
}

/** `GovernanceEdge.source`/`.target` are `RecordId | ArtifactIdentity`; every edge this projector emits uses a bare RecordId. */
function recordIdOf(endpoint: GovernanceEdge["source"]): string {
  return typeof endpoint === "string" ? endpoint : endpoint.path;
}
