// arbor-audit — Evidence ledger and trace-packet schema
// Clean-room from revoy-spec's audit/ discipline and LedgerMind (arXiv 2607.28374)
// provenance-constrained state machine concept.

import type { Provenance, GateRecord, NodeState, Cost } from "@arbor/core";
import { createHash, createPublicKey, verify as cryptoVerify } from "node:crypto";
import { canonicalizeForHash as canonicalJson, isValidCampaignId } from "@arbor/core";
import { isVerificationCheck } from "@arbor/core";

// ============================================================
// TRACE PACKET — per-action evidence record
// ============================================================

/**
 * A trace packet records everything that happened during one action's lifecycle:
 * selection → expansion → critic gate → scoring → branching/backtracking.
 *
 * Every arbor.expand call writes a trace packet. The audit trail is the
 * concatenation of all trace packets for a campaign.
 */
export interface TracePacket {
  /** Discriminator added on persisted records; omitted by the compatible record() input. */
  kind?: "trace";
  id: string;
  /** Hash of the preceding packet, or null for the first packet in the ledger. */
  previous_hash: string | null;
  /** SHA-256 of this packet's canonical content, including previous_hash. */
  content_hash: string;
  campaign_id: string;
  node_id: string;
  /** Durable tree join for replayed sibling-outcome analysis; absent on legacy records. */
  parent_id?: string | null;
  timestamp: string; // ISO 8601
  /**
   * Optional idempotency key (Track D2b). Omitted for backward compatibility
   * with every packet recorded before this field existed — `record()` only
   * dedupes when a caller supplies one, so legacy ledgers keep verifying
   * unchanged. A retried `record()` call with the same key and byte-identical
   * content is a detectable no-op that returns the original id; the same key
   * with different content is a loud conflict, never a silent overwrite.
   */
  idempotency_key?: string;

  // What was the action?
  action_description: string;
  action_category: string;

  // Who did it?
  specialist_agent: string;
  critic_agent: string | null;

  // What happened?
  node_state_before: NodeState;
  node_state_after: NodeState;

  // Verification evidence
  provenance: Provenance | null;
  specialist_output: string | null;
  critic_verdict_approved: boolean | null;
  critic_root_cause: string | null;

  // Score
  score_before: number;
  score_after: number;

  // Gate records
  gates: GateRecord[];

  // KB entries extracted
  kb_entries_written: string[];
}

/** The four accepted lifecycle transitions from ADR-006. */
export type GovernedTransition =
  | "campaign_start"
  | "node_expansion"
  | "node_verification"
  | "campaign_halt"
  | "sibling_spawn";

/**
 * Durable evidence that a gate was evaluated before its governed transition.
 * `operation_id` binds retries/replay to a single transition attempt; callers
 * must reuse it while retrying rather than manufacture a second checkpoint.
 */
export interface GateCheckpoint {
  transition: GovernedTransition;
  operation_id: string;
  gate: GateRecord;
  failures: string[];
  unresolved: string[];
}

/** A truthful, standalone audit record for durable gate evidence. */
export interface GateCheckpointRecord {
  kind: "gate_checkpoint";
  id: string;
  previous_hash: string | null;
  content_hash: string;
  campaign_id: string;
  node_id: string;
  timestamp: string;
  checkpoint: GateCheckpoint;
}

/** A recovery authority decision, deliberately distinct from a gate or action trace. */
export interface RecoveryDecision {
  recovery_operation_id: string;
  decision: "retry" | "abandon";
  actor: string;
  authority: "crown" | "cambium" | "operator" | "auditor";
  reason: string;
  prior_operation_id: string | null;
  new_operation_id: string | null;
  expected_version: string | null;
  observed_version: string;
  lease: {
    previous: "released" | "inactive" | "ambiguous" | "unknown";
    new_lease_id: string | null;
  };
  isolation: {
    result: "pass" | "fail" | "bypass" | "not_checked";
    checkpoint_operation_id: string | null;
    evidence_deficit: string | null;
  };
  outcome: "planned" | "authorized" | "blocked";
}

export interface RecoveryDecisionRecord {
  kind: "recovery_decision";
  id: string;
  previous_hash: string | null;
  content_hash: string;
  campaign_id: string;
  node_id: string;
  timestamp: string;
  decision: RecoveryDecision;
}

/**
 * An operator session fork reopening a campaign that halted because its
 * search ran out rather than because it was stopped (ADR-043 amendment,
 * fork reopen). `reopened` is written before the halt flag is cleared and
 * names the halt it overrides; `reverted` restores that halt when the fork
 * did not reach a runnable child. A budget or manual halt is never
 * reopenable, so neither reason can appear here.
 */
export interface CampaignReopen {
  operation_id: string;
  phase: "reopened" | "reverted";
  actor: string;
  authority: "operator";
  overridden_halt_reason: "no_nodes" | "converged";
  source_session_id: string;
  reason: string;
  /** The convergence counter before and after the reopen (budget counters are never touched). */
  iterations_without_kb_entry: { before: number; after: number };
}

export interface CampaignReopenRecord {
  kind: "campaign_reopen";
  id: string;
  previous_hash: string | null;
  content_hash: string;
  campaign_id: string;
  /** The forked child node whose dispatch the reopen exists for. */
  node_id: string;
  timestamp: string;
  reopen: CampaignReopen;
}

export type CampaignReopenInput = CampaignReopen & { campaign_id: string; node_id: string; timestamp?: string };

export interface Interruption {
  operation_id: string;
  scope: "node" | "subtree";
  phase: "requested" | "acknowledged" | "state_applied";
  affected_node_ids: readonly string[];
  partial_evidence_ids: readonly string[];
  provenance: Provenance;
  reason: string;
  request_record_id: string | null;
}
export interface InterruptionRecord {
  kind: "interruption";
  id: string;
  previous_hash: string | null;
  content_hash: string;
  campaign_id: string;
  node_id: string;
  timestamp: string;
  interruption: Interruption;
}
export type InterruptionInput = Interruption & { campaign_id: string; node_id: string; timestamp?: string };
export const INTERRUPTION_MAX_AFFECTED_NODES = 1024;
export const INTERRUPTION_MAX_PARTIAL_EVIDENCE = 128;
export const INTERRUPTION_MAX_ID_BYTES = 512;
export const INTERRUPTION_MAX_REASON_BYTES = 16 * 1024;

/**
 * Phase 4D.1 implementation note — conversation envelope.
 * Extends NodeCommunicationKind from 4→7 elements to support bidirectional
 * multi-turn conversations among parent↔node↔critic↔operator.
 * conversation_id joins a run of records into one conversation thread.
 * parent_communication_id links a reply to the record it answers
 * (distinct from acknowledges_communication_id / retracts_communication_id
 * which have retract/ack semantics). capability_tier enforcement remains
 * structural via canReadCommunication; a future ADR may add an explicit
 * role field for kind-to-author consistency (e.g. promote requires
 * orchestrator-tier authorship).
 */
export type NodeCommunicationKind = "delegate" | "report" | "retract" | "steer" | "reply" | "clarify" | "promote";
/**
 * Transport-level purpose of a durable conversation record. This deliberately
 * does not reuse A2A roles: the ledger retains the exact tree-node identities
 * that authored and received the record.
 */
export type NodeCommunicationIntent = "request" | "response" | "notify" | "needs_attention";
export const CONVERSATION_MAX_ID_BYTES = 512;
/** Host-verified remote ingress attribution. Never carries a credential or public key. */
export interface RemoteCommunicationAttribution {
  readonly session_id: string;
  readonly key_id: string;
  readonly certificate_id: string;
  readonly nonce: string;
  readonly integrity: "ed25519";
  /** ADR-041 digest of signed canonical bytes; raw signatures never enter the ledger. */
  readonly proof_digest?: `sha256:${string}`;
}
export interface NodeCommunication {
  author_node_id: string; recipient_node_id: string; other_recipient_node_ids: readonly string[];
  kind: NodeCommunicationKind; payload: { content: string; provenance: Provenance; /** Durable evidence/artifact pointers, never inline artifact bytes. */ evidence_refs?: readonly string[] };
  capability_tier: "specialist" | "critic" | "auditor" | "orchestrator";
  trigger_turn: boolean; as_of: string; correlation_id: string; idempotency_key: string;
  acknowledges_communication_id: string | null; retracts_communication_id: string | null;
  /** Phase 4D.1: conversation envelope — joins a run of records into one conversation.
   *  Optional for legacy-record replay; non-empty and <= 512 bytes when present. */
  conversation_id?: string;
  /** Phase 4D.1: links this record to the communication it responds to (conversation parent).
   *  null for the first message in a conversation. Cross-record parentage resolved
   *  at projection time, not at append (ledger is append-only). */
  parent_communication_id?: string | null;
  /** Clean-room revoy-spec transport metadata. Optional for replay of older records. */
  intent?: NodeCommunicationIntent;
  /** The durable record this message replies to; validated by the owning thread facade. */
  reply_to_communication_id?: string | null;
  /** Whether the recipient must append an explicit acknowledgement before deadline_at. */
  ack_required?: boolean;
  /** ISO deadline persisted with the message; timeout state is derived by projections. */
  deadline_at?: string | null;
  /** Present only after an opt-in host verifies a remote ingress proof. */
  remote_attribution?: RemoteCommunicationAttribution;
}
export interface NodeCommunicationRecord {
  kind: "node_communication"; id: string; previous_hash: string | null; content_hash: string;
  campaign_id: string; node_id: string; timestamp: string; communication: NodeCommunication;
}
export type NodeCommunicationInput = NodeCommunication & { campaign_id: string; node_id: string; timestamp?: string };

/** A runtime-memory fact witnessed by prior evidence in this campaign's ledger. */
export interface MemoryFact {
  /**
   * `cross_campaign` is an explicit promotion decision. It is never inferred
   * from a fact type, tag, or the storage location of a projection.
   */
  scope: { kind: "campaign" } | { kind: "subtree"; root_node_id: string } | { kind: "cross_campaign" };
  type: "failure_mode" | "success_pattern" | "parameter_finding";
  content: string;
  provenance: Provenance;
  tier: "specialist_visible" | "critic_only";
  source_evidence_id: string;
  idempotency_key: string;
  tags: readonly string[];
  /**
   * Present only when a fact was explicitly imported into this campaign from
   * another campaign's witnessed memory.  The imported fact remains a normal,
   * target-campaign ledger record; this immutable origin prevents the target
   * projection from laundering it into locally learned authority.
   */
  imported_from?: {
    campaign_id: string;
    memory_fact_id: string;
    requested_by: string;
    approved_by: string;
  };
}
/** Memory is a bounded projection; full output belongs in OutputEvidenceStore. */
export const MEMORY_FACT_MAX_CONTENT_BYTES = 16 * 1024;
export const MEMORY_FACT_MAX_TAGS = 32;
export const MEMORY_FACT_MAX_TAG_BYTES = 256;
export interface MemoryFactRecord {
  kind: "memory_fact";
  id: string;
  previous_hash: string | null;
  content_hash: string;
  campaign_id: string;
  node_id: string;
  timestamp: string;
  fact: MemoryFact;
}
export type MemoryFactInput = MemoryFact & { campaign_id: string; node_id: string; timestamp?: string };

/** Narrow streaming phase; a phase's final word, bounded and evidence-backed. */
export type PhaseMessageKind = "commentary" | "final";
export const PHASE_MESSAGE_MAX_CONTENT_BYTES = 8 * 1024;
export const PHASE_MESSAGE_MAX_PER_CAMPAIGN = 2_000;
export interface PhaseMessage {
  operation_id: string;
  phase: PhaseMessageKind;
  content: string;
  content_length_bytes: number;
  provenance: Provenance;
  idempotency_key: string;
}
export interface PhaseMessageRecord {
  kind: "phase_message";
  id: string;
  previous_hash: string | null;
  content_hash: string;
  campaign_id: string;
  node_id: string;
  timestamp: string;
  message: PhaseMessage;
}
export type PhaseMessageInput = PhaseMessage & { campaign_id: string; node_id: string; timestamp?: string };

// ============================================================
// REQUEST USER INPUT — ADR-019 governed user-interview transition
// ============================================================

/**
 * Question authority (ADR-019): only the root/lead node may interrupt the
 * human. A delegated sibling appends `needs_input` (never asks directly) — the
 * user-facing mirror of ADR-005 capability tiers.
 */
export type UserInputAuthority = "lead" | "delegated_needs_input";
export type UserInputStatus = "awaiting" | "answered" | "expired";
/** Whether the loop must block on the human or may proceed async (derived from mode). */
export type UserInputBlocking = "blocking" | "async";
/** A chosen option may steer/promote/backtrack a node — a governed typed transition. */
export type UserInputFollowUpKind = "steer" | "promote" | "backtrack";

export const USER_INPUT_MAX_QUESTION_BYTES = 4 * 1024;
export const USER_INPUT_MAX_OPTIONS = 16;
export const USER_INPUT_MAX_OPTION_BYTES = 512;
export const USER_INPUT_MAX_FOLLOW_UP_BYTES = 1024;
export const USER_INPUT_MAX_ANSWER_BYTES = 8 * 1024;

export interface UserInputOption {
  id: string;
  text: string;
  is_other: boolean;
  follow_up?: { text: string; kind: UserInputFollowUpKind };
}

export interface RequestUserInput {
  operation_id: string;
  question: string;
  options: readonly UserInputOption[];
  /** Authority mirrors capability tiering (lead vs delegated). */
  authority: UserInputAuthority;
  /** Derived from mode: plan/admission blocks selectNode; operator steer is async. */
  blocking: UserInputBlocking;
  /** Mode-scoped attribution. */
  requester_role: string;
  /** Optional native harness session that originated this request; never an approver identity. */
  origin_session_id?: string;
  idempotency_key: string;
  /** Ledger sequence for total order. */
  as_of: string;
}

export interface UserInputAnswer {
  option_id: string | null;
  custom_text: string;
  answered_by: string;
  answered_at: string;
}

export interface RequestUserInputRecord {
  kind: "request_user_input";
  id: string;
  previous_hash: string | null;
  content_hash: string;
  campaign_id: string;
  node_id: string;
  timestamp: string;
  question: RequestUserInput;
  /** Populated when answered (legacy in-place view; new answers append).
   *  Kept for backward-compat with records that pre-date the append answer. */
  answer: UserInputAnswer | null;
  status: UserInputStatus;
}

export type RequestUserInputInput = RequestUserInput & { campaign_id: string; node_id: string; timestamp?: string };

/**
 * Append-only answer record (ADR-019 "approve-from-ledger"): the human's answer
 * is its own ledger record referencing the question, so answering never mutates
 * an already-persisted packet's hash (append-only integrity preserved).
 */
export interface UserInputAnswerRecord {
  kind: "user_input_answer";
  id: string;
  previous_hash: string | null;
  content_hash: string;
  campaign_id: string;
  node_id: string;
  timestamp: string;
  question_record_id: string;
  answer: UserInputAnswer;
}

export interface UserInputAnswerInput {
  campaign_id: string;
  node_id: string;
  question_record_id: string;
  answer: UserInputAnswer;
  timestamp?: string;
}

// ============================================================
// COMPACTION LIFECYCLE — durable record of compaction operations
// ============================================================

export type CompactionTrigger = "auto" | "manual";
export type CompactionStatus = "completed" | "interrupted" | "failed";
export type CompactionStrategy = "local_model" | "token_budget_fresh_window" | "structural_folding";

export interface CompactionLifecycle {
  operation_id: string;
  trigger: CompactionTrigger;
  strategy: CompactionStrategy;
  status: CompactionStatus;
  /** Pre-compaction evidence pointer into the content-addressed store. */
  pre_evidence_id: string;
  /** Post-compaction evidence pointer (same store). */
  post_evidence_id: string | null;
  /** Anchor: id of the last sealed summary record (anchored merge, not regenerate). */
  anchor_summary_id: string | null;
  /** Bounded reason text for interrupted/failed (Commandment VI separation). */
  reason: string;
  /** Bounded partial evidence ids preserved on interrupted/failed compactions. */
  partial_evidence_ids: readonly string[];
  idempotency_key: string;
  /** Ledger sequence for total order. */
  as_of: string;
}

export interface CompactionLifecycleRecord {
  kind: "compaction_lifecycle";
  id: string;
  previous_hash: string | null;
  content_hash: string;
  campaign_id: string;
  node_id: string;
  timestamp: string;
  lifecycle: CompactionLifecycle;
}

export type CompactionLifecycleInput = CompactionLifecycle & { campaign_id: string; node_id: string; timestamp?: string };

export const COMPACTION_MAX_PARTIAL_EVIDENCE = 128;
export const COMPACTION_MAX_REASON_BYTES = 16 * 1024;
export const COMPACTION_MAX_ID_BYTES = 512;

export const TELEMETRY_PHASES = ["select", "expand", "gate", "critic", "backprop"] as const;
export type TelemetryPhase = typeof TELEMETRY_PHASES[number];
export const TELEMETRY_PROVIDERS = ["openai", "anthropic", "google", "local", "other"] as const;
export type TelemetryProvider = typeof TELEMETRY_PROVIDERS[number];
export const TELEMETRY_MODEL_FAMILIES = ["gpt", "claude", "gemini", "local", "other"] as const;
export type TelemetryModelFamily = typeof TELEMETRY_MODEL_FAMILIES[number];
export const TELEMETRY_OUTCOMES = ["success", "failure", "cancelled", "timeout"] as const;
export type TelemetryOutcome = typeof TELEMETRY_OUTCOMES[number];

export interface TelemetryIdentity {
  operation_id: string;
  /** Monotonic attempt identity supplied by the runtime, not inferred from time. */
  epoch: number;
  phase: TelemetryPhase;
  outcome: TelemetryOutcome;
  source_evidence_id: string;
  idempotency_key: string;
  provenance: Provenance;
}

export interface PhaseTimingObservation extends TelemetryIdentity {
  type: "phase_timing";
  /** Exact integer milliseconds; wall-clock start/end are deliberately not authority. */
  duration_ms: number;
}

export interface UsageCostObservation extends TelemetryIdentity {
  type: "usage_cost";
  /** Exact dispatched botanical agent; absent only on historical records. */
  agent_id?: string;
  provider: TelemetryProvider;
  model_family: TelemetryModelFamily;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  /**
   * A priced call carries an exact integer amount, currency, and
   * price-schedule evidence; an unpriced call carries a typed reason instead
   * of a fabricated zero (G-09).
   */
  cost: Cost;
}

/** Exact role/model pairing observed at dispatch; model aliases remain evidence, not inferred identity. */
export interface RoleModelIdentityObservation extends TelemetryIdentity {
  type: "role_model_identity";
  role: "specialist" | "critic";
  model_id: string;
}

export interface NodeCostSpan {
  span_id: string;
  kind: "specialist" | "critic" | "tool";
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  cost: Cost;
}

/** Durable, first-class attribution emitted when a node is finalized. */
export interface NodeCostAttributionObservation extends TelemetryIdentity {
  type: "node_cost_attribution";
  total_cost: Cost;
  total_tokens: { input: number; output: number; cache_read: number; cache_write: number };
  top_cost_spans: readonly NodeCostSpan[];
  redundant_tool_calls: readonly { normalized_signature: string; count: number }[];
  produced_verified_progress: boolean;
  /** Advisory only: tree state and verification remain authoritative. */
  pruning_signal: "retain" | "expensive_unproductive";
}

/**
 * Privacy-safe context-composition telemetry: token counts only, never raw
 * prompt text. Sourced from a native context layer's own read-only
 * observation (see `NativeContextManager.observeComposition` in
 * @arbor/harness) — this type is intentionally a structural mirror rather
 * than a dependency, so arbor-audit never depends on arbor-harness.
 */
export interface ContextEconomyObservation extends TelemetryIdentity {
  type: "context_economy";
  offered_tokens: number;
  retained_tokens: number;
  pruned_tokens: number;
  indexed_reference_tokens: number;
  stable_prefix_tokens: number;
  dynamic_tokens: number;
  /**
   * Bounded (always exactly `CONTEXT_ECONOMY_SOURCES.length`) per-source
   * breakdown: one row per native context operation, each carrying its own
   * offered/retained token counts. A structural mirror of
   * `NativeContextSourceComposition` (@arbor/harness) — counts only, never
   * raw content, so a row is a digest-shaped fact rather than evidence text.
   */
  per_source: readonly ContextEconomySourceRow[];
}

/** Content-free accounting for native tool-call suppression. */
export interface ToolEconomyObservation extends TelemetryIdentity {
  type: "tool_economy";
  offered_calls: number;
  host_executions: number;
  reused_reads: number;
  avoided_output_bytes: number;
}

export type ContextEconomySource = "system_instructions" | "project_instructions" | "task" | "repository_graph" | "code" | "tool_output" | "trajectory" | "memory" | "critic_feedback" | "human_input";
export type ContextEconomyCacheClass = "stable" | "dynamic";
export type ContextEconomyDisposition = "absent" | "retained" | "pruned" | "indexed" | "mixed";
export interface ContextEconomySourceRow {
  source: ContextEconomySource;
  offered_tokens: number;
  retained_tokens: number;
  cache_class: ContextEconomyCacheClass;
  disposition: ContextEconomyDisposition;
  reason: string;
  provenance: Provenance;
  evidence_pointer: string;
}
/** Fixed, stable enumeration order for per-source composition rows. */
export const CONTEXT_ECONOMY_SOURCES: readonly ContextEconomySource[] = Object.freeze([
  "system_instructions", "project_instructions", "task", "repository_graph", "code",
  "tool_output", "trajectory", "memory", "critic_feedback", "human_input",
]);

