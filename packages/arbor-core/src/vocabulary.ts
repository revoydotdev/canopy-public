/**
 * The one operator vocabulary every surface (TUI, WebUI, CLI, MCP) names
 * lifecycle, status and refusal facts with.
 *
 * WHY A PROJECTION, NOT AN ENUM. Every term here is already a closed union
 * owned elsewhere in core (`NodeState`, `HaltReason`, `Provenance["tag"]`,
 * the ADR-179 refusal-remedy table, ...). This module adds nothing to those
 * unions; it keys one label table by each existing type, so `tsc` refuses a
 * new member that has no operator label, and a surface (or a surface test)
 * can ask "is this rendered word a canonical term?" without re-listing the
 * members by hand.
 *
 * LABELS. A term has two acceptable renderings: its wire token
 * (`awaiting_review`, printed by `--json` and by the terse CLI/TUI rows) and
 * its label (`awaiting review`, printed by humanized display copy, the WebUI
 * S2 convention). The label is the token with `_` read as a space and nothing
 * else — so a humanized surface and a raw surface always name one fact the
 * same way. A surface that invents a third word ("working" for `expanding`,
 * "review" for `awaiting_review`) is the drift
 * `tests/cross-surface-vocabulary.test.ts` exists to catch.
 */
import type {
  GateRecord,
  GateType,
  HaltReason,
  NodeErrorKind,
  NodeState,
  OutcomeKind,
  Provenance,
  TerminalOutcome,
  VerificationStrength,
} from "./types.js";
import type { RuntimeCorrectiveAction, RuntimeGateRefusalV2, RuntimeRefusalAuthority, RuntimeRemedyActor } from "./runtime-contracts.js";

/** The fact families an operator surface names. */
export type OperatorVocabularyCategory =
  | "node_state"
  | "halt_reason"
  | "provenance_tag"
  | "gate"
  | "gate_result"
  | "refusal_authority"
  | "refusal_state"
  | "remedy_actor"
  | "corrective_action"
  | "outcome_kind"
  | "node_error_kind"
  | "terminal_outcome"
  | "verification_strength";

/** The existing core type each category labels — the only source of its members. */
export interface OperatorVocabularyTerms {
  readonly node_state: NodeState;
  /** `null` is "not halted", not a reason; it has no operator word. */
  readonly halt_reason: NonNullable<HaltReason>;
  readonly provenance_tag: Provenance["tag"];
  readonly gate: GateType;
  readonly gate_result: GateRecord["result"];
  readonly refusal_authority: RuntimeRefusalAuthority;
  readonly refusal_state: RuntimeGateRefusalV2["state"];
  readonly remedy_actor: RuntimeRemedyActor;
  readonly corrective_action: RuntimeCorrectiveAction;
  readonly outcome_kind: OutcomeKind;
  readonly node_error_kind: NodeErrorKind;
  readonly terminal_outcome: TerminalOutcome;
  readonly verification_strength: VerificationStrength;
}

type LabelTable<T extends string> = Readonly<Record<T, string>>;

/** Display label of a wire token: `_` reads as a space, nothing else changes. */
function operatorLabel(token: string): string {
  return token.replace(/_/g, " ");
}

function labels<T extends string>(table: Record<T, true>): LabelTable<T> {
  return Object.freeze(Object.fromEntries(Object.keys(table).map((token) => [token, operatorLabel(token)])) as Record<T, string>);
}

/**
 * Every canonical term, keyed by category then wire token, valued by label.
 * Each inner table is `Record<ExistingUnion, true>` at its declaration, so a
 * union member added in `types.ts`/`runtime-contracts.ts` without a row here
 * is a compile error, not a silent unlabeled word on some surface.
 */
export const OPERATOR_VOCABULARY: { readonly [C in OperatorVocabularyCategory]: LabelTable<OperatorVocabularyTerms[C]> } = Object.freeze({
  node_state: labels<NodeState>({ pending: true, expanding: true, verified: true, claimed: true, failed: true, pruned: true, interrupted: true, abandoned: true, awaiting_review: true }),
  halt_reason: labels<NonNullable<HaltReason>>({ budget_exhausted: true, below_threshold: true, converged: true, manual: true, no_nodes: true, verified_result: true, scope_unadoptable: true, stranded_work: true, max_iterations: true, unknown: true }),
  provenance_tag: labels<Provenance["tag"]>({ verified: true, claimed: true, critic_approved: true, generated: true }),
  gate: labels<GateType>({ admission: true, isolation: true, evidence: true, audit: true }),
  gate_result: labels<GateRecord["result"]>({ pass: true, fail: true, bypass: true }),
  refusal_authority: labels<RuntimeRefusalAuthority>({ admission: true, isolation: true, evidence: true, audit: true, capability: true, budget: true, tool_veto: true }),
  refusal_state: labels<RuntimeGateRefusalV2["state"]>({ refused: true, unavailable: true }),
  remedy_actor: labels<RuntimeRemedyActor>({ operator: true, campaign_planner: true, specialist: true, runtime_host: true, caller: true }),
  corrective_action: labels<RuntimeCorrectiveAction>({
    repair_plan_or_config: true, restore_isolation: true, attach_verified_evidence: true, resolve_audit_findings: true, compose_gate_authority: true,
    grant_capability: true, reauthenticate: true, request_approval: true, raise_budget: true, revise_tool_call: true,
  }),
  outcome_kind: labels<OutcomeKind>({ verdict: true, interrupted: true, error: true }),
  node_error_kind: labels<NodeErrorKind>({ timeout: true, context_window_exceeded: true, quota_exceeded: true, transport_error: true, internal_error: true, policy_refused: true }),
  terminal_outcome: labels<TerminalOutcome>({ completed: true, partial: true, failed: true, in_progress: true }),
  verification_strength: labels<VerificationStrength>({ command_executed: true, outputs_check: true }),
});
