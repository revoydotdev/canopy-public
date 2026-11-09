/**
 * Canonical operator projection for a gate that cannot authorize an action.
 *
 * Gate checks remain owned by the manager/gate authorities.  This module only
 * projects their already-recorded result for CLI, TUI, and web consumers. It
 * deliberately carries the owning gate, the evidence deficit (when one was
 * recorded), and an actionable remediation together so a surface cannot
 * render a bare "denied" message or invent a success from an unavailable
 * source.
 */
import { RUNTIME_REFUSAL_REMEDIES, isAuthorizedRefusalRemedy, isRefusalAuthority } from "@arbor/core";
import type { GateRecord, GateType, RuntimeCorrectiveAction, RuntimeRefusalAuthority, RuntimeRemedyActor } from "@arbor/core";

export const GATE_REFUSAL_PROJECTION_SCHEMA_VERSION = 2 as const;
export const GATE_REFUSAL_PROJECTION_MAX_TEXT = 2_048;

export type GateRefusalProjectionState = "refused" | "unavailable";
export type GateCorrectingActor = RuntimeRemedyActor;
export type GateCorrectiveAction = RuntimeCorrectiveAction;
/** A process gate or one of the non-gate refusal authorities (capability, budget, tool veto). */
export type GateRefusalAuthority = RuntimeRefusalAuthority;

/**
 * A bounded, redacted read model. `unavailable` means the gate authority or
 * its source was not composed/readable; it is intentionally distinct from a
 * gate that ran and denied the action (`refused`).
 */
export interface GateRefusalProjection {
  readonly schema_version: typeof GATE_REFUSAL_PROJECTION_SCHEMA_VERSION;
  readonly kind: "gate.refusal";
  readonly state: GateRefusalProjectionState;
  readonly gate: GateRefusalAuthority;
  readonly code: string;
  readonly summary: string;
  readonly evidence_deficit: string | null;
  readonly remediation: string;
  /** Actor with authority and practical ability to satisfy this refusal. */
  readonly correcting_actor: GateCorrectingActor;
  /** Stable action key; free text remains explanatory only. */
  readonly corrective_action: GateCorrectiveAction;
}

export interface GateRefusalInput {
  readonly gate: GateRefusalAuthority;
  readonly code: string;
  readonly summary: string;
  readonly evidence_deficit?: string | null;
  readonly remediation: string;
  readonly correcting_actor?: GateCorrectingActor;
  readonly corrective_action?: GateCorrectiveAction;
}

export interface GateUnavailableInput {
  readonly gate: GateRefusalAuthority;
  readonly code: string;
  readonly reason: string;
  readonly remediation: string;
  readonly correcting_actor?: GateCorrectingActor;
  readonly corrective_action?: GateCorrectiveAction;
}

/** Project a gate's recorded fail/bypass result without re-running the gate. */
export function projectGateRefusal(input: GateRefusalInput): GateRefusalProjection {
  return freezeProjection({
    state: "refused",
    gate: input.gate,
    code: input.code,
    summary: input.summary,
    evidence_deficit: input.evidence_deficit ?? null,
    remediation: input.remediation,
    correcting_actor: input.correcting_actor ?? defaultGateCorrection(input.gate).actor,
    corrective_action: input.corrective_action ?? defaultGateCorrection(input.gate).action,
  });
}

/** Project a source/capability absence; this is not evidence that a gate ran. */
export function projectGateUnavailable(input: GateUnavailableInput): GateRefusalProjection {
  return freezeProjection({
    state: "unavailable",
    gate: input.gate,
    code: input.code,
    summary: input.reason,
    evidence_deficit: null,
    remediation: input.remediation,
    correcting_actor: input.correcting_actor ?? "runtime_host",
    corrective_action: input.corrective_action ?? "compose_gate_authority",
  });
}

/**
 * Adapt the durable gate record used by CampaignManager snapshots. A passing
 * record has no refusal projection and must remain absent at the operator
 * boundary; callers cannot accidentally render a pass as a denial.
 */
export function projectGateRecord(
  record: GateRecord,
  remediation: string,
  code = `gate_${record.gate}_${record.result}`,
): GateRefusalProjection | null {
  if (record.result === "pass") return null;
  return projectGateRefusal({
    gate: record.gate,
    code,
    summary: record.detail,
    evidence_deficit: record.bypass_evidence_deficit ?? null,
    remediation,
  });
}