/** ADR-067 (X-2): one durable record per staggered specialist race — the bench must reconstruct true (double) cost from the ledger alone. */
export interface RaceOutcomeTelemetryObservation extends TelemetryIdentity {
  type: "race_outcome";
  forked_at_ms: number | null;
  winner: "primary" | "fork" | "none";
  loser_wall_ms: number | null;
  cancelled: boolean;
  /** Honest reason the loser's usage never became a real usage_cost row; absent when it was journaled normally. */
  loser_usage_unavailable_reason?: string;
  /** ADR-069 (X-1): the fork threshold this race actually used, with its provenance — ledger-visible, never silently tuned. */
  threshold_ms?: number;
  threshold_source?: "learned" | "env" | "default";
  threshold_observations?: number;
  /** ADR-071 (PM-1): how a forked winner:"none" tie was arbitrated; absent on every verified-winner path. */
  tie_break?: "primary" | "fork" | "none_default";
}

export type TelemetryObservation = PhaseTimingObservation | UsageCostObservation | RoleModelIdentityObservation | NodeCostAttributionObservation | ContextEconomyObservation | ToolEconomyObservation | RaceOutcomeTelemetryObservation;
export interface TelemetryObservationRecord {
  kind: "telemetry_observation";
  id: string;
  previous_hash: string | null;
  content_hash: string;
  campaign_id: string;
  node_id: string;
  timestamp: string;
  observation: TelemetryObservation;
}
export type TelemetryObservationInput = TelemetryObservation & { campaign_id: string; node_id: string; timestamp?: string };

/** Terminal substrate facts observed by the renderer, never inferred from TERM. */
export interface TerminalProfileObservation {
  operation_id: string;
  idempotency_key: string;
  capabilities: null | {
    focus_tracking: boolean;
    notifications: boolean;
    rgb: boolean;
    ansi256: boolean;
    remote: boolean;
    multiplexer: "none" | "tmux" | "zellij" | "screen" | "unknown";
    terminal_name: string;
    terminal_version: string;
  };
  theme_mode: "dark" | "light";
  theme_source: "terminal" | "timeout_default";
  provenance: Provenance;
}
export interface TerminalProfileRecord {
  kind: "terminal_profile";
  id: string;
  previous_hash: string | null;
  content_hash: string;
  campaign_id: string;
  node_id: string;
  timestamp: string;
  profile: TerminalProfileObservation;
}
export type TerminalProfileInput = TerminalProfileObservation & { campaign_id: string; node_id: string; timestamp?: string };

/** Delivery result from one terminal-native notification attempt. Message text is intentionally absent. */
export interface TerminalNotificationObservation {
  operation_id: string;
  idempotency_key: string;
  notification_ref: string;
  focus: "unknown" | "focused" | "blurred";
  emitted: boolean;
  provenance: Provenance;
}
export interface TerminalNotificationRecord {
  kind: "terminal_notification";
  id: string;
  previous_hash: string | null;
  content_hash: string;
  campaign_id: string;
  node_id: string;
  timestamp: string;
  notification: TerminalNotificationObservation;
}
export type TerminalNotificationInput = TerminalNotificationObservation & { campaign_id: string; node_id: string; timestamp?: string };

/**
 * ADR-062 direct-tier waiver outcome (E-8, arXiv 2605.26508 shape). Recorded
 * once per node whose review was waived (`params.review_waived` on
 * `recordResult`), independent of that node's own immediate outcome — the
 * arbiter's waiver decision is the auditable event, not the node's success or
 * failure. `adopted`/`later_failed` are NOT fields here: an append-only
 * record cannot honestly claim a future outcome at creation time, so they are
 * folded from `WaiverOutcomeAmendmentRecord`s appended later (see
 * `getWaiverOutcomeAmendments`) — the same append-then-fold shape ADR-019
 * uses for `RequestUserInputRecord`/`UserInputAnswerRecord`.
 */
export interface WaiverOutcome {
  task_category: string;
  waived_by: string;
  waived_reason: string;
  waived_at: string; // ISO 8601
  idempotency_key: string;
}
export const WAIVER_OUTCOME_MAX_CATEGORY_BYTES = 256;
export const WAIVER_OUTCOME_MAX_REASON_BYTES = 4 * 1024;
export interface WaiverOutcomeRecord {
  kind: "waiver_outcome";
  id: string;
  previous_hash: string | null;
  content_hash: string;
  campaign_id: string;
  node_id: string;
  timestamp: string;
  outcome: WaiverOutcome;
}
export type WaiverOutcomeInput = WaiverOutcome & { campaign_id: string; node_id: string; timestamp?: string };

/**
 * Amends a waiver outcome after the fact — "was it adopted" and "did it
 * later fail" are both determined AFTER `WaiverOutcomeRecord` is written
 * (adoption happens post-hoc via `arbor adopt`; a later failure is a future
 * feedback-loop event this cycle only builds the evidence base for, per the
 * roadmap's explicit scope cut). `later_failed` may be amended more than
 * once (e.g. `false` then later `true`) — the latest amendment of a given
 * `kind` for a waiver record wins; see `foldWaiverOutcome`.
 */
export type WaiverOutcomeAmendmentKind = "adopted" | "later_failed";
export interface WaiverOutcomeAmendment {
  waiver_record_id: string;
  kind: WaiverOutcomeAmendmentKind;
  value: boolean;
  recorded_by: string;
  reason: string;
  idempotency_key: string;
}
export const WAIVER_OUTCOME_AMENDMENT_MAX_REASON_BYTES = 4 * 1024;
export interface WaiverOutcomeAmendmentRecord {
  kind: "waiver_outcome_amendment";
  id: string;
  previous_hash: string | null;
  content_hash: string;
  campaign_id: string;
  node_id: string;
  timestamp: string;
  amendment: WaiverOutcomeAmendment;
}
export type WaiverOutcomeAmendmentInput = WaiverOutcomeAmendment & { campaign_id: string; node_id: string; timestamp?: string };

/** A waiver outcome record folded with its latest amendments — the read-side view `arbor report`/governance actually surface. */
export interface FoldedWaiverOutcome {
  readonly record: WaiverOutcomeRecord;
  readonly adopted: boolean;
  readonly later_failed: boolean | null;
}

/**
 * Y-1 (least-privilege #1, graduated scope enforcement): a durable record of
 * one write-scope check's outcome against a node's observed worktree diff.
 * Written for BOTH tiers -- an authored mismatch that blocked the node
 * ("blocked") and a mined mismatch that did not ("audit") -- so the ledger
 * carries the same evidence regardless of which tier decided the node's
 * fate. `enforcement` is never read from any model-produced field: it is
 * supplied by the composition root, which derives it solely from which code
 * path produced the node's write-scope declaration (authored vs mined; see
 * `cli.ts`'s `scopeIsAuthored`) -- a specialist or arbiter cannot influence
 * it by anything it writes or says.
 */
export interface ScopeObservation {
  declared: readonly string[];
  observed_out_of_scope: readonly string[];
  enforcement: "audit" | "blocked";
  idempotency_key: string;
  /**
   * Y-2 (ADR-066, dedupe + escalation): the grouping key `recordScopeObservation`
   * folds repeats within and queries blocked precedent against — two
   * observations with the same `lineage_root` are treated as the same
   * write-scope "lineage" for folding/escalation purposes. Optional and
   * additive: absent (every pre-Y-2 caller, including `manager.ts`'s
   * original ADR-065 wiring) defaults to `node_id`, so folding/escalation
   * degrade to per-node grouping rather than silently doing nothing.
   */
  lineage_root?: string;
}
export const SCOPE_OBSERVATION_MAX_PATHS = 256;
export const SCOPE_OBSERVATION_MAX_PATH_BYTES = 4 * 1024;
export interface ScopeObservationRecord {
  kind: "scope_observation";
  id: string;
  previous_hash: string | null;
  content_hash: string;
  campaign_id: string;
  node_id: string;
  timestamp: string;
  observation: ScopeObservation;
}
export type ScopeObservationInput = ScopeObservation & { campaign_id: string; node_id: string; timestamp?: string };

/**
 * Y-2: a repeat scope observation whose `observed_out_of_scope` set is
 * already a subset of an existing journaled observation's (same
 * `lineage_root`) is folded into an amendment instead of appending a
 * duplicate `ScopeObservationRecord` -- mirrors `WaiverOutcomeAmendmentRecord`'s
 * append-then-fold shape exactly, one additive `AuditRecord` variant.
 */
export type ScopeObservationAmendmentKind = "folded";
export interface ScopeObservationAmendment {
  scope_observation_record_id: string;
  kind: ScopeObservationAmendmentKind;
  idempotency_key: string;
}
export interface ScopeObservationAmendmentRecord {
  kind: "scope_observation_amendment";
  id: string;
  previous_hash: string | null;
  content_hash: string;
  campaign_id: string;
  node_id: string;
  timestamp: string;
  amendment: ScopeObservationAmendment;
}
export type ScopeObservationAmendmentInput = ScopeObservationAmendment & { campaign_id: string; node_id: string; timestamp?: string };

/** A scope observation folded with its later repeats -- the read-side view. */
export interface FoldedScopeObservation {
  readonly record: ScopeObservationRecord;
  /** 1 (never folded) plus the number of `folded` amendments journaled against it. */
  readonly folded_count: number;
}

/**
 * ADR-119 O3: a durable, append-only, hash-chained record of one scope-intent
 * bind -- the moment `native-tool-host.ts`'s bind-on-first-use path widens an
 * unbound `{argv_prefix, purpose}` intent entry to the literal argv actually
 * observed on its first matching call. Modeled directly on
 * `ScopeObservationRecord`/`recordScopeObservation`: hash-chained with an
 * `idempotency_key`, and additive alongside every existing `AuditRecord`
 * variant, so it changes no existing signing payload and invalidates no
 * existing chain. This is the ledger provenance ADR-119's operator
 * acceptance rested on ("the bind is journaled with the exact argv, so
 * provenance is complete even where pre-approval granularity narrows",
 * `decisions/interviews.jsonl`); `TreeNode.bound_scope_intents`
 * (`@arbor/core`) remains the fast, mutable working-state promotion of a
 * bound intent back to a literal `command_argv` entry on re-derivation --
 * a different job than this ledger record, which is the tamper-evident
 * evidence of record.
 */
export interface ScopeIntentBind {
  session_id: string;
  intent_index: number;
  argv_prefix: readonly string[];
  purpose: string;
  bound_argv: readonly string[];
  idempotency_key: string;
}
export const SCOPE_INTENT_BIND_MAX_ARGV_ENTRIES = 256;
export const SCOPE_INTENT_BIND_MAX_ARGV_BYTES = 4 * 1024;
export const SCOPE_INTENT_BIND_MAX_PURPOSE_BYTES = 4 * 1024;
export interface ScopeIntentBindRecord {
  kind: "scope_intent_bind";
  id: string;
  previous_hash: string | null;
  content_hash: string;
  campaign_id: string;
  node_id: string;
  timestamp: string;
  bind: ScopeIntentBind;
}
export type ScopeIntentBindInput = ScopeIntentBind & { campaign_id: string; node_id: string; timestamp?: string };

/**
 * Y-1 (ADR-068, durable advisory evidence): a bounded, non-authoritative
 * finding surfaced by an offline analysis pass -- a sibling-tree scan, the
 * test amplifier, or the mutation probe -- that would otherwise evaporate
 * after the single critic prompt that consumed it. "Advisory" means exactly
 * that: never a verdict input, never gate-blocking on its own; it is durable
 * evidence FOR a later human or auditor read. `source_evidence_id` is a
 * witness validated as PRIOR EVIDENCE in the same campaign, identically to
 * `TelemetryIdentity.source_evidence_id` (see `recordTelemetryObservation`).
 */
export const ADVISORY_EVIDENCE_GENERATORS = ["sibling_scan", "test_amplifier", "mutation_probe"] as const;
export type AdvisoryEvidenceGenerator = typeof ADVISORY_EVIDENCE_GENERATORS[number];
export const ADVISORY_EVIDENCE_MAX_ACTIVITY_BYTES = 256;
export const ADVISORY_EVIDENCE_MAX_PAYLOAD_BYTES = 8 * 1024;
export interface AdvisoryEvidence {
  generator: AdvisoryEvidenceGenerator;
  activity: string;
  payload: string;
  /**
   * True when `payload` was cut to fit `ADVISORY_EVIDENCE_MAX_PAYLOAD_BYTES`.
   * The ledger truncates the payload rather than refusing the record outright
   * -- an oversized advisory finding is still worth keeping in bounded form,
   * unlike (e.g.) `memory_fact`'s content, which is refused past its cap
   * because a durable memory claims to be the complete fact. This mirrors
   * `ContextWorkspaceView.truncated` (`@arbor/core/governed-context.ts`): a
   * bounded, honestly-marked-partial read rather than a silent cut or a hard
   * refusal.
   */
  payload_truncated: boolean;
  source_evidence_id: string;
  idempotency_key: string;
}
/**
 * `payload_truncated` is optional and, when supplied, is always recomputed
 * (never trusted) by `recordAdvisoryEvidence` -- callers pass the raw
 * `payload` and the ledger decides truncation, exactly as `record()` derives
 * `content_hash` rather than accepting a caller-supplied one.
 */
export type AdvisoryEvidenceInput = Omit<AdvisoryEvidence, "payload_truncated"> & {
  payload_truncated?: boolean;
  campaign_id: string;
  node_id: string;
  timestamp?: string;
};
export interface AdvisoryEvidenceRecord {
  kind: "advisory_evidence";
  id: string;
  previous_hash: string | null;
  content_hash: string;
  campaign_id: string;
  node_id: string;
  timestamp: string;
  evidence: AdvisoryEvidence;
}

/**
 * Y (ADR-070, PM-3): a signed, offline-verifiable hop in a campaign's
 * scope-decision chain -- an audit-tier widening judged legitimate
 * ("approved_widening"), or a later reversal of one ("revoked"). Key
 * management is deliberately campaign-local and ephemeral (`manager.ts`
 * holds the private key IN MEMORY ONLY, never persisted): this proves
 * INTRA-CAMPAIGN hop integrity (a tamperer must alter the hash chain AND
 * forge a signature) -- it is not a PKI and proves nothing about the real
 * -world identity of `decided_by`. A process restart loses the private key,
 * so `manager.ts` starts a NEW "generation" (a fresh keypair, journaled on a
 * `parent_decision_id: null` genesis hop) rather than silently reusing a key
 * it no longer holds; `recordScopeDecision`/`verifyScopeDecisionSignature`
 * enforce that every non-genesis hop's `public_key` matches its PARENT
 * hop's `public_key` -- the generation a hop belongs to is defined by
 * walking its `parent_decision_id` chain to that generation's genesis, not
 * by any single campaign-wide key.
 */
export type ScopeDecisionKind = "approved_widening" | "revoked";
export const SCOPE_DECISION_MAX_PATHS = 32;
export const SCOPE_DECISION_MAX_PATH_BYTES = 4 * 1024;
export interface ScopeDecision {
  paths: readonly string[];
  decision: ScopeDecisionKind;
  decided_by: string;
  /** Null iff this hop is a generation's genesis (no prior hop to chain from). */
  parent_decision_id: string | null;
  /** base64 SPKI DER -- the generation's journaled public key; the first hop of a generation carries it, every later hop in that generation must match it. */
  public_key: string;
  /** base64 Ed25519 signature over `scopeDecisionSigningPayload`'s canonical JSON. */
  signature: string;
  idempotency_key: string;
}
export interface ScopeDecisionRecord {
  kind: "scope_decision";
  id: string;
  previous_hash: string | null;
  content_hash: string;
  campaign_id: string;
  node_id: string;
  timestamp: string;
  decision: ScopeDecision;
}
/**
 * `previous_record_content_hash` is NOT persisted as its own field -- it is
 * exactly this record's own `previous_hash` (the ledger's tip for this
 * campaign at signing time), which is what makes the signature bind the hop
 * into the existing chain: tampering with `previous_hash` breaks the
 * signature too, not just the generic chain check every record already gets.
 * Callers (the manager) must supply the tip they signed against so
 * `recordScopeDecision` can refuse a stale signature (a race where the tip
 * moved between signing and recording) with a clear error rather than
 * silently accepting a signature over the wrong payload.
 */
export type ScopeDecisionInput = ScopeDecision & {
  campaign_id: string;
  node_id: string;
  previous_record_content_hash: string | null;
  timestamp?: string;
};

export type AuditRecord = TracePacket | GateCheckpointRecord | RecoveryDecisionRecord | CampaignReopenRecord | InterruptionRecord | NodeCommunicationRecord | MemoryFactRecord | TelemetryObservationRecord | TerminalProfileRecord | TerminalNotificationRecord | PhaseMessageRecord | CompactionLifecycleRecord | RequestUserInputRecord | UserInputAnswerRecord | WaiverOutcomeRecord | WaiverOutcomeAmendmentRecord | ScopeObservationRecord | ScopeObservationAmendmentRecord | AdvisoryEvidenceRecord | ScopeDecisionRecord | ScopeIntentBindRecord;

export interface GateCheckpointInput {
  campaign_id: string;
  node_id: string;
  transition: GovernedTransition;
  operation_id: string;
  gate: GateRecord;
  /** Optional only for source compatibility with pre-W1a checkpoint producers. */
  failures?: string[];
  /** Optional only for source compatibility with pre-W1a checkpoint producers. */
  unresolved?: string[];
  timestamp?: string;
}

export interface RecoveryDecisionInput extends RecoveryDecision {
  campaign_id: string;
  node_id: string;
  timestamp?: string;
}

const GATE_FOR_TRANSITION: Readonly<Record<GovernedTransition, GateRecord["gate"]>> = {
  campaign_start: "admission",
  node_expansion: "isolation",
  node_verification: "evidence",
  campaign_halt: "audit",
  sibling_spawn: "isolation",
};

export interface IntegrityCheck {
  valid: boolean;
  packet_count: number;
  error: string | null;
}

export class AuditIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuditIntegrityError";
  }
}

// ============================================================
// EVIDENCE LEDGER — append-only, content-addressed
// ============================================================

/**
 * Reserved campaign_id for ADR-027 Decision point 2's governance event
 * stream: governance events append to THIS SAME ledger under
 * `campaign_id: "governance"`, persisted by the existing `saveLedger` at
 * `<dir>/audit/governance.jsonl` — no parallel ledger class. Before this
 * guard, "governance" was reserved in ADR-027's prose only: nothing in
 * EvidenceLedger enforced it, so an ordinary campaign literally named
 * "governance" would silently collide with the governance stream. Not
 * exported: the only code that needs this literal is `assertOrdinaryCampaignId`
 * and `recordGovernanceEvent`, both in this file; every other consumer only
 * ever reads it back via `getCampaign`/`getRecords`, which take the
 * campaign id as an ordinary string argument they already control.
 */
const GOVERNANCE_CAMPAIGN_ID = "governance";

/**
 * The reserved-campaign-id guard (ADR-027 Decision point 2). Called
 * unconditionally from every method that accepts a caller-supplied
 * campaign_id — there is no parameter that grants an exception, which is
 * exactly what makes this a guard rather than a flag a caller could simply
 * pass. The ONE authorized way onto `GOVERNANCE_CAMPAIGN_ID` is
 * `recordGovernanceEvent`, whose signature does not accept campaign_id as
 * input at all: the reserved id is supplied internally by that method, never
 * read from caller-provided data, so there is nothing here for an ordinary
 * caller to forge. The separation is structural (which method you can reach),
 * not data-shaped (which fields you set) — a data-shaped check would just be
 * a more elaborate flag.
 */
function assertOrdinaryCampaignId(campaignId: string): void {
  if (!isValidCampaignId(campaignId)) {
    throw new AuditIntegrityError("campaign_id must be a safe campaign identifier");
  }
  if (campaignId === GOVERNANCE_CAMPAIGN_ID) {
    throw new AuditIntegrityError(
      `campaign_id "${GOVERNANCE_CAMPAIGN_ID}" is reserved for ADR-027's governance event stream; `
      + "use EvidenceLedger.recordGovernanceEvent for governance evidence, or choose a different campaign id",
    );
  }
}

/**
 * The evidence ledger is an append-only log of trace packets.
 * It provides formal provenance: every claim can be traced to evidence.
 *
 * Inspired by revoy-spec's audit/ directory and LedgerMind's
 * provenance-constrained state machine.
 */
export class EvidenceLedger {
  private packets: AuditRecord[] = [];
  private nextId = 0;

