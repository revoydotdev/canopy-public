/**
 * Ordered migration adapter for evidence publication and finalization.
 * Flight is always acquired first and released last; the legacy authority
 * remains the semantic owner and can independently refuse publication.
 */
export interface RepoFlightAuthorityLease {
  readonly authority: "flight" | "legacy";
  readonly receipt_id: string;
  readonly release: (reason: string) => void;
}

export type RepoFlightAuthorityAcquisition =
  | { readonly ok: true; readonly lease: RepoFlightAuthorityLease }
  | { readonly ok: false; readonly reason: string };

export type RepoFlightDualAuthorityResult<T> =
  | { readonly ok: true; readonly published: true; readonly value: T; readonly flight_receipt_id: string; readonly legacy_receipt_id: string }
  | { readonly ok: false; readonly published: false; readonly evidence_preserved: true; readonly refused_by: "flight" | "legacy" | "operation" | "release"; readonly reason: string; readonly flight_receipt_id: string | null; readonly legacy_receipt_id: string | null };

export function executeRepoFlightDualAuthorityTransaction<T>(input: {
  readonly acquire_flight: () => RepoFlightAuthorityAcquisition;
  readonly acquire_legacy: () => RepoFlightAuthorityAcquisition;
  readonly operate: () => T;
}): RepoFlightDualAuthorityResult<T> {
  let flight: RepoFlightAuthorityLease | null = null;
  let legacy: RepoFlightAuthorityLease | null = null;
  let result: RepoFlightDualAuthorityResult<T> = refusal("operation", "dual-authority transaction did not reach an operation", null, null);
  try {
    const flightResult = input.acquire_flight();
    if (!flightResult.ok) {
      result = refusal("flight", flightResult.reason, null, null);
    } else {
      flight = requireAuthority(flightResult.lease, "flight");
      const legacyResult = input.acquire_legacy();
      if (!legacyResult.ok) {
        result = refusal("legacy", legacyResult.reason, flight.receipt_id, null);
      } else {
        legacy = requireAuthority(legacyResult.lease, "legacy");
        try {
          result = { ok: true, published: true, value: input.operate(), flight_receipt_id: flight.receipt_id, legacy_receipt_id: legacy.receipt_id };
        } catch (error) {
          result = refusal("operation", message(error), flight.receipt_id, legacy.receipt_id);
        }
      }
    }
  } catch (error) {
    result = refusal(flight === null ? "flight" : legacy === null ? "legacy" : "operation", message(error), flight?.receipt_id ?? null, legacy?.receipt_id ?? null);
  } finally {
    const releaseFailures: string[] = [];
    if (legacy !== null) try { legacy.release("dual-authority transaction terminal"); } catch (error) { releaseFailures.push(`legacy: ${message(error)}`); }
    if (flight !== null) try { flight.release("dual-authority transaction terminal"); } catch (error) { releaseFailures.push(`flight: ${message(error)}`); }
    if (releaseFailures.length > 0) result = refusal("release", releaseFailures.join("; "), flight?.receipt_id ?? null, legacy?.receipt_id ?? null);
  }
  return result;
}

function requireAuthority(lease: RepoFlightAuthorityLease, expected: RepoFlightAuthorityLease["authority"]): RepoFlightAuthorityLease {
  if (lease.authority !== expected || !identifier(lease.receipt_id) || typeof lease.release !== "function") throw new Error(`${expected} authority returned a malformed lease`);
  return lease;
}
function refusal(refused_by: Extract<RepoFlightDualAuthorityResult<never>, { ok: false }>["refused_by"], reason: string, flight_receipt_id: string | null, legacy_receipt_id: string | null): Extract<RepoFlightDualAuthorityResult<never>, { ok: false }> { return { ok: false, published: false, evidence_preserved: true, refused_by, reason: reason.slice(0, 2_048), flight_receipt_id, legacy_receipt_id }; }
function identifier(value: unknown): value is string { return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,511}$/.test(value); }
function message(error: unknown): string { return error instanceof Error ? error.message : "dual-authority transaction failed"; }
