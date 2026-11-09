/**
 * Revoy-owned capability negotiation.
 *
 * This is intentionally a closed vocabulary.  A connector may attach opaque
 * diagnostic evidence to an unknown upstream feature, but it cannot make that
 * feature an admitted harness capability by spelling a new string here.
 */

export const HARNESS_CAPABILITIES = [
  "streaming",
  "interruption",
  "resumption",
  "forking",
  "ephemeral_sessions",
  "structured_output",
  "tool_policy",
  "workspace_isolation",
  "approval_mediation",
  "usage_reporting",
  "artifact_capture",
  "remote_transport",
  "browser_observe",
  "web_research",
  "computer_use",
] as const;

export type HarnessCapability = typeof HARNESS_CAPABILITIES[number];

export const SUPPORT_GRADES = ["native", "governed", "observed", "unsupported"] as const;
export type SupportGrade = typeof SUPPORT_GRADES[number];
export type RequiredSupportGrade = Exclude<SupportGrade, "unsupported">;

/** Evidence is required even for unsupported claims: it records what was checked. */
export interface CapabilityEvidence {
  readonly implementation_id: string;
  readonly observed_at: string;
  readonly detail: string;
}

export interface CapabilitySupport {
  readonly capability: HarnessCapability;
  readonly grade: SupportGrade;
  readonly evidence: CapabilityEvidence;
}

/**
 * The minimum acceptable fidelity for one requested behavior.  `observed`
 * deliberately cannot satisfy an enforcement requirement expressed as
 * `governed` or `native`.
 */
export interface CapabilityRequirement {
  readonly capability: HarnessCapability;
  readonly minimum_grade: RequiredSupportGrade;
  /** Maximum age of the evidence, in milliseconds.  Omit only when freshness is not required. */
  readonly max_evidence_age_ms?: number;
}

export interface CapabilityClock {
  now(): Date;
}

export const systemCapabilityClock: CapabilityClock = { now: () => new Date() };

const GRADE_LEVEL: Readonly<Record<SupportGrade, number>> = {
  unsupported: 0,
  observed: 1,
  governed: 2,
  native: 3,
};

export function isHarnessCapability(value: string): value is HarnessCapability {
  return (HARNESS_CAPABILITIES as readonly string[]).includes(value);
}

export function isSupportGrade(value: string): value is SupportGrade {
  return (SUPPORT_GRADES as readonly string[]).includes(value);
}

export function satisfiesSupportGrade(actual: SupportGrade, required: RequiredSupportGrade): boolean {
  return actual !== "unsupported" && GRADE_LEVEL[actual] >= GRADE_LEVEL[required];
}

/** `true` only when the supplied evidence can be parsed and is within its allowed age. */
export function isEvidenceFresh(
  evidence: CapabilityEvidence,
  maxAgeMs: number | undefined,
  clock: CapabilityClock = systemCapabilityClock,
): boolean {
  if (maxAgeMs === undefined) return true;
  if (!Number.isFinite(maxAgeMs) || maxAgeMs < 0) return false;
  const observedAt = Date.parse(evidence.observed_at);
  if (Number.isNaN(observedAt)) return false;
  const age = clock.now().getTime() - observedAt;
  // Future observations are not trusted: they indicate a clock or evidence error.
  return age >= 0 && age <= maxAgeMs;
}

export type CapabilityNegotiationFailure =
  | "missing_capability"
  | "insufficient_grade"
  | "stale_evidence";

export interface NegotiatedCapability {
  readonly requirement: CapabilityRequirement;
  readonly support: CapabilitySupport;
}

export interface RejectedCapability {
  readonly requirement: CapabilityRequirement;
  readonly reason: CapabilityNegotiationFailure;
  readonly support: CapabilitySupport | null;
}

/** A complete, explicit admission answer; callers never infer success from an omitted item. */
export type CapabilityNegotiation =
  | { readonly admitted: true; readonly negotiated: readonly NegotiatedCapability[]; readonly rejected: readonly [] }
  | { readonly admitted: false; readonly negotiated: readonly NegotiatedCapability[]; readonly rejected: readonly RejectedCapability[] };

function copySupport(support: CapabilitySupport): CapabilitySupport {
  return {
    capability: support.capability,
    grade: support.grade,
    evidence: { ...support.evidence },
  };
}

/**
 * Negotiates a request against one connector's published support table.
 * Duplicate connector entries are rejected by the registry; this function is
 * defensive and uses the first matching entry only, never a hidden upgrade.
 */
export function negotiateCapabilities(
  requirements: readonly CapabilityRequirement[],
  supports: readonly CapabilitySupport[],
  clock: CapabilityClock = systemCapabilityClock,
): CapabilityNegotiation {
  const byCapability = new Map<HarnessCapability, CapabilitySupport>();
  for (const support of supports) {
    if (!byCapability.has(support.capability)) byCapability.set(support.capability, support);
  }

  const negotiated: NegotiatedCapability[] = [];
  const rejected: RejectedCapability[] = [];
  for (const requirement of requirements) {
    const support = byCapability.get(requirement.capability);
    if (!support) {
      rejected.push({ requirement: { ...requirement }, reason: "missing_capability", support: null });
    } else if (!satisfiesSupportGrade(support.grade, requirement.minimum_grade)) {
      rejected.push({ requirement: { ...requirement }, reason: "insufficient_grade", support: copySupport(support) });
    } else if (!isEvidenceFresh(support.evidence, requirement.max_evidence_age_ms, clock)) {
      rejected.push({ requirement: { ...requirement }, reason: "stale_evidence", support: copySupport(support) });
    } else {
      negotiated.push({ requirement: { ...requirement }, support: copySupport(support) });
    }
  }
  return rejected.length === 0
    ? { admitted: true, negotiated, rejected: [] }
    : { admitted: false, negotiated, rejected };
}