  /**
   * Record a trace packet. Returns its id.
   *
   * Track D2b: if `packet.idempotency_key` is supplied, a retried call with
   * byte-identical content (ignoring `timestamp`, which legitimately differs
   * across retries) is a detectable no-op that returns the original id — it
   * never creates a second entry and never silently overwrites. A retry
   * under the same key with DIFFERENT content is a loud conflict. Omitting
   * the key preserves the prior behavior exactly (every packet recorded
   * before this field existed had no key, so this is purely additive).
   */
  record(packet: Omit<TracePacket, "id" | "previous_hash" | "content_hash">): string {
    assertOrdinaryCampaignId(packet.campaign_id);
    validateTracePacket(packet);
    return this.appendTracePacket(packet);
  }

  /**
   * The one authorized path onto ADR-027's reserved `GOVERNANCE_CAMPAIGN_ID`.
   * campaign_id is deliberately NOT a parameter — it is supplied here, not by
   * the caller — see `assertOrdinaryCampaignId`'s doc comment for why that is
   * what makes this a real guard. Reuses `appendTracePacket` (the same
   * tested hashing/verification/persistence every other trace packet gets)
   * rather than any parallel mechanism, per ADR-027's own rejection of a
   * separate GovernanceLedger class.
   */
  recordGovernanceEvent(packet: Omit<TracePacket, "id" | "previous_hash" | "content_hash" | "campaign_id">): string {
    const governed = { ...packet, campaign_id: GOVERNANCE_CAMPAIGN_ID };
    validateTracePacket(governed);
    return this.appendTracePacket(governed);
  }

  /** The body `record()` used to have directly; factored out so `recordGovernanceEvent` can reuse it past the guard. */
  private appendTracePacket(packet: Omit<TracePacket, "id" | "previous_hash" | "content_hash">): string {
    if (packet.idempotency_key !== undefined) {
      if (typeof packet.idempotency_key !== "string" || packet.idempotency_key.trim().length === 0) {
        throw new AuditIntegrityError("trace packet idempotency_key must be a non-empty string when present");
      }
      const existing = this.packets.find((record): record is TracePacket =>
        isTracePacket(record) && record.campaign_id === packet.campaign_id
        && record.idempotency_key === packet.idempotency_key);
      if (existing) {
        const { kind: _existingKind, id: _existingId, previous_hash: _existingPrev, content_hash: _existingHash, timestamp: _existingTimestamp, ...existingRest } = existing;
        const { timestamp: _timestamp, ...inputRest } = packet;
        if (canonicalJson(existingRest) !== canonicalJson(inputRest)) {
          throw new AuditIntegrityError(`conflicting trace packet for idempotency key ${packet.idempotency_key}`);
        }
        return existing.id;
      }
    }
    const id = `trace_${(++this.nextId).toString(36)}`;
    // Copy at the boundary: callers commonly reuse mutable node gate arrays.
    // The ledger must preserve the evidence observed at record time.
    const previous_hash = latestCampaignHash(this.packets, packet.campaign_id);
    const unhashed = structuredClone({ ...packet, kind: "trace" as const, id, previous_hash });
    const full: TracePacket = {
      ...unhashed,
      content_hash: hashPacket(unhashed),
    };
    this.packets.push(full);
    return id;
  }

  /** Append a standalone checkpoint before changing campaign or tree state. */
  recordGateCheckpoint(input: GateCheckpointInput): string {
    assertOrdinaryCampaignId(input.campaign_id);
    validateGateCheckpoint(input);
    const existing = this.getGateCheckpoints(input.campaign_id).find(
      (checkpoint) => checkpoint.node_id === input.node_id
        && checkpoint.checkpoint.transition === input.transition
        && checkpoint.checkpoint.operation_id === input.operation_id,
    );
    if (existing) {
      if (canonicalJson(existing.checkpoint.gate) !== canonicalJson(input.gate)
        || canonicalJson(existing.checkpoint.failures) !== canonicalJson(input.failures ?? [])
        || canonicalJson(existing.checkpoint.unresolved) !== canonicalJson(input.unresolved ?? [])) {
        throw new AuditIntegrityError(
          `conflicting gate checkpoint for operation ${input.operation_id}`,
        );
      }
      return existing.id;
    }

    const timestamp = input.timestamp ?? new Date().toISOString();
    const id = `trace_${(++this.nextId).toString(36)}`;
    const previous_hash = latestCampaignHash(this.packets, input.campaign_id);
    const unhashed = {
      kind: "gate_checkpoint" as const,
      id,
      campaign_id: input.campaign_id,
      node_id: input.node_id,
      timestamp,
      previous_hash,
      checkpoint: {
        transition: input.transition,
        operation_id: input.operation_id,
        gate: structuredClone(input.gate),
        failures: structuredClone(input.failures ?? []),
        unresolved: structuredClone(input.unresolved ?? []),
      },
    };
    const full: GateCheckpointRecord = { ...unhashed, content_hash: hashPacket(unhashed) };
    this.packets.push(full);
    return id;
  }

  /**
   * Append an ADR-012 recovery decision. It authorizes a future operation but
   * never claims that the operation ran or that its result is terminal.
   */
  recordRecoveryDecision(input: RecoveryDecisionInput): string {
    assertOrdinaryCampaignId(input.campaign_id);
    validateRecoveryDecision(input);
    const existing = this.getRecoveryDecisions(input.campaign_id, input.node_id).find(
      (record) => record.decision.recovery_operation_id === input.recovery_operation_id,
    );
    if (existing) {
      const { timestamp: _timestamp, ...existingDecision } = existing;
      const { campaign_id, node_id, timestamp: _inputTimestamp, ...inputDecision } = input;
      if (canonicalJson({ campaign_id: existing.campaign_id, node_id: existing.node_id, decision: existingDecision.decision })
        !== canonicalJson({ campaign_id, node_id, decision: inputDecision })) {
        throw new AuditIntegrityError(`conflicting recovery decision for operation ${input.recovery_operation_id}`);
      }
      return existing.id;
    }
    const id = `recovery_${(++this.nextId).toString(36)}`;
    const previous_hash = latestCampaignHash(this.packets, input.campaign_id);
    const { campaign_id, node_id, timestamp, ...decision } = input;
    const unhashed = {
      kind: "recovery_decision" as const,
      id,
      campaign_id,
      node_id,
      timestamp: timestamp ?? new Date().toISOString(),
      previous_hash,
      decision: structuredClone(decision),
    };
    const full: RecoveryDecisionRecord = { ...unhashed, content_hash: hashPacket(unhashed) };
    this.packets.push(full);
    return id;
  }

  recordNodeCommunication(input: NodeCommunicationInput): string {
    assertOrdinaryCampaignId(input.campaign_id);
    validateNodeCommunication(input);
    const existing = this.packets.find((record): record is NodeCommunicationRecord => record.kind === "node_communication"
      && record.campaign_id === input.campaign_id
      && record.communication.idempotency_key === input.idempotency_key);
    if (existing) {
      const { campaign_id, node_id, timestamp: _timestamp, ...communication } = input;
      if (canonicalJson({ campaign_id, node_id, communication }) !== canonicalJson({ campaign_id: existing.campaign_id, node_id: existing.node_id, communication: existing.communication })) throw new AuditIntegrityError(`conflicting node communication for idempotency key ${input.idempotency_key}`);
      return existing.id;
    }
    for (const link of [input.acknowledges_communication_id, input.retracts_communication_id]) {
      if (link !== null && !this.packets.some((record) => record.kind === "node_communication" && record.campaign_id === input.campaign_id && record.id === link)) {
        throw new AuditIntegrityError(`node communication references unknown record ${link} in campaign ${input.campaign_id}`);
      }
    }
    const id = `communication_${(++this.nextId).toString(36)}`;
    const { campaign_id, node_id, timestamp, ...communication } = input;
    const unhashed = { kind: "node_communication" as const, id, campaign_id, node_id, timestamp: timestamp ?? new Date().toISOString(), previous_hash: latestCampaignHash(this.packets, campaign_id), communication: structuredClone(communication) };
    this.packets.push({ ...unhashed, content_hash: hashPacket(unhashed) });
    return id;
  }

  recordInterruption(input: InterruptionInput): string {
    assertOrdinaryCampaignId(input.campaign_id);
    validateInterruption(input);
    const existing = this.packets.find((record): record is InterruptionRecord => record.kind === "interruption"
      && record.campaign_id === input.campaign_id && record.interruption.operation_id === input.operation_id
      && record.interruption.phase === input.phase);
    if (existing) {
      const { campaign_id, node_id, timestamp: _timestamp, ...interruption } = input;
      if (canonicalJson({ campaign_id, node_id, interruption }) !== canonicalJson({ campaign_id: existing.campaign_id, node_id: existing.node_id, interruption: existing.interruption })) {
        throw new AuditIntegrityError(`conflicting interruption ${input.phase} for operation ${input.operation_id}`);
      }
      return existing.id;
    }
    if (input.phase !== "requested") {
      const request = this.packets.find((record): record is InterruptionRecord => record.kind === "interruption"
        && record.campaign_id === input.campaign_id && record.id === input.request_record_id
        && record.interruption.operation_id === input.operation_id && record.interruption.phase === "requested");
      if (!request) throw new AuditIntegrityError(`interruption ${input.phase} requires its request record`);
      if (request.interruption.scope !== input.scope || request.node_id !== input.node_id) throw new AuditIntegrityError("interruption acknowledgement conflicts with requested scope");
      if (input.affected_node_ids.some((id) => !request.interruption.affected_node_ids.includes(id))) throw new AuditIntegrityError("interruption follow-up includes nodes outside its request");
      if (input.phase === "state_applied" && !this.packets.some((record) => record.kind === "interruption"
        && record.campaign_id === input.campaign_id && record.interruption.operation_id === input.operation_id
        && record.interruption.phase === "acknowledged" && record.interruption.request_record_id === input.request_record_id)) {
        throw new AuditIntegrityError("interruption state_applied requires a prior acknowledgement");
      }
    }
    for (const evidenceId of input.partial_evidence_ids) {
      if (!this.packets.some((record) => record.campaign_id === input.campaign_id && record.id === evidenceId)) {
        throw new AuditIntegrityError(`interruption partial evidence ${evidenceId} is not prior same-campaign evidence`);
      }
    }
    const id = `interruption_${(++this.nextId).toString(36)}`;
    const { campaign_id, node_id, timestamp, ...interruption } = input;
    const unhashed = { kind: "interruption" as const, id, campaign_id, node_id,
      timestamp: timestamp ?? new Date().toISOString(), previous_hash: latestCampaignHash(this.packets, campaign_id),
      interruption: structuredClone(interruption) };
    this.packets.push({ ...unhashed, content_hash: hashPacket(unhashed) });
    return id;
  }

  /**
   * Append one phase of a fork reopen. Idempotent per (operation, phase); a
   * `reverted` phase requires its `reopened` phase earlier in the same chain.
   */
  recordCampaignReopen(input: CampaignReopenInput): string {
    assertOrdinaryCampaignId(input.campaign_id);
    validateCampaignReopen(input);
    const existing = this.packets.find((record): record is CampaignReopenRecord => record.kind === "campaign_reopen"
      && record.campaign_id === input.campaign_id && record.reopen.operation_id === input.operation_id && record.reopen.phase === input.phase);
    const { campaign_id, node_id, timestamp, ...reopen } = input;
    if (existing) {
      if (canonicalJson({ campaign_id, node_id, reopen }) !== canonicalJson({ campaign_id: existing.campaign_id, node_id: existing.node_id, reopen: existing.reopen })) {
        throw new AuditIntegrityError(`conflicting campaign reopen ${input.phase} for operation ${input.operation_id}`);
      }
      return existing.id;
    }
    if (input.phase === "reverted" && !this.packets.some((record) => record.kind === "campaign_reopen"
      && record.campaign_id === input.campaign_id && record.reopen.operation_id === input.operation_id && record.reopen.phase === "reopened")) {
      throw new AuditIntegrityError(`campaign reopen revert for operation ${input.operation_id} has no reopen record`);
    }
    const id = `reopen_${(++this.nextId).toString(36)}`;
    const unhashed = { kind: "campaign_reopen" as const, id, campaign_id, node_id,
      timestamp: timestamp ?? new Date().toISOString(), previous_hash: latestCampaignHash(this.packets, campaign_id),
      reopen: structuredClone(reopen) };
    this.packets.push({ ...unhashed, content_hash: hashPacket(unhashed) });
    return id;
  }

  /** Fork reopen evidence for one campaign, in append order. */
  getCampaignReopens(campaignId: string): CampaignReopenRecord[] {
    return this.packets.filter((record): record is CampaignReopenRecord => record.kind === "campaign_reopen" && record.campaign_id === campaignId)
      .map((record) => structuredClone(record));
  }

  getInterruptions(campaignId: string, operationId?: string): InterruptionRecord[] {
    return this.packets.filter((record): record is InterruptionRecord => record.kind === "interruption"
      && record.campaign_id === campaignId && (operationId === undefined || record.interruption.operation_id === operationId))
      .map((record) => structuredClone(record));
  }

  /** Journal a fact only after its source evidence is present in the same campaign chain. */
  recordMemoryFact(input: MemoryFactInput): string {
    assertOrdinaryCampaignId(input.campaign_id);
    validateMemoryFact(input);
    validateImportedMemoryLink(input, this.packets);
    const existing = this.packets.find((record): record is MemoryFactRecord => record.kind === "memory_fact"
      && record.campaign_id === input.campaign_id && record.fact.idempotency_key === input.idempotency_key);
    if (existing) {
      const { campaign_id, node_id, timestamp: _timestamp, ...fact } = input;
      if (canonicalJson({ campaign_id, node_id, fact }) !== canonicalJson({ campaign_id: existing.campaign_id, node_id: existing.node_id, fact: existing.fact })) {
        throw new AuditIntegrityError(`conflicting memory fact for idempotency key ${input.idempotency_key}`);
      }
      return existing.id;
    }
    const witness = this.packets.find((record) => record.id === input.source_evidence_id);
    const importedWitness = input.imported_from !== undefined && witness?.campaign_id === input.imported_from.campaign_id;
    if (!witness || (witness.campaign_id !== input.campaign_id && !importedWitness)) {
      throw new AuditIntegrityError(`memory fact source ${input.source_evidence_id} is not witnessed in campaign ${input.campaign_id}`);
    }
    if (input.tier === "specialist_visible" && isRestrictedMemoryWitness(witness)) {
      throw new AuditIntegrityError(`specialist-visible memory fact cannot downgrade restricted witness ${input.source_evidence_id}`);
    }
    const id = `memory_${(++this.nextId).toString(36)}`;
    const { campaign_id, node_id, timestamp, ...fact } = input;
    const unhashed = { kind: "memory_fact" as const, id, campaign_id, node_id,
      timestamp: timestamp ?? new Date().toISOString(), previous_hash: latestCampaignHash(this.packets, campaign_id),
      fact: structuredClone(fact) };
    this.packets.push({ ...unhashed, content_hash: hashPacket(unhashed) });
    return id;
  }

  getMemoryFacts(campaignId: string): MemoryFactRecord[] {
    return this.packets.filter((record): record is MemoryFactRecord => record.kind === "memory_fact"
      && record.campaign_id === campaignId).map((record) => structuredClone(record));
  }

  /** Journal a bounded phase message. A campaign may hold at most PHASE_MESSAGE_MAX_PER_CAMPAIGN. */
  recordPhaseMessage(input: PhaseMessageInput): string {
    assertOrdinaryCampaignId(input.campaign_id);
    validatePhaseMessage(input);
    const campaignMessages = this.packets.filter(
      (record): record is PhaseMessageRecord =>
        record.kind === "phase_message" && record.campaign_id === input.campaign_id,
    );
    const existing = campaignMessages.find(
      (record) => record.message.idempotency_key === input.idempotency_key,
    );
    if (existing) {
      const { campaign_id, node_id, timestamp: _timestamp, ...message } = input;
      if (canonicalJson({ campaign_id, node_id, message }) !== canonicalJson({
        campaign_id: existing.campaign_id, node_id: existing.node_id, message: existing.message,
      })) throw new AuditIntegrityError(`conflicting phase message for idempotency key ${input.idempotency_key}`);
      return existing.id;
    }
    if (campaignMessages.length >= PHASE_MESSAGE_MAX_PER_CAMPAIGN) {
      throw new AuditIntegrityError(
        `campaign ${input.campaign_id} has reached the ${PHASE_MESSAGE_MAX_PER_CAMPAIGN} phase message limit`,
      );
    }
    const id = `phase_${(++this.nextId).toString(36)}`;
    const { campaign_id, node_id, timestamp, ...message } = input;
    const unhashed = {
      kind: "phase_message" as const, id, campaign_id, node_id,
      timestamp: timestamp ?? new Date().toISOString(), previous_hash: latestCampaignHash(this.packets, campaign_id),
      message: structuredClone(message),
    };
    this.packets.push({ ...unhashed, content_hash: hashPacket(unhashed) });
    return id;
  }