/**
 * Deterministic per-gate default remediation text, shared by every operator
 * surface (CLI, MCP tool response, runtime-catalog command result) that
 * projects a gate's recorded outcome without a caller-specific override.
 * Kept in one place so the four gates' "what to do next" text cannot drift
 * per call site the way the pre-projection ad-hoc strings did.
 */
export function defaultGateRemediation(gate: GateType): string {
  switch (gate) {
    case "admission": return "Resolve the admission gate's failing precondition (plan review, resource availability, or a valid config) and retry.";
    case "isolation": return "Verify worktree isolation, the starting commit, and lease acquisition, then retry node expansion.";
    case "evidence": return "Supply verified provenance (a real command's exit code and stdout hash) that supports the claimed result, then retry.";
    case "audit": return "Resolve the outstanding audit gate findings (unresolved bypasses or auditor disagreement) before halting.";
  }
}

/**
 * A permission refusal from the runtime catalog router (ADR-028 tier gate,
 * transport capability grant, or authenticated-session/identity check)
 * projected to the actor that can clear it. A tier or grant denial is the
 * operator's: the caller cannot raise its own tier. Every other permission
 * refusal is a session-proof or identity mismatch the caller clears by
 * presenting a current, authorized identity — `grantRemediation` lets the
 * transport name its own operator command.
 */
export function projectCapabilityRefusal(summary: string, grantRemediation: string): GateRefusalProjection {
  const tierOrGrant = summary.startsWith("CapabilityError:") || summary.startsWith("missing capability ");
  return projectGateRefusal({
    gate: "capability",
    code: tierOrGrant ? "capability_not_granted" : "caller_not_authenticated",
    summary: summary.trim().length === 0 ? "permission denied" : summary.slice(0, GATE_REFUSAL_PROJECTION_MAX_TEXT),
    remediation: tierOrGrant
      ? grantRemediation
      : "Re-authenticate: present a current signed session for the identity authorized to perform this action, then retry. A stale, malformed, or mismatched session proof is never reused.",
    correcting_actor: tierOrGrant ? "operator" : "caller",
    corrective_action: tierOrGrant ? "grant_capability" : "reauthenticate",
  });
}

/**
 * A read authorized solely by an approved two-party record (`output.raw`)
 * was refused because no matching approval exists: the record is missing,
 * pending, expired, rejected, self-approved, or for another action or
 * resource. The caller's session and tier are not the problem, so
 * "re-authenticate" would send it in a circle (ADR-179 amendment
 * 2026-10-06). The caller obtains a matching approval — requested by an
 * authenticated proposer, decided by a distinct approver — and retries with
 * its id. The refusing router attaches this at the denial site, so no
 * transport re-derives it from the summary text.
 */
export function projectApprovalRefusal(action: string, summary: string): GateRefusalProjection {
  return projectGateRefusal({
    gate: "capability",
    code: "approval_not_granted",
    summary: summary.trim().length === 0 ? `${action} approval denied` : summary.slice(0, GATE_REFUSAL_PROJECTION_MAX_TEXT),
    remediation: `Obtain an approved \`${action}\` approval for this exact resource: an authenticated proposer submits approval.request (action \`${action}\`, resource_id set to the resource), a distinct decider approves it before it expires, then retry with that approval_id. Re-authenticating does not clear this refusal.`,
    correcting_actor: "caller",
    corrective_action: "request_approval",
  });
}

/**
 * A native usage or campaign spend ceiling refused a session. Only the
 * operator can raise a configured ceiling; the specialist cannot recover a
 * spent budget by retrying, so the remedy is never routed to it.
 */
export function projectBudgetRefusal(code: "campaign_budget" | "usage_budget", summary: string): GateRefusalProjection {
  return projectGateRefusal({
    gate: "budget",
    code,
    summary: summary.trim().length === 0 ? "budget refused the session" : summary.slice(0, GATE_REFUSAL_PROJECTION_MAX_TEXT),
    remediation: code === "campaign_budget"
      ? "Raise the campaign ceiling (native.usage_budget.max_campaign_tokens / max_campaign_cost in arbor.jsonc) or narrow the plan, then retry the node."
      : "Raise the per-session ceiling (native.usage_budget.max_session_* tokens / max_session_cost in arbor.jsonc) or narrow the node's task, then retry the node.",
  });
}

/**
 * A governed hook vetoed a tool call (`hook_denied`): the session's own model
 * asked for an action a reduction-only policy forbids, so it is the actor that
 * can correct course by choosing a different call. A handler that threw or
 * returned an invalid decision (`hook_veto_failed`) is not a policy decision
 * at all — the veto authority is unavailable, and only the runtime host can
 * repair it.
 */
