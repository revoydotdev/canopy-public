/**
 * obligation/coverage.ts — compute, per obligation and per record, how many
 * proofs actually resolve, and derive the record's `implementation` /
 * `verification` StatusVector fields from that (never hand-set — see
 * contracts.ts's own doc-comments on `ImplementationStatus`/`VerificationStatus`).
 *
 * THE HONEST CEILING (restated here because this is the layer that turns a
 * proof resolution into a status claim, so it is the layer most tempted to
 * overclaim): a resolving `roundtrip=` proves a named test file exists and is
 * collected by vitest — nothing more. `attests` below is the typed way this
 * ceiling is carried forward instead of silently forgotten once a boolean
 * "resolved" flag is all a caller sees. `verification: "verified"` in
 * `RecordCoverage` is bounded by the same ceiling: it means every obligation
 * has at least one resolving proof, i.e. every claim names a real, collected
 * test — it does NOT mean the suite was run, passed, or exercises the claimed
 * obligation. This is narrower than `VerificationStatus`'s own doc-comment in
 * contracts.ts ("Attests a named test exists and ran"): this package's
 * resolver never spawns vitest (a deliberate scope decision — see proof.ts's
 * module header), so "ran" is never something this layer can honestly claim.
 */

import type { GovernanceResult, ImplementationStatus, VerificationStatus } from "../contracts.js";
import type { Obligation, RecordObligations } from "./parse.js";
import { resolveProofComment, type ProofResolution, type ResolveProofOptions } from "./proof.js";

/** What a resolving proof attests, and nothing more. See module header. */
export type ObligationAttestation = "test_exists_and_is_collected";

export interface ObligationCoverage {
  obligation_id: string;
  ordinal: string;
  text: string;
  proof_count: number;
  /** Proofs whose symbol/file/roundtrip fields ALL resolved. */
  resolving_proof_count: number;
  fully_resolved: boolean;
  /** Null when there is no resolving proof — there is nothing to attest. */
  attests: ObligationAttestation | null;
  proofs: readonly ProofResolution[];
  unverifiable_reason?: string;
}

export interface RecordCoverage {
  record_id: string;
  source_path: string;
  has_obligations_section: boolean;
  obligation_count: number;
  obligations_with_resolving_proof: number;
  obligations: readonly ObligationCoverage[];
  /**
   * COMPUTED. `none` covers BOTH "zero obligations declared" (every legacy ADR
   * in this repo, today) and "obligations declared, none resolve" — this type
   * does not distinguish those further than `obligation_count` already does,
   * so a caller who needs the distinction reads that field directly rather
   * than inferring it from `implementation` alone.
   */
  implementation: ImplementationStatus;
  verification: VerificationStatus;
}

export function computeObligationCoverage(
  obligation: Obligation,
  options: ResolveProofOptions,
): GovernanceResult<ObligationCoverage> {
  try {
    const proofResults: ProofResolution[] = [];
    for (const proof of obligation.proofs) {
      const resolved = resolveProofComment(proof, options);
      if (!resolved.ok) return { ok: false, error: resolved.error, capability: resolved.capability };
      proofResults.push(resolved.value);
    }
    const resolvingCount = proofResults.filter((p) => p.fully_resolved).length;

    return {
      ok: true,
      capability: "governance.obligation.coverage",
      value: {
        obligation_id: obligation.id,
        ordinal: obligation.ordinal,
        text: obligation.text,
        proof_count: obligation.proofs.length,
        resolving_proof_count: resolvingCount,
        fully_resolved: resolvingCount > 0,
        attests: resolvingCount > 0 ? "test_exists_and_is_collected" : null,
        proofs: proofResults,
        ...(obligation.unverifiable_reason ? { unverifiable_reason: obligation.unverifiable_reason } : {}),
      },
    };
  } catch (err) {
    return {
      ok: false,
      error: { code: "internal", message: err instanceof Error ? err.message : String(err) },
      capability: "governance.obligation.coverage",
    };
  }
}

export function computeRecordCoverage(
  record: RecordObligations,
  options: ResolveProofOptions,
): GovernanceResult<RecordCoverage> {
  try {
    const obligationCoverages: ObligationCoverage[] = [];
    for (const obligation of record.obligations) {
      const computed = computeObligationCoverage(obligation, options);
      if (!computed.ok) return { ok: false, error: computed.error, capability: computed.capability };
      obligationCoverages.push(computed.value);
    }

    const obligationCount = record.obligations.length;
    const withResolvingProof = obligationCoverages.filter((c) => c.resolving_proof_count > 0).length;

    let implementation: ImplementationStatus;
    let verification: VerificationStatus;
    if (obligationCount === 0) {
      // The current true state of every legacy ADR in this repo: zero
      // obligations declared means zero implementation can be substantiated —
      // "none", not "not_applicable". A record with no obligations at all is
      // not exempt from the question; it simply has not answered it yet.
      implementation = "none";
      verification = "not_applicable"; // nothing to verify when nothing was claimed
    } else if (withResolvingProof === 0) {
      implementation = "none";
      verification = "unverified";
    } else if (withResolvingProof === obligationCount) {
      implementation = "complete";
      verification = "verified";
    } else {
      implementation = "partial";
      verification = "partial";
    }

    return {
      ok: true,
      capability: "governance.obligation.coverage",
      value: {
        record_id: record.record_id,
        source_path: record.source_path,
        has_obligations_section: record.has_obligations_section,
        obligation_count: obligationCount,
        obligations_with_resolving_proof: withResolvingProof,
        obligations: obligationCoverages,
        implementation,
        verification,
      },
    };
  } catch (err) {
    return {
      ok: false,
      error: { code: "internal", message: err instanceof Error ? err.message : String(err) },
      capability: "governance.obligation.coverage",
    };
  }
}