  getPhaseMessages(campaignId: string, options: { node_id?: string; phase?: PhaseMessageKind; limit?: number } = {}): PhaseMessageRecord[] {
    const limit = options.limit ?? PHASE_MESSAGE_MAX_PER_CAMPAIGN;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > PHASE_MESSAGE_MAX_PER_CAMPAIGN) {
      throw new AuditIntegrityError(`phase message query limit must be from 1 to ${PHASE_MESSAGE_MAX_PER_CAMPAIGN}`);
    }
    return this.packets.filter((record): record is PhaseMessageRecord =>
      record.kind === "phase_message" && record.campaign_id === campaignId
      && (options.node_id === undefined || record.node_id === options.node_id)
      && (options.phase === undefined || record.message.phase === options.phase))
      .slice(-limit).map((record) => structuredClone(record));
  }

  /** Journal a compaction lifecycle record after its pre-evidence anchor. */
  recordCompactionLifecycle(input: CompactionLifecycleInput): string {
    assertOrdinaryCampaignId(input.campaign_id);
    validateCompactionLifecycle(input);
    const existing = this.packets.find((record): record is CompactionLifecycleRecord =>
      record.kind === "compaction_lifecycle" && record.campaign_id === input.campaign_id
      && record.lifecycle.idempotency_key === input.idempotency_key);
    if (existing) {
      const { campaign_id, node_id, timestamp: _timestamp, ...lifecycle } = input;
      if (canonicalJson({ campaign_id, node_id, lifecycle }) !== canonicalJson({
        campaign_id: existing.campaign_id, node_id: existing.node_id, lifecycle: existing.lifecycle,
      })) throw new AuditIntegrityError(`idempotency conflict for compaction lifecycle ${input.idempotency_key}`);
      return existing.id;
    }
    const id = `compaction_${(++this.nextId).toString(36)}`;
    const { campaign_id, node_id, timestamp, ...lifecycle } = input;
    const unhashed = {
      kind: "compaction_lifecycle" as const, id, campaign_id, node_id,
      timestamp: timestamp ?? new Date().toISOString(), previous_hash: latestCampaignHash(this.packets, campaign_id),
      lifecycle: structuredClone(lifecycle),
    };
    this.packets.push({ ...unhashed, content_hash: hashPacket(unhashed) });
    return id;
  }

  getCompactionLifecycles(campaignId: string, nodeId?: string, options: { as_of?: string; limit?: number } = {}): CompactionLifecycleRecord[] {
    const limit = options.limit ?? 100;
    if (!Number.isSafeInteger(limit) || limit < 1) throw new AuditIntegrityError("compaction lifecycle query limit must be positive");
    const asOf = options.as_of === undefined ? null : Date.parse(options.as_of);
    if (options.as_of !== undefined && Number.isNaN(asOf)) throw new AuditIntegrityError("compaction lifecycle as_of must be ISO-parseable");
    return this.packets.filter((record): record is CompactionLifecycleRecord =>
      record.kind === "compaction_lifecycle" && record.campaign_id === campaignId
      && (nodeId === undefined || record.node_id === nodeId)
      && (asOf === null || Date.parse(record.lifecycle.as_of) <= asOf))
      .slice(-limit).map((record) => structuredClone(record));
  }

  /**
   * Journal a RequestUserInput transition (ADR-019) — evidence before the loop
   * may stall (Commandment II). Idempotent on idempotency_key; a different
   * payload under the same key conflicts loudly.
   */
  recordRequestUserInput(input: RequestUserInputInput): string {
    assertOrdinaryCampaignId(input.campaign_id);
    validateRequestUserInput(input);
    const existing = this.packets.find((record): record is RequestUserInputRecord =>
      record.kind === "request_user_input" && record.campaign_id === input.campaign_id
      && record.question.idempotency_key === input.idempotency_key);
    if (existing) {
      const { campaign_id, node_id, timestamp: _timestamp, ...question } = input;
      if (canonicalJson({ campaign_id, node_id, question }) !== canonicalJson({
        campaign_id: existing.campaign_id, node_id: existing.node_id, question: existing.question,
      })) throw new AuditIntegrityError(`idempotency conflict for request_user_input ${input.idempotency_key}`);
      return existing.id;
    }
    const id = `userinput_${(++this.nextId).toString(36)}`;
    const { campaign_id, node_id, timestamp, ...question } = input;
    const unhashed = {
      kind: "request_user_input" as const, id, campaign_id, node_id,
      timestamp: timestamp ?? new Date().toISOString(), previous_hash: latestCampaignHash(this.packets, campaign_id),
      question: structuredClone(question), answer: null, status: "awaiting" as const,
    };
    this.packets.push({ ...unhashed, content_hash: hashPacket(unhashed) });
    return id;
  }

  getRequestUserInputs(campaignId: string, nodeId?: string, options: { limit?: number } = {}): RequestUserInputRecord[] {
    const limit = options.limit ?? 100;
    if (!Number.isSafeInteger(limit) || limit < 1) throw new AuditIntegrityError("request_user_input query limit must be positive");
    return this.packets.filter((record): record is RequestUserInputRecord =>
      record.kind === "request_user_input" && record.campaign_id === campaignId
      && (nodeId === undefined || record.node_id === nodeId))
      .slice(-limit).map((record) => structuredClone(record));
  }

  /** PURE reconciliation: is this campaign/node awaiting an unanswered interview? */
  /**
   * Ids of this campaign's questions that have an answer record.
   *
   * A `RequestUserInputRecord`'s own `status`/`answer` fields are frozen at
   * creation — ADR-019 appends the answer as a SEPARATE record rather than
   * mutating a hash-covered packet, so an answered question still reads
   * `status: "awaiting"`, `answer: null`, forever and by design. Anything that
   * needs the current state must reconcile against the answer stream, and this
   * is the one place that reconciliation lives: `awaitingUserInput` collapses
   * it to a boolean, and `userinput.list` surfaces it per question so a
   * consumer can tell an answered interview from a pending one without
   * rewriting fields the ledger hashed.
   */
  answeredQuestionIds(campaignId: string, nodeId?: string): string[] {
    const questions = this.packets.filter((record): record is RequestUserInputRecord =>
      record.kind === "request_user_input" && record.campaign_id === campaignId
      && (nodeId === undefined || record.node_id === nodeId));
    const answered = new Set(this.packets
      .filter((record): record is UserInputAnswerRecord =>
        record.kind === "user_input_answer" && record.campaign_id === campaignId)
      .map((record) => record.question_record_id));
    return questions.filter((question) => answered.has(question.id)).map((question) => question.id);
  }

  /**
   * Is the loop blocked on an unanswered interview? By default only questions
   * whose `blocking` is `"blocking"` count: an `"async"` question (the native
   * `userinput.ask` tool, "post and keep working") is durable and visible but
   * must not stop selection of the next node -- before this, every open
   * question halted the loop regardless of `blocking`, which made the async
   * mode a lie. `scope: "any"` is the operator-facing view (is anything
   * unanswered at all).
   */
  awaitingUserInput(campaignId: string, nodeId?: string, scope: "blocking" | "any" = "blocking"): boolean {
    const questions = this.packets.filter((record): record is RequestUserInputRecord =>
      record.kind === "request_user_input" && record.campaign_id === campaignId
      && (nodeId === undefined || record.node_id === nodeId)
      && (scope === "any" || record.question.blocking === "blocking"));
    if (questions.length === 0) return false;
    // Same reconciliation as answeredQuestionIds, deliberately shared: two
    // independent implementations of "is this answered" is how the projections
    // came to disagree in the first place.
    const answered = new Set(this.answeredQuestionIds(campaignId, nodeId));
    return questions.some((question) => !answered.has(question.id));
  }

  /**
   * Append the human's answer as its own ledger record (ADR-019 approve-from-
   * ledger / append-only integrity). Never mutates an already-persisted question
   * packet. References an existing question record.
   */
  recordUserInputAnswer(input: UserInputAnswerInput): string {
    assertOrdinaryCampaignId(input.campaign_id);
    validateUserInputAnswer(input.answer);
    const question = this.packets.find((record): record is RequestUserInputRecord =>
      record.kind === "request_user_input" && record.id === input.question_record_id
      && record.campaign_id === input.campaign_id);
    if (!question) throw new AuditIntegrityError(`request_user_input ${input.question_record_id} not found in campaign ${input.campaign_id}`);
    assertUserInputAnswerMatchesQuestion(question, input.node_id, input.answer);
    const existing = this.packets.find((record): record is UserInputAnswerRecord =>
      record.kind === "user_input_answer" && record.campaign_id === input.campaign_id
      && record.question_record_id === input.question_record_id);
    if (existing) {
      if (canonicalJson(existing.answer) !== canonicalJson(input.answer)) {
        throw new AuditIntegrityError(`conflicting user input answer for question ${input.question_record_id}`);
      }
      return existing.id;
    }
    const id = `useranswer_${(++this.nextId).toString(36)}`;
    const unhashed = {
      kind: "user_input_answer" as const, id, campaign_id: input.campaign_id, node_id: input.node_id,
      timestamp: input.timestamp ?? new Date().toISOString(), previous_hash: latestCampaignHash(this.packets, input.campaign_id),
      question_record_id: input.question_record_id, answer: structuredClone(input.answer),
    };
    this.packets.push({ ...unhashed, content_hash: hashPacket(unhashed) });
    return id;
  }

  getUserInputAnswers(campaignId: string, questionRecordId?: string): UserInputAnswerRecord[] {
    return this.packets.filter((record): record is UserInputAnswerRecord =>
      record.kind === "user_input_answer" && record.campaign_id === campaignId
      && (questionRecordId === undefined || record.question_record_id === questionRecordId))
      .map((record) => structuredClone(record));
  }

  /**
   * Journal a direct-tier waiver outcome (E-8). Idempotent on
   * `idempotency_key` — `manager.ts` derives it stably from the node's
   * result operation id, so a retried `recordResult` call never mints a
   * second record for the same waived node.
   */
  recordWaiverOutcome(input: WaiverOutcomeInput): string {
    assertOrdinaryCampaignId(input.campaign_id);
    validateWaiverOutcome(input);
    const existing = this.packets.find((record): record is WaiverOutcomeRecord => record.kind === "waiver_outcome"
      && record.campaign_id === input.campaign_id && record.outcome.idempotency_key === input.idempotency_key);
    if (existing) {
      const { campaign_id, node_id, timestamp: _timestamp, ...outcome } = input;
      if (canonicalJson({ campaign_id, node_id, outcome }) !== canonicalJson({
        campaign_id: existing.campaign_id, node_id: existing.node_id, outcome: existing.outcome,
      })) throw new AuditIntegrityError(`conflicting waiver outcome for idempotency key ${input.idempotency_key}`);
      return existing.id;
    }
    const id = `waiver_${(++this.nextId).toString(36)}`;
    const { campaign_id, node_id, timestamp, ...outcome } = input;
    const unhashed = {
      kind: "waiver_outcome" as const, id, campaign_id, node_id,
      timestamp: timestamp ?? new Date().toISOString(), previous_hash: latestCampaignHash(this.packets, campaign_id),
      outcome: structuredClone(outcome),
    };
    this.packets.push({ ...unhashed, content_hash: hashPacket(unhashed) });
    return id;
  }

  getWaiverOutcomes(campaignId: string): WaiverOutcomeRecord[] {
    return this.packets.filter((record): record is WaiverOutcomeRecord => record.kind === "waiver_outcome" && record.campaign_id === campaignId)
      .map((record) => structuredClone(record));
  }

  /**
   * Append a post-hoc determination against an existing waiver outcome
   * record. This is the "documented API for future feedback loops" the
   * roadmap calls for: nothing in this cycle calls it automatically for
   * `later_failed` (policy auto-adjustment is out of scope) — `manager.ts`
   * exposes it as `recordWaiverOutcomeFollowUp` for an operator or a future
   * cycle's feedback loop to call explicitly. `adopted` IS wired this cycle,
   * from `arbor adopt`'s success path.
   */
  recordWaiverOutcomeAmendment(input: WaiverOutcomeAmendmentInput): string {
    assertOrdinaryCampaignId(input.campaign_id);
    validateWaiverOutcomeAmendment(input);
    const target = this.packets.find((record): record is WaiverOutcomeRecord => record.kind === "waiver_outcome"
      && record.campaign_id === input.campaign_id && record.id === input.waiver_record_id);
    if (!target) {
      throw new AuditIntegrityError(`waiver outcome amendment references unknown waiver record ${input.waiver_record_id} in campaign ${input.campaign_id}`);
    }
    if (target.node_id !== input.node_id) {
      throw new AuditIntegrityError(`waiver outcome amendment node ${input.node_id} does not match its waiver record's node ${target.node_id}`);
    }
    const existing = this.packets.find((record): record is WaiverOutcomeAmendmentRecord => record.kind === "waiver_outcome_amendment"
      && record.campaign_id === input.campaign_id && record.amendment.idempotency_key === input.idempotency_key);
    if (existing) {
      const { campaign_id, node_id, timestamp: _timestamp, ...amendment } = input;
      if (canonicalJson({ campaign_id, node_id, amendment }) !== canonicalJson({
        campaign_id: existing.campaign_id, node_id: existing.node_id, amendment: existing.amendment,
      })) throw new AuditIntegrityError(`conflicting waiver outcome amendment for idempotency key ${input.idempotency_key}`);
      return existing.id;
    }
    const id = `waiveramend_${(++this.nextId).toString(36)}`;
    const { campaign_id, node_id, timestamp, ...amendment } = input;
    const unhashed = {
      kind: "waiver_outcome_amendment" as const, id, campaign_id, node_id,
      timestamp: timestamp ?? new Date().toISOString(), previous_hash: latestCampaignHash(this.packets, campaign_id),
      amendment: structuredClone(amendment),
    };
    this.packets.push({ ...unhashed, content_hash: hashPacket(unhashed) });
    return id;
  }

  getWaiverOutcomeAmendments(campaignId: string, waiverRecordId?: string): WaiverOutcomeAmendmentRecord[] {
    return this.packets.filter((record): record is WaiverOutcomeAmendmentRecord => record.kind === "waiver_outcome_amendment"
      && record.campaign_id === campaignId && (waiverRecordId === undefined || record.amendment.waiver_record_id === waiverRecordId))
      .map((record) => structuredClone(record));
  }

  /** Fold every waiver outcome for a campaign with its latest amendments — the read-side view. */
  getFoldedWaiverOutcomes(campaignId: string): FoldedWaiverOutcome[] {
    return this.getWaiverOutcomes(campaignId).map((record) => {
      const amendments = this.getWaiverOutcomeAmendments(campaignId, record.id);
      const adopted = amendments.filter((a) => a.amendment.kind === "adopted").at(-1)?.amendment.value ?? false;
      const laterFailed = amendments.filter((a) => a.amendment.kind === "later_failed").at(-1)?.amendment.value ?? null;
      return { record, adopted, later_failed: laterFailed };
    });
  }

  /**
   * Y-1: journal one write-scope check's outcome. Idempotent on
   * `idempotency_key` — the caller derives it stably from the node's result
   * operation id (mirroring `recordWaiverOutcome`), so a retried journal
   * call never mints a second record for the same observation.
   */
  recordScopeObservation(input: ScopeObservationInput): string {
    assertOrdinaryCampaignId(input.campaign_id);
    validateScopeObservation(input);
    const existing = this.packets.find((record): record is ScopeObservationRecord => record.kind === "scope_observation"
      && record.campaign_id === input.campaign_id && record.observation.idempotency_key === input.idempotency_key);
    if (existing) {
      const { campaign_id, node_id, timestamp: _timestamp, ...observation } = input;
      if (canonicalJson({ campaign_id, node_id, observation }) !== canonicalJson({
        campaign_id: existing.campaign_id, node_id: existing.node_id, observation: existing.observation,
      })) throw new AuditIntegrityError(`conflicting scope observation for idempotency key ${input.idempotency_key}`);
      return existing.id;
    }
    // Y-2: fold a repeat whose out-of-scope path set is already covered by
    // an existing journaled observation in the same lineage (`lineage_root`,
    // defaulting to `node_id`) into a `folded` amendment instead of
    // appending a duplicate `ScopeObservationRecord`. Only the FIRST such
    // covering record is folded onto -- deterministic (append order), and
    // exactly mirrors how a repeat waiver amendment targets one waiver
    // record, never a chain of them.
    // Folding requires the SAME enforcement tier too: an "audit" observation
    // and a "blocked" observation over the identical path set are different
    // classes of event (a mined guess versus an authored hard violation) --
    // silently merging them would both corrupt the read-side `enforcement`
    // view and defeat `hasBlockedScopePrecedent`'s escalation query, which
    // depends on a genuine `"blocked"` record existing in its own right.
    const lineageRoot = input.lineage_root ?? input.node_id;
    const observedOutOfScope = new Set(input.observed_out_of_scope);
    const foldTarget = this.packets.find((record): record is ScopeObservationRecord => record.kind === "scope_observation"
      && record.campaign_id === input.campaign_id
      && record.observation.enforcement === input.enforcement
      && (record.observation.lineage_root ?? record.node_id) === lineageRoot
      && [...observedOutOfScope].every((path) => record.observation.observed_out_of_scope.includes(path)));
    if (foldTarget) {
      this.recordScopeObservationAmendment({
        campaign_id: input.campaign_id, node_id: input.node_id,
        scope_observation_record_id: foldTarget.id, kind: "folded",
        idempotency_key: input.idempotency_key,
      });
      return foldTarget.id;
    }
    const id = `scopeobs_${(++this.nextId).toString(36)}`;
    const { campaign_id, node_id, timestamp, ...observation } = input;
    const unhashed = {
      kind: "scope_observation" as const, id, campaign_id, node_id,
      timestamp: timestamp ?? new Date().toISOString(), previous_hash: latestCampaignHash(this.packets, campaign_id),
      observation: structuredClone(observation),
    };
    this.packets.push({ ...unhashed, content_hash: hashPacket(unhashed) });
    return id;
  }

  getScopeObservations(campaignId: string): ScopeObservationRecord[] {
    return this.packets.filter((record): record is ScopeObservationRecord => record.kind === "scope_observation" && record.campaign_id === campaignId)
      .map((record) => structuredClone(record));
  }

  /**
   * Y-2: append a `folded` amendment against an existing scope observation.
   * Idempotent on `idempotency_key`, mirroring `recordWaiverOutcomeAmendment`.
   * `recordScopeObservation` is the only production caller; exposed
   * separately so a test can exercise the fold record shape directly.
   */
  recordScopeObservationAmendment(input: ScopeObservationAmendmentInput): string {
    assertOrdinaryCampaignId(input.campaign_id);
    validateScopeObservationAmendment(input);
    const target = this.packets.find((record): record is ScopeObservationRecord => record.kind === "scope_observation"
      && record.campaign_id === input.campaign_id && record.id === input.scope_observation_record_id);
    if (!target) {
      throw new AuditIntegrityError(`scope observation amendment references unknown scope observation record ${input.scope_observation_record_id} in campaign ${input.campaign_id}`);
    }
    const existing = this.packets.find((record): record is ScopeObservationAmendmentRecord => record.kind === "scope_observation_amendment"
      && record.campaign_id === input.campaign_id && record.amendment.idempotency_key === input.idempotency_key);
    if (existing) {
      const { campaign_id, node_id, timestamp: _timestamp, ...amendment } = input;
      if (canonicalJson({ campaign_id, node_id, amendment }) !== canonicalJson({
        campaign_id: existing.campaign_id, node_id: existing.node_id, amendment: existing.amendment,
      })) throw new AuditIntegrityError(`conflicting scope observation amendment for idempotency key ${input.idempotency_key}`);
      return existing.id;
    }
    const id = `scopeobsamend_${(++this.nextId).toString(36)}`;
    const { campaign_id, node_id, timestamp, ...amendment } = input;
    const unhashed = {
      kind: "scope_observation_amendment" as const, id, campaign_id, node_id,
      timestamp: timestamp ?? new Date().toISOString(), previous_hash: latestCampaignHash(this.packets, campaign_id),
      amendment: structuredClone(amendment),
    };
    this.packets.push({ ...unhashed, content_hash: hashPacket(unhashed) });
    return id;
  }

  getScopeObservationAmendments(campaignId: string, scopeObservationRecordId?: string): ScopeObservationAmendmentRecord[] {
    return this.packets.filter((record): record is ScopeObservationAmendmentRecord => record.kind === "scope_observation_amendment"
      && record.campaign_id === campaignId && (scopeObservationRecordId === undefined || record.amendment.scope_observation_record_id === scopeObservationRecordId))
      .map((record) => structuredClone(record));
  }

  /** Y-2: every scope observation for a campaign, folded with its later-repeat counts -- the read-side view. */
  getFoldedScopeObservations(campaignId: string): FoldedScopeObservation[] {
    return this.getScopeObservations(campaignId).map((record) => ({
      record, folded_count: 1 + this.getScopeObservationAmendments(campaignId, record.id).length,
    }));
  }

  /**
   * ADR-119 O3: journal one scope-intent bind. Idempotent on
   * `idempotency_key`, mirroring `recordScopeObservation` exactly: a retried
   * journal call for the same bind never mints a second record, and a
   * conflicting retry (same key, different bind facts) is refused rather
   * than silently accepted.
   */
  recordScopeIntentBind(input: ScopeIntentBindInput): string {
    assertOrdinaryCampaignId(input.campaign_id);
    validateScopeIntentBind(input);
    const existing = this.packets.find((record): record is ScopeIntentBindRecord => record.kind === "scope_intent_bind"
      && record.campaign_id === input.campaign_id && record.bind.idempotency_key === input.idempotency_key);
    if (existing) {
      const { campaign_id, node_id, timestamp: _timestamp, ...bind } = input;
      if (canonicalJson({ campaign_id, node_id, bind }) !== canonicalJson({
        campaign_id: existing.campaign_id, node_id: existing.node_id, bind: existing.bind,
      })) throw new AuditIntegrityError(`conflicting scope intent bind for idempotency key ${input.idempotency_key}`);
      return existing.id;
    }
    const id = `scopeintentbind_${(++this.nextId).toString(36)}`;
    const { campaign_id, node_id, timestamp, ...bind } = input;
    const unhashed = {
      kind: "scope_intent_bind" as const, id, campaign_id, node_id,
      timestamp: timestamp ?? new Date().toISOString(), previous_hash: latestCampaignHash(this.packets, campaign_id),
      bind: structuredClone(bind),
    };
    this.packets.push({ ...unhashed, content_hash: hashPacket(unhashed) });
    return id;
  }

  getScopeIntentBinds(campaignId: string, nodeId?: string): ScopeIntentBindRecord[] {
    return this.packets.filter((record): record is ScopeIntentBindRecord => record.kind === "scope_intent_bind"
      && record.campaign_id === campaignId && (nodeId === undefined || record.node_id === nodeId))
      .map((record) => structuredClone(record));
  }

  /**
   * Y-1 (ADR-068): journal one durable advisory finding. Idempotent on
   * `idempotency_key`, witnessed by `source_evidence_id` exactly like
   * `recordTelemetryObservation` -- a caller cannot mint advisory evidence
   * that predates the evidence it advises about.
   */
  recordAdvisoryEvidence(input: AdvisoryEvidenceInput): string {
    assertOrdinaryCampaignId(input.campaign_id);
    validateAdvisoryEvidence(input);
    const { value: payload, truncated: payloadTruncated } = truncateUtf8Bytes(input.payload, ADVISORY_EVIDENCE_MAX_PAYLOAD_BYTES);
    const evidence: AdvisoryEvidence = {
      generator: input.generator,
      activity: input.activity,
      payload,
      payload_truncated: payloadTruncated,
      source_evidence_id: input.source_evidence_id,
      idempotency_key: input.idempotency_key,
    };
    const existing = this.packets.find((record): record is AdvisoryEvidenceRecord => record.kind === "advisory_evidence"
      && record.campaign_id === input.campaign_id && record.evidence.idempotency_key === input.idempotency_key);
    if (existing) {
      if (canonicalJson({ campaign_id: input.campaign_id, node_id: input.node_id, evidence })
        !== canonicalJson({ campaign_id: existing.campaign_id, node_id: existing.node_id, evidence: existing.evidence })) {
        throw new AuditIntegrityError(`conflicting advisory evidence for idempotency key ${input.idempotency_key}`);
      }
      return existing.id;
    }
    const witness = this.packets.find((record) => record.campaign_id === input.campaign_id
      && record.id === input.source_evidence_id);
    if (!witness) throw new AuditIntegrityError(`advisory evidence source ${input.source_evidence_id} is not prior evidence in campaign ${input.campaign_id}`);
    const id = `advisory_${(++this.nextId).toString(36)}`;
    const unhashed = {
      kind: "advisory_evidence" as const, id, campaign_id: input.campaign_id, node_id: input.node_id,
      timestamp: input.timestamp ?? new Date().toISOString(), previous_hash: latestCampaignHash(this.packets, input.campaign_id),
      evidence: structuredClone(evidence),
    };
    this.packets.push({ ...unhashed, content_hash: hashPacket(unhashed) });
    return id;
  }

  getAdvisoryEvidence(campaignId: string): AdvisoryEvidenceRecord[] {
    return this.packets.filter((record): record is AdvisoryEvidenceRecord => record.kind === "advisory_evidence" && record.campaign_id === campaignId)
      .map((record) => structuredClone(record));
  }

  /**
   * This campaign's current ledger tip content hash (or null when the
   * campaign has no records yet) -- the exact value a caller must sign as
   * `previous_record_content_hash` for a `recordScopeDecision` call to
   * succeed. Exposed so `manager.ts` can build a signature over the real
   * tip without duplicating `latestCampaignHash`'s scan logic.
   */
  getLedgerTip(campaignId: string): string | null {
    return latestCampaignHash(this.packets, campaignId);
  }

  /**
   * Y (ADR-070): journal one signed scope-decision hop. Idempotent on
   * `idempotency_key`, mirroring every other journal method in this class.
   * Validates, IN ORDER: shape/bounds (`validateScopeDecision`), that
   * `previous_record_content_hash` matches this campaign's ACTUAL current
   * tip (refusing a signature signed over a stale tip -- the race guard),
   * that `parent_decision_id` resolves to a prior `scope_decision` in the
   * same campaign (or is null, starting a fresh generation), that a non-null
   * parent's `public_key` matches this hop's (the generation-membership
   * check), and finally the Ed25519 signature itself
   * (`verifyScopeDecisionSignature`). Any failure is a loud
   * `AuditIntegrityError` -- there is no path that journals an unverified
   * hop.
   */
  recordScopeDecision(input: ScopeDecisionInput): string {
    assertOrdinaryCampaignId(input.campaign_id);
    validateScopeDecision(input);
    const existing = this.packets.find((record): record is ScopeDecisionRecord => record.kind === "scope_decision"
      && record.campaign_id === input.campaign_id && record.decision.idempotency_key === input.idempotency_key);
    if (existing) {
      const { campaign_id, node_id, timestamp: _timestamp, previous_record_content_hash: _prev, ...decision } = input;
      // Paths are order-independent by design (scopeDecisionSigningPayload
      // sorts them before signing, and they are persisted sorted below) --
      // compare sorted here too, or a byte-identical retry whose caller
      // happened to build the array in a different order is rejected as a
      // false conflict instead of recognized as the same decision.
      if (canonicalJson({ campaign_id, node_id, decision: { ...decision, paths: [...decision.paths].sort() } }) !== canonicalJson({
        campaign_id: existing.campaign_id, node_id: existing.node_id, decision: existing.decision,
      })) throw new AuditIntegrityError(`conflicting scope decision for idempotency key ${input.idempotency_key}`);
      return existing.id;
    }
    const actualTip = latestCampaignHash(this.packets, input.campaign_id);
    if (input.previous_record_content_hash !== actualTip) {
      throw new AuditIntegrityError(
        `scope decision was signed against a stale ledger tip for campaign ${input.campaign_id} `
        + "(the tip moved since signing) -- resign against the current tip and retry",
      );
    }
    let parent: ScopeDecisionRecord | null = null;
    if (input.parent_decision_id !== null) {
      parent = this.packets.find((record): record is ScopeDecisionRecord => record.kind === "scope_decision"
        && record.campaign_id === input.campaign_id && record.id === input.parent_decision_id) ?? null;
      if (!parent) {
        throw new AuditIntegrityError(`scope decision parent_decision_id ${input.parent_decision_id} does not resolve in campaign ${input.campaign_id}`);
      }
      if (parent.decision.public_key !== input.public_key) {
        throw new AuditIntegrityError(
          `scope decision public_key does not match its parent hop's generation key in campaign ${input.campaign_id}`,
        );
      }
    }
    const sortedPaths = [...input.paths].sort();
    const signaturePayload = scopeDecisionSigningPayload({
      campaign_id: input.campaign_id, node_id: input.node_id, paths: sortedPaths,
      decision: input.decision, parent_decision_id: input.parent_decision_id,
      previous_record_content_hash: actualTip,
    });
    if (!verifyEd25519Signature(signaturePayload, input.public_key, input.signature)) {
      throw new AuditIntegrityError(`scope decision signature is invalid for campaign ${input.campaign_id}`);
    }
    const id = `scopedec_${(++this.nextId).toString(36)}`;
    const { campaign_id, node_id, timestamp, previous_record_content_hash: _prev, paths: _paths, ...rest } = input;
    const unhashed = {
      kind: "scope_decision" as const, id, campaign_id, node_id,
      timestamp: timestamp ?? new Date().toISOString(), previous_hash: actualTip,
      decision: structuredClone({ ...rest, paths: sortedPaths }),
    };
    this.packets.push({ ...unhashed, content_hash: hashPacket(unhashed) });
    return id;
  }

  getScopeDecisions(campaignId: string): ScopeDecisionRecord[] {
    return this.packets.filter((record): record is ScopeDecisionRecord => record.kind === "scope_decision" && record.campaign_id === campaignId)
      .map((record) => structuredClone(record));
  }

  /** Journal a bounded metric observation after its source evidence is durable. */
  recordTelemetryObservation(input: TelemetryObservationInput): string {
    assertOrdinaryCampaignId(input.campaign_id);
    validateTelemetryObservation(input);
    const existing = this.packets.find((record): record is TelemetryObservationRecord =>
      record.kind === "telemetry_observation" && record.campaign_id === input.campaign_id
      && record.observation.idempotency_key === input.idempotency_key);
    if (existing) {
      const { campaign_id, node_id, timestamp: _timestamp, ...observation } = input;
      if (canonicalJson({ campaign_id, node_id, observation }) !== canonicalJson({
        campaign_id: existing.campaign_id, node_id: existing.node_id, observation: existing.observation,
      })) throw new AuditIntegrityError(`conflicting telemetry observation for idempotency key ${input.idempotency_key}`);
      return existing.id;
    }
    const witness = this.packets.find((record) => record.campaign_id === input.campaign_id
      && record.id === input.source_evidence_id);
    if (!witness) throw new AuditIntegrityError(`telemetry source ${input.source_evidence_id} is not prior evidence in campaign ${input.campaign_id}`);
    const id = `telemetry_${(++this.nextId).toString(36)}`;
    const { campaign_id, node_id, timestamp, ...observation } = input;
    const unhashed = { kind: "telemetry_observation" as const, id, campaign_id, node_id,
      timestamp: timestamp ?? new Date().toISOString(), previous_hash: latestCampaignHash(this.packets, campaign_id),
      observation: structuredClone(observation) };
    this.packets.push({ ...unhashed, content_hash: hashPacket(unhashed) });
    return id;
  }

  getTelemetryObservations(campaignId: string, limit = 1_000): TelemetryObservationRecord[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000) {
      throw new AuditIntegrityError("telemetry query limit must be from 1 to 10000");
    }
    return this.packets.filter((record): record is TelemetryObservationRecord =>
      record.kind === "telemetry_observation" && record.campaign_id === campaignId)
      .slice(-limit).map((record) => structuredClone(record));
  }

  recordTerminalProfile(input: TerminalProfileInput): string {
    assertOrdinaryCampaignId(input.campaign_id);
    validateTerminalProfile(input);
    const existing = this.packets.find((record): record is TerminalProfileRecord => record.kind === "terminal_profile"
      && record.campaign_id === input.campaign_id && record.profile.idempotency_key === input.idempotency_key);
    if (existing) {
      const { campaign_id, node_id, timestamp: _timestamp, ...profile } = input;
      if (canonicalJson({ campaign_id, node_id, profile }) !== canonicalJson({ campaign_id: existing.campaign_id, node_id: existing.node_id, profile: existing.profile })) {
        throw new AuditIntegrityError(`conflicting terminal profile for idempotency key ${input.idempotency_key}`);
      }
      return existing.id;
    }
    const id = `terminal_${(++this.nextId).toString(36)}`;
    const { campaign_id, node_id, timestamp, ...profile } = input;
    const unhashed = { kind: "terminal_profile" as const, id, campaign_id, node_id,
      timestamp: timestamp ?? new Date().toISOString(), previous_hash: latestCampaignHash(this.packets, campaign_id), profile: structuredClone(profile) };
    this.packets.push({ ...unhashed, content_hash: hashPacket(unhashed) });
    return id;
  }

  getTerminalProfiles(campaignId: string): TerminalProfileRecord[] {
    return this.packets.filter((record): record is TerminalProfileRecord => record.kind === "terminal_profile" && record.campaign_id === campaignId)
      .map((record) => structuredClone(record));
  }

  recordTerminalNotification(input: TerminalNotificationInput): string {
    assertOrdinaryCampaignId(input.campaign_id);
    validateTerminalNotification(input);
    const existing = this.packets.find((record): record is TerminalNotificationRecord => record.kind === "terminal_notification"
      && record.campaign_id === input.campaign_id && record.notification.idempotency_key === input.idempotency_key);
    if (existing) {
      const { campaign_id, node_id, timestamp: _timestamp, ...notification } = input;
      if (canonicalJson({ campaign_id, node_id, notification }) !== canonicalJson({ campaign_id: existing.campaign_id, node_id: existing.node_id, notification: existing.notification })) {
        throw new AuditIntegrityError(`conflicting terminal notification for idempotency key ${input.idempotency_key}`);
      }
      return existing.id;
    }
    const id = `notification_${(++this.nextId).toString(36)}`;
    const { campaign_id, node_id, timestamp, ...notification } = input;
    const unhashed = { kind: "terminal_notification" as const, id, campaign_id, node_id,
      timestamp: timestamp ?? new Date().toISOString(), previous_hash: latestCampaignHash(this.packets, campaign_id), notification: structuredClone(notification) };
    this.packets.push({ ...unhashed, content_hash: hashPacket(unhashed) });
    return id;
  }

  getTerminalNotifications(campaignId: string): TerminalNotificationRecord[] {
    return this.packets.filter((record): record is TerminalNotificationRecord => record.kind === "terminal_notification" && record.campaign_id === campaignId)
      .map((record) => structuredClone(record));
  }

  getNodeCommunications(campaignId: string, nodeId: string, options: { tier?: NodeCommunication["capability_tier"]; limit?: number } = {}): NodeCommunicationRecord[] {
    const limit = options.limit ?? 100;
    if (!Number.isSafeInteger(limit) || limit < 1) throw new AuditIntegrityError("communication query limit must be positive");
    return this.packets.filter((record): record is NodeCommunicationRecord => record.kind === "node_communication" && record.campaign_id === campaignId
      && (record.communication.author_node_id === nodeId || record.communication.recipient_node_id === nodeId || record.communication.other_recipient_node_ids.includes(nodeId))
      && (options.tier === undefined || canReadCommunication(options.tier, record.communication.capability_tier))).slice(-limit).map((record) => structuredClone(record));
  }


  /** Return durable gate checkpoints in ledger order for replay/reconciliation. */
  getGateCheckpoints(campaignId: string): GateCheckpointRecord[] {
    return this.packets.filter(
      (packet): packet is GateCheckpointRecord => packet.campaign_id === campaignId
        && packet.kind === "gate_checkpoint",
    ).map((packet) => structuredClone(packet));
  }

  /** Return recovery authority evidence in append order, optionally for one node. */
  getRecoveryDecisions(campaignId: string, nodeId?: string): RecoveryDecisionRecord[] {
    return this.packets.filter(
      (packet): packet is RecoveryDecisionRecord => packet.campaign_id === campaignId
        && packet.kind === "recovery_decision" && (nodeId === undefined || packet.node_id === nodeId),
    ).map((packet) => structuredClone(packet));
  }


  /**
   * Require a previously-recorded checkpoint before recording the observable
   * state transition. Managers should use this method rather than `record`
   * for each of ADR-006's four governed transitions.
   */
  recordGovernedTransition(
    transition: GovernedTransition,
    operationId: string,
    packet: Omit<TracePacket, "id" | "previous_hash" | "content_hash" | "gate_checkpoint">,
  ): string {
    const checkpoint = this.getGateCheckpoints(packet.campaign_id).find(
      (candidate) => candidate.node_id === packet.node_id
        && candidate.checkpoint.transition === transition
        && candidate.checkpoint.operation_id === operationId,
    );
    if (!checkpoint) {
      throw new AuditIntegrityError(
        `missing durable ${GATE_FOR_TRANSITION[transition]} gate checkpoint for operation ${operationId}`,
      );
    }
    if (checkpoint.checkpoint.gate.result === "fail") {
      throw new AuditIntegrityError(
        `cannot apply ${transition}: its durable ${GATE_FOR_TRANSITION[transition]} gate failed`,
      );
    }
    // Track D2b, applied at the one production site that has a stable
    // identifier. An independent audit found that `record()`'s idempotency key
    // was implemented and tested but never supplied by any real caller, so the
    // system remained as replay-vulnerable as before the feature landed.
    //
    // A governed transition is uniquely identified by its operation and the
    // transition itself — both stable across a retry, which is exactly what an
    // idempotency key requires. The ungoverned `record()` path deliberately
    // keeps no key: its callers build a packet with a fresh `new Date()`
    // timestamp, so any key derived there would differ on every retry and
    // would be a no-op dressed as a fix. Supplying one honestly requires the
    // caller to pass its own stable id, which is left to those callers.
    return this.record({ ...packet, idempotency_key: `governed:${operationId}:${transition}` });
  }

  /**
   * Get all trace packets for a campaign.
   */
  getCampaign(campaignId: string): TracePacket[] {
    return this.packets
      .filter((p): p is TracePacket => p.campaign_id === campaignId && isTracePacket(p))
      .map((packet) => structuredClone(packet));
  }

  /** Return every persisted record, including gate checkpoints, in chain order. */
  getRecords(campaignId?: string): readonly AuditRecord[] {
    return structuredClone(campaignId
      ? this.packets.filter((packet) => packet.campaign_id === campaignId)
      : this.packets);
  }

  /**
   * Get the trace packet for a specific node.
   */
  getNode(campaignId: string, nodeId: string): TracePacket | null {
    const packet = this.packets.find(
      (p): p is TracePacket => p.campaign_id === campaignId && p.node_id === nodeId && isTracePacket(p),
    );
    return packet ? structuredClone(packet) : null;
  }

  /**
   * Get all packets where gates were bypassed.
   * These represent evidence deficits that need later resolution.
   */
  getBypasses(campaignId: string): AuditRecord[] {
    return this.packets.filter(
      (p) =>
        p.campaign_id === campaignId &&
        ((p.kind === "gate_checkpoint" && p.checkpoint.gate.result === "bypass")
          || (isTracePacket(p) && p.gates.some((g) => g.result === "bypass"))),
    ).map((packet) => structuredClone(packet));
  }

  /**
   * Export as JSONL for persistence.
   */
  toJSONL(): string {
    return this.packets.map((p) => JSON.stringify(p)).join("\n");
  }

  /** Return an immutable snapshot suitable for an append-only persistence adapter. */
  getPackets(): readonly AuditRecord[] {
    return structuredClone(this.packets);
  }

  /**
   * Import from JSONL. Idempotent — duplicate ids are skipped.
   */
  fromJSONL(data: string): number {
    let count = 0;
    // Seeded from the packets already held, so first-wins dedup still spans
    // separate calls (audit-ledger-attacks.test.ts imports the original and
    // the poisoned copy in two calls and expects the second dropped).
    //
    // Built once per call rather than scanning `this.packets` per line. That
    // scan made a single import O(n^2), which `saveLedger` then paid on EVERY
    // append: measured here at n=3200, fromJSONL cost 48.6ms against
    // verifyIntegrity's 25.1ms, having grown 15x for 8x the records while the
    // integrity walk grew 4.3x. The dedup index is pure bookkeeping — it
    // carries no integrity property — so this is waste, not protection.
    const seen = new Set(this.packets.map((packet) => packet.id));
    for (const line of data.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const packet = JSON.parse(trimmed) as AuditRecord;
        if (!seen.has(packet.id)) {
          seen.add(packet.id);
          this.packets.push(structuredClone(packet));
          this.nextId = Math.max(this.nextId, parseTraceId(packet.id));
          count++;
        }
      } catch {
        // benign-catch: a malformed JSONL line is skipped rather than
        // aborting the whole import -- fromJSONL is a best-effort reload of
        // whatever bytes are on disk, and verifyIntegrity (run by every
        // caller that then trusts the ledger) independently re-validates
        // every line that WAS accepted, so a skipped line cannot masquerade
        // as a validated one.
      }
    }
    return count;
  }

  /**
   * Validate the complete, ordered hash chain. Call this before trusting an
   * imported ledger; a single changed, deleted, or reordered packet is detected.
   */
  verifyIntegrity(): IntegrityCheck {
    const previousHashes = new Map<string, string>();
    for (let index = 0; index < this.packets.length; index++) {
      const packet = this.packets[index];
      if (packet.kind === "gate_checkpoint") {
        try {
          validateGateCheckpoint({
            campaign_id: packet.campaign_id,
            node_id: packet.node_id,
            ...packet.checkpoint,
          });
        } catch (error) {
          return {
            valid: false,
            packet_count: this.packets.length,
            error: `packet ${index + 1} (${packet.id}) has an invalid gate checkpoint: ${errorMessage(error)}`,
          };
        }
      } else if (packet.kind === "recovery_decision") {
        try {
          validateRecoveryDecision({
            campaign_id: packet.campaign_id,
            node_id: packet.node_id,
            timestamp: packet.timestamp,
            ...packet.decision,
          });
        } catch (error) {
          return {
            valid: false,
            packet_count: this.packets.length,
            error: `packet ${index + 1} (${packet.id}) has an invalid recovery decision: ${errorMessage(error)}`,
          };
        }
      } else if (packet.kind === "campaign_reopen") {
        try { validateCampaignReopen({ campaign_id: packet.campaign_id, node_id: packet.node_id, timestamp: packet.timestamp, ...packet.reopen }); }
        catch (error) { return { valid: false, packet_count: this.packets.length, error: `packet ${index + 1} (${packet.id}) has invalid campaign reopen: ${errorMessage(error)}` }; }
      } else if (packet.kind === "interruption") {
        try { validateInterruption({ campaign_id: packet.campaign_id, node_id: packet.node_id, timestamp: packet.timestamp, ...packet.interruption }); }
        catch (error) { return { valid: false, packet_count: this.packets.length, error: `packet ${index + 1} (${packet.id}) has invalid interruption: ${errorMessage(error)}` }; }
        if (packet.interruption.phase !== "requested") {
          const request = this.packets.slice(0, index).find((record): record is InterruptionRecord => record.kind === "interruption"
            && record.id === packet.interruption.request_record_id && record.campaign_id === packet.campaign_id
            && record.interruption.operation_id === packet.interruption.operation_id && record.interruption.phase === "requested");
          if (!request || request.node_id !== packet.node_id || request.interruption.scope !== packet.interruption.scope) {
            return { valid: false, packet_count: this.packets.length, error: `packet ${index + 1} (${packet.id}) has invalid interruption request linkage` };
          }
          if (packet.interruption.affected_node_ids.some((id) => !request.interruption.affected_node_ids.includes(id))) {
            return { valid: false, packet_count: this.packets.length, error: `packet ${index + 1} (${packet.id}) includes nodes outside its interruption request` };
          }
          if (packet.interruption.phase === "state_applied" && !this.packets.slice(0, index).some((record) => record.kind === "interruption"
            && record.campaign_id === packet.campaign_id && record.interruption.operation_id === packet.interruption.operation_id
            && record.interruption.phase === "acknowledged" && record.interruption.request_record_id === packet.interruption.request_record_id)) {
            return { valid: false, packet_count: this.packets.length, error: `packet ${index + 1} (${packet.id}) applies interruption before acknowledgement` };
          }
        }
        if (packet.interruption.partial_evidence_ids.some((evidenceId) => !this.packets.slice(0, index)
          .some((record) => record.campaign_id === packet.campaign_id && record.id === evidenceId))) {
          return { valid: false, packet_count: this.packets.length, error: `packet ${index + 1} (${packet.id}) has missing, cross-campaign, or forward partial evidence` };
        }
      } else if (packet.kind === "node_communication") {
        try { validateNodeCommunication({ campaign_id: packet.campaign_id, node_id: packet.node_id, timestamp: packet.timestamp, ...packet.communication }); }
        catch (error) { return { valid: false, packet_count: this.packets.length, error: `packet ${index + 1} (${packet.id}) has invalid node communication: ${errorMessage(error)}` }; }
      } else if (packet.kind === "memory_fact") {
        try { validateMemoryFact({ campaign_id: packet.campaign_id, node_id: packet.node_id, timestamp: packet.timestamp, ...packet.fact }); }
        catch (error) { return { valid: false, packet_count: this.packets.length, error: `packet ${index + 1} (${packet.id}) has invalid memory fact: ${errorMessage(error)}` }; }
        try { validateImportedMemoryLink({ campaign_id: packet.campaign_id, node_id: packet.node_id, timestamp: packet.timestamp, ...packet.fact }, this.packets.slice(0, index)); }
        catch (error) { return { valid: false, packet_count: this.packets.length, error: `packet ${index + 1} (${packet.id}) has invalid memory import: ${errorMessage(error)}` }; }
        const witness = this.packets.slice(0, index).find((record) => record.id === packet.fact.source_evidence_id);
        const importedWitness = packet.fact.imported_from !== undefined && witness?.campaign_id === packet.fact.imported_from.campaign_id;
        if (!witness || (witness.campaign_id !== packet.campaign_id && !importedWitness)) {
          return { valid: false, packet_count: this.packets.length, error: `packet ${index + 1} (${packet.id}) has a missing or cross-campaign memory witness` };
        }
        if (packet.fact.tier === "specialist_visible" && isRestrictedMemoryWitness(witness)) {
          return { valid: false, packet_count: this.packets.length, error: `packet ${index + 1} (${packet.id}) downgrades a restricted memory witness` };
        }
      } else if (packet.kind === "telemetry_observation") {
        try { validateTelemetryObservation({ campaign_id: packet.campaign_id, node_id: packet.node_id, timestamp: packet.timestamp, ...packet.observation }); }
        catch (error) { return { valid: false, packet_count: this.packets.length, error: `packet ${index + 1} (${packet.id}) has invalid telemetry: ${errorMessage(error)}` }; }
        if (!this.packets.slice(0, index).some((record) => record.campaign_id === packet.campaign_id
          && record.id === packet.observation.source_evidence_id)) {
          return { valid: false, packet_count: this.packets.length, error: `packet ${index + 1} (${packet.id}) has missing, cross-campaign, or forward telemetry evidence` };
        }
      } else if (packet.kind === "advisory_evidence") {
        try { validateAdvisoryEvidence({ campaign_id: packet.campaign_id, node_id: packet.node_id, timestamp: packet.timestamp, ...packet.evidence }); }
        catch (error) { return { valid: false, packet_count: this.packets.length, error: `packet ${index + 1} (${packet.id}) has invalid advisory evidence: ${errorMessage(error)}` }; }
        if (!this.packets.slice(0, index).some((record) => record.campaign_id === packet.campaign_id
          && record.id === packet.evidence.source_evidence_id)) {
          return { valid: false, packet_count: this.packets.length, error: `packet ${index + 1} (${packet.id}) has missing, cross-campaign, or forward advisory evidence witness` };
        }
      } else if (packet.kind === "scope_decision") {
        try {
          validateScopeDecision({
            campaign_id: packet.campaign_id, node_id: packet.node_id, timestamp: packet.timestamp,
            previous_record_content_hash: packet.previous_hash, ...packet.decision,
          });
        } catch (error) { return { valid: false, packet_count: this.packets.length, error: `packet ${index + 1} (${packet.id}) has invalid scope decision: ${errorMessage(error)}` }; }
        if (packet.decision.parent_decision_id !== null) {
          const parent = this.packets.slice(0, index).find((record): record is ScopeDecisionRecord => record.kind === "scope_decision"
            && record.campaign_id === packet.campaign_id && record.id === packet.decision.parent_decision_id);
          if (!parent) {
            return { valid: false, packet_count: this.packets.length, error: `packet ${index + 1} (${packet.id}) amends a missing or cross-campaign scope decision parent` };
          }
          if (parent.decision.public_key !== packet.decision.public_key) {
            return { valid: false, packet_count: this.packets.length, error: `packet ${index + 1} (${packet.id}) scope decision public_key does not match its parent's generation key` };
          }
        }
        if (!verifyScopeDecisionSignature(packet)) {
          return { valid: false, packet_count: this.packets.length, error: `packet ${index + 1} (${packet.id}) has an invalid scope decision signature` };
        }
      } else if (packet.kind === "terminal_profile") {
        try { validateTerminalProfile({ campaign_id: packet.campaign_id, node_id: packet.node_id, timestamp: packet.timestamp, ...packet.profile }); }
        catch (error) { return { valid: false, packet_count: this.packets.length, error: `packet ${index + 1} (${packet.id}) has invalid terminal profile: ${errorMessage(error)}` }; }
      } else if (packet.kind === "terminal_notification") {
        try { validateTerminalNotification({ campaign_id: packet.campaign_id, node_id: packet.node_id, timestamp: packet.timestamp, ...packet.notification }); }
        catch (error) { return { valid: false, packet_count: this.packets.length, error: `packet ${index + 1} (${packet.id}) has invalid terminal notification: ${errorMessage(error)}` }; }
      } else if (packet.kind === "phase_message") {
        try { validatePhaseMessage({ campaign_id: packet.campaign_id, node_id: packet.node_id, timestamp: packet.timestamp, ...packet.message }); }
        catch (error) { return { valid: false, packet_count: this.packets.length, error: `packet ${index + 1} (${packet.id}) has invalid phase message: ${errorMessage(error)}` }; }
        const phaseMessagesInCampaign = this.packets.slice(0, index).filter(
          (record) => record.kind === "phase_message" && record.campaign_id === packet.campaign_id,
        ).length;
        if (phaseMessagesInCampaign >= PHASE_MESSAGE_MAX_PER_CAMPAIGN) {
          return { valid: false, packet_count: this.packets.length, error: `packet ${index + 1} (${packet.id}) exceeds phase message campaign limit` };
        }
      } else if (packet.kind === "compaction_lifecycle") {
        try { validateCompactionLifecycle({ campaign_id: packet.campaign_id, node_id: packet.node_id, timestamp: packet.timestamp, ...packet.lifecycle }); }
        catch (error) { return { valid: false, packet_count: this.packets.length, error: `packet ${index + 1} (${packet.id}) has invalid compaction lifecycle: ${errorMessage(error)}` }; }
      } else if (packet.kind === "waiver_outcome") {
        try { validateWaiverOutcome({ campaign_id: packet.campaign_id, node_id: packet.node_id, timestamp: packet.timestamp, ...packet.outcome }); }
        catch (error) { return { valid: false, packet_count: this.packets.length, error: `packet ${index + 1} (${packet.id}) has invalid waiver outcome: ${errorMessage(error)}` }; }
      } else if (packet.kind === "scope_observation") {
        try { validateScopeObservation({ campaign_id: packet.campaign_id, node_id: packet.node_id, timestamp: packet.timestamp, ...packet.observation }); }
        catch (error) { return { valid: false, packet_count: this.packets.length, error: `packet ${index + 1} (${packet.id}) has invalid scope observation: ${errorMessage(error)}` }; }
      } else if (packet.kind === "scope_intent_bind") {
        try { validateScopeIntentBind({ campaign_id: packet.campaign_id, node_id: packet.node_id, timestamp: packet.timestamp, ...packet.bind }); }
        catch (error) { return { valid: false, packet_count: this.packets.length, error: `packet ${index + 1} (${packet.id}) has invalid scope intent bind: ${errorMessage(error)}` }; }
      } else if (packet.kind === "scope_observation_amendment") {
        try { validateScopeObservationAmendment({ campaign_id: packet.campaign_id, node_id: packet.node_id, timestamp: packet.timestamp, ...packet.amendment }); }
        catch (error) { return { valid: false, packet_count: this.packets.length, error: `packet ${index + 1} (${packet.id}) has invalid scope observation amendment: ${errorMessage(error)}` }; }
        const target = this.packets.slice(0, index).find((record): record is ScopeObservationRecord => record.kind === "scope_observation"
          && record.campaign_id === packet.campaign_id && record.id === packet.amendment.scope_observation_record_id);
        if (!target) {
          return { valid: false, packet_count: this.packets.length, error: `packet ${index + 1} (${packet.id}) amends a missing or cross-campaign scope observation` };
        }
      } else if (packet.kind === "waiver_outcome_amendment") {
        try { validateWaiverOutcomeAmendment({ campaign_id: packet.campaign_id, node_id: packet.node_id, timestamp: packet.timestamp, ...packet.amendment }); }
        catch (error) { return { valid: false, packet_count: this.packets.length, error: `packet ${index + 1} (${packet.id}) has invalid waiver outcome amendment: ${errorMessage(error)}` }; }
        const target = this.packets.slice(0, index).find((record): record is WaiverOutcomeRecord => record.kind === "waiver_outcome"
          && record.campaign_id === packet.campaign_id && record.id === packet.amendment.waiver_record_id);
        if (!target || target.node_id !== packet.node_id) {
          return { valid: false, packet_count: this.packets.length, error: `packet ${index + 1} (${packet.id}) amends a missing or cross-node waiver outcome` };
        }
      } else if (packet.kind === "request_user_input") {
        try { validateRequestUserInput({ campaign_id: packet.campaign_id, node_id: packet.node_id, timestamp: packet.timestamp, ...packet.question }); }
        catch (error) { return { valid: false, packet_count: this.packets.length, error: `packet ${index + 1} (${packet.id}) has invalid request_user_input: ${errorMessage(error)}` }; }
      } else if (packet.kind === "user_input_answer") {
        try {
          validateUserInputAnswer(packet.answer);
          const question = this.packets.slice(0, index).find((record): record is RequestUserInputRecord => record.kind === "request_user_input"
            && record.id === packet.question_record_id && record.campaign_id === packet.campaign_id);
          if (!question) throw new AuditIntegrityError("answer has no prior question in the same campaign");
          assertUserInputAnswerMatchesQuestion(question, packet.node_id, packet.answer);
        }
        catch (error) { return { valid: false, packet_count: this.packets.length, error: `packet ${index + 1} (${packet.id}) has invalid user input answer: ${errorMessage(error)}` }; }
      } else if (isTracePacket(packet)) {
        try { validateTracePacket(packet); }
        catch (error) { return { valid: false, packet_count: this.packets.length, error: `packet ${index + 1} (${packet.id}) has an invalid trace packet: ${errorMessage(error)}` }; }
      }
      const previousHash = previousHashes.get(packet.campaign_id) ?? null;
      if (!packet.content_hash || packet.previous_hash !== previousHash) {
        return {
          valid: false,
          packet_count: this.packets.length,
          error: `packet ${index + 1} (${packet.id}) has an invalid predecessor hash`,
        };
      }
      const { content_hash, ...unhashed } = packet;
      if (content_hash !== hashPacket(unhashed)) {
        return {
          valid: false,
          packet_count: this.packets.length,
          error: `packet ${index + 1} (${packet.id}) content hash does not match`,
        };
      }
      previousHashes.set(packet.campaign_id, content_hash);
    }
    return { valid: true, packet_count: this.packets.length, error: null };
  }

  /**
   * Count packets by node state outcome.
   */
  stats(campaignId: string): {
    total: number;
    verified: number;
    claimed: number;
    failed: number;
    pruned: number;
    bypassed: number;
  } {
    const campaign = this.getCampaign(campaignId);
    return {
      total: campaign.length,
      verified: campaign.filter((p) => p.node_state_after === "verified").length,
      claimed: campaign.filter((p) => p.node_state_after === "claimed").length,
      failed: campaign.filter((p) => p.node_state_after === "failed").length,
      pruned: campaign.filter((p) => p.node_state_after === "pruned").length,
      bypassed: campaign.filter((p) =>
        p.gates.some((g) => g.result === "bypass"),
      ).length,
    };
  }
}