export function projectToolVeto(code: "hook_denied" | "hook_veto_failed", summary: string): GateRefusalProjection {
  const bounded = summary.trim().length === 0 ? "tool call vetoed" : summary.slice(0, GATE_REFUSAL_PROJECTION_MAX_TEXT);
  return code === "hook_denied"
    ? projectGateRefusal({ gate: "tool_veto", code, summary: bounded, remediation: "Do not repeat this call. Choose a different action the vetoing policy permits, or report the blocked step in your final answer for the operator." })
    : projectGateUnavailable({ gate: "tool_veto", code, reason: bounded, remediation: "Repair or remove the failing veto hook (its handler threw, overran its bound, or returned an invalid decision), then rerun the session." });
}

/** The authority's primary correction; the core remedy table is the only source of allowed pairs. */
function defaultGateCorrection(gate: GateRefusalAuthority): { actor: GateCorrectingActor; action: GateCorrectiveAction } {
  const [primary] = RUNTIME_REFUSAL_REMEDIES[gate];
  return { actor: primary!.actor, action: primary!.action };
}

/** Runtime boundary validator used by all three presentation adapters. */
export function isGateRefusalProjection(value: unknown): value is GateRefusalProjection {
  if (!record(value)) return false;
  return value.schema_version === GATE_REFUSAL_PROJECTION_SCHEMA_VERSION
    && value.kind === "gate.refusal"
    && (value.state === "refused" || value.state === "unavailable")
    && isGate(value.gate)
    && boundedText(value.code)
    && boundedText(value.summary)
    && (value.evidence_deficit === null || boundedText(value.evidence_deficit))
    && boundedText(value.remediation)
    && isCorrectingActor(value.correcting_actor)
    && isCorrectiveAction(value.corrective_action)
    && hasAuthoritativeRemedy(value.state, value.gate, value.evidence_deficit, value.correcting_actor, value.corrective_action);
}

function freezeProjection(input: Omit<GateRefusalProjection, "schema_version" | "kind">): GateRefusalProjection {
  if (!hasAuthoritativeRemedy(input.state, input.gate, input.evidence_deficit, input.correcting_actor, input.corrective_action)) {
    throw new Error("gate refusal remedy must match the owning gate and projection state");
  }
  const value: GateRefusalProjection = {
    schema_version: GATE_REFUSAL_PROJECTION_SCHEMA_VERSION,
    kind: "gate.refusal",
    state: input.state,
    gate: input.gate,
    code: bounded(input.code, "code"),
    summary: bounded(input.summary, "summary"),
    evidence_deficit: input.evidence_deficit === null ? null : bounded(input.evidence_deficit, "evidence_deficit"),
    remediation: bounded(input.remediation, "remediation"),
    correcting_actor: input.correcting_actor,
    corrective_action: input.corrective_action,
  };
  return Object.freeze(value);
}

function bounded(value: string, field: string): string {
  if (!boundedText(value)) throw new Error(`gate refusal ${field} must be a non-empty string of at most ${GATE_REFUSAL_PROJECTION_MAX_TEXT} characters`);
  return value;
}

function boundedText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= GATE_REFUSAL_PROJECTION_MAX_TEXT;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isGate(value: unknown): value is GateRefusalAuthority {
  return isRefusalAuthority(value);
}

function isCorrectingActor(value: unknown): value is GateCorrectingActor {
  return value === "operator" || value === "campaign_planner" || value === "specialist" || value === "runtime_host" || value === "caller";
}

function isCorrectiveAction(value: unknown): value is GateCorrectiveAction {
  return value === "repair_plan_or_config" || value === "restore_isolation" || value === "attach_verified_evidence" || value === "resolve_audit_findings" || value === "compose_gate_authority"
    || value === "grant_capability" || value === "reauthenticate" || value === "request_approval" || value === "raise_budget" || value === "revise_tool_call";
}

function hasAuthoritativeRemedy(
  state: unknown,
  gate: unknown,
  evidenceDeficit: unknown,
  actor: unknown,
  action: unknown,
): boolean {
  if (state === "unavailable") return evidenceDeficit === null && isAuthorizedRefusalRemedy(state, gate, actor, action);
  return (evidenceDeficit === null || boundedText(evidenceDeficit)) && isAuthorizedRefusalRemedy(state, gate, actor, action);
}
