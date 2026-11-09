/**
 * status.ts — the decision-status lifecycle transition table, and derivation
 * of the three COMPUTED StatusVector fields.
 *
 * `implementation` / `verification` / `compliance` are COMPUTED per
 * contracts.ts's doc comments ("never hand-set") — there is no setter for
 * them anywhere in this module. `deriveStatusVector` is the only way to
 * produce a `StatusVector`, and it takes `decision` plus an obligation-proof
 * summary, never the computed fields themselves.
 */

import type {
  ComplianceStatus,
  DecisionStatus,
  GovernanceError,
  GovernanceResult,
  ImplementationStatus,
  VerificationStatus,
  StatusVector,
} from "../contracts.js";

const CAPABILITY_VALIDATE_TRANSITION = "record.status.validate_transition";

/**
 * Legal decision-status transitions (mission-specified, closed set):
 * draft->proposed, draft->rejected, proposed->accepted, proposed->rejected,
 * accepted->superseded. Everything else — including no-ops, skips
 * (draft->accepted), and any transition out of a terminal state
 * (rejected/superseded) — is illegal.
 */
const LEGAL_TRANSITIONS: ReadonlySet<string> = new Set([
  "draft->proposed",
  "draft->rejected",
  "proposed->accepted",
  "proposed->rejected",
  "accepted->superseded",
]);

function transitionKey(from: DecisionStatus, to: DecisionStatus): string {
  return `${from}->${to}`;
}

export interface DecisionTransition {
  readonly from: DecisionStatus;
  readonly to: DecisionStatus;
}

/**
 * Validates a proposed decision-status transition against the lifecycle
 * table above. Never throws — an illegal transition is a typed `validation`
 * error, not an exception, so a caller processing a batch of records can
 * report every violation rather than stopping at the first one.
 */
export function validateTransition(from: DecisionStatus, to: DecisionStatus): GovernanceResult<DecisionTransition> {
  const key = transitionKey(from, to);
  if (LEGAL_TRANSITIONS.has(key)) {
    return { ok: true, value: { from, to }, capability: CAPABILITY_VALIDATE_TRANSITION };
  }
  const error: GovernanceError = {
    code: "validation",
    message: `illegal decision-status transition: "${from}" -> "${to}"`,
    at: key,
  };
  return { ok: false, error, capability: CAPABILITY_VALIDATE_TRANSITION };
}

/**
 * Summary of obligation-proof resolution for one record, the only input
 * `deriveStatusVector` needs to compute `implementation` and `verification`.
 * This package parses legacy records with zero obligations (see schema.ts),
 * so `total: 0` is the only case exercised against the real corpus; the
 * partial/complete/verified arithmetic below is still total-correct against
 * contracts.ts's types for whatever the obligation-tracking workstream feeds
 * in later.
 */
export interface ObligationProofSummary {
  /** Total obligations attached to the record. */
  readonly total: number;
  /** Obligations with a resolved (accepted) implementation claim. */
  readonly satisfied: number;
  /** Obligations backed by a named test that has actually run. */
  readonly verifiedByTest: number;
}

function deriveImplementation(obligations: ObligationProofSummary): ImplementationStatus {
  if (obligations.total === 0) return "none";
  if (obligations.satisfied <= 0) return "none";
  if (obligations.satisfied < obligations.total) return "partial";
  return "complete";
}

function deriveVerification(obligations: ObligationProofSummary): VerificationStatus {
  if (obligations.total === 0) return "unverified";
  if (obligations.verifiedByTest <= 0) return "unverified";
  if (obligations.verifiedByTest < obligations.total) return "partial";
  return "verified";
}

/**
 * `compliance` is COMPUTED "by comparing graph planes" (contracts.ts) —
 * intended vs. declared vs. derived vs. observed edges. This package owns
 * record parsing/schema/status only; it does not own the graph projection,
 * so it has no plane data to compare. `"unknown"` is the honest value for
 * "not computed here," distinct from `"consistent"` (compared and matched).
 * A graph-owning workstream is expected to recompute this field once plane
 * data exists; this function must never guess `"consistent"` in its place.
 */
function deriveCompliance(): ComplianceStatus {
  return "unknown";
}

/** Computes the full StatusVector. The only production path to a StatusVector in this package. */
export function deriveStatusVector(decision: DecisionStatus, obligations: ObligationProofSummary): StatusVector {
  return {
    decision,
    implementation: deriveImplementation(obligations),
    verification: deriveVerification(obligations),
    compliance: deriveCompliance(),
  };
}

/** The zero-obligation summary every legacy record in this corpus carries. */
export const ZERO_OBLIGATIONS: ObligationProofSummary = { total: 0, satisfied: 0, verifiedByTest: 0 };