/** Runtime validation for checkpoint creation and JSONL replay. */
export function validateGateCheckpoint(input: GateCheckpointInput): void {
  if (!input.campaign_id || !input.node_id || !input.operation_id) {
    throw new AuditIntegrityError("gate checkpoint requires campaign_id, node_id, and operation_id");
  }
  if (GATE_FOR_TRANSITION[input.transition] !== input.gate.gate) {
    throw new AuditIntegrityError(
      `${input.transition} requires ${GATE_FOR_TRANSITION[input.transition]} gate evidence`,
    );
  }
  if (!isValidGateRecord(input.gate)) {
    throw new AuditIntegrityError("gate checkpoint contains an invalid gate record");
  }
  if ((input.failures !== undefined && !isStringArray(input.failures))
    || (input.unresolved !== undefined && !isStringArray(input.unresolved))) {
    throw new AuditIntegrityError("gate checkpoint failures and unresolved must be string arrays");
  }
}

/** Runtime validation for recovery decision creation and JSONL replay. */
export function validateRecoveryDecision(input: RecoveryDecisionInput): void {
  const text = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
  if (!text(input.campaign_id) || !text(input.node_id) || !text(input.recovery_operation_id)
    || !text(input.actor) || !text(input.reason) || !text(input.observed_version)) {
    throw new AuditIntegrityError("recovery decision requires campaign, node, operation, actor, reason, and observed version");
  }
  if (!(["retry", "abandon"] as const).includes(input.decision)
    || !(["crown", "cambium", "operator", "auditor"] as const).includes(input.authority)
    || !(["planned", "authorized", "blocked"] as const).includes(input.outcome)) {
    throw new AuditIntegrityError("recovery decision contains an invalid decision, authority, or outcome");
  }
  for (const field of [input.prior_operation_id, input.new_operation_id, input.expected_version]) {
    if (field !== null && !text(field)) throw new AuditIntegrityError("recovery decision optional operation/version fields must be non-empty when present");
  }
  if (!(["released", "inactive", "ambiguous", "unknown"] as const).includes(input.lease.previous)
    || (input.lease.new_lease_id !== null && !text(input.lease.new_lease_id))) {
    throw new AuditIntegrityError("recovery decision contains invalid lease evidence");
  }
  if (!(["pass", "fail", "bypass", "not_checked"] as const).includes(input.isolation.result)
    || (input.isolation.checkpoint_operation_id !== null && !text(input.isolation.checkpoint_operation_id))
    || (input.isolation.evidence_deficit !== null && !text(input.isolation.evidence_deficit))
    || (input.isolation.result === "bypass" && input.isolation.evidence_deficit === null)) {
    throw new AuditIntegrityError("recovery decision contains invalid isolation evidence");
  }
  if (input.timestamp !== undefined && Number.isNaN(Date.parse(input.timestamp))) {
    throw new AuditIntegrityError("recovery decision timestamp must be ISO-parseable when present");
  }
}

