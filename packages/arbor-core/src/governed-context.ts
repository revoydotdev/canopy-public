import type { Provenance } from "./types.js";

/** Immutable, content-addressed evidence that may be inspected by a context workspace. */
export interface ContextArtifactRef {
  id: string;
  sha256: string;
  media_type: string;
  byte_length: number;
  campaign_id: string;
  producer: string;
  visibility: "campaign" | "critic_only";
  provenance: Provenance;
}

/** A bounded, read-only projection. It is not an executable REPL capability. */
export interface ContextWorkspaceView {
  artifact: ContextArtifactRef;
  offset: number;
  content: string;
  truncated: boolean;
}

export type FoldScale = "granular" | "deep";
/** Opaque span into an existing durable parent/subagent conversation record.
 * The conversation bus remains the authority for message content and lineage. */
export interface MessageRangeRef {
  /** A2A/Codex-style conversation identity; never substituted by the overlay. */
  context_id: string;
  /** Parent-thread identity retained across a fold. */
  thread_id: string;
  /** Inclusive durable-message range in ledger order. */
  start_communication_id: string;
  end_communication_id: string;
  start_byte: number;
  end_byte: number;
}
export interface FoldMeasures {
  expected_token_savings: number;
  measured_token_savings?: number;
  main_model_tokens?: number;
  child_model_tokens?: number;
  latency_ms?: number;
  /** Required before activation: verified retained claims / required claims. */
  fidelity_ratio?: number;
}

/** A non-destructive context projection proposal; raw evidence remains authoritative. */
export interface FoldProposal {
  id: string;
  campaign_id: string;
  /** Work identity is distinct from conversation context and artifact identity. */
  task_id: string;
  node_id: string;
  scale: FoldScale;
  source_event_ids: readonly string[];
  source_message_ranges: readonly MessageRangeRef[];
  retained_claims: readonly string[];
  omitted_artifacts: readonly ContextArtifactRef[];
  output_artifact: ContextArtifactRef;
  measures: FoldMeasures;
  proposed_by: string;
  provenance: Provenance;
  created_at: string;
  expires_at: string;
  supersedes_fold_id?: string;
}

export type GovernedProjectionStatus = "proposed" | "active" | "rejected" | "rolled_back" | "quarantined" | "expired";
export interface FoldRecord extends FoldProposal {
  status: GovernedProjectionStatus;
  approved_by?: string;
  approved_at?: string;
  rollback_of?: string;
  rejection_reason?: string;
}

export type PlaybookDeltaKind = "add" | "revise" | "supersede" | "retract";
export interface PlaybookDelta {
  id: string;
  campaign_id: string;
  task_id: string;
  kind: PlaybookDeltaKind;
  target_id?: string;
  patch: Record<string, unknown>;
  source_event_ids: readonly string[];
  source_message_ranges: readonly MessageRangeRef[];
  observed_outcome: string;
  counter_evidence: readonly string[];
  proposed_by: string;
  provenance: Provenance;
  created_at: string;
  expires_at: string;
  status: GovernedProjectionStatus;
  approved_by?: string;
  approved_at?: string;
}

/** Only these campaign-local overlays are mutable in the first governed-harness pass. */
export type HarnessMutableComponent =
  | "supplemental_prompt"
  | "retrieval_policy"
  | "subagent_descriptor";

/** A declarative descriptor only: it cannot carry command, code, tool, or skill execution. */
export interface NonExecutableSubagentDescriptor {
  role: string;
  objective: string;
  allowed_context_artifact_ids: readonly string[];
  allowed_message_ranges: readonly MessageRangeRef[];
  max_children: number;
  recursive_delegation: false;
}

/**
 * Durable result of one explicitly activated declarative-child dispatch.
 * This is lineage/evidence metadata, not a new tree, task, or message
 * authority.  The descriptor itself never supplies executable capabilities.
 */
export interface DeclarativeSubagentExecution {
  id: string;
  campaign_id: string;
  parent_node_id: string;
  revision_id: string;
  /** Immutable revision identity observed before the child was dispatched. */
  revision_created_at: string;
  requested_by: string;
  requested_at: string;
  state: "requested" | "completed" | "failed";
  child_session_id: string;
  worktree_node_id: string;
  result_artifact_id?: string;
  result_provenance?: Provenance;
  evidence_ids: readonly string[];
  completed_at?: string;
  failure_reason?: string;
}

/** Explicitly forbidden targets prevent a refinement loop from changing its governors. */
const FORBIDDEN_HARNESS_COMPONENTS = [
  "base_prompt", "provenance_policy", "gate_policy", "critic_policy",
  "capability_grant", "executable_skill",
] as const;
export type ForbiddenHarnessComponent = typeof FORBIDDEN_HARNESS_COMPONENTS[number];

export interface RevisionEvaluation {
  outcome: "improved" | "unchanged" | "regressed" | "not_yet_measured";
  fidelity_ratio: number | null;
  main_model_tokens: number | null;
  child_model_tokens: number | null;
  latency_ms: number | null;
  regression_detected: boolean;
  rollback_count: number;
  replay_evidence_ids: readonly string[];
  holdout_evidence_ids: readonly string[];
}

export interface HarnessRevision {
  id: string;
  campaign_id: string;
  task_id: string;
  component: HarnessMutableComponent | ForbiddenHarnessComponent;
  patch: Record<string, unknown>;
  source_event_ids: readonly string[];
  source_message_ranges: readonly MessageRangeRef[];
  expected_benefit: string;
  proposed_by: string;
  provenance: Provenance;
  created_at: string;
  expires_at: string;
  status: GovernedProjectionStatus;
  evaluation: RevisionEvaluation;
  approved_by?: string;
  approved_at?: string;
  rollback_of?: string;
  promotion?: { approved_by_human: string; approved_at: string };
  evaluation_by?: string;
  quarantine?: { decided_by: string; reason: string; evidence_ids: readonly string[]; decided_at: string };
  rejection_reason?: string;
}

export interface HarnessEvaluationRun {
  id: string; revision_id: string; campaign_id: string; requested_by: string; evaluator_id: string;
  requested_at: string; state: "running" | "measured" | "unmeasured" | "failed";
  evaluation?: RevisionEvaluation; evidence_ids: readonly string[]; detail?: readonly Record<string, unknown>[]; reason?: string; completed_at?: string;
}

export interface GovernedContextOverlays {
  campaign_id: string;
  active_folds: readonly FoldRecord[];
  active_playbook: readonly PlaybookDelta[];
  active_harness_revisions: readonly HarnessRevision[];
  /** Recent fixed-profile descriptor child outcomes; execution is not an overlay. */
  declarative_subagent_executions: readonly DeclarativeSubagentExecution[];
  rollbackable_ids: readonly string[];
}

export function isAllowedHarnessComponent(component: string): component is HarnessMutableComponent {
  return component === "supplemental_prompt" || component === "retrieval_policy"
    || component === "subagent_descriptor";
}