export function validateCampaignReopen(input: CampaignReopenInput): void {
  const text = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
  if (!text(input.campaign_id) || !text(input.node_id) || !text(input.operation_id) || !text(input.actor)
    || !text(input.source_session_id) || !text(input.reason)) {
    throw new AuditIntegrityError("campaign reopen requires campaign, node, operation, actor, source session, and reason");
  }
  if (!(["reopened", "reverted"] as const).includes(input.phase) || input.authority !== "operator"
    || !(["no_nodes", "converged"] as const).includes(input.overridden_halt_reason)) {
    throw new AuditIntegrityError("campaign reopen has an invalid phase, authority, or overridden halt reason");
  }
  const counter = input.iterations_without_kb_entry;
  if (counter === null || typeof counter !== "object" || !Number.isSafeInteger(counter.before) || !Number.isSafeInteger(counter.after)
    || counter.after < 0 || counter.after > counter.before) {
    throw new AuditIntegrityError("campaign reopen convergence counter must be non-negative integers that never increase");
  }
  if (input.timestamp !== undefined && Number.isNaN(Date.parse(input.timestamp))) {
    throw new AuditIntegrityError("campaign reopen timestamp must be ISO-parseable when present");
  }
}

export function validateInterruption(input: InterruptionInput): void {
  const text = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
  if (!text(input.campaign_id) || !text(input.node_id) || !text(input.operation_id) || !text(input.reason)
    || !isValidProvenance(input.provenance)) throw new AuditIntegrityError("interruption requires campaign, node, operation, reason, and provenance");
  if (!(["node", "subtree"] as const).includes(input.scope) || !(["requested", "acknowledged", "state_applied"] as const).includes(input.phase)) {
    throw new AuditIntegrityError("interruption has invalid scope or phase");
  }
  if (!Array.isArray(input.affected_node_ids) || input.affected_node_ids.length === 0 || !input.affected_node_ids.includes(input.node_id)
    || input.affected_node_ids.some((id) => !text(id))
    || new Set(input.affected_node_ids).size !== input.affected_node_ids.length
    || !Array.isArray(input.partial_evidence_ids) || input.partial_evidence_ids.some((id) => !text(id))
    || new Set(input.partial_evidence_ids).size !== input.partial_evidence_ids.length) {
    throw new AuditIntegrityError("interruption links require the target node and unique non-empty node/evidence IDs");
  }
  const allIds = [input.campaign_id, input.node_id, input.operation_id, ...input.affected_node_ids, ...input.partial_evidence_ids,
    ...(input.request_record_id === null ? [] : [input.request_record_id])];
  if (input.affected_node_ids.length > INTERRUPTION_MAX_AFFECTED_NODES
    || input.partial_evidence_ids.length > INTERRUPTION_MAX_PARTIAL_EVIDENCE
    || allIds.some((id) => Buffer.byteLength(id, "utf8") > INTERRUPTION_MAX_ID_BYTES)
    || Buffer.byteLength(input.reason, "utf8") > INTERRUPTION_MAX_REASON_BYTES) {
    throw new AuditIntegrityError("interruption exceeds affected-node, evidence, ID, or reason bounds");
  }
  if (input.phase === "requested" ? input.request_record_id !== null : !text(input.request_record_id)) {
    throw new AuditIntegrityError("only follow-up interruption phases require a request record");
  }
  if (input.timestamp !== undefined && Number.isNaN(Date.parse(input.timestamp))) throw new AuditIntegrityError("interruption timestamp must be ISO-parseable");
}

export function validateNodeCommunication(input: NodeCommunicationInput): void {
  const text = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
  if (!text(input.campaign_id) || !text(input.node_id) || !text(input.author_node_id) || !text(input.recipient_node_id) || !text(input.payload.content) || !text(input.as_of) || !text(input.correlation_id) || !text(input.idempotency_key)) throw new AuditIntegrityError("node communication requires identity, payload, as_of, correlation, and idempotency");
  if (!( ["delegate", "report", "retract", "steer", "reply", "clarify", "promote"] as const).includes(input.kind) || !( ["specialist", "critic", "auditor", "orchestrator"] as const).includes(input.capability_tier) || typeof input.trigger_turn !== "boolean" || !isValidProvenance(input.payload.provenance)) throw new AuditIntegrityError("node communication has invalid kind, tier, trigger, or provenance");
  if (!Array.isArray(input.other_recipient_node_ids) || input.other_recipient_node_ids.some((id) => !text(id)) || (input.acknowledges_communication_id !== null && !text(input.acknowledges_communication_id)) || (input.retracts_communication_id !== null && !text(input.retracts_communication_id))) throw new AuditIntegrityError("node communication has invalid linkage or fan-out");
  if (input.payload.evidence_refs !== undefined && (!Array.isArray(input.payload.evidence_refs) || input.payload.evidence_refs.length > 32 || input.payload.evidence_refs.some((ref) => !text(ref) || Buffer.byteLength(ref, "utf8") > 512))) throw new AuditIntegrityError("node communication has invalid evidence references");
  if ((input.kind === "retract") !== (input.retracts_communication_id !== null)) throw new AuditIntegrityError("retract communications must identify exactly one retracted communication");
  // Phase 4D.1: conversation envelope validation
  if (input.conversation_id !== undefined) {
    if (input.conversation_id === "" || !text(input.conversation_id)) throw new AuditIntegrityError("conversation_id must be non-empty when present");
    if (Buffer.byteLength(input.conversation_id, "utf8") > CONVERSATION_MAX_ID_BYTES) throw new AuditIntegrityError(`conversation_id exceeds ${CONVERSATION_MAX_ID_BYTES} UTF-8 bytes`);
  }
  if (input.parent_communication_id !== undefined && input.parent_communication_id !== null) {
    if (input.parent_communication_id === "" || !text(input.parent_communication_id)) throw new AuditIntegrityError("parent_communication_id must be non-empty when present and non-null");
  }
  if (input.intent !== undefined && !(["request", "response", "notify", "needs_attention"] as const).includes(input.intent)) {
    throw new AuditIntegrityError("node communication has invalid intent");
  }
  if (input.reply_to_communication_id !== undefined && input.reply_to_communication_id !== null && !text(input.reply_to_communication_id)) {
    throw new AuditIntegrityError("reply_to_communication_id must be non-empty when present and non-null");
  }
  if (input.ack_required !== undefined && typeof input.ack_required !== "boolean") throw new AuditIntegrityError("ack_required must be boolean when present");
  if (input.deadline_at !== undefined && input.deadline_at !== null && (!text(input.deadline_at) || Number.isNaN(Date.parse(input.deadline_at)))) {
    throw new AuditIntegrityError("deadline_at must be ISO-parseable when present");
  }
  if (input.remote_attribution !== undefined) {
    const attribution = input.remote_attribution;
    if (!text(attribution.session_id) || !text(attribution.key_id) || !text(attribution.certificate_id) || !text(attribution.nonce) || attribution.integrity !== "ed25519"
      || (attribution.proof_digest !== undefined && !/^sha256:[0-9a-f]{64}$/.test(attribution.proof_digest))) {
      throw new AuditIntegrityError("node communication has invalid remote attribution");
    }
  }
}

export function validateMemoryFact(input: MemoryFactInput): void {
  const text = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
  if (!text(input.campaign_id) || !text(input.node_id) || !text(input.content)
    || !text(input.source_evidence_id) || !text(input.idempotency_key) || !isValidProvenance(input.provenance)) {
    throw new AuditIntegrityError("memory fact requires campaign, node, content, provenance, source evidence, and idempotency");
  }
  if (!["failure_mode", "success_pattern", "parameter_finding"].includes(input.type)
    || !["specialist_visible", "critic_only"].includes(input.tier)
    || !["campaign", "subtree", "cross_campaign"].includes(input.scope.kind)
    || (input.scope.kind === "subtree" && !text(input.scope.root_node_id))) {
    throw new AuditIntegrityError("memory fact contains an invalid type, tier, or scope");
  }
  if (!Array.isArray(input.tags) || input.tags.some((tag) => !text(tag)) || new Set(input.tags).size !== input.tags.length) {
    throw new AuditIntegrityError("memory fact tags must be unique non-empty strings");
  }
  if (Buffer.byteLength(input.content, "utf8") > MEMORY_FACT_MAX_CONTENT_BYTES) {
    throw new AuditIntegrityError(`memory fact content exceeds ${MEMORY_FACT_MAX_CONTENT_BYTES} UTF-8 bytes; retain full output as evidence`);
  }
  if (input.tags.length > MEMORY_FACT_MAX_TAGS
    || input.tags.some((tag) => Buffer.byteLength(tag, "utf8") > MEMORY_FACT_MAX_TAG_BYTES)) {
    throw new AuditIntegrityError(`memory fact tags exceed the ${MEMORY_FACT_MAX_TAGS}-tag or ${MEMORY_FACT_MAX_TAG_BYTES}-byte bounds`);
  }
  if (input.imported_from !== undefined) {
    const imported = input.imported_from;
    if (!text(imported.campaign_id) || !text(imported.memory_fact_id)
      || !text(imported.requested_by) || !text(imported.approved_by)
      || imported.requested_by.trim() !== imported.requested_by || imported.approved_by.trim() !== imported.approved_by
      || imported.requested_by.trim() === imported.approved_by.trim()
      || [imported.campaign_id, imported.memory_fact_id, imported.requested_by, imported.approved_by]
        .some((value) => Buffer.byteLength(value, "utf8") > 512)) {
      throw new AuditIntegrityError("memory import requires bounded source identity and independent request/approval actors");
    }
  }
  if (input.timestamp !== undefined && Number.isNaN(Date.parse(input.timestamp))) throw new AuditIntegrityError("memory fact timestamp must be ISO-parseable");
}

/**
 * An import is a copied *projection*, never a way to rewrite or downgrade a
 * source fact.  Validate against prior ledger authority on both append and
 * replay so a hand-edited JSONL line cannot launder critic-only/unverified
 * memory or alter the portable payload.
 */
function validateImportedMemoryLink(input: MemoryFactInput, prior: readonly AuditRecord[]): void {
  const imported = input.imported_from;
  if (imported === undefined) return;
  if (imported.campaign_id === input.campaign_id) throw new AuditIntegrityError("memory import source must be a different campaign");
  if (input.scope.kind !== "campaign") throw new AuditIntegrityError("imported memory must remain target-campaign scoped");
  const source = prior.find((record): record is MemoryFactRecord => record.kind === "memory_fact"
    && record.campaign_id === imported.campaign_id && record.id === imported.memory_fact_id);
  if (!source) throw new AuditIntegrityError("memory import source fact must be prior ledger authority");
  const witness = prior.find((record) => record.id === source.fact.source_evidence_id && record.campaign_id === imported.campaign_id);
  const trace = witness !== undefined && (witness.kind === "trace" || witness.kind === undefined) ? witness as TracePacket : null;
  if (source.fact.tier !== "specialist_visible" || source.fact.provenance.tag !== "verified" || trace?.provenance?.tag !== "verified") {
    throw new AuditIntegrityError("memory import source must be verified and specialist-visible");
  }
  if (input.source_evidence_id !== source.fact.source_evidence_id || input.type !== source.fact.type
    || input.content !== source.fact.content || input.tier !== source.fact.tier
    || canonicalJson(input.provenance) !== canonicalJson(source.fact.provenance)
    || canonicalJson(input.tags) !== canonicalJson(source.fact.tags)) {
    throw new AuditIntegrityError("memory import must preserve source evidence, type, content, provenance, tier, and tags exactly");
  }
}

export function validateTelemetryObservation(input: TelemetryObservationInput): void {
  const text = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
  const count = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
  if (!text(input.campaign_id) || !text(input.node_id) || !text(input.operation_id)
    || !text(input.source_evidence_id) || !text(input.idempotency_key) || !isValidProvenance(input.provenance)) {
    throw new AuditIntegrityError("telemetry requires campaign, node, operation, source evidence, idempotency, and provenance");
  }
  if (!count(input.epoch) || !TELEMETRY_PHASES.includes(input.phase)
    || !TELEMETRY_OUTCOMES.includes(input.outcome)) {
    throw new AuditIntegrityError("telemetry contains an invalid epoch, phase, or outcome");
  }
  if (input.type === "phase_timing") {
    if (!count(input.duration_ms)) throw new AuditIntegrityError("phase timing duration must be a non-negative safe integer");
  } else if (input.type === "usage_cost") {
    if (input.agent_id !== undefined && !text(input.agent_id)) throw new AuditIntegrityError("usage/cost telemetry agent identity must be non-empty when present");
    if (!TELEMETRY_PROVIDERS.includes(input.provider) || !TELEMETRY_MODEL_FAMILIES.includes(input.model_family)
      || !count(input.input_tokens) || !count(input.output_tokens) || !count(input.cache_read_tokens)
      || !count(input.cache_write_tokens)) {
      throw new AuditIntegrityError("usage/cost telemetry contains invalid catalog or token data");
    }
    if (input.cost.kind === "priced") {
      if (!count(input.cost.minor_units)
        || !Number.isSafeInteger(input.cost.minor_unit_exponent) || input.cost.minor_unit_exponent < 0 || input.cost.minor_unit_exponent > 9
        || !/^[A-Z]{3}$/.test(input.cost.currency) || !text(input.cost.price_source_id)) {
        throw new AuditIntegrityError("priced usage/cost telemetry contains invalid amount, currency, or price-source data");
      }
    } else if (input.cost.kind === "unpriced") {
      if (!text(input.cost.reason)) throw new AuditIntegrityError("unpriced usage/cost telemetry requires a non-empty reason");
    } else {
      throw new AuditIntegrityError("usage/cost telemetry has an unknown cost kind");
    }
  } else if (input.type === "role_model_identity") {
    if ((input.role !== "specialist" && input.role !== "critic") || !text(input.model_id)) {
      throw new AuditIntegrityError("role/model telemetry requires a closed role and non-empty model identity");
    }
  } else if (input.type === "node_cost_attribution") {
    const tokens = input.total_tokens;
    if (!count(tokens.input) || !count(tokens.output) || !count(tokens.cache_read) || !count(tokens.cache_write)
      || !Array.isArray(input.top_cost_spans) || input.top_cost_spans.length > 20
      || !Array.isArray(input.redundant_tool_calls) || input.redundant_tool_calls.length > 50
      || typeof input.produced_verified_progress !== "boolean"
      || (input.pruning_signal !== "retain" && input.pruning_signal !== "expensive_unproductive")) {
      throw new AuditIntegrityError("node cost attribution contains invalid totals, spans, or pruning signal");
    }
    validateCost(input.total_cost, "node cost attribution total");
    for (const span of input.top_cost_spans) {
      if (!text(span.span_id) || !["specialist", "critic", "tool"].includes(span.kind)
        || !count(span.input_tokens) || !count(span.output_tokens) || !count(span.cache_read_tokens) || !count(span.cache_write_tokens)) {
        throw new AuditIntegrityError("node cost attribution contains an invalid span");
      }
      validateCost(span.cost, "node cost attribution span");
    }
    if (input.redundant_tool_calls.some((cluster) => !text(cluster.normalized_signature) || !count(cluster.count) || cluster.count < 2)) {
      throw new AuditIntegrityError("node cost attribution contains an invalid redundant-tool cluster");
    }
  } else if (input.type === "context_economy") {
    if (!count(input.offered_tokens) || !count(input.retained_tokens) || !count(input.pruned_tokens)
      || !count(input.indexed_reference_tokens) || !count(input.stable_prefix_tokens) || !count(input.dynamic_tokens)
      || input.retained_tokens > input.offered_tokens || input.pruned_tokens !== input.offered_tokens - input.retained_tokens
      || input.stable_prefix_tokens + input.dynamic_tokens !== input.retained_tokens) {
      throw new AuditIntegrityError("context economy telemetry contains invalid or inconsistent token counts");
    }
    if (!Array.isArray(input.per_source) || input.per_source.length !== CONTEXT_ECONOMY_SOURCES.length) {
      throw new AuditIntegrityError("context economy telemetry per-source breakdown must have exactly one row per context source");
    }
    const seenSources = new Set<string>();
    let sourceOffered = 0;
    let sourceRetained = 0;
    for (const row of input.per_source) {
      if (!CONTEXT_ECONOMY_SOURCES.includes(row.source) || seenSources.has(row.source)
        || !count(row.offered_tokens) || !count(row.retained_tokens) || row.retained_tokens > row.offered_tokens
        || !["stable", "dynamic"].includes(row.cache_class)
        || !["absent", "retained", "pruned", "indexed", "mixed"].includes(row.disposition)
        || !text(row.reason) || !text(row.evidence_pointer) || !row.provenance) {
        throw new AuditIntegrityError("context economy telemetry contains an invalid per-source row");
      }
      seenSources.add(row.source);
      sourceOffered += row.offered_tokens;
      sourceRetained += row.retained_tokens;
    }
    if (sourceOffered !== input.offered_tokens || sourceRetained !== input.retained_tokens) {
      throw new AuditIntegrityError("context economy telemetry per-source breakdown does not sum to its aggregate totals");
    }
  } else if (input.type === "tool_economy") {
    if (!count(input.offered_calls) || !count(input.host_executions) || !count(input.reused_reads) || !count(input.avoided_output_bytes)
      || input.host_executions + input.reused_reads > input.offered_calls) {
      throw new AuditIntegrityError("tool economy telemetry contains invalid or inconsistent counts");
    }
  } else if (input.type === "race_outcome") {
    if ((input.winner !== "primary" && input.winner !== "fork" && input.winner !== "none")
      || (input.forked_at_ms !== null && !count(input.forked_at_ms))
      || (input.loser_wall_ms !== null && !count(input.loser_wall_ms))
      || typeof input.cancelled !== "boolean"
      || (input.winner === "none" && input.cancelled)
      || (input.loser_usage_unavailable_reason !== undefined && !text(input.loser_usage_unavailable_reason))
      || (input.threshold_ms !== undefined && !count(input.threshold_ms))
      || (input.threshold_source !== undefined && !["learned", "env", "default"].includes(input.threshold_source))
      || (input.threshold_observations !== undefined && !count(input.threshold_observations))
      || (input.tie_break !== undefined && (!["primary", "fork", "none_default"].includes(input.tie_break) || input.winner !== "none"))) {
      throw new AuditIntegrityError("race outcome telemetry contains an invalid winner, timing, or cancellation flag");
    }
  } else {
    throw new AuditIntegrityError("telemetry contains an unknown observation type");
  }
  if (input.timestamp !== undefined && Number.isNaN(Date.parse(input.timestamp))) {
    throw new AuditIntegrityError("telemetry timestamp must be ISO-parseable");
  }
}

export function validateTerminalProfile(input: TerminalProfileInput): void {
  const text = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
  if (!text(input.campaign_id) || !text(input.node_id) || !text(input.operation_id) || !text(input.idempotency_key) || !isValidProvenance(input.provenance)) {
    throw new AuditIntegrityError("terminal profile requires campaign, node, operation, idempotency, and provenance");
  }
  if ((input.theme_mode !== "dark" && input.theme_mode !== "light") || (input.theme_source !== "terminal" && input.theme_source !== "timeout_default")) {
    throw new AuditIntegrityError("terminal profile has an invalid theme observation");
  }
  const capabilities = input.capabilities;
  if (capabilities !== null && (!["none", "tmux", "zellij", "screen", "unknown"].includes(capabilities.multiplexer)
    || !text(capabilities.terminal_name) || typeof capabilities.terminal_version !== "string"
    || [capabilities.focus_tracking, capabilities.notifications, capabilities.rgb, capabilities.ansi256, capabilities.remote].some((value) => typeof value !== "boolean"))) {
    throw new AuditIntegrityError("terminal profile has invalid capabilities");
  }
  if (input.timestamp !== undefined && Number.isNaN(Date.parse(input.timestamp))) throw new AuditIntegrityError("terminal profile timestamp must be ISO-parseable");
}

export function validateTerminalNotification(input: TerminalNotificationInput): void {
  const text = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
  if (!text(input.campaign_id) || !text(input.node_id) || !text(input.operation_id) || !text(input.idempotency_key)
    || !/^sha256:[a-f0-9]{64}$/.test(input.notification_ref) || !["unknown", "focused", "blurred"].includes(input.focus)
    || typeof input.emitted !== "boolean" || !isValidProvenance(input.provenance)) {
    throw new AuditIntegrityError("terminal notification requires bounded identity, focus, delivery result, and provenance");
  }
  if (input.timestamp !== undefined && Number.isNaN(Date.parse(input.timestamp))) throw new AuditIntegrityError("terminal notification timestamp must be ISO-parseable");
}

function validateCost(cost: Cost, label: string): void {
  if (cost.kind === "priced") {
    if (!Number.isSafeInteger(cost.minor_units) || cost.minor_units < 0 || !Number.isSafeInteger(cost.minor_unit_exponent)
      || cost.minor_unit_exponent < 0 || cost.minor_unit_exponent > 9 || !/^[A-Z]{3}$/.test(cost.currency)
      || typeof cost.price_source_id !== "string" || cost.price_source_id.trim().length === 0) throw new AuditIntegrityError(`${label} is invalid`);
  } else if (cost.kind !== "unpriced" || typeof cost.reason !== "string" || cost.reason.trim().length === 0) {
    throw new AuditIntegrityError(`${label} is invalid`);
  }
}

export function validateWaiverOutcome(input: WaiverOutcomeInput): void {
  const text = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
  if (!text(input.campaign_id) || !text(input.node_id) || !text(input.task_category)
    || !text(input.waived_by) || !text(input.waived_reason) || !text(input.waived_at) || !text(input.idempotency_key)) {
    throw new AuditIntegrityError("waiver outcome requires campaign, node, task_category, waived_by, waived_reason, waived_at, and idempotency");
  }
  if (Number.isNaN(Date.parse(input.waived_at))) throw new AuditIntegrityError("waiver outcome waived_at must be ISO-parseable");
  if (Buffer.byteLength(input.task_category, "utf8") > WAIVER_OUTCOME_MAX_CATEGORY_BYTES) {
    throw new AuditIntegrityError(`waiver outcome task_category exceeds ${WAIVER_OUTCOME_MAX_CATEGORY_BYTES} UTF-8 bytes`);
  }
  if (Buffer.byteLength(input.waived_reason, "utf8") > WAIVER_OUTCOME_MAX_REASON_BYTES) {
    throw new AuditIntegrityError(`waiver outcome waived_reason exceeds ${WAIVER_OUTCOME_MAX_REASON_BYTES} UTF-8 bytes`);
  }
  if (input.timestamp !== undefined && Number.isNaN(Date.parse(input.timestamp))) {
    throw new AuditIntegrityError("waiver outcome timestamp must be ISO-parseable");
  }
}

export function validateWaiverOutcomeAmendment(input: WaiverOutcomeAmendmentInput): void {
  const text = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
  if (!text(input.campaign_id) || !text(input.node_id) || !text(input.waiver_record_id)
    || !text(input.recorded_by) || !text(input.reason) || !text(input.idempotency_key)) {
    throw new AuditIntegrityError("waiver outcome amendment requires campaign, node, waiver_record_id, recorded_by, reason, and idempotency");
  }
  if (input.kind !== "adopted" && input.kind !== "later_failed") {
    throw new AuditIntegrityError("waiver outcome amendment kind must be adopted or later_failed");
  }
  if (typeof input.value !== "boolean") throw new AuditIntegrityError("waiver outcome amendment value must be a boolean");
  if (Buffer.byteLength(input.reason, "utf8") > WAIVER_OUTCOME_AMENDMENT_MAX_REASON_BYTES) {
    throw new AuditIntegrityError(`waiver outcome amendment reason exceeds ${WAIVER_OUTCOME_AMENDMENT_MAX_REASON_BYTES} UTF-8 bytes`);
  }
  if (input.timestamp !== undefined && Number.isNaN(Date.parse(input.timestamp))) {
    throw new AuditIntegrityError("waiver outcome amendment timestamp must be ISO-parseable");
  }
}

export function validateScopeObservation(input: ScopeObservationInput): void {
  const text = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
  const pathList = (value: unknown): value is readonly string[] => Array.isArray(value) && value.every((entry) => typeof entry === "string" && entry.length > 0);
  if (!text(input.campaign_id) || !text(input.node_id) || !text(input.idempotency_key)
    || !pathList(input.declared) || !pathList(input.observed_out_of_scope)) {
    throw new AuditIntegrityError("scope observation requires campaign, node, idempotency, declared, and observed_out_of_scope path lists");
  }
  if (input.observed_out_of_scope.length === 0) {
    throw new AuditIntegrityError("scope observation requires at least one observed out-of-scope path");
  }
  if (input.declared.length > SCOPE_OBSERVATION_MAX_PATHS || input.observed_out_of_scope.length > SCOPE_OBSERVATION_MAX_PATHS) {
    throw new AuditIntegrityError(`scope observation path lists exceed ${SCOPE_OBSERVATION_MAX_PATHS} entries`);
  }
  for (const path of [...input.declared, ...input.observed_out_of_scope]) {
    if (Buffer.byteLength(path, "utf8") > SCOPE_OBSERVATION_MAX_PATH_BYTES) {
      throw new AuditIntegrityError(`scope observation path exceeds ${SCOPE_OBSERVATION_MAX_PATH_BYTES} UTF-8 bytes`);
    }
  }
  if (input.enforcement !== "audit" && input.enforcement !== "blocked") {
    throw new AuditIntegrityError("scope observation enforcement must be audit or blocked");
  }
  if (input.timestamp !== undefined && Number.isNaN(Date.parse(input.timestamp))) {
    throw new AuditIntegrityError("scope observation timestamp must be ISO-parseable");
  }
  if (input.lineage_root !== undefined && (typeof input.lineage_root !== "string" || input.lineage_root.trim().length === 0)) {
    throw new AuditIntegrityError("scope observation lineage_root must be a non-empty string when present");
  }
}

export function validateScopeObservationAmendment(input: ScopeObservationAmendmentInput): void {
  const text = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
  if (!text(input.campaign_id) || !text(input.node_id) || !text(input.scope_observation_record_id) || !text(input.idempotency_key)) {
    throw new AuditIntegrityError("scope observation amendment requires campaign, node, scope_observation_record_id, and idempotency");
  }
  if (input.kind !== "folded") throw new AuditIntegrityError("scope observation amendment kind must be folded");
  if (input.timestamp !== undefined && Number.isNaN(Date.parse(input.timestamp))) {
    throw new AuditIntegrityError("scope observation amendment timestamp must be ISO-parseable");
  }
}

/** ADR-119 O3: runtime validation for a scope-intent bind record, mirroring `validateScopeObservation`'s bounding pattern. */
export function validateScopeIntentBind(input: ScopeIntentBindInput): void {
  const text = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
  const argvList = (value: unknown): value is readonly string[] => Array.isArray(value) && value.length > 0 && value.every((entry) => typeof entry === "string" && entry.length > 0);
  if (!text(input.campaign_id) || !text(input.node_id) || !text(input.session_id) || !text(input.purpose) || !text(input.idempotency_key)
    || !argvList(input.argv_prefix) || !argvList(input.bound_argv)) {
    throw new AuditIntegrityError("scope intent bind requires campaign, node, session, purpose, idempotency, argv_prefix, and bound_argv");
  }
  if (!Number.isInteger(input.intent_index) || input.intent_index < 0) {
    throw new AuditIntegrityError("scope intent bind intent_index must be a non-negative integer");
  }
  if (input.argv_prefix.length > SCOPE_INTENT_BIND_MAX_ARGV_ENTRIES || input.bound_argv.length > SCOPE_INTENT_BIND_MAX_ARGV_ENTRIES) {
    throw new AuditIntegrityError(`scope intent bind argv lists exceed ${SCOPE_INTENT_BIND_MAX_ARGV_ENTRIES} entries`);
  }
  for (const part of [...input.argv_prefix, ...input.bound_argv]) {
    if (Buffer.byteLength(part, "utf8") > SCOPE_INTENT_BIND_MAX_ARGV_BYTES) {
      throw new AuditIntegrityError(`scope intent bind argv token exceeds ${SCOPE_INTENT_BIND_MAX_ARGV_BYTES} UTF-8 bytes`);
    }
  }
  if (Buffer.byteLength(input.purpose, "utf8") > SCOPE_INTENT_BIND_MAX_PURPOSE_BYTES) {
    throw new AuditIntegrityError(`scope intent bind purpose exceeds ${SCOPE_INTENT_BIND_MAX_PURPOSE_BYTES} UTF-8 bytes`);
  }
  // O2/manager.ts's own re-check: the observed bound argv must actually
  // start with the declared prefix -- a journaled bind whose argv does not
  // extend its own prefix would misrepresent what the intent authorized.
  if (input.bound_argv.length < input.argv_prefix.length
    || !input.argv_prefix.every((part, index) => part === input.bound_argv[index])) {
    throw new AuditIntegrityError("scope intent bind bound_argv is not a positional extension of argv_prefix");
  }
  if (input.timestamp !== undefined && Number.isNaN(Date.parse(input.timestamp))) {
    throw new AuditIntegrityError("scope intent bind timestamp must be ISO-parseable");
  }
}

export function validateAdvisoryEvidence(input: AdvisoryEvidenceInput): void {
  const text = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
  if (!text(input.campaign_id) || !text(input.node_id) || !text(input.activity) || !text(input.payload)
    || !text(input.source_evidence_id) || !text(input.idempotency_key)) {
    throw new AuditIntegrityError("advisory evidence requires campaign, node, activity, payload, source_evidence_id, and idempotency");
  }
  if (!ADVISORY_EVIDENCE_GENERATORS.includes(input.generator)) {
    throw new AuditIntegrityError(`advisory evidence generator must be one of ${ADVISORY_EVIDENCE_GENERATORS.join(", ")}`);
  }
  if (Buffer.byteLength(input.activity, "utf8") > ADVISORY_EVIDENCE_MAX_ACTIVITY_BYTES) {
    throw new AuditIntegrityError(`advisory evidence activity exceeds ${ADVISORY_EVIDENCE_MAX_ACTIVITY_BYTES} UTF-8 bytes`);
  }
  if (input.payload_truncated !== undefined && typeof input.payload_truncated !== "boolean") {
    throw new AuditIntegrityError("advisory evidence payload_truncated must be a boolean when present");
  }
  if (input.timestamp !== undefined && Number.isNaN(Date.parse(input.timestamp))) {
    throw new AuditIntegrityError("advisory evidence timestamp must be ISO-parseable");
  }
}

export function validateScopeDecision(input: ScopeDecisionInput): void {
  const text = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
  const pathList = (value: unknown): value is readonly string[] => Array.isArray(value) && value.length > 0 && value.every((entry) => typeof entry === "string" && entry.length > 0);
  if (!text(input.campaign_id) || !text(input.node_id) || !text(input.decided_by) || !text(input.public_key)
    || !text(input.signature) || !text(input.idempotency_key) || !pathList(input.paths)) {
    throw new AuditIntegrityError("scope decision requires campaign, node, decided_by, public_key, signature, idempotency, and a non-empty paths list");
  }
  if (input.paths.length > SCOPE_DECISION_MAX_PATHS) {
    throw new AuditIntegrityError(`scope decision paths exceed ${SCOPE_DECISION_MAX_PATHS} entries`);
  }
  for (const path of input.paths) {
    if (Buffer.byteLength(path, "utf8") > SCOPE_DECISION_MAX_PATH_BYTES) {
      throw new AuditIntegrityError(`scope decision path exceeds ${SCOPE_DECISION_MAX_PATH_BYTES} UTF-8 bytes`);
    }
  }
  if (input.decision !== "approved_widening" && input.decision !== "revoked") {
    throw new AuditIntegrityError("scope decision decision must be approved_widening or revoked");
  }
  if (input.parent_decision_id !== null && !text(input.parent_decision_id)) {
    throw new AuditIntegrityError("scope decision parent_decision_id must be a non-empty string or null");
  }
  if (input.previous_record_content_hash !== null && !text(input.previous_record_content_hash)) {
    throw new AuditIntegrityError("scope decision previous_record_content_hash must be a non-empty string or null");
  }
  if (input.timestamp !== undefined && Number.isNaN(Date.parse(input.timestamp))) {
    throw new AuditIntegrityError("scope decision timestamp must be ISO-parseable");
  }
}

/**
 * Y (ADR-070): the exact canonical payload an Ed25519 signature over a scope
 * decision must cover -- `{campaign_id, node_id, paths (sorted), decision,
 * parent_decision_id, previous_record_content_hash}`. Exported so the ONE
 * signer (`manager.ts`) and every verifier (`recordScopeDecision`,
 * `verifyIntegrity`, `verifyScopeDecisionSignature`, and the offline
 * `ledger-audit-sweep.ts` check (f)) construct byte-identical payloads --
 * there is exactly one place this shape is defined.
 */
export function scopeDecisionSigningPayload(input: {
  campaign_id: string;
  node_id: string;
  paths: readonly string[];
  decision: ScopeDecisionKind;
  parent_decision_id: string | null;
  previous_record_content_hash: string | null;
}): object {
  return {
    campaign_id: input.campaign_id,
    node_id: input.node_id,
    paths: [...input.paths].sort(),
    decision: input.decision,
    parent_decision_id: input.parent_decision_id,
    previous_record_content_hash: input.previous_record_content_hash,
  };
}

function verifyEd25519Signature(payload: object, publicKeyBase64: string, signatureBase64: string): boolean {
  try {
    const publicKey = createPublicKey({ key: Buffer.from(publicKeyBase64, "base64"), format: "der", type: "spki" });
    return cryptoVerify(null, Buffer.from(canonicalJson(payload), "utf8"), publicKey, Buffer.from(signatureBase64, "base64"));
  } catch {
    return false;
  }
}

/**
 * Y (ADR-070): re-verify one already-persisted `ScopeDecisionRecord`'s
 * signature, reconstructing the exact payload it must have been signed
 * over from the record's OWN fields (`previous_hash` stands in for
 * `previous_record_content_hash` -- see `ScopeDecisionInput`'s doc). Pure
 * and offline: takes no ledger, does not consult sibling records, and is
 * the single primitive both `verifyIntegrity`'s live dispatch and
 * `ledger-audit-sweep.ts`'s check (f) call, so the two never drift.
 */
export function verifyScopeDecisionSignature(record: ScopeDecisionRecord): boolean {
  const payload = scopeDecisionSigningPayload({
    campaign_id: record.campaign_id, node_id: record.node_id, paths: record.decision.paths,
    decision: record.decision.decision, parent_decision_id: record.decision.parent_decision_id,
    previous_record_content_hash: record.previous_hash,
  });
  return verifyEd25519Signature(payload, record.decision.public_key, record.decision.signature);
}

export function validatePhaseMessage(input: PhaseMessageInput): void {
  const text = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
  if (!text(input.campaign_id) || !text(input.node_id) || !text(input.operation_id)
    || !text(input.idempotency_key) || !input.provenance || !isValidProvenance(input.provenance)) {
    throw new AuditIntegrityError("phase message requires campaign, node, operation, idempotency, and provenance");
  }
  if (input.phase !== "commentary" && input.phase !== "final") {
    throw new AuditIntegrityError("phase message phase must be commentary or final");
  }
  if (typeof input.content !== "string" || input.content.length === 0) {
    throw new AuditIntegrityError("phase message content must be a non-empty string");
  }
  const byteLength = Buffer.byteLength(input.content, "utf8");
  if (byteLength > PHASE_MESSAGE_MAX_CONTENT_BYTES) {
    throw new AuditIntegrityError(`phase message content exceeds ${PHASE_MESSAGE_MAX_CONTENT_BYTES} UTF-8 bytes`);
  }
  if (!Number.isSafeInteger(input.content_length_bytes) || input.content_length_bytes !== byteLength) {
    throw new AuditIntegrityError("phase message content_length_bytes must match the UTF-8 byte length");
  }
  if (input.timestamp !== undefined && Number.isNaN(Date.parse(input.timestamp))) {
    throw new AuditIntegrityError("phase message timestamp must be ISO-parseable");
  }
}

export function validateCompactionLifecycle(input: CompactionLifecycleInput): void {
  const text = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
  if (!text(input.campaign_id) || !text(input.node_id) || !text(input.operation_id)
    || !text(input.idempotency_key) || !text(input.pre_evidence_id) || !text(input.as_of)) {
    throw new AuditIntegrityError("compaction lifecycle requires campaign, node, operation, idempotency, pre_evidence, and as_of");
  }
  if (!(["auto", "manual"] as const).includes(input.trigger)
    || !(["completed", "interrupted", "failed"] as const).includes(input.status)
    || !(["local_model", "token_budget_fresh_window", "structural_folding"] as const).includes(input.strategy)) {
    throw new AuditIntegrityError("compaction lifecycle has invalid trigger, status, or strategy");
  }
  if (input.status === "completed" && !text(input.post_evidence_id ?? "")) {
    throw new AuditIntegrityError("completed compaction requires a non-null post_evidence_id");
  }
  if (input.status !== "completed" && (input.post_evidence_id !== null && input.post_evidence_id !== undefined)) {
    throw new AuditIntegrityError("non-completed compaction must have null post_evidence_id");
  }
  if (!Array.isArray(input.partial_evidence_ids) || input.partial_evidence_ids.some((id) => !text(id))
    || new Set(input.partial_evidence_ids).size !== input.partial_evidence_ids.length) {
    throw new AuditIntegrityError("compaction partial_evidence_ids must be unique non-empty strings");
  }
  const allIds = [input.campaign_id, input.node_id, input.operation_id, input.pre_evidence_id, input.idempotency_key, input.as_of,
    ...(input.post_evidence_id === null ? [] : [input.post_evidence_id]),
    ...(input.anchor_summary_id === null ? [] : [input.anchor_summary_id]),
    ...input.partial_evidence_ids];
  if (input.partial_evidence_ids.length > COMPACTION_MAX_PARTIAL_EVIDENCE
    || allIds.some((id) => Buffer.byteLength(id, "utf8") > COMPACTION_MAX_ID_BYTES)
    || Buffer.byteLength(input.reason, "utf8") > COMPACTION_MAX_REASON_BYTES) {
    throw new AuditIntegrityError("compaction exceeds partial_evidence, ID, or reason bounds");
  }
  if (input.timestamp !== undefined && Number.isNaN(Date.parse(input.timestamp))) {
    throw new AuditIntegrityError("compaction lifecycle timestamp must be ISO-parseable");
  }
}

export function validateRequestUserInput(input: RequestUserInputInput): void {
  const text = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
  if (!text(input.campaign_id) || !text(input.node_id) || !text(input.operation_id)
    || !text(input.idempotency_key) || !text(input.as_of) || !text(input.requester_role)) {
    throw new AuditIntegrityError("request_user_input requires campaign, node, operation, idempotency, as_of, and requester_role");
  }
  if (input.authority !== "lead" && input.authority !== "delegated_needs_input") {
    throw new AuditIntegrityError("request_user_input authority must be lead or delegated_needs_input");
  }
  if (input.blocking !== "blocking" && input.blocking !== "async") {
    throw new AuditIntegrityError("request_user_input blocking must be blocking or async");
  }
  if (input.origin_session_id !== undefined && (!text(input.origin_session_id) || Buffer.byteLength(input.origin_session_id, "utf8") > 1024)) {
    throw new AuditIntegrityError("request_user_input origin_session_id must be non-empty and within 1024 bytes when present");
  }
  if (!text(input.question) || Buffer.byteLength(input.question, "utf8") > USER_INPUT_MAX_QUESTION_BYTES) {
    throw new AuditIntegrityError(`request_user_input question must be non-empty and within ${USER_INPUT_MAX_QUESTION_BYTES} bytes`);
  }
  if (!Array.isArray(input.options) || input.options.length === 0 || input.options.length > USER_INPUT_MAX_OPTIONS) {
    throw new AuditIntegrityError(`request_user_input options must be from 1 to ${USER_INPUT_MAX_OPTIONS}`);
  }
  const optionIds = new Set<string>();
  for (const option of input.options) {
    if (!text(option.id) || optionIds.has(option.id)) throw new AuditIntegrityError("request_user_input option ids must be unique non-empty strings");
    optionIds.add(option.id);
    if (!text(option.text) || Buffer.byteLength(option.text, "utf8") > USER_INPUT_MAX_OPTION_BYTES) {
      throw new AuditIntegrityError(`request_user_input option text exceeds ${USER_INPUT_MAX_OPTION_BYTES} bytes`);
    }
    if (option.follow_up !== undefined && (!text(option.follow_up.text)
      || !(["steer", "promote", "backtrack"] as const).includes(option.follow_up.kind)
      || Buffer.byteLength(option.follow_up.text, "utf8") > USER_INPUT_MAX_FOLLOW_UP_BYTES)) {
      throw new AuditIntegrityError("request_user_input follow_up must have text and a valid steer/promote/backtrack kind");
    }
    if (typeof option.is_other !== "boolean") {
      throw new AuditIntegrityError("request_user_input option is_other must be boolean");
    }
  }
  if (input.timestamp !== undefined && Number.isNaN(Date.parse(input.timestamp))) {
    throw new AuditIntegrityError("request_user_input timestamp must be ISO-parseable");
  }
}

export function validateUserInputAnswer(answer: UserInputAnswer): void {
  const text = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
  if (!text(answer.answered_by) || !text(answer.answered_at) || Number.isNaN(Date.parse(answer.answered_at))) {
    throw new AuditIntegrityError("user input answer requires answered_by and an ISO-parseable answered_at");
  }
  if (!text(answer.custom_text) && !text(answer.option_id ?? "")) {
    throw new AuditIntegrityError("user input answer requires an option_id or custom_text");
  }
  if (Buffer.byteLength(answer.custom_text, "utf8") > USER_INPUT_MAX_ANSWER_BYTES) {
    throw new AuditIntegrityError(`user input answer custom_text exceeds ${USER_INPUT_MAX_ANSWER_BYTES} bytes`);
  }
}

function assertUserInputAnswerMatchesQuestion(question: RequestUserInputRecord, nodeId: string, answer: UserInputAnswer): void {
  if (question.node_id !== nodeId) {
    throw new AuditIntegrityError(`user input answer node ${nodeId} does not match question node ${question.node_id}`);
  }
  if (answer.option_id !== null && !question.question.options.some((option) => option.id === answer.option_id)) {
    throw new AuditIntegrityError(`user input answer references an option not offered by question ${question.id}`);
  }
  if (answer.option_id === null && !question.question.options.some((option) => option.is_other === true)) {
    throw new AuditIntegrityError(`user input answer has custom text but question ${question.id} offers no other option`);
  }
}

function validateTracePacket(packet: Omit<TracePacket, "id" | "previous_hash" | "content_hash"> | TracePacket): void {
  const text = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
  const states: readonly NodeState[] = ["pending", "expanding", "verified", "claimed", "failed", "pruned", "interrupted", "abandoned", "awaiting_review"];
  if (packet.idempotency_key !== undefined && !text(packet.idempotency_key)) {
    throw new AuditIntegrityError("trace packet idempotency_key must be a non-empty string when present");
  }
  const validProvenance = packet.provenance === null || isValidProvenance(packet.provenance);
  const rejectedVerificationAttempt = packet.node_state_after === "failed" && isRejectedVerificationAttempt(packet.provenance);
  if ((packet.kind !== undefined && packet.kind !== "trace") || !isValidCampaignId(packet.campaign_id) || !text(packet.node_id)
    || !text(packet.timestamp) || Number.isNaN(Date.parse(packet.timestamp)) || !text(packet.action_description)
    || !text(packet.action_category) || !text(packet.specialist_agent) || (packet.critic_agent !== null && !text(packet.critic_agent))
    || !states.includes(packet.node_state_before) || !states.includes(packet.node_state_after)
    || !Number.isFinite(packet.score_before) || !Number.isFinite(packet.score_after)
    || (!validProvenance && !rejectedVerificationAttempt)
    || (packet.specialist_output !== null && typeof packet.specialist_output !== "string")
    || (packet.critic_verdict_approved !== null && typeof packet.critic_verdict_approved !== "boolean")
    || (packet.critic_root_cause !== null && typeof packet.critic_root_cause !== "string")
    || !Array.isArray(packet.gates) || !packet.gates.every(isValidGateRecord)
    || !Array.isArray(packet.kb_entries_written) || !packet.kb_entries_written.every(text)
    || (packet.parent_id !== undefined && packet.parent_id !== null && !text(packet.parent_id))) {
    throw new AuditIntegrityError("trace packet has an invalid schema");
  }
}

/** A failed trace may witness the malformed verified claim that the evidence gate rejected. */
function isRejectedVerificationAttempt(value: unknown): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const provenance = value as Record<string, unknown>;
  return provenance.tag === "verified" && typeof provenance.cmd === "string" && provenance.cmd.trim().length > 0
    && typeof provenance.exit === "number" && Number.isSafeInteger(provenance.exit)
    && typeof provenance.stdout_hash === "string";
}

function isValidProvenance(value: unknown): value is Provenance {
  if (value === null || typeof value !== "object") return false;
  const provenance = value as Record<string, unknown>;
  switch (provenance.tag) {
    case "verified": return typeof provenance.cmd === "string" && provenance.cmd.length > 0 && provenance.exit === 0
      && typeof provenance.stdout_hash === "string" && provenance.stdout_hash.length > 0
      && (provenance.check === undefined || isVerificationCheck(provenance.check));
    case "claimed": return typeof provenance.claimant === "string" && provenance.claimant.length > 0;
    case "critic_approved": return typeof provenance.critic === "string" && provenance.critic.length > 0
      && typeof provenance.rationale === "string" && provenance.rationale.length > 0;
    case "generated": return typeof provenance.generator === "string" && provenance.generator.length > 0
      && typeof provenance.input_hash === "string" && provenance.input_hash.length > 0;
    default: return false;
  }
}


function isValidGateRecord(record: GateRecord): boolean {
  const validGates = new Set(["admission", "isolation", "evidence", "audit"]);
  const validResults = new Set(["pass", "fail", "bypass"]);
  if (!validGates.has(record.gate) || !validResults.has(record.result)
    || !record.detail || Number.isNaN(Date.parse(record.checked_at))) return false;
  return record.result !== "bypass" || (typeof record.bypass_evidence_deficit === "string" && record.bypass_evidence_deficit.trim().length > 0);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string" && entry.length > 0);
}

/**
 * Cut `text` to at most `maxBytes` UTF-8 bytes without splitting a multi-byte
 * character, backing off from the byte boundary until it lands outside a
 * continuation byte (`10xxxxxx`, top two bits `10`). Used by
 * `recordAdvisoryEvidence` to cap `payload` while honestly marking the
 * result `payload_truncated` rather than throwing on an oversized finding.
 */
function truncateUtf8Bytes(text: string, maxBytes: number): { value: string; truncated: boolean } {
  const buffer = Buffer.from(text, "utf8");
  if (buffer.byteLength <= maxBytes) return { value: text, truncated: false };
  let end = maxBytes;
  while (end > 0 && (buffer[end] & 0xc0) === 0x80) end -= 1;
  return { value: buffer.subarray(0, end).toString("utf8"), truncated: true };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function hashPacket(packet: object): string {
  return createHash("sha256").update(canonicalJson(packet)).digest("hex");
}

/** JSON with recursively sorted object keys, so hashes do not depend on key order. */

/**
 * Recover the id counter from an existing id, so `fromJSONL` can resume minting
 * without colliding with what it just loaded.
 *
 * EVERY prefix minted from `++this.nextId` must appear here. `phase`,
 * `userinput` and `useranswer` were missing: each was added with its own id
 * prefix without updating this alternation, so a reload under-counted and the
 * next record of that kind reused an id already in the ledger. That is not a
 * restart-only concern — `manager.ts` reseeds a fresh ledger via `fromJSONL` on
 * every `askForUserInput`/`answerUserInput` call, so the SECOND ordinary
 * interview question in a persisted campaign minted a duplicate id and
 * `saveLedger` refused it ("cannot overwrite persisted trace packet
 * userinput_1"), permanently, since the manager only advances its ledger on
 * success. id-prefix-coverage.test.ts scans this file's minting sites and fails
 * if a new kind is ever added without extending this list.
 *
 * Deliberately NOT a generic `/^[a-z]+_(...)$/`: content-addressed ids such as
 * OutputEvidenceStore's `out_<64 hex>` would then parse as astronomical base-36
 * values, push `nextId` past 2**53, and stop `++` from incrementing at all —
 * turning an under-count into a permanent collision on every kind.
 */
function parseTraceId(id: string): number {
  const match = /^(?:trace|recovery|reopen|interruption|communication|memory|telemetry|terminal|notification|compaction|phase|userinput|useranswer|waiver|waiveramend|scopeobsamend|scopeobs|scopeintentbind|scopedec|advisory)_([0-9a-z]+)$/.exec(id);
  return match ? Number.parseInt(match[1], 36) : 0;
}

/** ES2022-compatible replacement for Array.prototype.findLast. */
function latestCampaignHash(packets: readonly AuditRecord[], campaignId: string): string | null {
  for (let index = packets.length - 1; index >= 0; index--) {
    const candidate = packets[index];
    if (candidate.campaign_id === campaignId) return candidate.content_hash;
  }
  return null;
}

function isTracePacket(packet: AuditRecord): packet is TracePacket {
  return packet.kind === undefined || packet.kind === "trace";
}

function canReadCommunication(reader: NodeCommunication["capability_tier"], required: NodeCommunication["capability_tier"]): boolean {
  const rank: Record<NodeCommunication["capability_tier"], number> = { specialist: 0, critic: 1, auditor: 2, orchestrator: 3 };
  return rank[reader] >= rank[required];
}

/** Visibility is monotonic across typed witness links. Trace visibility remains governed elsewhere. */
function isRestrictedMemoryWitness(record: AuditRecord): boolean {
  if (record.kind === "memory_fact") return record.fact.tier === "critic_only";
  if (record.kind === "node_communication") return record.communication.capability_tier !== "specialist";
  return false;
}
