/**
 * arbor-opencode/loop — the deterministic tree-search campaign loop.
 *
 * This is the executable core of the `/arbor` skill (ROADMAP §2.3). It drives a
 * CampaignManager through the canonical cycle:
 *
 *   select → expand (isolation gate) → dispatch specialist (KB-injected)
 *         → critic review → record result → branch | backtrack → halt check
 *
 * The loop is deterministic and the executor is injected, so it runs in three
 * modes:
 *   1. against fakes (unit tests — this file's tests)
 *   2. against a real agent adapter (the opencode `/arbor` skill wires Seeds and
 *      Lenticel via task())
 *   3. against a headless adapter (CLI/CI where agent calls are scripted)
 *
 * Checks-and-balances (ADR-001) are enforced structurally:
 *   - Crown (this loop) selects and records, but never approves — the critic
 *     verdict decides.
 *   - Isolation is mandatory before expansion.
 *   - KB injection is mandatory before every specialist + critic dispatch.
 *   - Only !verified provenance retires a branch; !claimed stays 'claimed'.
 *
 * The loop's only job is to CALL the manager in the right order and wire the
 * executor. It does not write code, score anything, or judge — that's Lenticel.
 */

import type {
  PhaseMessageInput,
  RequestUserInputInput,
  TelemetryModelFamily,
  TelemetryProvider,
  UserInputAuthority,
  UserInputBlocking,
  UserInputOption,
} from "@arbor/audit";
import { PHASE_MESSAGE_MAX_CONTENT_BYTES } from "@arbor/audit";
import type {
  Action,
  ActionExecutionRole,
  CandidateArtifact,
  CapabilityContext,
  CriticVerdict,
  Cost,
  DecomposerPort,
  GovernanceTier,
  HaltReason,
  NodeCard,
  NodeError,
  NodeErrorKind,
  NodeState,
  OutputBudget,
  Provenance,
  RaceOutcomeObservation,
  ScoreContext,
  TokenUsage,
  TokenUsageResult,
} from "@arbor/core";
import { verifyNodeCard } from "@arbor/core";
import { deriveCandidateNodeCard } from "@arbor/core";
import { isTerminalNodeState } from "@arbor/core";
import { buildContextEconomyObservation } from "./context-economy.js";
import { createHash } from "node:crypto";
import {
  WorktreeManager,
  MAX_DECOMPOSITION_DEPTH,
  decompositionDepthOf,
  decompositionProvenance,
  depthBoundReached,
  validateDecomposition,
  PanelOfCritics,
  type PanelDecision,
  type ReviewerRunner,
  appendSelectionCommunications,
  type SelectionCommunicationPort,
  prepareOutput,
  excerptCapturedField,
  suppressRoutineSuccess,
  type OutputEvidenceCapturePort,
  type PreparedOutput,
  ContextOverflowError,
  prepareTokenDispatch,
  type TokenEconomyConfig,
  type TokenDispatchPreparation,
  buildNodeCostAttribution,
  aggregatePanelUsageCost,
  buildRetryContextCapsule,
  projectRetryContextCapsule,
  decideRetryContinuation,
  deriveFailureFingerprint,
  FIELD_MAX_BYTES,
  type RetryContextCapsule,
  type RetryContextProjection,
  type FailureClassificationInput,
  type TaskFact as RetryTaskFact,
  type ChangedFile as RetryChangedFile,
  type EvidenceRef as RetryEvidenceRef,
  type CriticRequirement as RetryCriticRequirement,
  type ToolSignature as RetryToolSignature,
  assessAnalyzerApplicability,
  computeDiffChangedFiles,
  computeSiblingSiteNote,
  computeSiblingSites,
  type SiblingSite,
} from "@arbor/campaign-support";
import { raceSpecialize, isRaceEligible, resolveForkThresholdMs, type RaceResult } from "./race.js";

// ============================================================
// MANAGER PORT — structural match for @arbor/mcp's CampaignManager
// ============================================================

/**
 * The subset of `@arbor/mcp`'s `CampaignManager` (manager.ts) this loop
 * drives. Defined locally rather than imported: `@arbor/mcp` imports
 * `@arbor/opencode` at runtime (real value imports in `cli.ts`, `demo.ts`,
 * `recovery-lease-adapter.ts`, `loop-ports-helper.ts`), so a value-erasing
 * `import type { CampaignManager } from "@arbor/mcp"` here still forces
 * `arbor-opencode`'s tsconfig to reference `arbor-mcp` for `tsc --build` to
 * resolve the type — completing a real cycle in the project-reference
 * graph, not merely the runtime module graph. `@arbor/mcp`'s own
 * `loop-adapters.ts` already uses this identical "structural match" pattern
 * in the opposite direction (`ManagerSelectionCommunicationPort`,
 * `ManagerOutputEvidenceCapturePort`, `ManagerTelemetryPort`) for exactly
 * this reason — arbor-opencode adopting it here is the same convention, not
 * a new one. `CampaignManager` structurally satisfies this port with no
 * adapter needed: every call site in this file passes a real
 * `CampaignManager` instance, and the compiler checks the match at that call
 * site regardless of which package declares the interface.
 */
export interface CampaignManagerPort {
  selectNode(campaignId: string, ctx: ScoreContext): string | null;
  selectNodeWithCard(
    campaignId: string,
    ctx: ScoreContext,
    options: { taskSkills?: readonly string[]; requestedTier?: NodeCard["tier"]; cards?: readonly NodeCard[] },
  ): { node_id: string | null; card: NodeCard | null };
  expandNode(
    campaignId: string,
    nodeId: string,
    isolationCheck: { worktree_isolated: boolean; starting_commit_correct: boolean; lease_acquired: boolean },
  ): { ok: true } | { ok: false; gate: { detail: string } };
  recordResult(
    campaignId: string,
    nodeId: string,
    params: {
      specialist_output: string;
      specialist_agent: string;
      provenance: Provenance;
      critic_agent: string;
      critic_approved: boolean;
      critic_rationale: string;
      critic_root_cause?: string;
      /** Trusted acceptance command attempted and failed; critic approval cannot override it. */
      verification_failure?: { readonly code: string; readonly exit?: number; readonly diagnostic?: string; readonly stages?: VerificationStageProgress };
      /** A complete, parsed five-mandate verdict. Absent only for non-critic paths. */
      critic_verdict?: CriticVerdict;
      node_error?: NodeError;
      /** ADR-062 `direct` tier: present only when this result was accepted without a real critic verdict. */
      review_waived?: { readonly by: string; readonly reason: string };
      score_ctx: ScoreContext;
    },
  ): { state: NodeState; backtrack_parent: string | null; kb_entry_id: string | null };
  /** ADR-062 bounded critic-block retry: revive a `"failed"` node back to `"pending"`. */
  reviveNodeForRetry(campaignId: string, nodeId: string): void;
  /** Bounded corrective retry after trusted write-scope enforcement blocks a result. */
  reviveNodeForScopeRetry(campaignId: string, nodeId: string): void;
  branch(campaignId: string, parentId: string, actions: Action[]): string[];
  /** Capture the specialist's completed output as a durable candidate BEFORE critic dispatch. */
  recordCandidate(
    campaignId: string,
    nodeId: string,
    candidate: { specialist_output: string; specialist_agent: string; provenance: Provenance; token_usage?: TokenUsageResult },
  ): void;
  /** Critic DISPATCH itself failed (transport/timeout) — the node stays `"awaiting_review"`, the candidate is untouched. */
  recordReviewFailure(campaignId: string, nodeId: string, error: NodeError): void;
  /** B3: ids of nodes stranded `"awaiting_review"` with a durably captured candidate whose review never completed. */
  resumableReviewNodes(campaignId: string): string[];
  /** Fast, free preflight: catches a missing/invalid tool authority before any model call. */
  projectDispatchPreflight(
    campaignId: string,
    nodeId: string,
  ): { workspace: "ready" | "not_ready"; authority: "sufficient" | "missing"; reasons: readonly string[] };
  haltStatus(campaignId: string): { halted: boolean; reason: HaltReason };
  isHalted(campaignId: string): { halted: boolean; reason: HaltReason };
  completeAutoHalt(campaignId: string, reason: HaltReason): { ok: true; version: string };
  /**
   * WA-40: durably record the FIRST actionable failure this run hit (e.g. an
   * isolation-gate refusal that fails a node before any specialist runs) so
   * `runtime.ts`'s settlement can surface it even when the campaign's own
   * halt reason ends up a generic exhaustion label. See
   * `manager.recordCampaignRunDiagnostic`'s own doc for the durable field
   * this writes onto the campaign snapshot.
   */
  recordCampaignRunDiagnostic(campaignId: string, diagnostic: { message: string; stack_head?: string }): void;
  /** The durable diagnostic last recorded via `recordCampaignRunDiagnostic`, if any. */
  getCampaignRunDiagnostic(campaignId: string): { message: string; stack_head?: string; recorded_at: string } | null;
  kbInject(prompt: string, campaignId: string, cap: CapabilityContext, nodeId?: string): string;
  /** Only the `pruned` count is ever read from this — see `countPruned`. */
  auditCampaign(campaignId: string): unknown;
  getLatestEvidenceId(campaignId: string): string | null;
  getNodeInfo(
    campaignId: string,
    nodeId: string,
  ): {
    action: Action;
    score: number;
    parent_id: string | null;
    provenance?: Provenance | null;
    /**
     * Widened for the decompose recovery path (G-08): the real
     * `CampaignManager.getNodeInfo` (arbor-mcp/manager.ts) already returns
     * `state` and `children_ids` on every call — this only exposes what was
     * already there. `children_ids.length > 0` while a node is still
     * "expanding" is the tree-derived idempotency check: only a prior
     * decomposition could have given an in-flight node children (the normal
     * `branch_actions` path only ever fires after a node reaches
     * verified/claimed), so this can never be true on a node's first
     * dispatch and is always true after a real decomposition of it.
     */
    state: NodeState;
    children_ids: readonly string[];
    /** B3: durable pre-review candidate (see `resumeStrandedReviews`), when captured. */
    candidate?: CandidateArtifact;
    /** ADR-062: bounded critic-block retries already spent on this node. */
    critic_retry_count?: number;
    scope_retry_count?: number;
    /** Durable expansion visit used to scope per-attempt token recovery epochs. */
    visit_count?: number;
  } | null;
  getCampaignSnapshot(campaignId: string): {
    root_id: string;
    nodes: readonly {
      id: string;
      state: NodeState;
      action_description: string;
      action_category: string;
      action_delegate: string;
    }[];
    /**
     * X-1 (ADR-067): the campaign's recorded governance-tier decision, when
     * one exists. Widened additively — the real `CampaignManager` already
     * returns this (ADR-062); test fakes that omit it simply gate racing
     * off, which is the correct conservative default.
     */
    governance?: { tier: GovernanceTier } | null;
  } | null;
  getCompactionGuard(campaignId: string, nodeId: string): { active: boolean; since: string | null };
  askForUserInput(input: RequestUserInputInput): string;
  awaitingUserInput(campaignId: string): boolean;
  incrementNoKbIteration(campaignId: string): void;
}

// ============================================================
// EXECUTOR INTERFACE — the adapter the loop calls
// ============================================================

/**
 * A specialist or critic's typed signal that it cannot proceed without a
 * human answer (ADR-019, Phase 4D.8). Before this existed, `askForUserInput`
 * had exactly one caller — the runtime catalog's own operator-driven
 * dispatcher — so no agent and no loop path ever raised a question; the
 * pending-interview guard in this file genuinely blocked selection but had
 * nothing to guard. This is the origination point.
 */
export interface NeedsUserInputSignal {
  /** Bounded question text (ADR-019: capability-consistent projection). */
  question: string;
  /** Bounded options, each carrying its own `is_other` escape. */
  options: readonly UserInputOption[];
  /** Mode-scoped attribution recorded on the ledger transition. */
  requester_role: string;
  /** Correlates a request to its source harness session, not to an approver. */
  origin_session_id?: string;
  /** Caller-supplied idempotency key so a retried dispatch does not duplicate the ledger record. */
  idempotency_key: string;
}

/** Result of a specialist (Seed/Heartwood) dispatch. */
/** Y-1 (ADR-065): audit-tier write-scope mismatch evidence; see `SpecialistResult.deferred_verification`. */
/**
 * ADR-185: the machine verifier's graded signal for a failed plan -- how many
 * of its declared stages (each declared verification command, fail-fast)
 * passed. The manager turns it into the measured partial reward.
 */
export interface VerificationStageProgress {
  readonly passed: number;
  readonly total: number;
}

export interface ScopeObservationEvidence {
  readonly declared: readonly string[];
  readonly observed_out_of_scope: readonly string[];
  readonly enforcement: "audit" | "blocked";
}

export interface SpecialistResult {
  output: string;
  /** Provenance of the work. Set by the executor based on how it verified. */
  provenance: Extract<
    import("@arbor/core").Provenance,
    { tag: "verified" } | { tag: "claimed" }
  >;
  /**
   * Provider-observed usage for the expansion epoch, including cache
   * accounting — or a typed reason it could not be recovered. Required: an
   * executor must state why usage is absent rather than omitting the field.
   */
  token_usage: TokenUsageResult;
  /** Honest cost observation for this call, if the executor has one. */
  usage_cost?: ExecutorUsageCost;
  /** Exact configured model identity observed by the executor. */
  model_identity?: string;
  /** Independently observed verification output used for exact containment. */
  verification_evidence?: string;
  /**
   * OPT-1 (pipelined verification): a machine-verification observation the
   * executor STARTED but deliberately did not await, so the loop can overlap
   * it with critic dispatch — verification and critic both consume the
   * finished specialist output and are independent of each other, so running
   * them sequentially only added their wall times. Resolves to the upgraded
   * provenance when the verifier observed success, or null (the returned
   * `provenance` stands). Executors MUST attach their own catch — this
   * promise never rejects. The loop awaits it after the critic settles and
   * uses the upgrade at recordResult; evidence rules are unchanged (the
   * upgrade still comes only from the independent machine observation).
   */
  /**
   * Y-1 (ADR-065): an audit-tier write-scope mismatch the verifier observed.
   * Structurally mirrors arbor-mcp's `ScopeMismatchObservation` — the
   * dependency direction (mcp depends on opencode) forbids importing it here.
   */
  deferred_verification?: Promise<
    | {
        provenance: SpecialistResult["provenance"];
        /** Exact argv returned by the trusted machine-verification port. */
        verification_command_argv?: readonly string[];
        scope_observation?: ScopeObservationEvidence;
        /**
         * E-7c (ADR-063): the campaign/node identity the verification
         * evidence actually originated from, so the loop can echo it into
         * `recordResult`'s `verification_source` and let the manager's own
         * evidence-replay check confirm it matches this call's target
         * instead of silently discarding it. Optional: an executor that has
         * not been updated to carry this identity still upgrades provenance
         * exactly as before, just without replay protection.
         */
        verification_source?: { readonly campaign_id: string; readonly node_id: string };
      }
    /**
     * E-2 (arXiv 2607.13034): a real machine-verification FAILURE (a
     * command was derived and actually run but did not exit cleanly),
     * distinct from `null` ("nothing was attempted" — no port, no
     * declared command, aborted, or non-admitted worktree). Only this
     * shape may justify a turn-budget expansion on a subsequent
     * critic-block retry.
     */
    | { attempted: true; failed: true; code?: string; exit?: number; diagnostic?: string; scope_observation?: ScopeObservationEvidence; stages?: VerificationStageProgress }
    | null
  >;
  /** Content-minimized tool name + input-summary signatures for redundancy attribution. */
  tool_call_signatures?: readonly string[];
  /** Privacy-safe context-composition counts for the native context layer, if the executor observed one. */
  context_composition?: ExecutorContextComposition;
  tool_economy?: ExecutorToolEconomy;
  /**
   * Bounded, digest-only worktree deltas observed after the specialist turn.
   * Raw file contents and diffs never cross this executor boundary.
   */
  changed_files?: readonly import("@arbor/campaign-support").ChangedFile[];
  /** Set when the specialist cannot proceed without a human answer (ADR-019). */
  needs_input?: NeedsUserInputSignal;
  /**
   * A classified operational failure (G-08): the executor boundary — spawn
   * errors, timeouts, non-zero exits, transport failures — construct this
   * instead of burying the failure as unstructured text in `output`. Never
   * set alongside genuine work; when present the loop records the node as
   * failed without dispatching a critic on a result that never happened.
   */
  error?: NodeError;
}

/** Result of a critic (Lenticel) review. */
export interface CriticResult {
  approved: boolean;
  rationale: string;
  root_cause?: string; // Required on rejection (Five-Point Mandate #1)
  critic_agent?: string;
  /** Whether measurement validation passed (Five-Point Mandate #2). */
  measurement_validated?: boolean;
  /**
   * The actual five-mandate verdict emitted by a critic transport.  This is
   * intentionally optional because isolation/transport failures do not have
   * a critic verdict at all; callers must never synthesize one for them.
   */
  verdict?: CriticVerdict;
  /** Provider-observed usage for this review, or a typed reason it is unavailable. */
  token_usage: TokenUsageResult;
  /** Honest cost observation for this call, if the executor has one. */
  usage_cost?: ExecutorUsageCost;
  /** Exact configured model identity observed by the executor. */
  model_identity?: string;
  tool_call_signatures?: readonly string[];
  /** Privacy-safe context-composition counts for the native context layer, if the executor observed one. */
  context_composition?: ExecutorContextComposition;
  tool_economy?: ExecutorToolEconomy;
  /** Set when the critic cannot render a verdict without a human answer (ADR-019). */
  needs_input?: NeedsUserInputSignal;
  /** A classified operational failure dispatching the critic itself (G-08). */
  error?: NodeError;
}

/** Provider/model categories are closed audit dimensions; price identity stays in Cost. */
export interface ExecutorUsageCost {
  provider: TelemetryProvider;
  model_family: TelemetryModelFamily;
  cost: Cost;
}

/**
 * Structural mirror of `NativeContextCompositionObservation` (@arbor/harness).
 * Defined independently rather than imported so arbor-opencode never gains a
 * dependency on arbor-harness; token counts only, never raw prompt text.
 */
export interface ExecutorContextComposition {
  offered_tokens: number;
  retained_tokens: number;
  pruned_tokens: number;
  indexed_reference_tokens: number;
  stable_prefix_tokens: number;
  dynamic_tokens: number;
  /** Bounded per-source breakdown; structural mirror of `NativeContextSourceComposition` (@arbor/harness). */
  per_source: readonly ExecutorContextSourceComposition[];
}

export interface ExecutorContextSourceComposition {
  source: "system_instructions" | "project_instructions" | "task" | "repository_graph" | "code" | "tool_output" | "trajectory" | "memory" | "critic_feedback" | "human_input";
  offered_tokens: number;
  retained_tokens: number;
  cache_class: "stable" | "dynamic";
  disposition: "absent" | "retained" | "pruned" | "indexed" | "mixed";
  reason: string;
  provenance: import("@arbor/core").Provenance;
  evidence_pointer: string;
}

export interface ExecutorToolEconomy {
  offered_calls: number;
  host_executions: number;
  reused_reads: number;
  avoided_output_bytes: number;
}

export interface NodeRoutingDecision {
  readonly difficulty: number;
  readonly expansion_depth: number;
  readonly model_tier: "economical" | "balanced" | "capable";
  readonly evidence_ref: string;
}

/**
 * The executor the loop needs. Implementations vary by runtime:
 *   - opencode: task(subagent_type="seed", prompt=...) for specialists,
 *               task(subagent_type="lenticel", prompt=...) for critics
 *   - test fake: returns canned results
 *
 * The loop passes the KB-injected prompt to each call; the executor is
 * responsible for routing it to the right agent.
 */
export interface LoopExecutor {
  /** Dispatch a specialist to work on a node in its isolated worktree. */
  specialize(params: {
    campaign_id: string;
    node_id: string;
    action: Action;
    prompt: string; // role prompt + task + KB-injected context
    worktree_path: string;
    specialist_agent: string;
    /** Optional durable role request; hosts may only reduce authority from it. */
    execution_role?: ActionExecutionRole;
    /** Optional exact declarative skill identity; hosts may only reduce authority from it. */
    skill_id?: string;
    skill_version?: string;
    skill_inputs?: Action["skill_inputs"];
    skill_inputs_provenance?: Action["skill_inputs_provenance"];
    /** Evidence-derived routing refines model/depth only; it never selects the node. */
    routing?: NodeRoutingDecision;
    /** Digest-only retry deltas may focus repository retrieval without replaying prior context. */
    retrieval_changed_paths?: readonly string[];
    /**
     * E-2 (arXiv 2607.13034): the current turn-budget estimate for this
     * dispatch (the arbiter's per-tier estimate, or an already-expanded
     * value after a failed-verification critic-block retry). Absent means
     * no estimate is available; the executor falls back to its own
     * existing default, byte-identical to pre-E-2 behavior.
     */
    turn_budget_estimate?: number;
    /** Cooperative cancellation for the dispatched operation. */
    signal?: AbortSignal;
  }): Promise<SpecialistResult>;

  /** Dispatch the critic to review a specialist's output. */
  review(params: {
    campaign_id: string;
    node_id: string;
    action: Action;
    specialist_output: string;
    specialist_agent: string;
    prompt: string; // role prompt + KB-injected context (critic sees all)
    critic_agent: string;
    /** Cooperative cancellation for the dispatched operation. */
    signal?: AbortSignal;
  }): Promise<CriticResult>;

  /** Report progress/events (logger hook). */
  log?(event: LoopEvent): void;
}

/** Events the loop emits to the executor's log hook. */
export type LoopEvent =
  | { type: "campaign_start"; campaign_id: string }
  | { type: "leases_reconciled"; live: number; stale: number; reclaimed: number; diagnostics: number }
  | { type: "selected"; node_id: string; category: string }
  | { type: "expanded"; node_id: string }
  | { type: "workspace_composed"; node_id: string; source_node_ids: readonly string[] }
  | { type: "specialist_dispatched"; node_id: string; agent: string }
  | { type: "critic_dispatched"; node_id: string; agent: string }
  | { type: "compaction_interrupted"; node_id: string; reason: string }
  | { type: "node_verified"; node_id: string; score: number }
  | { type: "node_claimed"; node_id: string; score: number }
  | { type: "node_failed"; node_id: string; root_cause: string }
  /**
   * A critic transport/timeout failure (never a rendered verdict) left the
   * node `"awaiting_review"` with its candidate intact instead of scoring it
   * as a failure (tranche1 §13 item 3). Distinct from `node_failed`: no
   * failure was recorded, and real specialist work is still waiting on a
   * genuine review.
   */
  | { type: "review_pending"; node_id: string; reason: string }
  /** A trusted machine-verification attempt failed; bounded class only, never raw output. */
  | { type: "review_failed_after_machine_failure"; node_id: string; reason: string }
  | { type: "machine_verification_failed"; node_id: string; code: string; exit?: number }
  | { type: "branched"; parent_id: string; children: number }
  | { type: "backtracked"; node_id: string; parent_id: string | null }
  | { type: "halt"; reason: string }
  | { type: "iteration"; index: number }
  | { type: "cancelled"; reason: string }
  | { type: "token_budget_warning"; node_id: string; epoch_id: string }
  | { type: "context_management_claimed"; node_id: string; epoch_id: string }
  | { type: "overflow_recovered"; node_id: string; epoch_id: string; recovered_from_tokens: number; retries_used: 1 }
  | { type: "dispatch_suppressed"; node_id: string; reason: "eligible_context_overflow"; overflow_tokens: number; retry: TokenDispatchPreparation["overflow_retry"] }
  | { type: "awaiting_user_input"; campaign_id: string }
  | { type: "compaction_skipped"; node_id: string; reason: string }
  /** ADR-062 bounded critic-block retry: a rejected node was revived to `"pending"` instead of staying terminal. */
  | { type: "critic_retry"; node_id: string; attempt: number; max_retries: number }
  | { type: "scope_retry"; node_id: string; attempt: number; max_retries: number; paths: readonly string[] }
  /**
   * G-08 bounded operational retry: a node that hit the decomposer-declines-
   * as-atomic dead end (see `OPERATIONAL_RETRY_CEILING`'s doc) was recorded
   * as failed, then revived to `"pending"` for one bounded re-dispatch —
   * never more than `max_retries`.
   */
  | { type: "operational_retry"; node_id: string; attempt: number; max_retries: number; kind: NodeErrorKind }
  | {
      type: "retry_advisory";
      node_id: string;
      action: "continue" | "decompose" | "stop";
      reason: string;
      occurrences: number;
      enforced: boolean;
    }
  /**
   * A timed-out node was split via `DecomposerPort` + `decompose-policy.ts`
   * instead of being recorded as a terminal failure (G-08's
   * `timeout -> "decompose"` recovery). `provenance` is always
   * `{tag: "generated"}` — decomposition children are model-proposed, never
   * `claimed` or `verified`.
   */
  | { type: "decomposed"; node_id: string; children: number; depth: number; provenance: Extract<Provenance, { tag: "generated" }> }
  /**
   * Emitted once per iteration only when `task_skills` is set (capability
   * routing is engaged). `matched: true` means `manager.selectNodeWithCard`'s
   * best-overlap card agreed with UCT's own pick for this round and was
   * attached; `false` means either no card cleared verification/overlap for
   * the UCT-selected node, or the best card pointed at a different node (UCT
   * wins on mismatch). This makes capability routing's real effect
   * observable from outside `runCampaign` — see loop.test.ts.
   */
  | { type: "capability_routed"; node_id: string; matched: boolean }
  | { type: "difficulty_routed"; node_id: string; decision: NodeRoutingDecision }
  /** A durable governed overlay checkpoint was sampled for this dispatch. */
  | { type: "governed_overlay_checkpoint"; node_id: string; applied: number; unapplied: number }
  /** X-1 (ADR-067): the race gate engaged and forked a second specialist attempt past the fork threshold. */
  | { type: "race_forked"; node_id: string; forked_at_ms: number }
  /** X-1 (ADR-067): a race (forked or not) reached its outcome. */
  | { type: "race_settled"; node_id: string; winner: "primary" | "fork" | "none"; cancelled: boolean }
  /** The ledger refused a race observation (validation). Telemetry stays projection-only, but the refusal is no longer invisible. */
  | { type: "race_telemetry_rejected"; node_id: string; reason: string }
  | { type: "phase_message_truncated"; node_id: string; original_bytes: number; kept_bytes: number }
  /**
   * Periodic proof-of-life while a specialist/critic dispatch is still
   * in-flight. `executor.specialize`/`executor.review` are a single opaque
   * `await` from this loop's perspective — a 2026-08-27 hour-long real
   * capture (`arbor run` without `--once`, default 900s specialist timeout)
   * showed exactly the resulting blind spot: one `specialist_dispatched`
   * line, then total ledger silence for the rest of the hour, with nothing
   * to tell "still genuinely working" apart from "wedged" — not even the
   * eventual timeout/failure ever arrived inside the capture window,
   * because a dispatch's real worst-case wall time (the specialist's own
   * budget, plus opencode-executor.ts's post-hoc diff/change capture and
   * verification, none of which shorten on a specialist failure) is several
   * multiples of the specialist timeout alone. This event changes no
   * semantics — no timeout, retry, or cancellation follows from it — it
   * only makes an in-flight dispatch observable while the loop waits on it.
   */
  | { type: "dispatch_heartbeat"; node_id: string; phase: "specialist" | "critic"; elapsed_ms: number };

// ============================================================
// LOOP CONFIGURATION
// ============================================================

export interface CampaignLoopConfig {
  /** Max loop iterations before forcing a halt (safety). Default 100. */
  max_iterations: number;
  /** Base prompt injected into every specialist. */
  specialist_base_prompt: string;
  /** Base prompt injected into every critic. */
  critic_base_prompt: string;
  /**
   * Project-authored acceptance commands (config `verification.acceptance_commands`).
   * Named to the specialist and run by the harness for nodes whose plan
   * declared no command of its own.
   */
  acceptance_commands?: readonly (readonly string[])[];
  /** Tier used for specialist KB injection (ADR-005). */
  specialist_cap: CapabilityContext;
  /** Tier used for critic KB injection (ADR-005). */
  critic_cap: CapabilityContext;
  /** How fresh the score context must be. Loop derives it each iteration, scoped to the campaign under search. */
  score_ctx: (campaignId: string) => ScoreContext;
  /** Whether to create git worktrees (default true). Tests pass false + dryRun. */
  use_worktrees: boolean;
  /** Actions to branch from a node, given its action + verified output. */
  branch_actions: (params: {
    action: Action;
    output: string;
  }) => Action[] | null;
  /** Selection/stopping policy inside the one canonical campaign runner. */
  execution_strategy?: CampaignExecutionStrategy;
  /**
   * Optional panel-of-critics (Phase 3.4). When set, `runReviewer` dispatches
   * the individual panel critics; the panel reconciles a single decision and
   * Lenticel's word is binding.
   */
  panel?: PanelOfCritics;
  /** Dispatch a single panel critic. Required when panel is set. */
  run_reviewer?: ReviewerRunner;
  /** Capability-filtered, bounded communication projection read at selection. */
  communications?: SelectionCommunicationPort;
  /** Maximum communication facts injected per role. Default 20, capped at 100. */
  communication_limit?: number;
  /** Independent aggregate model-context ceiling for communication injection. */
  communication_budget?: OutputBudget;
  /** Injectable wall clock used to create a single immutable selection checkpoint. */
  communication_clock?: () => string;
  /** Durable sink required before oversized agent/tool output may propagate. */
  output_evidence?: OutputEvidenceCapturePort;
  /** Independent model-context budget for agent/tool outputs. */
  output_budget?: OutputBudget;
  /** Durable, provider-aware context economy. Omitted only for legacy adapters. */
  token_economy?: TokenEconomyConfig;
  /** Canonical runtime interruption sink. Required to persist cancellation/overflow as a recoverable outcome. */
  interruptions?: LoopInterruptionPort;
  /** Ledger-backed telemetry emission for loop phase timing and provider cost. Omitted for legacy adapters. */
  telemetry?: LoopTelemetryPort;
  /**
   * Optional adopt-result capture. Called once per node, just before its
   * worktree lease is released and the worktree removed, so a verified (or
   * merely completed) node's changes can be durably captured for later
   * operator adoption. It is passive and best-effort: it never grants
   * authority, mutates the tree, or fails the loop.
   */
  result_capture?: LoopResultCapturePort;
  /**
   * Materializes explicit prerequisite results into a fresh node worktree.
   * Required whenever `action.depends_on` is non-empty: without it a
   * downstream verifier would test pristine HEAD rather than the work it
   * claims to verify.
   */
  workspace_composition?: LoopWorkspaceCompositionPort;
  /** Optional list-rate threshold for an advisory expensive-without-progress signal. */
  expensive_unproductive_threshold_minor_units?: number;
  /**
   * Interval, in ms, for `dispatch_heartbeat` proof-of-life events emitted
   * while a specialist/critic dispatch is in flight. `0`/negative disables
   * heartbeats entirely (legacy silence). Defaults to
   * `DEFAULT_DISPATCH_HEARTBEAT_MS`.
   */
  dispatch_heartbeat_ms?: number;
  /**
   * Optional capability routing (Phase 4D.3/4D.4): when task skills are given,
   * selection refines through NodeCard capability routing (selectNodeWithCard).
   * The loop builds a live `NodeCard` for every pending (selectable) node in
   * the campaign tree — via `deriveCandidateNodeCard` — and passes that set
   * to `manager.selectNodeWithCard`. UCT is always the authority; the card
   * only refines the pick, and `manager.ts`'s own comment on
   * `selectNodeWithCard` documents this: "on mismatch, UCT wins". This loop
   * has no lever to change that (it is manager-owned), and advisory is the
   * correct default anyway — checks-and-balances (ADR-001) means the tree,
   * not a re-derivable capability projection, retires or advances a branch.
   */
  task_skills?: readonly string[];
  /**
   * HMAC secret used to sign the live `NodeCard`s built for capability
   * routing (see `task_skills`). This is an internal-integrity signature, not
   * a trust boundary yet (per 4D.3: "the verifiable-identity step, still
   * entirely internal") — callers that don't cross a trust boundary can rely
   * on `DEFAULT_NODE_CARD_SECRET`.
   */
  card_secret?: string;
  /** Optional evidence-backed policy for how the UCT-selected node is executed. */
  node_routing?: {
    route(input: { description: string; category: string; constraints: readonly string[]; estimated_gain: number; estimated_cost: number; high_stakes?: boolean; decomposition_depth?: number }): NodeRoutingDecision;
    recordOutcome(input: { category: string; succeeded: boolean }): void;
  };
  /** Optional compact-every-N-iterations policy. When set and the guard is
   * clear, the loop emits a `compaction_skipped` event — no
   * `CompactionLifecycle` ledger record is written, because no structural
   * folding is implemented yet (G-04): claiming `status: "completed"` for a
   * compaction that never folded anything is a fabricated ledger record, and
   * the manager's own validator correctly rejects it. 0/omitted = the check
   * never runs. */
  compaction_every_iterations?: number;
  /** Authority that performs a real structural fold, durably writes the
   * replacement anchor, and only then reports its evidence identifiers. */
  structural_compaction?: {
    compact(input: { campaign_id: string; node_id: string; iteration: number; signal?: AbortSignal }): Promise<
      | { status: "completed"; pre_evidence_id: string; post_evidence_id: string; anchor_summary_id: string }
      | { status: "skipped" | "interrupted" | "failed"; reason: string }
    >;
  };
  /**
   * Optional LLM-backed decomposer (G-08's `timeout -> "decompose"`
   * recovery, `FAULT_MATRIX`). Omitted = unchanged legacy behavior: a
   * timeout records the node's typed failure exactly as before this field
   * existed. When set, a timed-out node whose `FAULT_MATRIX` recovery is
   * `"decompose"` is offered to this port first; the port only proposes,
   * `decompose-policy.ts` bounds and validates before any child becomes a
   * real tree node (see `attemptDecomposition`).
   */
  decomposer?: DecomposerPort;
  /** Per-dispatch foreground projection. The caller resolves model/config
   * inputs; the loop supplies the live campaign node and agent identity. */
  foreground?: {
    derive(input: {
      campaign_id: string;
      node_id: string;
      agent: string;
      capability: "specialist" | "critic";
    }): { readonly prompt_fragment: string };
  };
  /**
   * Campaign-local context/harness projection sampled exactly once after node
   * selection.  This is intentionally a structural port: @arbor/opencode
   * cannot import @arbor/mcp without making a project-reference cycle.
   *
   * The loop consumes only the bounded prompt/context fields below. Retrieval
   * policy and declarative subagent descriptors remain visible as unapplied
   * dispositions until an isolated executor exposes typed semantics for them;
   * they must never be guessed into a prompt or a capability grant.
   */
  governed_context?: GovernedOverlayCheckpointPort;
  /**
   * Optional bounded retry-context capsule port (see `CampaignRetryContextPort`).
   * Omitted = unchanged legacy behavior: prompts are byte-identical to before
   * this port existed, and no capsule is ever built or persisted.
   */
  retry_context?: CampaignRetryContextPort;
  /**
   * Y-3 (ADR-066): injectable generated-oracle amplifier, called only when
   * the sibling-site scan flagged remaining sites. The composition root
   * supplies arbor-mcp's `amplifySiblingSites` (the dependency direction
   * forbids importing it here). Findings are EVIDENCE ONLY — each `note`
   * joins the critic prompt; nothing feeds outcomes or provenance. Omitted
   * = no amplification, byte-identical prompts.
   */
  test_amplifier?: (input: { worktree_path: string; flagged_sites: readonly SiblingSite[]; campaign_id: string; node_id: string; signal: AbortSignal }) => Promise<readonly { readonly note: string; readonly generator?: "test_amplifier" | "mutation_probe" }[]>;
  /**
   * ADR-069 (X-1): composition-supplied fork-threshold resolver (learned
   * p50 from the ledger's own history, with provenance). Omitted = the
   * fixed env/default threshold, provenance "default".
   */
  fork_threshold?: (taskCategory: string) => { thresholdMs: number; source: "learned" | "env" | "default"; observations: number };
  /** ADR-071 (PM-1): none-tie arbitration for forked races where neither attempt verified; see race.ts's `tie_breaker`. */
  race_tie_breaker?: (a: SpecialistResult, b: SpecialistResult, signal?: AbortSignal) => Promise<"primary" | "fork" | null>;
  /**
   * When true, a `decideRetryContinuation` "decompose"/"stop" advisory
   * against a loaded capsule with no material fingerprint/digest delta since
   * the last attempt suppresses this iteration's specialist dispatch — the
   * node is recorded as failed via the same loop-owned path an isolation-gate
   * rejection uses, never through the critic or verification path. Default
   * false: the advisory is always computed and available for telemetry/tests,
   * but never changes control flow unless explicitly opted in.
   */
  retry_advisory_enforcement?: boolean;
  /**
   * ADR-062 bounded critic-block retry. Omitted/`max_retries: 0` = unchanged
   * legacy behavior: a critic rejection (or an evidence-gate failure after
   * critic approval) is terminal and the loop backtracks exactly as before
   * this field existed. When `max_retries > 0`, a rejected node whose own
   * `critic_retry_count` (persisted on the tree node) is still below the cap
   * is revived to `"pending"` instead of staying terminal — its next
   * dispatch picks up the rejection rationale via the already-saved
   * retry-context capsule (`saveRetryContext`, run unconditionally on every
   * critic-block failure). Capped per node, never an unbounded loop.
   */
  critic_retry?: { max_retries: number };
  /** Bounded retry after machine enforcement rejects out-of-scope writes. */
  scope_retry?: { max_retries: number };
  /**
   * E-2 (arXiv 2607.13034, manifest item E3): the arbiter's per-tier
   * turn-budget estimate for this campaign/node (see
   * `ArbiterDecision.turn_budget_estimate`). Threaded into every
   * `executor.specialize()` dispatch as `turn_budget_estimate`; a
   * connector's own `ARBOR_CLAUDE_CODE_MAX_TURNS`-style env override still
   * wins over it. Absent = unchanged pre-E-2 behavior (the executor's own
   * default applies). Doubled (capped at `TURN_BUDGET_EXPANSION_CEILING`)
   * for a node's retry dispatch ONLY when the critic-block retry that
   * revived it was triggered by a failed machine verification — never for
   * a plain critic rejection or a low-confidence-BLOCK retry (E-3).
   */
  turn_budget_estimate?: number;
}

/**
 * E-2: ceiling for a turn-budget expansion after a failed-verification
 * critic-block retry. Kept as a loop-local literal (not imported) so
 * `@arbor/opencode` has no dependency on any specific connector's own
 * default turn cap (`claude-code-campaign.ts`'s
 * `SPECIALIST_MAX_TURNS_DEFAULT`, currently also 32) — @arbor/opencode must
 * never import @arbor/mcp, even for a constant. Keep the two values in sync
 * by hand if either changes.
 */
const TURN_BUDGET_EXPANSION_CEILING = 32;

export type CampaignExecutionStrategy =
  | { readonly kind: "tree_search" }
  | { readonly kind: "first_verified" }
  | {
      readonly kind: "direct_single_action";
      readonly node_id: string;
      /**
       * Governance review mode for this single dispatch (ADR-062 arbiter
       * intake). `"critic"` (the default when absent, byte-identical to
       * behavior before this field existed) dispatches the ordinary critic
       * gate. `"waived"` is the `direct` governance tier: the loop skips
       * critic dispatch entirely and records the result via
       * `CampaignManager.recordResult`'s `review_waived` marker, which is
       * the only way a node can reach `verified`/`claimed` without a real
       * critic verdict — never a fabricated `critic_approved` provenance.
       */
      readonly review?: "critic" | "waived";
    };

/** The safe, executable subset of a governed overlay checkpoint. */
export interface GovernedOverlayCheckpoint {
  readonly checkpoint_at: string;
  readonly specialist_context: readonly string[];
  readonly critic_context: readonly string[];
  readonly specialist_prompt_fragments: readonly string[];
  readonly critic_prompt_fragments: readonly string[];
  readonly applied_overlay_ids: readonly string[];
  readonly unapplied_overlays: readonly { readonly id: string; readonly reason: string }[];
}

/** A production composition root derives this from its durable overlay service. */
export interface GovernedOverlayCheckpointPort {
  checkpoint(input: { campaign_id: string; node_id: string; as_of: string }): GovernedOverlayCheckpoint;
}

/**
 * Default HMAC secret for the live `NodeCard`s the loop derives for
 * capability routing (see `CampaignLoopConfig.card_secret`). Not a security
 * boundary — see that field's doc comment.
 */
export const DEFAULT_NODE_CARD_SECRET = "arbor-loop-node-card-v1";

const MANDATE_CHECKS: CriticVerdict["checks"][number]["name"][] = [
  "root_cause", "measurement_validation", "guardrail_enforcement", "introspection", "stability_monitoring",
];

/** Deterministically reconcile independently emitted full reviewer mandates.
 * This is a generated panel projection, not a fabricated reviewer response:
 * every check names how many durable votes supplied and passed it. */
function reconcilePanelVerdict(decision: PanelDecision): CriticVerdict {
  const full = Object.values(decision.votes).map((vote) => vote.verdict).filter((value): value is CriticVerdict => value !== undefined);
  const checks = MANDATE_CHECKS.map((name) => {
    const observed = full.map((verdict) => verdict.checks.find((check) => check.name === name)).filter((check): check is CriticVerdict["checks"][number] => check !== undefined);
    return {
      name,
      passed: observed.length === full.length && observed.length > 0 && observed.every((check) => check.passed),
      detail: `${observed.filter((check) => check.passed).length}/${full.length} panel reviewer mandates passed ${name}`,
    };
  });
  const passed = (name: typeof MANDATE_CHECKS[number]) => checks.find((check) => check.name === name)!.passed;
  return {
    approved: decision.approved,
    critic: "panel",
    rationale: decision.critic_rationale,
    ...(decision.approved ? {} : { root_cause: decision.critic_root_cause ?? "panel_binding_rejection" }),
    measurement_validated: passed("measurement_validation"),
    guardrails_enforced: passed("guardrail_enforcement"),
    introspection_passed: passed("introspection"),
    stability_ok: passed("stability_monitoring"),
    checks,
  };
}

/**
 * Filter a candidate card set down to cards whose signature verifies against
 * `secret`. A card that fails verification is dropped rather than trusted —
 * this is the live production call site for `verifyNodeCard` (Phase 4D.3):
 * a card is signed on derivation (`deriveNodeCard` → `signNodeCard`) and
 * this is where that signature is actually checked before the card can
 * influence routing. Before this, `verifyNodeCard` had zero production
 * callers — signing without a corresponding check downstream is decorative,
 * not security-bearing (audit finding, 2026-08-04). Dropping a card
 * degrades that one node to plain UCT for this selection round, the same
 * "fail open on the loop, never fail closed" pattern `buildLiveNodeCards`
 * already uses for a snapshot read failure.
 */
export function verifyLiveNodeCards(cards: readonly NodeCard[], secret: string): NodeCard[] {
  return cards.filter((card) => verifyNodeCard(card, secret));
}

/**
 * Build a `NodeCard` for every pending (selectable) node in the campaign
 * tree, so `manager.selectNodeWithCard` has a real card set to route
 * against. Every derived card is verified (`verifyLiveNodeCards`) before it
 * enters the candidate set. Failure to build a card set never blocks the
 * loop — it degrades to plain UCT (`cards: []`), the same way an empty
 * communications projection never blocks dispatch.
 */
function buildLiveNodeCards(manager: CampaignManagerPort, campaignId: string, secret: string): NodeCard[] {
  try {
    const snapshot = manager.getCampaignSnapshot(campaignId);
    if (!snapshot) return [];
    const candidates = snapshot.nodes
      .filter((n) => n.state === "pending")
      .map((n) => deriveCandidateNodeCard(
        { id: n.id, action_description: n.action_description, action_category: n.action_category, action_delegate: n.action_delegate },
        secret,
      ));
    return verifyLiveNodeCards(candidates, secret);
  } catch {
    return [];
  }
}

/**
 * ADR-019 lead-only question authority, resolved against how this tree
 * actually shapes: `createCampaign` seeds the root node as already
 * `claimed` with zero children (see arbor-core's `createCampaign`), so the
 * literal tree root is never itself `pending` and `selectNode` never
 * dispatches a specialist/critic to it — `node.parent_id === null` is
 * unreachable from inside the dispatch loop. The plan's actual admission-
 * level actions are the root's *direct children* (what `manager.branch(id,
 * "root", steps)` creates from the plan) — those are "the lead" in ADR-019's
 * sense. Anything branched deeper (a plan step's own sub-actions, created by
 * `config.branch_actions` mid-campaign) is a delegated sibling.
 */
function isLeadNode(manager: CampaignManagerPort, campaignId: string, node: { parent_id: string | null } | null): boolean {
  if (!node) return false;
  try {
    const snapshot = manager.getCampaignSnapshot(campaignId);
    return snapshot !== null && node.parent_id === snapshot.root_id;
  } catch {
    return false;
  }
}

export interface LoopInterruptionPort {
  interrupt(input: {
    campaign_id: string; node_id: string; scope: "node" | "subtree"; reason: string;
    cause: "cancellation" | "context_overflow" | "operational_error"; phase: string; epoch_id?: string;
  }): void | Promise<void>;
}

export interface LoopResultCapturePort {
  capture(input: {
    campaign_id: string; node_id: string; worktree_path: string;
    /** True only for a command-evidenced verified node. */
    verified: boolean; score: number;
    /** Manager-retained evidence produced by the trusted machine verifier. */
    verification_provenance?: Provenance;
    /** Exact argv observed by the trusted machine verifier; never reconstructed from display prose. */
    verification_command_argv?: readonly string[];
    /** Immutable action-authored file authority; absent only for legacy/unscoped actions. */
    declared_write_paths?: readonly string[];
  }): void;
}

export interface LoopWorkspaceCompositionPort {
  compose(input: {
    campaign_id: string;
    node_id: string;
    worktree_path: string;
    source_node_ids: readonly string[];
  }): { ok: true } | { ok: false; reason: string };
}

/**
 * Durable, byte-bounded retry-context capsule storage for a node (see
 * `retry-context-capsule.ts`). `load` is read once, before specialist
 * dispatch, so the dispatched prompt can carry a bounded delta projection of
 * what changed since the node's last recorded failure. `save` is called
 * after an operational or critic failure to persist the freshly built
 * capsule for the node's next attempt. Both are best-effort: a port failure
 * degrades to the pre-port behavior (no projection appended, no capsule
 * persisted) and never breaks the loop, the same "fail open" pattern every
 * other optional port in this file uses.
 */
export interface CampaignRetryContextPort {
  load(input: { campaign_id: string; node_id: string }): RetryContextCapsule | null;
  save(input: { campaign_id: string; node_id: string; capsule: RetryContextCapsule }): void;
}

export type LoopTelemetryPhase = "select" | "expand" | "gate" | "critic" | "backprop" | "awaiting_user_input";
export type LoopTelemetryOutcome = "success" | "failure" | "cancelled" | "timeout" | "pending";
export interface LoopTelemetryPort {
  recordPhaseTiming(input: {
    campaign_id: string;
    node_id: string;
    operation_id: string;
    epoch: number;
    phase: LoopTelemetryPhase;
    outcome: LoopTelemetryOutcome;
    duration_ms: number;
    source_evidence_id: string;
  }): string | void;
  recordUsageCost(input: {
    campaign_id: string;
    node_id: string;
    operation_id: string;
    epoch: number;
    phase: LoopTelemetryPhase;
    outcome: LoopTelemetryOutcome;
    source_evidence_id: string;
    agent_id: string;
    provider: TelemetryProvider;
    model_family: TelemetryModelFamily;
    input_tokens: number;
    output_tokens: number;
    cache_read_tokens: number;
    cache_write_tokens: number;
    cost: Cost;
  }): string | void;
  recordRoleModelIdentity?(input: {
    campaign_id: string; node_id: string; operation_id: string; epoch: number;
    phase: "expand" | "critic"; outcome: "success"; source_evidence_id: string;
    role: "specialist" | "critic"; model_id: string;
  }): string | void;
  recordNodeCostAttribution?(input: import("@arbor/audit").NodeCostAttributionObservation & { campaign_id: string; node_id: string }): string | void;
  recordContextEconomy?(input: import("@arbor/audit").ContextEconomyObservation & { campaign_id: string; node_id: string }): string | void;
  recordToolEconomy?(input: import("@arbor/audit").ToolEconomyObservation & { campaign_id: string; node_id: string }): string | void;
  /**
   * ADR-016: the specialist's completed streaming output, journaled as ledger
   * evidence distinct from the node's critic-governed outcome. Optional and
   * additive like the other projection-only recorders above — a port that
   * doesn't implement it simply drops phase-message evidence.
   */
  recordPhaseMessage?(input: PhaseMessageInput): string | void;
  /**
   * X-2 (ADR-067): a staggered specialist race's outcome. Optional and
   * additive like the other projection-only recorders above — a port that
   * doesn't implement it simply drops race telemetry, exactly as an omitted
   * `recordToolEconomy` drops tool-economy telemetry today.
   */
  recordRaceOutcome?(input: RaceOutcomeObservation & { campaign_id: string; node_id: string; operation_id: string; epoch: number; source_evidence_id: string }): string | void;
}

/**
 * G-08: table-driven fault matrix mapping every closed `NodeErrorKind` to its
 * telemetry outcome and default recovery disposition. Previously this
 * mapping existed only as test assertions (arbor-core's outcome.test.ts) —
 * no kind→recovery table lived in source. `retry` kinds are transient/
 * operational and the same node is safe to re-select on the tree's normal
 * backtrack path; `terminal` kinds need a human decision or a config change
 * before a retry could plausibly differ, so the node fails through the same
 * typed-evidence path (`recordClassifiedError`) a declined decomposition
 * uses — no separate branch exists for this value, deliberately: this
 * matrix previously named the disposition `"abandon"`, which reads as the
 * governed `abandoned` terminal node state ADR-012 defines (preserves the
 * node, releases the confirmed lease, and requires operator/auditor
 * authorization and a recorded reason). No code path here does any of that
 * — recordClassifiedError records a `"failed"` node, exactly like a
 * declined decomposition, with no operator involved. Renamed to `"terminal"`
 * so the matrix stops claiming a mechanism (governed abandonment) that does
 * not exist in this loop; ADR-012's actual `abandoned` state remains an
 * operator-authorized action outside the automatic loop, not something a
 * `NodeErrorKind` alone can trigger. A `NodeError` instance's own
 * `recoverable` flag (where the kind carries one) refines this per
 * occurrence — the matrix gives the class default, not an override.
 *
 * G-08 originally carried a sixth kind, `cap_stall`, with no production
 * construction site anywhere in the repo. The only genuine numeric-cap
 * invariant in the codebase — `TaskSupervisor`'s `SiblingBounds`
 * (`maxNestingDepth`/`maxSimultaneousSiblings`, arbor-core's
 * task-supervisor.ts) — governs *job* registration, not campaign tree node
 * expansion: `CampaignManager` (arbor-mcp/manager.ts) never calls
 * `TaskSupervisor`, so no per-node numeric cap ever stalls a tree node's
 * progress today. Wiring the two subsystems together to manufacture a use
 * would be new integration work invented to justify a type, not a real
 * boundary being described — the same mistake this table's own header
 * warns against. Removed from `NodeErrorKind`/`NodeError` rather than left
 * unconstructible; see `types.ts`'s `NODE_ERROR_KINDS`.
 *
 * `timeout` maps to `"decompose"`, not `"retry"`. Retrying an over-large
 * action reproduces the exact timeout — measured in production: a specialist
 * given a raised 900s dispatch ceiling still timed out, because the
 * candidate action was an epic ("bring branch coverage to >=85%") seeded as
 * a tree-search leaf, with nothing left to decompose. `"decompose"` routes
 * the node to `attemptDecomposition` below instead of a terminal failure —
 * but only when `config.decomposer` is wired; omitted, this is unreachable
 * and a timeout still records a typed failure exactly as before this recovery
 * value existed (see `attemptDecomposition`'s fallthrough).
 */
export const FAULT_MATRIX: Record<NodeErrorKind, { telemetry_outcome: LoopTelemetryOutcome; recovery: "retry" | "terminal" | "decompose" }> = {
  timeout: { telemetry_outcome: "timeout", recovery: "decompose" },
  context_window_exceeded: { telemetry_outcome: "failure", recovery: "terminal" },
  quota_exceeded: { telemetry_outcome: "failure", recovery: "retry" },
  transport_error: { telemetry_outcome: "failure", recovery: "retry" },
  internal_error: { telemetry_outcome: "failure", recovery: "terminal" },
  // ADR-120 Decision §3: recovery policy stays "terminal" deliberately, same
  // outcome `internal_error` already gave these same underlying failures
  // today. This entry exists so the discriminant is total over
  // NodeErrorKind and so a `policy_refused` node is now distinguishable in
  // telemetry from a crash — not to change what happens to it. Whether it
  // should route to "retry"/"decompose", including wiring into
  // `reviveNodeForScopeRetry`, is left to a separate decision (ADR-115) that
  // can route on the `code` field this ADR now preserves.
  policy_refused: { telemetry_outcome: "failure", recovery: "terminal" },
};

/**
 * G-08 bounded operational retry: caps the one specific dead end where a
 * `timeout`-mapped node routes to `"decompose"`, the decomposer itself
 * declines (`attemptDecomposition`'s `"decomposer declined: ..."` reason —
 * see `opencode-decomposer.ts`'s "action may already be atomic" message),
 * and the node would otherwise fail terminally on a genuine contradiction:
 * an action cannot simultaneously be too large to finish inside the timeout
 * window and already minimal. `saveRetryContext` already persists a capsule
 * on this exact path — this constant bounds the ONE re-dispatch that
 * consumes it (see the call site near `recordClassifiedError`, below).
 * Scoped narrowly to the decomposer-decline reason string, not every
 * operational failure that reaches this fallthrough: retrying a node that
 * hit the decomposition depth bound, already has children, or whose
 * decomposer-proposed children failed shape validation would not resolve
 * any contradiction and duplicates coverage the existing, well-tested
 * "fails exactly as before this recovery path existed" behavior already
 * has for those cases.
 */
const OPERATIONAL_RETRY_CEILING = 1;

/** Default `dispatch_heartbeat` interval — frequent enough to distinguish "still working" from "wedged" inside a single 900s specialist budget, rare enough to never be mistaken for real progress. */
const DEFAULT_DISPATCH_HEARTBEAT_MS = 60_000;

/**
 * Emit `onTick` on a fixed interval for as long as `promise` is pending, then
 * stop. Never affects `promise`'s own timing, result, or rejection — this is
 * observability only, not a timeout/retry/cancellation mechanism (those stay
 * exactly where they already live: `runOpenCode`'s own timer, `signal`'s own
 * abort path). See `dispatch_heartbeat`'s doc on `LoopEvent` for the incident
 * this closes the blind spot on.
 */
function withDispatchHeartbeat<T>(promise: Promise<T>, intervalMs: number, onTick: (elapsedMs: number) => void): Promise<T> {
  if (!(intervalMs > 0)) return promise;
  const startedAt = Date.now();
  const timer = setInterval(() => onTick(Date.now() - startedAt), intervalMs);
  return promise.finally(() => clearInterval(timer));
}

export const DEFAULT_LOOP_CONFIG: Pick<
  CampaignLoopConfig,
  "max_iterations" | "specialist_base_prompt" | "critic_base_prompt" | "use_worktrees"
> = {
  max_iterations: 100,
  specialist_base_prompt: "You are a Seed, an isolated task executor in a dedicated git worktree. Self-validate before submitting.",
  critic_base_prompt: "You are Lenticel, the Critic. You are APPROVAL-BIASED: reject only verified blockers. Run the Five-Point Mandate.",
  use_worktrees: true,
};

/**
 * Render the only overlay material the loop is allowed to enact.  A second
 * bound at this trust boundary means a malformed third-party adapter cannot
 * turn a governed checkpoint into unbounded prompt injection.  The adapter
 * remains responsible for provenance, approval, expiry and campaign scope.
 */
export function appendGovernedOverlay(
  prompt: string,
  checkpoint: GovernedOverlayCheckpoint | null,
  role: "specialist" | "critic",
): string {
  if (!checkpoint) return prompt;
  const context = role === "specialist" ? checkpoint.specialist_context : checkpoint.critic_context;
  const fragments = role === "specialist" ? checkpoint.specialist_prompt_fragments : checkpoint.critic_prompt_fragments;
  const bounded = [...context, ...fragments]
    .filter((value) => typeof value === "string" && value.trim().length > 0)
    .map((value) => value.slice(0, 8_192))
    .slice(0, 12);
  if (bounded.length === 0) return prompt;
  return `${prompt}\n\nGoverned campaign-local overlay (approved and unexpired at ${checkpoint.checkpoint_at}):\n${bounded.join("\n\n")}`;
}

export interface SpecialistPromptInput {
  readonly base_prompt: string;
  readonly foreground: string;
  readonly action: Pick<Action, "description" | "category" | "constraints" | "acceptance_checks">;
  readonly governed_checkpoint: GovernedOverlayCheckpoint | null;
  readonly checkpoint_at: string;
  readonly communications: readonly import("@arbor/campaign-support").SelectionCommunication[];
  readonly communication_budget?: OutputBudget;
  readonly inject_memory: (prompt: string) => string;
  readonly acceptance_commands?: readonly (readonly string[])[];
}

/** The one canonical specialist prompt composition used by dispatch and debug projection. */
export function completionEvidenceProtocol(action: Pick<Action, "description" | "constraints" | "acceptance_checks" | "high_risk_tool_scope">, options: { readonly acceptance_commands?: readonly (readonly string[])[] } = {}): string {
  const constraints = action.constraints?.filter((constraint) => constraint.trim().length > 0) ?? [];
  const acceptanceChecks = action.acceptance_checks?.filter((criterion) => criterion.trim().length > 0) ?? [];
  const assignedCriteria = [
    `- Action outcome: ${action.description}`,
    ...constraints.map((constraint) => `- Constraint: ${constraint}`),
    ...acceptanceChecks.map((criterion) => `- Acceptance check: ${criterion}`),
  ];
  // The commands the harness WILL run after this turn, named exactly. A
  // specialist that only reads prose criteria cannot know which command
  // decides its fate; every provider-backed run then ended with the critic
  // blocking on "the authored acceptance command was not run" (EC-061, B1).
  const harnessCommands = acceptanceCommandsForAction(action, options.acceptance_commands);
  const harnessLines = harnessCommands.length === 0 ? [] : [
    `The harness will run ${harnessCommands.length === 1 ? "this acceptance command" : "these acceptance commands, in order, fail-fast,"} in your worktree after your turn; run ${harnessCommands.length === 1 ? "it" : "them"} yourself first and report the exit status:`,
    ...harnessCommands.map((argv) => `  $ ${argv.join(" ")}`),
  ];
  return [
    "Completion evidence protocol (required before handoff to review):",
    "Derive concrete, observable checks from the assigned action and these acceptance inputs:",
    ...(assignedCriteria.length === 1 ? [...assignedCriteria, "- No separate criteria were supplied. Derive observable checks from the assigned action's intended outcome."] : assignedCriteria),
    ...harnessLines,
    "Execute every practical check within the assigned authority before reporting completion. Cover behavioral, accessibility, visual/presentation, or other task-specific checks when they apply; do not invent irrelevant checks.",
    "End the result with a `VALIDATION EVIDENCE:` section. For each check, state the criterion, the method actually executed or observed, the observed result, and a concise evidence reference. State `not run` with the reason for every required check that was not executed.",
    "Artifact existence, a diff, or an outputs-only check is evidence only of artifact presence. It is never sufficient to call the action complete, working, or verified without the applicable executed/observed validation evidence.",
    "Report only observations you made. This self-report does not replace independent critic review or machine provenance.",
  ].join("\n");
}

/**
 * The acceptance commands that apply to an action: the plan's own declared
 * `command_argv` when it authored one, else the project's configured
 * `verification.acceptance_commands`. Mirrors the harness-side verifier's
 * precedence so the specialist is told exactly what will run.
 */
export function acceptanceCommandsForAction(action: Pick<Action, "high_risk_tool_scope">, configured: readonly (readonly string[])[] | undefined): readonly (readonly string[])[] {
  // Literal argv entries only: an ADR-119 intent is bound to a real argv at
  // first use, so there is nothing exact to promise the specialist yet.
  const declared = (action.high_risk_tool_scope?.command_argv ?? []).filter((entry): entry is readonly string[] => Array.isArray(entry) && entry.length > 0);
  if (declared.length > 0) return declared;
  return (configured ?? []).filter((argv) => argv.length > 0);
}

function completionEvidenceReviewNote(specialistOutput: string, action: Pick<Action, "acceptance_checks">): string {
  const hasReport = /(?:^|\n)VALIDATION EVIDENCE\s*:/i.test(specialistOutput);
  const acceptanceCriteria = action.acceptance_checks?.length
    ? `\n\nAssigned acceptance criteria:\n${action.acceptance_checks.map((criterion) => `- ${criterion}`).join("\n")}`
    : "\n\nAssigned acceptance criteria: none materialized for this action.";
  return `${acceptanceCriteria}${hasReport
    ? "\n\nCompletion-evidence protocol: the specialist supplied a self-reported VALIDATION EVIDENCE section. It is candidate evidence only; independently assess whether the stated checks actually cover the assigned action and do not treat it as verification."
    : "\n\nCompletion-evidence protocol: the specialist did not provide the required VALIDATION EVIDENCE section. Treat the candidate as lacking a completion report; artifact existence, a diff, or outputs-only verification cannot fill that gap. Independently decide the verdict; do not infer completion from the missing report."}`;
}

export function composeSpecialistPrompt(input: SpecialistPromptInput): string {
  const base = `${input.base_prompt}${input.foreground ? `\n\nLive foreground:\n${input.foreground}` : ""}\n\nAction: ${input.action.description}\nCategory: ${input.action.category}\nConstraints: ${input.action.constraints?.join("; ") ?? "none"}\n\n${completionEvidenceProtocol(input.action, { acceptance_commands: input.acceptance_commands })}`;
  const governed = appendGovernedOverlay(base, input.governed_checkpoint, "specialist");
  const communications = appendSelectionCommunications(governed, { checkpoint_at: input.checkpoint_at, communications: input.communications }, input.communication_budget);
  return input.inject_memory(communications);
}

function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * Appends a bounded retry-context delta projection (see
 * `retry-context-capsule.ts`) to a composed prompt. Only ever called with a
 * real, already byte-bounded projection — never raw prior prompt/tool/file
 * content. Absent a projection (no port configured, no prior capsule, or the
 * projection itself failed to build), the prompt is returned unchanged —
 * this is what keeps dispatch byte-identical to legacy behavior when no
 * `retry_context` port is wired.
 */
export function appendRetryContextProjection(prompt: string, projection: RetryContextProjection | null): string {
  if (!projection) return prompt;
  const unresolved = projection.requirements.filter((requirement) => requirement.status === "unresolved").map((requirement) => `- ${requirement.description}`);
  const correction = unresolved.length > 0
    ? `\n\nCORRECTIVE RETRY: the prior candidate was rejected. Resolve every blocking correction below before resubmitting; do not repeat the prior implementation unchanged.\n${unresolved.join("\n")}`
    : "";
  return `${prompt}${correction}\n\nBounded retry context (attempt ${projection.attempt}, failure fingerprint ${projection.failure.fingerprint}):\n${JSON.stringify(projection)}`;
}

function loadRetryContext(port: CampaignRetryContextPort, campaign_id: string, node_id: string): RetryContextCapsule | null {
  try {
    return port.load({ campaign_id, node_id });
  } catch {
    return null;
  }
}

function truncateToFieldCeiling(text: string): string {
  const buf = Buffer.from(text, "utf8");
  return buf.byteLength <= FIELD_MAX_BYTES ? text : buf.subarray(0, FIELD_MAX_BYTES).toString("utf8");
}

/**
 * Byte-safe truncation to the ledger's phase-message content cap (ADR-016,
 * `PHASE_MESSAGE_MAX_CONTENT_BYTES`) — a chatty specialist must never flood
 * the ledger, but truncation must be deliberate and observable, never a
 * silent drop or a bypassed cap.
 */
function truncatePhaseMessageContent(content: string): { content: string; truncated: boolean; original_bytes: number } {
  const buf = Buffer.from(content, "utf8");
  if (buf.byteLength <= PHASE_MESSAGE_MAX_CONTENT_BYTES) return { content, truncated: false, original_bytes: buf.byteLength };
  return { content: buf.subarray(0, PHASE_MESSAGE_MAX_CONTENT_BYTES).toString("utf8"), truncated: true, original_bytes: buf.byteLength };
}

function retryTaskFacts(category: string, action: Action | null): RetryTaskFact[] {
  const facts: RetryTaskFact[] = [{ id: "action_category", summary: truncateToFieldCeiling(category) }];
  if (action?.description) facts.push({ id: "action_description", summary: truncateToFieldCeiling(action.description) });
  return facts;
}

/** Splits `${tool}:${input_summary}` executor signatures (see native-agent-executor.ts's `toolCallSignatures`) into a real name and a digest of the full signature — never the raw input summary itself. */
function retryToolSignatures(...signatureLists: readonly (readonly string[] | undefined)[]): RetryToolSignature[] {
  const bySignature = new Map<string, RetryToolSignature>();
  for (const signatures of signatureLists) {
    for (const signature of signatures ?? []) {
      const separator = signature.indexOf(":");
      const name = truncateToFieldCeiling(separator === -1 ? signature : signature.slice(0, separator));
      bySignature.set(signature, { name, argsDigest: sha256Hex(signature) });
    }
  }
  return [...bySignature.values()];
}

function retryEvidenceFromCapture(id: string, kind: string, capture: PreparedOutput["capture"]): RetryEvidenceRef[] {
  if (!capture) return [];
  return [{ id, kind, digest: capture.content_sha256, pointer: capture.evidence_pointer, provenance: capture.provenance }];
}

function retryRequirementsFromRootCause(rootCause: string | undefined): RetryCriticRequirement[] {
  if (!rootCause) return [];
  return [{ id: "critic_root_cause", description: truncateToFieldCeiling(rootCause), status: "unresolved" }];
}

/**
 * Builds a fresh retry-context capsule from real, already-available loop
 * state and persists it via `config.retry_context.save`. Best-effort — a
 * build/save failure degrades to "no capsule persisted this attempt" and
 * never breaks the loop, the same "fail open" pattern every other optional
 * port in this file uses. `attempt` continues counting only when the newly
 * derived fingerprint matches the loaded prior capsule's fingerprint; any
 * other case (no prior capsule, or a changed fingerprint) restarts it at 1.
 */
function saveRetryContext(params: {
  retry_context: CampaignRetryContextPort | undefined;
  campaign_id: string;
  node_id: string;
  loaded: RetryContextCapsule | null;
  failure: FailureClassificationInput;
  stableContextDigest: string;
  priorPromptDigest: string;
  taskFacts: readonly RetryTaskFact[];
  changedFiles: readonly RetryChangedFile[];
  evidence: readonly RetryEvidenceRef[];
  requirements: readonly RetryCriticRequirement[];
  toolSignatures: readonly RetryToolSignature[];
}): void {
  if (!params.retry_context) return;
  try {
    const fingerprint = deriveFailureFingerprint(params.failure);
    const attempt = params.loaded && params.loaded.failure.fingerprint === fingerprint ? params.loaded.attempt + 1 : 1;
    const result = buildRetryContextCapsule({
      identity: { campaignId: params.campaign_id, nodeId: params.node_id },
      failure: params.failure,
      stableContextDigest: params.stableContextDigest,
      attempt,
      priorPromptDigest: params.priorPromptDigest,
      taskFacts: params.taskFacts,
      changedFiles: params.changedFiles,
      evidence: params.evidence,
      requirements: params.requirements,
      toolSignatures: params.toolSignatures,
    });
    if (result.ok) {
      params.retry_context.save({ campaign_id: params.campaign_id, node_id: params.node_id, capsule: result.capsule });
    }
  } catch { /* retry-context persistence is best-effort and must never break the loop */ }
}

// ============================================================
// THE LOOP
// ============================================================

/**
 * Runs one campaign to completion (halt) or until max_iterations.
 * Returns a report summarizing the run.
 */
export async function runCampaign(params: {
  manager: CampaignManagerPort;
  campaign_id: string;
  executor: LoopExecutor;
  config: CampaignLoopConfig;
  worktrees?: WorktreeManager; // required only if use_worktrees
  /** Cooperative cancellation. Timeouts must be implemented separately by callers. */
  signal?: AbortSignal;
}): Promise<CampaignReport> {
  const { manager, campaign_id, executor, config, signal } = params;
  const log = (e: LoopEvent) => executor.log?.(e);

  // Best-effort ledger telemetry. ADR-017 requires that a telemetry failure can
  // never mutate, gate, or halt a campaign, so every emission is defensive.
  const telemetry = config.telemetry;
  const emitPhase = (input: Parameters<NonNullable<typeof telemetry>["recordPhaseTiming"]>[0]): void => {
    try {
      const witness = manager.getLatestEvidenceId(campaign_id);
      if (witness) telemetry?.recordPhaseTiming({ ...input, source_evidence_id: witness });
    } catch { /* telemetry must never break the loop */ }
  };
  const emitCost = (input: Parameters<NonNullable<typeof telemetry>["recordUsageCost"]>[0]): void => {
    try {
      const witness = manager.getLatestEvidenceId(campaign_id);
      if (witness) telemetry?.recordUsageCost({ ...input, source_evidence_id: witness });
    } catch { /* telemetry must never break the loop */ }
  };
  const emitModelIdentity = (input: Parameters<NonNullable<NonNullable<typeof telemetry>["recordRoleModelIdentity"]>>[0]): void => {
    try {
      const witness = manager.getLatestEvidenceId(campaign_id);
      if (witness) telemetry?.recordRoleModelIdentity?.({ ...input, source_evidence_id: witness });
    } catch { /* telemetry must never break the loop */ }
  };
  const emitToolEconomy = (input: { node_id: string; epoch: number; phase: "expand" | "critic"; role: "specialist" | "critic"; economy: ExecutorToolEconomy }): void => {
    try {
      const witness = manager.getLatestEvidenceId(campaign_id);
      if (!witness || !telemetry?.recordToolEconomy) return;
      const operation = `${campaign_id}:${input.node_id}:tool-economy:${input.role}`;
      telemetry.recordToolEconomy({
        campaign_id, node_id: input.node_id, operation_id: operation, epoch: input.epoch,
        type: "tool_economy", phase: input.phase, outcome: "success", source_evidence_id: witness,
        idempotency_key: `tool-economy:${campaign_id}:${input.node_id}:${input.epoch}:${input.role}`,
        provenance: { tag: "generated", generator: "arbor-loop-tool-economy", input_hash: operation },
        ...input.economy,
      });
    } catch { /* telemetry must never break the loop */ }
  };
  /**
   * ADR-016: journal the specialist's completed output as ledger phase-
   * message evidence, distinct from the node's critic-governed outcome.
   * Best-effort like the other telemetry emitters above — a rejection here
   * must never mutate, gate, or halt the campaign — but a cap violation is
   * handled by deliberate truncation (logged via `phase_message_truncated`)
   * rather than by silently letting the ledger reject the whole record.
   */
  const emitPhaseMessage = (input: {
    node_id: string; epoch: number; role: "specialist"; phase: "commentary" | "final";
    content: string; provenance: Provenance;
  }): void => {
    if (!telemetry?.recordPhaseMessage) return;
    try {
      const { content, truncated, original_bytes } = truncatePhaseMessageContent(input.content);
      if (content.length === 0) return;
      if (truncated) {
        log({ type: "phase_message_truncated", node_id: input.node_id, original_bytes, kept_bytes: Buffer.byteLength(content, "utf8") });
      }
      telemetry.recordPhaseMessage({
        campaign_id, node_id: input.node_id,
        operation_id: `${campaign_id}:${input.node_id}:${input.role}:phase`,
        phase: input.phase, content, content_length_bytes: Buffer.byteLength(content, "utf8"),
        provenance: input.provenance,
        idempotency_key: `phase-message:${campaign_id}:${input.node_id}:${input.epoch}:${input.role}:${input.phase}`,
      });
    } catch { /* telemetry must never break the loop */ }
  };

  if (config.use_worktrees && params.worktrees === undefined) {
    // A silent `new WorktreeManager()` here would resolve repoRoot from
    // process.cwd() — scoping every real `git worktree add/remove`,
    // `git branch -D`, and prune sweep this campaign runs to whatever
    // directory the Node process happens to be launched from. In a box that
    // runs many concurrent processes against the same checkout, that has
    // produced real orphaned worktrees/branches registered against the
    // wrong repo. Callers that want real worktrees must say which repo.
    throw new Error("runCampaign: config.use_worktrees is true but no `worktrees` was supplied — refusing to default to process.cwd(). Pass an explicit WorktreeManager({ repoRoot }) or set use_worktrees: false.");
  }
  const worktrees = config.use_worktrees
    ? params.worktrees!
    : new WorktreeManager({}, true); // dryRun — no git, no disk

  if (config.use_worktrees) {
    // The loop OWNS `.worktrees/`: it is the only thing that creates managed
    // worktrees, and the only thing that can reclaim the ones a failed
    // `releaseLease` stranded there. Sweeping is opted into here and nowhere
    // else, and the two-phase grace rule in `reconcileLeases` is what makes it
    // safe against a concurrently-acquiring campaign.
    const reconciliation = worktrees.reconcileLeases({ sweep: true });
    log({
      type: "leases_reconciled",
      live: reconciliation.live.length,
      stale: reconciliation.outcomes.filter((outcome) => outcome.status === "stale").length,
      reclaimed: reconciliation.outcomes.filter((outcome) => outcome.status === "reclaimed").length,
      diagnostics: reconciliation.outcomes.filter(
        (outcome) => outcome.status !== "live" && outcome.status !== "stale" && outcome.status !== "reclaimed",
      ).length,
    });
  }

  log({ type: "campaign_start", campaign_id });

  const report: CampaignReport = {
    campaign_id,
    iterations: 0,
    verified: 0,
    claimed: 0,
    failed: 0,
    pruned: 0,
    decomposed: 0,
    review_pending: 0,
    halted: false,
    halt_reason: null,
    best_score: 0,
    kb_entries_written: 0,
    path: [],
    cancelled: false,
    cancellation_reason: null,
    interrupted: 0,
    operational_retried: 0,
    cleanup: { leases_released: 0 },
    awaiting_user_input: false,
  };

  // B3: on every entry into the loop, resume any node stranded in
  // `"awaiting_review"` with a durable candidate before normal selection
  // starts — see `resumeStrandedReviews` doc for why these are otherwise
  // invisible to `arbor recover`/`re-confirm`/`adopt`. Critic-only: the
  // candidate already IS the specialist's completed output.
  await resumeStrandedReviews({ manager, campaign_id, executor, config, log, report, signal });

  // E-2: per-node turn-budget expansion, scoped to this single runCampaign
  // invocation (a bounded critic-block retry revives the SAME node into a
  // later iteration of the loop below, not a separate process). Absent
  // entry = use `config.turn_budget_estimate` unexpanded.
  const turnBudgetByNode = new Map<string, number>();
  // G-08 bounded operational retry (see `OPERATIONAL_RETRY_CEILING`'s doc):
  // scoped to this single runCampaign invocation, same lifetime as
  // `turnBudgetByNode` above, for the same reason.
  const operationalRetryByNode = new Map<string, number>();

  for (let i = 0; i < config.max_iterations; i++) {
    if (signal?.aborted) {
      markCancelled(report, signal);
      log({ type: "cancelled", reason: report.cancellation_reason! });
      break;
    }
    // 1. Halt check — every iteration, before selecting. An operator-driven
    // `campaign.halt` (manualHalt) sets the durable `campaign.halted` ledger
    // flag directly and does not necessarily satisfy any automatic budget/
    // score/convergence condition, so `manager.isHalted` is checked first —
    // otherwise a live supervised run would only notice a manual halt one
    // iteration later (via selectNode's own `campaign.halted` guard
    // returning null) and would misreport it as halt_reason "no_nodes".
    const manualHalt = manager.isHalted(campaign_id);
    if (manualHalt.halted) {
      report.halted = true;
      report.halt_reason = manualHalt.reason;
      manager.completeAutoHalt(campaign_id, manualHalt.reason ?? "unknown");
      log({ type: "halt", reason: manualHalt.reason ?? "unknown" });
      break;
    }
    const haltCheck = manager.haltStatus(campaign_id);
    if (haltCheck.halted) {
      report.halted = true;
      report.halt_reason = haltCheck.reason;
      manager.completeAutoHalt(campaign_id, haltCheck.reason ?? "unknown");
      log({ type: "halt", reason: haltCheck.reason ?? "unknown" });
      break;
    }

    // 1.5 Blind/awaiting-user-input gate (ADR-019): if a blocking interview is
    // unanswered, stop selecting until the human answers (reconciled from
    // durable ledger facts — never a transient in-memory flag, so a crash
    // cannot leave a phantom waiting state).
    if (manager.awaitingUserInput(campaign_id)) {
      report.awaiting_user_input = true;
      log({ type: "awaiting_user_input", campaign_id });
      emitPhase({ campaign_id, node_id: campaign_id, operation_id: `${campaign_id}:awaiting-user-input`, epoch: i + 1, phase: "awaiting_user_input", outcome: "pending", duration_ms: 0, source_evidence_id: "" });
      break;
    }

    // 2. Select the next node.
    const selectStart = Date.now();
    const directNode = config.execution_strategy?.kind === "direct_single_action" && i === 0
      ? config.execution_strategy.node_id
      : null;
    const directInfo = directNode === null ? null : manager.getNodeInfo(campaign_id, directNode);
    if (directNode !== null && directInfo?.state !== "pending") {
      throw new Error(`direct task node ${directNode} is not pending`);
    }
    const cardSelection = directNode === null && config.task_skills && config.task_skills.length > 0
      ? manager.selectNodeWithCard(campaign_id, config.score_ctx(campaign_id), {
          taskSkills: config.task_skills,
          requestedTier: "specialist",
          cards: buildLiveNodeCards(manager, campaign_id, config.card_secret ?? DEFAULT_NODE_CARD_SECRET),
      })
      : null;
    const nodeId = directNode ?? (cardSelection ? cardSelection.node_id : manager.selectNode(campaign_id, config.score_ctx(campaign_id)));
    const selectDuration = Date.now() - selectStart;
    if (cardSelection && nodeId) {
      log({ type: "capability_routed", node_id: nodeId, matched: cardSelection.card !== null });
    }
    if (!nodeId) {
      // No expandable nodes — the tree is exhausted. Halt.
      report.halted = true;
      // WA-69: a campaign that verified at least one node before the
      // frontier emptied achieved a real, accepted result — exhaustion
      // ("no_nodes") is reserved for the genuine hollow case where nothing
      // ever verified. Without this, exploratory (`tree_search`) and
      // governed multi-branch campaigns that keep exploring alternatives
      // after an early verify (by design — see `taskComplete` above) halted
      // with a terminal label reading identically to a run that produced
      // nothing at all. `haltStatus`'s own budget/threshold/convergence/
      // manual reasons still take priority: those describe why the run
      // actually stopped, not that the tree was exhausted.
      //
      // `selectNode` only ever picks `"pending"` nodes — it cannot see a
      // node parked `"interrupted"` (recoverable operational stop, ADR-016)
      // or `"awaiting_review"` (a durable candidate whose critic dispatch
      // itself failed). `resumeStrandedReviews` only resolves the latter
      // once, at loop entry, not on every iteration a stranded node could
      // arise mid-run. Reporting `"no_nodes"` here would tell the operator
      // the tree is exhausted when real, recoverable work is actually
      // sitting in the frontier, invisible to selection — the exact failure
      // this loop must never commit (see `admitUnblockedDeferredActions`'s
      // neighboring "depends_on ordering, not evidence" comment in
      // manager.ts for the closely related class this already burned once).
      // Distinguish that case with its own honest reason rather than
      // silently making these states selectable, which would violate their
      // own state contracts.
      const strandedWorkPending = (manager.getCampaignSnapshot(campaign_id)?.nodes ?? [])
        .some((n) => n.state === "interrupted" || n.state === "awaiting_review");
      const exhaustionReason: HaltReason = report.verified > 0
        ? "verified_result"
        : strandedWorkPending ? "stranded_work" : "no_nodes";
      const resolvedHaltReason: HaltReason = manager.haltStatus(campaign_id).reason ?? exhaustionReason;
      report.halt_reason = resolvedHaltReason;
      manager.completeAutoHalt(campaign_id, resolvedHaltReason);
      log({ type: "halt", reason: resolvedHaltReason });
      break;
    }
    report.iterations = i + 1;
    emitPhase({ campaign_id, node_id: nodeId, operation_id: `${campaign_id}:${nodeId}:select`, epoch: i + 1, phase: "select", outcome: "success", duration_ms: selectDuration, source_evidence_id: "" });

    // Read the node's action for dispatch metadata.
    const node = manager.getNodeInfo(campaign_id, nodeId);
    const action = node?.action ?? null;
    const category = action?.category ?? "unknown";
    const specialistAgent = action?.delegate_to ?? "seed";
    const routingDecision = action && config.node_routing ? config.node_routing.route({
      description: action.description, category: action.category, constraints: action.constraints ?? [],
      estimated_gain: action.estimated_gain, estimated_cost: action.estimated_cost,
      ...(action.decomposition_depth === undefined ? {} : { decomposition_depth: action.decomposition_depth }),
    }) : undefined;
    if (routingDecision) log({ type: "difficulty_routed", node_id: nodeId, decision: routingDecision });
    log({ type: "selected", node_id: nodeId, category });

    // Communications are sampled once per role at the selection checkpoint.
    // They are prompt context only: an empty projection never blocks dispatch,
    // and message state never influences selection, halt, success, or liveness.
    const communicationCheckpoint = config.communication_clock?.() ?? new Date().toISOString();
    // Overlay state is sampled at the same immutable selection checkpoint as
    // communications.  A later approval/rollback therefore cannot change an
    // already-dispatched prompt, while the next iteration observes the new
    // durable state.  No base prompt, gate, provenance, capability, or
    // executor behavior is mutable through this port.
    const governedCheckpoint = config.governed_context?.checkpoint({
      campaign_id,
      node_id: nodeId,
      as_of: communicationCheckpoint,
    }) ?? null;
    if (governedCheckpoint) {
      log({
        type: "governed_overlay_checkpoint",
        node_id: nodeId,
        applied: governedCheckpoint.applied_overlay_ids.length,
        unapplied: governedCheckpoint.unapplied_overlays.length,
      });
    }
    const communicationLimit = Math.max(1, Math.min(100, config.communication_limit ?? 20));
    const specialistCommunications = config.communications?.projectSelection({
      campaign_id: campaign_id,
      node_id: nodeId,
      tier: config.specialist_cap.tier,
      limit: communicationLimit,
      as_of: communicationCheckpoint,
    }) ?? [];
    const criticCommunications = config.communications?.projectSelection({
      campaign_id: campaign_id,
      node_id: nodeId,
      tier: config.critic_cap.tier,
      limit: communicationLimit,
      as_of: communicationCheckpoint,
    }) ?? [];

    // 3. Expand — isolation gate. Acquire worktree + lease.
    const recoveredLease = config.use_worktrees ? worktrees.readLease(nodeId) : null;
    const lease = config.use_worktrees
      ? recoveredLease?.active === true && recoveredLease.campaign_id === campaign_id
        ? recoveredLease
        : await worktrees.acquireLeaseAsync({ campaign_id, node_id: nodeId, specialist: specialistAgent }, signal)
      : { active: true, path: ".tmp", branch: "", starting_commit: "HEAD", acquireLease: false };
    const worktreePath = lease?.active ? lease.path : ".worktree-unavailable";
    let capturedVerificationCommand: readonly string[] | undefined;
    // Set only on the genuinely uncaught-throw path at the bottom of the
    // outer catch below (never on the `ContextOverflowError`/abort-specific
    // branches, which `break` without rethrowing). Used by `finally` to
    // decide whether releasing this node's lease is safe — see the comment
    // there for why a non-terminal node otherwise keeps its lease.
    let unwindingOnThrow = false;

    try {
      throwIfAborted(signal);

    let compositionFailure: string | null = null;
    const dependencyDescriptions = action?.depends_on ?? [];
    if (dependencyDescriptions.length > 0) {
      const snapshot = manager.getCampaignSnapshot(campaign_id);
      const sourceNodeIds: string[] = [];
      for (const description of dependencyDescriptions) {
        const matches = (snapshot?.nodes ?? []).filter((candidate) => candidate.id !== nodeId
          && manager.getNodeInfo(campaign_id, candidate.id)?.action.description === description);
        if (matches.length !== 1) {
          compositionFailure = `dependent workspace composition could not resolve exactly one source for ${JSON.stringify(description)}`;
          break;
        }
        sourceNodeIds.push(matches[0]!.id);
      }
      if (compositionFailure === null) {
        if (!lease?.active) compositionFailure = "dependent workspace composition requires an active isolated lease";
        else if (!config.workspace_composition) compositionFailure = "dependent workspace composition port is unavailable";
        else {
          try {
            const composed = config.workspace_composition.compose({ campaign_id, node_id: nodeId, worktree_path: worktreePath, source_node_ids: sourceNodeIds });
            if (!composed.ok) compositionFailure = composed.reason;
            else log({ type: "workspace_composed", node_id: nodeId, source_node_ids: sourceNodeIds });
          } catch (error) {
            compositionFailure = `dependent workspace composition failed: ${error instanceof Error ? error.message : "unknown error"}`;
          }
        }
      }
    }

    const expandStart = Date.now();
    const expand = manager.expandNode(campaign_id, nodeId, {
      worktree_isolated: config.use_worktrees ? (lease?.active ?? false) : true,
      // A refused acquisition proves there is no isolated worktree or active
      // lease; it does not prove a commit mismatch. Successful real leases
      // are issued only after WorktreeManager verifies the detached HEAD.
      starting_commit_correct: (config.use_worktrees
        ? lease === null || lease === undefined || lease.starting_commit.trim().length > 0
        : true) && compositionFailure === null,
      lease_acquired: config.use_worktrees ? (lease?.active ?? false) : true,
    });
    const expandDuration = Date.now() - expandStart;
    if (!expand.ok) {
      emitPhase({ campaign_id, node_id: nodeId, operation_id: `${campaign_id}:${nodeId}:expand`, epoch: i + 1, phase: "expand", outcome: "failure", duration_ms: expandDuration, source_evidence_id: "" });
      // Isolation gate failed — record failure and backtrack.
      const isolationDetail = compositionFailure ?? worktrees.lastAcquireFailure ?? expand.gate.detail;
      // WA-40: this detail is already durable on the NODE (specialist_output/
      // critic_rationale below), but a gate refusal recorded before any
      // specialist ever ran can leave the whole campaign halting on a
      // generic exhaustion label with no per-node text a caller happens to
      // scrape. First-failure-wins: a later, possibly less specific failure
      // must never bury the original refusal reason.
      if (manager.getCampaignRunDiagnostic(campaign_id) === null) {
        manager.recordCampaignRunDiagnostic(campaign_id, { message: `isolation gate rejected node ${nodeId}: ${isolationDetail}` });
      }
      const fail = manager.recordResult(campaign_id, nodeId, {
        specialist_output: `Isolation gate rejected: ${isolationDetail}`,
        specialist_agent: specialistAgent,
        provenance: { tag: "claimed", claimant: "loop" },
        critic_agent: "loop",
        critic_approved: false,
        critic_rationale: isolationDetail,
        // U3: the fixed literal previously dropped `expand.gate.detail` here,
        // so `arbor report`'s root-cause line showed "isolation gate failed"
        // with no reason even though `specialist_output`/`critic_rationale`
        // carried it a few lines up.
        critic_root_cause: `isolation gate failed: ${isolationDetail}`,
        score_ctx: config.score_ctx(campaign_id),
      });
      config.node_routing?.recordOutcome({ category, succeeded: false });
      if (fail.backtrack_parent) {
        log({ type: "backtracked", node_id: nodeId, parent_id: fail.backtrack_parent });
        report.path.push({ node_id: nodeId, state: "failed", score: 0 });
      }
      continue;
    }
    emitPhase({ campaign_id, node_id: nodeId, operation_id: `${campaign_id}:${nodeId}:expand`, epoch: i + 1, phase: "expand", outcome: "success", duration_ms: expandDuration, source_evidence_id: "" });
    log({ type: "expanded", node_id: nodeId });
    // visit_count is incremented and persisted by beginExpansion before any
    // model dispatch. It is stable for re-entry into this expansion and
    // advances on every later logical retry, including a retry after restart.
    let tokenAttemptId: string | undefined;
    if (config.token_economy !== undefined) {
      const expansionVisit = manager.getNodeInfo(campaign_id, nodeId)?.visit_count;
      if (typeof expansionVisit !== "number" || !Number.isSafeInteger(expansionVisit) || expansionVisit < 1) {
        throw new Error(`token_economy requires a durable visit_count for expanded node ${nodeId} to scope retry recovery epochs`);
      }
      tokenAttemptId = `visit:${expansionVisit}`;
    }

    // 3.5 Dispatch preflight: a fast, free check that catches a known-missing
    // tool authority (or other locally-knowable dispatch blocker) BEFORE any
    // model/provider call, instead of discovering it only when the first
    // denied tool call fails mid-session. Reuses the isolation gate's own
    // synthetic-rejection mechanism — the same evidence-gated `recordResult`
    // path, never a fabricated critic verdict.
    const preflight = manager.projectDispatchPreflight(campaign_id, nodeId);
    if (preflight.authority === "missing" || preflight.workspace === "not_ready") {
      const detail = preflight.reasons.join("; ") || "dispatch preflight rejected the node";
      emitPhase({ campaign_id, node_id: nodeId, operation_id: `${campaign_id}:${nodeId}:preflight`, epoch: i + 1, phase: "gate", outcome: "failure", duration_ms: 0, source_evidence_id: "" });
      const fail = manager.recordResult(campaign_id, nodeId, {
        specialist_output: `Dispatch preflight rejected: ${detail}`,
        specialist_agent: specialistAgent,
        provenance: { tag: "claimed", claimant: "loop" },
        critic_agent: "loop",
        critic_approved: false,
        critic_rationale: detail,
        // U3: same fixed-literal defect as the isolation gate above — thread
        // the actual reason through instead of a detail-free constant.
        critic_root_cause: `dispatch preflight failed: ${detail}`,
        score_ctx: config.score_ctx(campaign_id),
      });
      config.node_routing?.recordOutcome({ category, succeeded: false });
      if (fail.backtrack_parent) {
        log({ type: "backtracked", node_id: nodeId, parent_id: fail.backtrack_parent });
        report.path.push({ node_id: nodeId, state: "failed", score: 0 });
      }
      continue;
    }

    // 4. Dispatch specialist with KB-injected prompt.
    const specialistForeground = config.foreground?.derive({
      campaign_id, node_id: nodeId, agent: specialistAgent, capability: "specialist",
    }).prompt_fragment;
    const specialistPromptBase = composeSpecialistPrompt({
      acceptance_commands: config.acceptance_commands,
      base_prompt: config.specialist_base_prompt, foreground: specialistForeground ?? "",
      action: action ?? emptyAction(category), governed_checkpoint: governedCheckpoint,
      checkpoint_at: communicationCheckpoint, communications: specialistCommunications,
      communication_budget: config.communication_budget,
      inject_memory: (prompt) => manager.kbInject(prompt, campaign_id, config.specialist_cap, nodeId),
    });
    // Bounded retry-context capsule (see retry-context-capsule.ts): load is a
    // no-op without a configured port, so a caller that never wires
    // `config.retry_context` gets a byte-identical `specialistPrompt` to
    // legacy behavior. When a prior capsule exists, its projection is
    // appended and `decideRetryContinuation` runs as a pure advisory signal;
    // it only ever gates dispatch (loop-owned, never the critic/verification
    // path) when `retry_advisory_enforcement` is explicitly opted in AND the
    // decision found no material fingerprint/digest delta since last attempt.
    const stableContextDigest = sha256Hex(config.specialist_base_prompt);
    const loadedRetryContext = config.retry_context ? loadRetryContext(config.retry_context, campaign_id, nodeId) : null;
    let specialistPrompt = specialistPromptBase;
    if (loadedRetryContext) {
      const projectionResult = projectRetryContextCapsule(loadedRetryContext);
      if (projectionResult.ok) {
        specialistPrompt = appendRetryContextProjection(specialistPromptBase, projectionResult.projection);
      }
      const retryDecision = decideRetryContinuation({
        currentFingerprint: loadedRetryContext.failure.fingerprint,
        previousFingerprint: loadedRetryContext.failure.fingerprint,
        stableContextDigest,
        previousStableContextDigest: loadedRetryContext.stableContextDigest,
        hasNewEvidence: false,
        hasTaskOrFileDelta: sha256Hex(JSON.stringify(retryTaskFacts(category, action)))
          !== sha256Hex(JSON.stringify(loadedRetryContext.taskFacts)),
        occurrenceCount: loadedRetryContext.attempt,
      });
      const retryEnforced = retryDecision.action !== "continue" && (config.retry_advisory_enforcement ?? false);
      log({
        type: "retry_advisory",
        node_id: nodeId,
        action: retryDecision.action,
        reason: retryDecision.reason,
        occurrences: retryDecision.occurrenceCount,
        enforced: retryEnforced,
      });
      if (retryEnforced) {
        const fail = manager.recordResult(campaign_id, nodeId, {
          specialist_output: `Retry advisory suppressed dispatch: ${retryDecision.reason}`,
          specialist_agent: specialistAgent,
          provenance: { tag: "claimed", claimant: "loop" },
          critic_agent: "loop",
          critic_approved: false,
          critic_rationale: retryDecision.reason,
          // U3: same fixed-literal defect — include the actual advisory
          // reason, not just the enforced action kind.
          critic_root_cause: `retry_advisory_${retryDecision.action}: ${retryDecision.reason}`,
          score_ctx: config.score_ctx(campaign_id),
        });
        config.node_routing?.recordOutcome({ category, succeeded: false });
        if (fail.backtrack_parent) {
          log({ type: "backtracked", node_id: nodeId, parent_id: fail.backtrack_parent });
          report.path.push({ node_id: nodeId, state: "failed", score: 0 });
        }
        continue;
      }
    }
    const tokenDispatch = config.token_economy
      ? await prepareTokenDispatch({ campaign_id, node_id: nodeId, prompt: specialistPrompt, capability: "specialist", phase: "specialist", attempt_id: tokenAttemptId, config: config.token_economy })
      : undefined;
    if (tokenDispatch?.warning === "claimed") log({ type: "token_budget_warning", node_id: nodeId, epoch_id: tokenDispatch.epoch.epoch_id });
    if (tokenDispatch?.management === "claimed") log({ type: "context_management_claimed", node_id: nodeId, epoch_id: tokenDispatch.epoch.epoch_id });
    if (tokenDispatch?.overflow_retry === "recovered") log({ type: "overflow_recovered", node_id: nodeId, epoch_id: tokenDispatch.epoch.epoch_id, recovered_from_tokens: tokenDispatch.recovered_from_overflow_tokens, retries_used: 1 });
    if (tokenDispatch?.status === "suppressed_overflow") {
      log({ type: "dispatch_suppressed", node_id: nodeId, reason: "eligible_context_overflow", overflow_tokens: tokenDispatch.overflow_tokens, retry: tokenDispatch.overflow_retry });
      throw overflowError(campaign_id, nodeId, "specialist", tokenDispatch);
    }
    log({ type: "specialist_dispatched", node_id: nodeId, agent: specialistAgent });
    // E-2: this node's own expanded budget (set only after a
    // failed-verification critic-block retry) wins over the campaign's
    // base estimate; absent both, the executor falls back to its own
    // default unchanged.
    const turnBudgetEstimate = turnBudgetByNode.get(nodeId) ?? config.turn_budget_estimate;
    const specializeBaseParams = {
      campaign_id,
      node_id: nodeId,
      action: action ?? emptyAction(category),
      prompt: tokenDispatch?.prompt ?? specialistPrompt,
      specialist_agent: specialistAgent,
      ...(action?.execution_role === undefined ? {} : { execution_role: action.execution_role }),
      ...(action?.skill_id === undefined ? {} : { skill_id: action.skill_id, skill_version: action.skill_version! }),
      ...(action?.skill_inputs === undefined ? {} : { skill_inputs: action.skill_inputs, skill_inputs_provenance: action.skill_inputs_provenance }),
      ...(routingDecision === undefined ? {} : { routing: routingDecision }),
      ...(loadedRetryContext === null ? {} : { retrieval_changed_paths: loadedRetryContext.changedFiles.map((file) => file.path) }),
      ...(turnBudgetEstimate === undefined ? {} : { turn_budget_estimate: turnBudgetEstimate }),
    };
    // X-1 (ADR-067): env-gated (ARBOR_RACE_SPECIALISTS=2) and direct/reviewed
    // governance tier only; a governed tree (or one with no recorded
    // governance decision) always takes the unraced path below, byte-
    // identical to pre-ADR-067 behavior. Racing also requires a real
    // isolation-gated worktree (config.use_worktrees) — the fake ".tmp"
    // path used when worktrees are off has no lease to fork a second one
    // from.
    const raceGateTier = manager.getCampaignSnapshot(campaign_id)?.governance?.tier;
    const raceEligible = config.use_worktrees && isRaceEligible(process.env, raceGateTier);
    let specResult: SpecialistResult;
    let raceOutcome: RaceResult["outcome"] = null;
    if (raceEligible) {
      const raced = await raceSpecialize({
        executor,
        baseParams: specializeBaseParams,
        primaryWorktreePath: worktreePath,
        worktrees,
        // ADR-071 (PM-1): composition-supplied none-tie arbitration; absent
        // = attempt 1, today's behavior. Verification still owns every
        // verified winner.
        ...(config.race_tie_breaker === undefined ? {} : { tie_breaker: config.race_tie_breaker }),
        campaign_id,
        node_id: nodeId,
        specialist_agent: specialistAgent,
        signal,
        // ADR-069 (X-1): a composition-supplied learned threshold (p50 of
        // the ledger's own specialist walls) wins over the fixed default;
        // its provenance rides the race telemetry either way.
        ...(config.fork_threshold
          ? (() => { const learned = config.fork_threshold!(category); return { forkThresholdMs: learned.thresholdMs, thresholdSource: learned.source, thresholdObservations: learned.observations }; })()
          : { forkThresholdMs: resolveForkThresholdMs(process.env), thresholdSource: "default" as const, thresholdObservations: 0 }),
        log: (event) => {
          if (event.type === "race_forked") log({ type: "race_forked", node_id: event.node_id, forked_at_ms: event.forked_at_ms! });
          else log({ type: "race_settled", node_id: event.node_id, winner: event.winner!, cancelled: event.cancelled! });
        },
      });
      specResult = raced.result;
      raceOutcome = raced.outcome;
    } else {
      specResult = await withDispatchHeartbeat(
        executor.specialize({ ...specializeBaseParams, worktree_path: worktreePath, signal }),
        config.dispatch_heartbeat_ms ?? DEFAULT_DISPATCH_HEARTBEAT_MS,
        (elapsed_ms) => log({ type: "dispatch_heartbeat", node_id: nodeId, phase: "specialist", elapsed_ms }),
      );
    }
    if (raceOutcome) {
      try {
        const witness = manager.getLatestEvidenceId(campaign_id);
        if (witness) telemetry?.recordRaceOutcome?.({
          campaign_id, node_id: nodeId, operation_id: `${campaign_id}:${nodeId}:race`, epoch: i + 1,
          source_evidence_id: witness,
          ...raceOutcome.telemetry,
        });
      } catch (error) {
        // Telemetry is projection-only and cannot break governance — but a
        // silently-eaten refusal cost two live debugging rounds (empty
        // witness, then fractional learned threshold), so the rejection is
        // at least visible in the loop log now.
        log({ type: "race_telemetry_rejected", node_id: nodeId, reason: error instanceof Error ? error.message : String(error) });
      }
      // X-2: the loser's spend was real — journal it through the same
      // usage-cost path the winner uses below, never a fabricated zero-token
      // record when usage genuinely could not be recovered (see
      // `loser_usage_unavailable_reason`, emitted above on the race
      // observation itself rather than as a hollow `recordUsageCost` row).
      const loserUsage = raceOutcome.loser?.result?.token_usage;
      if (loserUsage && hasTokenUsage(loserUsage)) {
        const loserCost = raceOutcome.loser?.result?.usage_cost;
        emitCost({
          campaign_id, node_id: nodeId, operation_id: `${campaign_id}:${nodeId}:specialist:race-loser`, epoch: i + 1,
          phase: "expand", outcome: "cancelled", source_evidence_id: "", agent_id: specialistAgent,
          provider: loserCost?.provider ?? "other", model_family: loserCost?.model_family ?? "other",
          input_tokens: loserUsage.input_tokens,
          output_tokens: loserUsage.output_tokens,
          cache_read_tokens: loserUsage.cached_input_tokens,
          cache_write_tokens: loserUsage.cache_write_input_tokens,
          cost: loserCost?.cost ?? { kind: "unpriced", reason: "executor did not provide an attributable configured price observation" },
        });
      }
    }
    if (specResult.model_identity) emitModelIdentity({
      campaign_id, node_id: nodeId, operation_id: `${campaign_id}:${nodeId}:specialist:model`, epoch: i + 1,
      phase: "expand", outcome: "success", source_evidence_id: "", role: "specialist", model_id: specResult.model_identity,
    });
    if (tokenDispatch && hasTokenUsage(specResult.token_usage)) {
      config.token_economy!.epochs.recordUsage(
        campaign_id,
        nodeId,
        tokenDispatch.expansion_id,
        specResult.token_usage,
      );
    }
    throwIfAborted(signal);
    // A record is only written when the executor actually measured usage; an
    // `unavailable` result must not manufacture a hollow zero-token record.
    if (hasTokenUsage(specResult.token_usage)) {
      const usageCost = specResult.usage_cost;
      emitCost({
        campaign_id, node_id: nodeId, operation_id: `${campaign_id}:${nodeId}:specialist`, epoch: i + 1,
        phase: "expand", outcome: "success", source_evidence_id: "", agent_id: specialistAgent,
        provider: usageCost?.provider ?? "other", model_family: usageCost?.model_family ?? "other",
        input_tokens: specResult.token_usage.input_tokens,
        output_tokens: specResult.token_usage.output_tokens,
        cache_read_tokens: specResult.token_usage.cached_input_tokens,
        cache_write_tokens: specResult.token_usage.cache_write_input_tokens,
        cost: usageCost?.cost ?? { kind: "unpriced", reason: "executor did not provide an attributable configured price observation" },
      });
    }
    if (specResult.context_composition && telemetry?.recordContextEconomy) {
      try {
        const observation = buildContextEconomyObservation({
          identity: { operation_id: `${campaign_id}:${nodeId}:context-economy:specialist`, epoch: i + 1, phase: "expand",
            outcome: "success", source_evidence_id: "",
            idempotency_key: `context-economy:${campaign_id}:${nodeId}:${i + 1}:specialist`,
            provenance: { tag: "generated", generator: "arbor-loop-context-economy", input_hash: `${campaign_id}:${nodeId}:${i + 1}:specialist` } },
          composition: specResult.context_composition,
        });
        telemetry.recordContextEconomy({ campaign_id, node_id: nodeId, ...observation });
      } catch { /* telemetry is projection-only and cannot break governance */ }
    }
    if (specResult.tool_economy) emitToolEconomy({ node_id: nodeId, epoch: i + 1, phase: "expand", role: "specialist", economy: specResult.tool_economy });
    // ADR-019: the specialist cannot proceed without a human answer. Raise
    // the governed ledger transition and stop this iteration — dispatching a
    // critic on work that never happened would fabricate a review.
    if (specResult.needs_input) {
      raiseUserInput({
        manager, campaign_id, node_id: nodeId,
        is_lead: isLeadNode(manager, campaign_id, node),
        signal: specResult.needs_input,
      });
      report.awaiting_user_input = true;
      log({ type: "awaiting_user_input", campaign_id });
      break;
    }
    // G-08: a classified operational failure (timeout, spawn error, non-zero
    // exit, transport failure) — record it as the node's failure via the
    // same evidence-gated path as an isolation-gate rejection, instead of
    // burying it as unstructured text inside `output`. No critic dispatch:
    // there is no genuine work for a critic to review.
    if (specResult.error) {
      const fault = FAULT_MATRIX[specResult.error.kind];
      const explicitlyRecoverable = "recoverable" in specResult.error
        ? specResult.error.recoverable
        : true;
      // A retryable provider/runtime failure is an interruption, not a
      // rejected implementation.  Previously this branch ignored the
      // NodeError's `recoverable` field, failed the node, learned transient
      // transport trouble as a failure mode, and then auto-halted no_nodes.
      // Route it through the existing durable interruption protocol so a
      // fresh lease and explicit recovery decision are required before the
      // same node can be dispatched again.  Compositions without that port
      // retain the legacy terminal behavior rather than fabricating recovery
      // authority locally.
      if (fault.recovery === "retry" && explicitlyRecoverable && config.interruptions) {
        const durationMs = specResult.error.kind === "timeout" ? specResult.error.elapsed_ms : 0;
        emitPhase({
          campaign_id, node_id: nodeId,
          operation_id: `${campaign_id}:${nodeId}:${specResult.error.kind}`,
          epoch: i + 1, phase: "backprop", outcome: fault.telemetry_outcome,
          duration_ms: durationMs, source_evidence_id: "",
        });
        await config.interruptions.interrupt({
          campaign_id, node_id: nodeId, scope: "node",
          reason: `${specResult.error.kind}: ${specResult.error.message}`,
          cause: "operational_error", phase: "specialist",
        });
        saveRetryContext({
          retry_context: config.retry_context,
          campaign_id, node_id: nodeId,
          loaded: loadedRetryContext,
          failure: { failure_class: "operational", kind: specResult.error.kind, normalized_root_cause: `operational failure: ${specResult.error.kind}` },
          stableContextDigest, priorPromptDigest: sha256Hex(specialistPrompt),
          taskFacts: retryTaskFacts(category, action),
          changedFiles: specResult.changed_files ?? [],
          evidence: [], requirements: [],
          toolSignatures: retryToolSignatures(specResult.tool_call_signatures),
        });
        report.interrupted++;
        break;
      }
      const decomposeAttempt =
        fault.recovery === "decompose" && config.decomposer
          ? await attemptDecomposition({
              manager, campaign_id, node_id: nodeId, node, decomposer: config.decomposer, signal,
              ...(routingDecision === undefined ? {} : { max_depth: routingDecision.expansion_depth }),
            })
          : null;
      if (decomposeAttempt?.ok) {
        emitPhase({ campaign_id, node_id: nodeId, operation_id: `${campaign_id}:${nodeId}:decompose`, epoch: i + 1, phase: "backprop", outcome: "success", duration_ms: 0, source_evidence_id: "" });
        log({ type: "decomposed", node_id: nodeId, children: decomposeAttempt.children_ids.length, depth: decomposeAttempt.depth, provenance: decomposeAttempt.provenance });
        report.decomposed++;
        continue;
      }
      // No decomposer wired, the error kind doesn't route to "decompose", or
      // the decomposition attempt was itself rejected (depth bound, already
      // decomposed, decomposer declined, or invalid children) — the node
      // fails exactly as it did before this recovery path existed, with the
      // decompose-specific reason folded into the recorded message when
      // there is one.
      recordClassifiedError({
        manager, campaign_id, node_id: nodeId, epoch: i + 1, emitPhase, log,
        specialist_output: specResult.output,
        specialist_agent: specialistAgent,
        provenance: specResult.provenance,
        critic_agent: "loop",
        error: decomposeAttempt
          ? { ...specResult.error, message: `${specResult.error.message} (decomposition rejected: ${decomposeAttempt.reason})` }
          : specResult.error,
        score_ctx: config.score_ctx(campaign_id),
      });
      config.node_routing?.recordOutcome({ category, succeeded: false });
      report.failed++;
      report.kb_entries_written++;
      saveRetryContext({
        retry_context: config.retry_context,
        campaign_id, node_id: nodeId,
        loaded: loadedRetryContext,
        failure: { failure_class: "operational", kind: specResult.error.kind, normalized_root_cause: `operational failure: ${specResult.error.kind}` },
        stableContextDigest, priorPromptDigest: sha256Hex(specialistPrompt),
        taskFacts: retryTaskFacts(category, action),
        changedFiles: specResult.changed_files ?? [],
        evidence: [],
        requirements: [],
        toolSignatures: retryToolSignatures(specResult.tool_call_signatures),
      });
      // G-08 bounded operational retry (see `OPERATIONAL_RETRY_CEILING`'s
      // doc): the node was just recorded "failed" with real, durable
      // evidence above — never fabricated — exactly like a declined
      // decomposition always has. The one case this bounds is the
      // contradiction a decomposer-decline produces: "too large to finish
      // in the timeout window" and "already atomic, nothing to split"
      // cannot both be true, so the node deserves one bounded re-dispatch
      // of its own retry capsule (just persisted above) instead of dying on
      // that contradiction with no floor. `reviveNodeForRetry` requires the
      // node to already be `"failed"` (tree.ts's `reviveFailedNode`), which
      // is exactly the state `recordClassifiedError` just produced.
      const declinedAsAtomic = decomposeAttempt !== null && !decomposeAttempt.ok
        && decomposeAttempt.reason.startsWith("decomposer declined:");
      const priorOperationalRetries = operationalRetryByNode.get(nodeId) ?? 0;
      if (declinedAsAtomic && priorOperationalRetries < OPERATIONAL_RETRY_CEILING) {
        operationalRetryByNode.set(nodeId, priorOperationalRetries + 1);
        manager.reviveNodeForRetry(campaign_id, nodeId);
        log({
          type: "operational_retry", node_id: nodeId,
          attempt: priorOperationalRetries + 1, max_retries: OPERATIONAL_RETRY_CEILING,
          kind: specResult.error.kind,
        });
        report.operational_retried++;
      }
      continue;
    }
    const preparedSpecialist = await prepareOutput({
      campaign_id,
      node_id: nodeId,
      kind: "specialist",
      content: specResult.output,
      provenance: specResult.provenance,
      ...(specResult.verification_evidence === undefined ? {} : { verification_evidence: specResult.verification_evidence }),
      capture: config.output_evidence,
      budget: config.output_budget,
    });
    // Durably capture the specialist's completed output as a candidate BEFORE
    // critic dispatch (tranche1 §13 items 2/3): a critic-transport failure
    // below must never discard already-completed, potentially valuable
    // specialist work — `node.candidate` is that durable fallback,
    // independent of whatever verdict the critic eventually renders.
    manager.recordCandidate(campaign_id, nodeId, {
      specialist_output: preparedSpecialist.summary,
      specialist_agent: specialistAgent,
      provenance: specResult.provenance,
      // Q4: persist the specialist's observed token usage onto the candidate
      // itself so it survives even when review never completes — before
      // this, usage lived only on the ephemeral `specResult`/telemetry event
      // and was lost once the node went "awaiting_review" with no verdict.
      token_usage: specResult.token_usage,
    });
    // ADR-016: the specialist's completed output is real, durable evidence —
    // journal it as the node's `final` phase message. Nothing upstream
    // (opencode-executor.ts's `spawn`) exposes genuine incremental output
    // (see loop.ts's module doc / ADR-016 obligations), so only `final` is
    // ever emitted here; a `commentary` stream would fabricate structure the
    // transport never provided.
    emitPhaseMessage({
      node_id: nodeId, epoch: i + 1, role: "specialist", phase: "final",
      content: preparedSpecialist.summary, provenance: specResult.provenance,
    });
    // B2: everything from here through `recordResult` below is the "critic
    // phase" — the candidate is already durably captured (`recordCandidate`,
    // above), so ANY throw in this span (a KB-injection precondition, a
    // token-economy dispatch precondition, an output-boundary evidence
    // capture failure, or anything unexpected the critic transport itself
    // throws instead of returning a classified `critic.error`) must not
    // discard the candidate or kill the whole campaign run the way an
    // uncaught throw previously did (it propagated out of `runCampaign`
    // entirely, past the `ContextOverflowError`/abort-only outer catch
    // below, and the caller — `campaignRunner.run` in runtime.ts — recorded
    // the rejection only in an in-memory diagnostic map, never journaled to
    // the audit ledger, never emitted as a devtools event, and never
    // persisted to the supervised job record). The fix mirrors the existing,
    // already-tested `critic.error` handling a few lines down: leave the
    // node `"awaiting_review"` with its candidate intact via
    // `recordReviewFailure`, classified `internal_error`, and continue the
    // loop instead of dying. `ContextOverflowError` and an aborted signal
    // keep their existing, more specific outer-catch handling (interrupt /
    // cancellation) — only genuinely unexpected throws are contained here.
    try {
    const criticAgent = "lenticel";
    // ADR-062 `direct` governance tier: the arbiter waived review for this
    // single dispatch. Skip critic prompt-building and dispatch entirely
    // (no prompt is built, no critic call is made, no tokens are spent) and
    // synthesize the one honest way a node can leave `recordResult`
    // verified/claimed without a real critic verdict — `review_waived` on
    // the eventual `recordResult` call, never a fabricated `critic_approved`.
    const isDirectWaived = config.execution_strategy?.kind === "direct_single_action"
      && config.execution_strategy.review === "waived" && config.execution_strategy.node_id === nodeId;
    let critic: Awaited<ReturnType<LoopExecutor["review"]>>;
    // ADR-068: advisory findings journaled durably with the result; built in
    // the reviewed/governed branch below (a direct-tier waiver skips the
    // scan along with the critic it feeds).
    const advisoryEvidence: { generator: "sibling_scan" | "test_amplifier" | "mutation_probe"; activity: string; payload: string }[] = [];
    const criticStart = Date.now();
    if (isDirectWaived) {
      critic = {
        approved: true,
        rationale: "governance waived by arbiter (direct tier): specialist output accepted without critic review",
        critic_agent: "arbiter-direct",
        measurement_validated: true,
        token_usage: { kind: "unavailable", reason: "direct tier waives critic dispatch; no critic call was made" },
      };
    } else {
    const criticForeground = config.foreground?.derive({
      campaign_id, node_id: nodeId, agent: "lenticel", capability: "critic",
    }).prompt_fragment;
    // OPT-5 (verification-informed critic): give the pipelined verification a
    // short grace window to settle. When the machine observation is already
    // in, telling the critic so lets it skip re-running the very command the
    // harness just ran — the single largest driver of critic wall time and
    // tokens. Measured: a critic that must re-establish test results itself
    // takes 11–20 s; verification typically settles in 1–3 s, so this race
    // usually wins the evidence for free while preserving OPT-1's overlap in
    // the miss case. The grace never blocks longer than the window.
    const verificationGraceMs = 2_500;
    const earlyVerification = specResult.deferred_verification === undefined
      ? null
      : await Promise.race([
          specResult.deferred_verification,
          new Promise<undefined>((resolveGrace) => setTimeout(() => resolveGrace(undefined), verificationGraceMs)),
        ]);
    // E-2: only the "a real provenance upgrade settled" shape carries a
    // `.provenance`; a failed-attempt or not-yet-settled result must not be
    // read as one.
    const deferredEarlyVerified = earlyVerification != null && "provenance" in earlyVerification ? earlyVerification : null;
    // Connector integrations may finish independent verification before
    // `specialize()` returns instead of exposing the optional pipelined
    // promise. Treat that already-observed provenance identically for critic
    // context; otherwise the panel sees "not observed", rejects a genuinely
    // verified result, and the later recordResult fallback is too late.
    const earlyVerified = deferredEarlyVerified ?? (specResult.provenance.tag === "verified" ? { provenance: specResult.provenance } : null);
    // E-4 (arXiv 2605.17029/2501.01054, cascades 2607.13918): a weak
    // (`outputs_check`) verification must never be presented to the critic
    // as "verification passed" — that phrasing correctly belongs only to a
    // real, executed acceptance command.
    const verificationNote = earlyVerified === null || earlyVerified.provenance.tag !== "verified"
      ? ""
      : earlyVerified.provenance.strength === "outputs_check"
        ? `\n\nIndependent machine verification ran for this result: declared outputs are present (command: ${earlyVerified.provenance.cmd}, exit ${earlyVerified.provenance.exit}), but the plan's acceptance command was NOT run. This is weaker evidence than a passed acceptance command; verify correctness and completeness yourself rather than assuming the change works.`
        : `\n\nIndependent machine verification has ALREADY RUN for this result and passed (command: ${earlyVerified.provenance.cmd}, exit ${earlyVerified.provenance.exit}). Do not re-run tests or verification commands; focus your review on correctness, completeness, and guardrails of the change itself.`;
    // X-1 (patch-overfitting #1, arXiv 1909.13694): a cheap, bounded,
    // silently-degrading scan of the node's own worktree for sibling sites
    // the specialist's diff modified but left unaddressed elsewhere in the
    // tree. This is generated evidence for the critic to weigh, never a
    // verification signal — it never blocks, never retries, and is computed
    // fresh every time (no caching) since it's cheap and the worktree could
    // have changed. `worktreePath` is already in scope here (§3, above).
    const siblingSiteNote = computeSiblingSiteNote(worktreePath);
    // Y-3 (ADR-066): when the scan found sibling sites, an injectable
    // amplifier (cli supplies arbor-mcp's amplifySiblingSites; dependency
    // direction forbids importing it here) may generate an inverted
    // regression oracle per site and run it. A running-and-failing generated
    // test is EVIDENCE ONLY — one more note for the critic to weigh, never
    // an outcome or provenance input. Silent degradation on any failure.
    let amplifierNote = "";
    if (siblingSiteNote !== "") advisoryEvidence.push({ generator: "sibling_scan", activity: "sibling-site completeness scan", payload: siblingSiteNote.trim() });
    if (siblingSiteNote !== "" && config.test_amplifier) {
      try {
        const findings = await config.test_amplifier({ worktree_path: worktreePath, flagged_sites: computeSiblingSites(worktreePath), campaign_id, node_id: nodeId, signal: signal ?? new AbortController().signal });
        if (findings.length > 0) {
          amplifierNote = `\n\nGenerated-oracle check (evidence only, mined-class oracle): ${findings.map((finding) => finding.note).join(" ")}`;
          for (const finding of findings) {
            advisoryEvidence.push({ generator: finding.generator ?? "test_amplifier", activity: finding.generator === "mutation_probe" ? "diff∪sibling mutation probe" : "generated inverted regression oracle", payload: finding.note });
          }
        }
      } catch { /* advisory; never break dispatch */ }
    } else if (siblingSiteNote === "" && config.test_amplifier) {
      // Y-3 (BLINDSPOT-MANIFEST class 5): an amplifier IS configured, but
      // the sibling scan found nothing to feed it, so the branch above
      // never ran -- with no signal here, that is indistinguishable from
      // "analyzed this substrate and it was clean." `assessAnalyzerApplicability`
      // tells the two apart: a diff over only non-JS/TS files (e.g. `.py`)
      // means the downstream JS-shaped mutation-probe/amplifier pipeline
      // structurally could not have run, regardless of what it would have
      // found. Best-effort/advisory only, same posture as every scan above.
      try {
        const applicability = assessAnalyzerApplicability(computeDiffChangedFiles(worktreePath));
        const applicabilityNote = applicability.applicable
          ? "Generated-oracle/mutation-probe check: no sibling sites were flagged for this diff on a JS/TS-shaped substrate -- analyzed, nothing found."
          : `Generated-oracle/mutation-probe check: NOT APPLICABLE to this diff's substrate (${applicability.reason}) -- not analyzed, not evidence of correctness either way.`;
        advisoryEvidence.push({ generator: "sibling_scan", activity: "analyzer applicability", payload: applicabilityNote });
      } catch { /* advisory; never break dispatch */ }
    }
    const criticPrompt = manager.kbInject(
      appendSelectionCommunications(
        appendGovernedOverlay(
          `${config.critic_base_prompt}${criticForeground ? `\n\nLive foreground:\n${criticForeground}` : ""}\n\nSpecialist output:\n${preparedSpecialist.summary}${completionEvidenceReviewNote(preparedSpecialist.summary, action ?? emptyAction(category))}${verificationNote}${siblingSiteNote}${amplifierNote}`,
          governedCheckpoint,
          "critic",
        ),
        { checkpoint_at: communicationCheckpoint, communications: criticCommunications },
        config.communication_budget,
      ),
      campaign_id,
      config.critic_cap,
      nodeId,
    );
    const criticDispatch = config.token_economy && !config.panel
      ? await prepareTokenDispatch({ campaign_id, node_id: nodeId, prompt: criticPrompt, capability: "critic", phase: "critic", attempt_id: tokenAttemptId, config: config.token_economy })
      : undefined;
    enforceTokenDispatch(criticDispatch, campaign_id, nodeId, "critic", log);
    log({ type: "critic_dispatched", node_id: nodeId, agent: criticAgent });
    if (config.panel) {
      // Panel-of-critics (Phase 3.4): run the active critics and reconcile.
      if (!config.run_reviewer) {
        throw new Error("config.panel requires config.run_reviewer");
      }
      const panelCtx = {
        action_category: category,
        high_stakes: category === "architecture" || category === "security",
        description: action?.description ?? "",
        specialist_output: preparedSpecialist.summary,
        verification_note: verificationNote.trim(),
        worktree_path: worktreePath,
      };
      const decision = await config.panel.review(panelCtx, async (reviewer, context) => {
        const phase = `reviewer:${reviewer}`;
        const dispatch = config.token_economy
          ? await prepareTokenDispatch({ campaign_id, node_id: nodeId, prompt: `${criticPrompt}\n\nReviewer: ${reviewer}\n${JSON.stringify(context)}`, capability: "critic", phase, attempt_id: tokenAttemptId, config: config.token_economy })
          : undefined;
        enforceTokenDispatch(dispatch, campaign_id, nodeId, phase, log);
        const verdict = await config.run_reviewer!(reviewer, context);
        if (dispatch && verdict.token_usage) config.token_economy!.epochs.recordUsage(campaign_id, nodeId, dispatch.expansion_id, verdict.token_usage);
        return verdict;
      });
      // TEL-1 (ab3 bench): per-reviewer usage was dropped at reconciliation,
      // so no critic usage_cost record ever reached the audit ledger and the
      // review's spend was invisible to cost accounting. Sum whatever the
      // reviewers actually reported; stay honestly unavailable otherwise.
      const reviewerUsages = Object.values(decision.votes)
        .map((vote) => vote.token_usage)
        .filter((usage): usage is NonNullable<typeof usage> => usage !== undefined);
      // TEL-1: without this, a native single-call review and a CLI panel
      // review were indistinguishable in the ledger. One record per distinct
      // transport identity the reviewers reported.
      for (const identity of new Set(Object.values(decision.votes).map((vote) => vote.model_identity).filter((id): id is string => id !== undefined))) {
        emitModelIdentity({
          campaign_id, node_id: nodeId, operation_id: `${campaign_id}:${nodeId}:critic:model`, epoch: i + 1,
          phase: "critic", outcome: "success", source_evidence_id: "", role: "critic", model_id: identity,
        });
      }
      critic = {
        approved: decision.approved,
        rationale: decision.critic_rationale,
        root_cause: decision.critic_root_cause,
        critic_agent: "panel",
        measurement_validated: decision.approved,
        // A panel that could not reach the reviewers it needed has no verdict
        // to project. `reconcilePanelVerdict` would happily build a
        // syntactically valid five-mandate verdict out of zero parsed votes —
        // which is exactly how a network blip came to be durably recorded as a
        // critic rejection. Carry the typed error instead; the containment
        // branch below parks the node `awaiting_review` on it.
        ...(decision.error === undefined
          ? { verdict: reconcilePanelVerdict(decision) }
          : { error: decision.error }),
        // Without this the panel path (every production campaign) left the
        // critic span unpriced even with pricing configured: the reviewers'
        // cost observations were dropped at reconciliation, as usage was.
        ...(() => { const usage_cost = aggregatePanelUsageCost(decision.votes); return usage_cost === undefined ? {} : { usage_cost }; })(),
        token_usage: reviewerUsages.length === 0
          ? { kind: "unavailable", reason: "no panel reviewer reported provider-observed token usage" }
          : reviewerUsages.reduce((sum, usage) => ({
            input_tokens: sum.input_tokens + usage.input_tokens,
            output_tokens: sum.output_tokens + usage.output_tokens,
            cached_input_tokens: sum.cached_input_tokens + usage.cached_input_tokens,
            cache_write_input_tokens: sum.cache_write_input_tokens + usage.cache_write_input_tokens,
            counter_source: sum.counter_source,
          })),
      };
    } else {
      critic = await withDispatchHeartbeat(
        executor.review({
          campaign_id,
          node_id: nodeId,
          action: action ?? emptyAction(category),
          specialist_output: preparedSpecialist.summary,
          specialist_agent: specialistAgent,
          prompt: criticDispatch?.prompt ?? criticPrompt,
          critic_agent: criticAgent,
          signal,
        }),
        config.dispatch_heartbeat_ms ?? DEFAULT_DISPATCH_HEARTBEAT_MS,
        (elapsed_ms) => log({ type: "dispatch_heartbeat", node_id: nodeId, phase: "critic", elapsed_ms }),
      );
      if (critic.model_identity) emitModelIdentity({
        campaign_id, node_id: nodeId, operation_id: `${campaign_id}:${nodeId}:critic:model`, epoch: i + 1,
        phase: "critic", outcome: "success", source_evidence_id: "", role: "critic", model_id: critic.model_identity,
      });
      if (criticDispatch && hasTokenUsage(critic.token_usage)) config.token_economy!.epochs.recordUsage(campaign_id, nodeId, criticDispatch.expansion_id, critic.token_usage);
    }
    }
    const criticDuration = Date.now() - criticStart;
    emitPhase({ campaign_id, node_id: nodeId, operation_id: `${campaign_id}:${nodeId}:critic`, epoch: i + 1, phase: "critic", outcome: "success", duration_ms: criticDuration, source_evidence_id: "" });
    if (hasTokenUsage(critic.token_usage)) {
      const usageCost = critic.usage_cost;
      emitCost({
        campaign_id, node_id: nodeId, operation_id: `${campaign_id}:${nodeId}:critic`, epoch: i + 1,
        phase: "critic", outcome: "success", source_evidence_id: "", agent_id: critic.critic_agent ?? criticAgent,
        provider: usageCost?.provider ?? "other", model_family: usageCost?.model_family ?? "other",
        input_tokens: critic.token_usage.input_tokens,
        output_tokens: critic.token_usage.output_tokens,
        cache_read_tokens: critic.token_usage.cached_input_tokens,
        cache_write_tokens: critic.token_usage.cache_write_input_tokens,
        cost: usageCost?.cost ?? { kind: "unpriced", reason: "executor did not provide an attributable configured price observation" },
      });
    }
    if (critic.context_composition && telemetry?.recordContextEconomy) {
      try {
        const observation = buildContextEconomyObservation({
          identity: { operation_id: `${campaign_id}:${nodeId}:context-economy:critic`, epoch: i + 1, phase: "critic",
            outcome: "success", source_evidence_id: "",
            idempotency_key: `context-economy:${campaign_id}:${nodeId}:${i + 1}:critic`,
            provenance: { tag: "generated", generator: "arbor-loop-context-economy", input_hash: `${campaign_id}:${nodeId}:${i + 1}:critic` } },
          composition: critic.context_composition,
        });
        telemetry.recordContextEconomy({ campaign_id, node_id: nodeId, ...observation });
      } catch { /* telemetry is projection-only and cannot break governance */ }
    }
    if (critic.tool_economy) emitToolEconomy({ node_id: nodeId, epoch: i + 1, phase: "critic", role: "critic", economy: critic.tool_economy });
    throwIfAborted(signal);

    // ADR-019: the critic cannot render a verdict without a human answer.
    if (critic.needs_input) {
      raiseUserInput({
        manager, campaign_id, node_id: nodeId,
        is_lead: isLeadNode(manager, campaign_id, node),
        signal: critic.needs_input,
      });
      report.awaiting_user_input = true;
      log({ type: "awaiting_user_input", campaign_id });
      break;
    }
    // G-08/tranche1 item 3: a classified operational failure dispatching the
    // critic itself (transport failure, timeout, non-zero exit) — not a
    // rendered verdict. Before this, this path called `recordClassifiedError`
    // exactly like a genuine critic rejection: it discarded the specialist's
    // already-completed, potentially valuable work and scored the node as a
    // failure purely because review never happened. The candidate was
    // already durably captured (`manager.recordCandidate`, above) before
    // dispatch, so this path now only records that review attempt failed —
    // `manager.recordReviewFailure` leaves the node `"awaiting_review"` and
    // the candidate untouched. FAULT_MATRIX's telemetry outcome (and the
    // timeout kind's `elapsed_ms` salvage duration) is still emitted so this
    // event is not silently lost, but it is deliberately never counted
    // against `report.failed` or the failure_mode KB memory, and
    // `node_routing` is not told this was a failure — none of those signals
    // are true of a transport error on a specialist whose work is fine.
    //
    // O1 (ADR-184): that parking is only correct while the candidate might
    // still be good. When machine verification has ALREADY definitively failed
    // for this dispatch, the failure is proven and no critic opinion can rescue
    // it — parking would strand the node and halt `stranded_work` instead of
    // letting the loop backtrack/retry. Settle the pipelined verification
    // first; on a definite failure, record the review failure as a diagnostic
    // and fall through to the canonical failed-node path below with a
    // synthesized, verdict-less rejection (never a fabricated critic verdict).
    if (critic.error && specResult.deferred_verification) {
      const early = await specResult.deferred_verification;
      if (early !== null && "attempted" in early && early.failed === true) {
        const reviewError = critic.error;
        log({ type: "review_failed_after_machine_failure", node_id: nodeId, reason: reviewError.kind });
        critic = {
          approved: false,
          rationale: `critic review did not complete (${reviewError.kind}); node failed on its machine verification failure`,
          critic_agent: critic.critic_agent ?? criticAgent,
          token_usage: critic.token_usage,
          ...(critic.usage_cost === undefined ? {} : { usage_cost: critic.usage_cost }),
        };
      }
    }
    if (critic.error) {
      const mapped = FAULT_MATRIX[critic.error.kind];
      const duration_ms = critic.error.kind === "timeout" ? critic.error.elapsed_ms : 0;
      emitPhase({
        campaign_id, node_id: nodeId, operation_id: `${campaign_id}:${nodeId}:${critic.error.kind}`,
        epoch: i + 1, phase: "critic", outcome: mapped.telemetry_outcome, duration_ms, source_evidence_id: "",
      });
      manager.recordReviewFailure(campaign_id, nodeId, critic.error);
      log({ type: "review_pending", node_id: nodeId, reason: critic.error.kind });
      report.review_pending++;
      continue;
    }

    const effectiveCriticAgent = critic.verdict?.critic ?? critic.critic_agent ?? criticAgent;
    const criticProvenance = { tag: "claimed" as const, claimant: effectiveCriticAgent };
    const preparedCritic = await prepareOutput({
      campaign_id,
      node_id: nodeId,
      kind: "critic",
      content: [critic.rationale, critic.root_cause].filter(Boolean).join("\nRoot cause: "),
      provenance: criticProvenance,
      capture: config.output_evidence,
      budget: config.output_budget,
    });
    const propagatedSpecialist = suppressRoutineSuccess(preparedSpecialist, critic.approved);
    const propagatedRootCause = critic.root_cause
      ? excerptCapturedField(critic.root_cause, preparedCritic, config.output_budget)
      : undefined;

    // 6. Record result. A pipelined verification (OPT-1) has been running
    // concurrently with the critic since specialize returned; settle it now
    // — this await costs only whatever verification time exceeded the
    // critic's, usually zero.
    const deferredUpgrade = specResult.deferred_verification ? await specResult.deferred_verification : null;
    const verificationUpgrade = deferredUpgrade !== null && "provenance" in deferredUpgrade ? deferredUpgrade : null;
    capturedVerificationCommand = verificationUpgrade?.verification_command_argv;
    // E-2: this iteration's dispatch actually ran a declared verification
    // command and it did not exit cleanly — as opposed to `null` (no port,
    // no declared command, aborted, or non-admitted worktree). Only this
    // gates a turn-budget expansion on a subsequent critic-block retry.
    const machineVerificationFailed = deferredUpgrade !== null && "attempted" in deferredUpgrade && deferredUpgrade.failed === true;
    const machineVerificationRootCause = machineVerificationFailed
      ? `machine verification failed: ${deferredUpgrade.code ?? "verification_failed"}${deferredUpgrade.exit === undefined ? "" : ` (exit ${deferredUpgrade.exit})`}${deferredUpgrade.diagnostic === undefined ? "" : `: ${deferredUpgrade.diagnostic}`}`
      : null;
    if (machineVerificationFailed) {
      log({ type: "machine_verification_failed", node_id: nodeId, code: deferredUpgrade.code ?? "verification_failed", ...(deferredUpgrade.exit === undefined ? {} : { exit: deferredUpgrade.exit }) });
    }
    // Y-1 (ADR-065): an audit-tier scope mismatch is journaled with the
    // result — evidence, never a verdict input.
    const scopeObservation = deferredUpgrade !== null && "scope_observation" in deferredUpgrade ? deferredUpgrade.scope_observation : undefined;
    const blockedScopePaths = scopeObservation?.enforcement === "blocked"
      ? [...new Set(scopeObservation.observed_out_of_scope)].sort()
      : [];
    const scopeBlocked = blockedScopePaths.length > 0;
    const scopeFailureRootCause = scopeBlocked
      ? `write scope violation: modified path(s) outside declared authority: ${blockedScopePaths.join(", ")}`
      : null;
    // E-7c (ADR-063): when the settled verification upgrade carries the
    // campaign/node identity it was actually observed for, echo it into
    // `recordResult`'s `verification_source` so the manager's own
    // evidence-replay check can confirm it matches this call's own target.
    // Absent when the executor's port did not supply one (pre-existing
    // callers stay exactly as before — no replay protection, not a
    // regression).
    const verificationSource = verificationUpgrade?.verification_source;
    // An outputs-only check establishes that declared artifacts exist, not
    // that the task's acceptance command passed. Preserve that evidence for
    // review, but never let it retire a branch or make a result adoptable as
    // command-verified work. The specialist's original claimed provenance is
    // the honest terminal state until command_executed evidence exists.
    const effectiveProvenance = verificationUpgrade?.provenance.tag === "verified"
      && verificationUpgrade.provenance.strength === "outputs_check"
      ? specResult.provenance
      : verificationUpgrade?.provenance ?? specResult.provenance;
    const backpropStart = Date.now();
    const recorded = manager.recordResult(campaign_id, nodeId, {
      specialist_output: propagatedSpecialist,
      specialist_agent: specialistAgent,
      provenance: effectiveProvenance,
      critic_agent: effectiveCriticAgent,
      critic_approved: critic.approved,
      // A complete critic verdict is durable governance evidence.  Do not
      // replace its fields with a display-budget excerpt before persisting it.
      critic_rationale: critic.verdict?.rationale ?? preparedCritic.summary,
      critic_root_cause: critic.verdict?.root_cause ?? propagatedRootCause,
      ...(critic.verdict ? { critic_verdict: critic.verdict } : {}),
      ...(machineVerificationFailed ? { verification_failure: { code: deferredUpgrade.code ?? "verification_failed", ...(deferredUpgrade.exit === undefined ? {} : { exit: deferredUpgrade.exit }), ...(deferredUpgrade.diagnostic === undefined ? {} : { diagnostic: deferredUpgrade.diagnostic }), ...(deferredUpgrade.stages === undefined ? {} : { stages: deferredUpgrade.stages }) } } : {}),
      ...(verificationSource === undefined ? {} : { verification_source: verificationSource }),
      ...(isDirectWaived ? { review_waived: { by: "arbiter-direct", reason: "direct tier: critic review waived by the arbiter at task intake" } } : {}),
      ...(scopeObservation === undefined ? {} : { scope_observation: scopeObservation }),
      ...(advisoryEvidence.length === 0 ? {} : { advisory_evidence: advisoryEvidence }),
      score_ctx: config.score_ctx(campaign_id),
    });
    if (recorded.state === "failed") {
      const rootCause = scopeFailureRootCause ?? machineVerificationRootCause ?? critic.verdict?.root_cause ?? propagatedRootCause ?? preparedCritic.summary;
      const verificationBlocked = scopeBlocked || machineVerificationFailed;
      saveRetryContext({
        retry_context: config.retry_context,
        campaign_id,
        node_id: nodeId,
        loaded: loadedRetryContext,
        failure: {
          failure_class: verificationBlocked ? "verification" : "critic",
          kind: scopeBlocked ? "write_scope_violation" : machineVerificationFailed ? "machine_verification_failed" : "critic_rejection",
          normalized_root_cause: truncateToFieldCeiling(rootCause),
        },
        stableContextDigest,
        priorPromptDigest: sha256Hex(specialistPrompt),
        taskFacts: retryTaskFacts(category, action),
        changedFiles: specResult.changed_files ?? [],
        evidence: [
          ...retryEvidenceFromCapture(`${nodeId}:specialist`, "specialist_output", preparedSpecialist.capture),
          ...retryEvidenceFromCapture(`${nodeId}:critic`, "critic_output", preparedCritic.capture),
        ],
        requirements: scopeBlocked
          ? blockedScopePaths.map((path, index) => ({ id: `scope_path_${index + 1}`, description: `Do not modify ${path}; it is outside the action's declared write authority.`, status: "unresolved" as const }))
          : retryRequirementsFromRootCause(rootCause),
        toolSignatures: retryToolSignatures(specResult.tool_call_signatures, critic.tool_call_signatures),
      });
    }
    // WA-67 (label half): an audit-mode scope violation on a node that
    // still verified (ADR-065 graduated enforcement let the run proceed) —
    // durably record it so the settlement summary carries the actual
    // violation, not just a downgraded terminal_outcome. First-failure/
    // first-violation-wins, same as the isolation-gate diagnostic above.
    if (recorded.state === "verified" && scopeObservation?.enforcement === "audit" && scopeObservation.observed_out_of_scope.length > 0
      && manager.getCampaignRunDiagnostic(campaign_id) === null) {
      const auditPaths = [...new Set(scopeObservation.observed_out_of_scope)].sort();
      manager.recordCampaignRunDiagnostic(campaign_id, { message: `node ${nodeId} verified but changed path(s) outside its declared write scope (audit mode): ${auditPaths.join(", ")}` });
    }
    config.node_routing?.recordOutcome({ category, succeeded: recorded.state !== "failed" });
    let suppressCostExpansion = false;
    const costWitness = manager.getLatestEvidenceId(campaign_id);
    if (costWitness && telemetry?.recordNodeCostAttribution) {
      try {
        const attribution = buildNodeCostAttribution({
          identity: { operation_id: `${campaign_id}:${nodeId}:cost-attribution`, epoch: i + 1, phase: "backprop",
            outcome: recorded.state === "failed" ? "failure" : "success", source_evidence_id: costWitness,
            idempotency_key: `node-cost:${campaign_id}:${nodeId}:${i + 1}`,
            provenance: { tag: "generated", generator: "arbor-loop-cost-attribution", input_hash: `${campaign_id}:${nodeId}:${i + 1}` } },
          calls: [
            { span_id: `${campaign_id}:${nodeId}:specialist`, kind: "specialist", usage: specResult.token_usage, cost: specResult.usage_cost?.cost ?? { kind: "unpriced", reason: "specialist did not provide attributable cost" } },
            { span_id: `${campaign_id}:${nodeId}:critic`, kind: "critic", usage: critic.token_usage, cost: critic.usage_cost?.cost ?? { kind: "unpriced", reason: "critic did not provide attributable cost" } },
          ],
          tool_call_signatures: [...(specResult.tool_call_signatures ?? []), ...(critic.tool_call_signatures ?? [])],
          produced_verified_progress: recorded.state === "verified",
          expensive_threshold_minor_units: config.expensive_unproductive_threshold_minor_units,
        });
        telemetry.recordNodeCostAttribution({ campaign_id, node_id: nodeId, ...attribution });
        suppressCostExpansion = attribution.pruning_signal === "expensive_unproductive";
      } catch { /* telemetry is projection-only and cannot break governance */ }
    }
    const backpropDuration = Date.now() - backpropStart;
    emitPhase({ campaign_id, node_id: nodeId, operation_id: `${campaign_id}:${nodeId}:backprop`, epoch: i + 1, phase: "backprop", outcome: recorded.state === "failed" ? "failure" : "success", duration_ms: backpropDuration, source_evidence_id: "" });

    // Convergence: if this iteration produced no NEW KB entry (the outcome was
    // already known), increment the counter. The manager resets it to 0 when a
    // genuinely new entry is written. When the counter crosses
    // convergence_iterations, the next haltCheck returns "converged".
    if (recorded.kb_entry_id === null) {
      manager.incrementNoKbIteration(campaign_id);
    }

    // 7.5 Automatic structural compaction. The injected authority must commit
    // the replacement anchor before returning "completed"; the loop never
    // manufactures evidence ids or infers success from a rendered summary.
    const compactEvery = config.compaction_every_iterations ?? 0;
    if (compactEvery > 0 && (i + 1) % compactEvery === 0) {
      const guard = manager.getCompactionGuard(campaign_id, nodeId);
      if (!guard.active) {
        if (!config.structural_compaction) {
          log({ type: "compaction_skipped", node_id: nodeId, reason: "structural compaction authority is not configured; no lifecycle was recorded" });
        } else {
          const compacted = await config.structural_compaction.compact({ campaign_id, node_id: nodeId, iteration: i + 1, signal });
          if (compacted.status === "interrupted") {
            log({ type: "compaction_interrupted", node_id: nodeId, reason: compacted.reason });
          } else if (compacted.status !== "completed") {
            log({ type: "compaction_skipped", node_id: nodeId, reason: compacted.reason });
          }
        }
      }
    }

    // 8. Branch or backtrack based on the recorded state.
    if (recorded.state === "verified" || recorded.state === "claimed") {
      const score = manager.getNodeInfo(campaign_id, nodeId)?.score ?? 0;
      report.path.push({ node_id: nodeId, state: recorded.state, score });
      if (recorded.state === "verified") {
        report.verified++;
        log({ type: "node_verified", node_id: nodeId, score });
      } else {
        report.claimed++;
        log({ type: "node_claimed", node_id: nodeId, score });
      }
      if (score > report.best_score) report.best_score = score;
      if (recorded.kb_entry_id) report.kb_entries_written++;

      // A verified task is terminal before alternative branches are proposed.
      // Exploratory search retains the existing branch behavior.
      const taskComplete = recorded.state === "verified" && config.execution_strategy !== undefined
        && config.execution_strategy.kind !== "tree_search";
      if (!taskComplete) {
        const children = config.branch_actions({ action: action ?? emptyAction(category), output: propagatedSpecialist });
        if (children && children.length > 0 && !suppressCostExpansion && !manager.haltStatus(campaign_id).halted) {
          const childIds = manager.branch(campaign_id, nodeId, children);
          log({ type: "branched", parent_id: nodeId, children: childIds.length });
        }
      }
    } else if (recorded.state === "failed") {
      report.failed++;
      report.kb_entries_written++;
      log({ type: "node_failed", node_id: nodeId, root_cause: machineVerificationRootCause ?? propagatedRootCause ?? preparedCritic.summary });
      if (recorded.backtrack_parent) {
        log({ type: "backtracked", node_id: nodeId, parent_id: recorded.backtrack_parent });
      }
      // ADR-062 bounded critic-block retry: the measured flow gap this
      // closes is "critic rejects, campaign backtracks once and halts
      // no_nodes without ever retrying" — the rejection rationale was
      // already saved above (`saveRetryContext`) as a retry-context capsule
      // keyed by this exact node id, so reviving the SAME node lets the next
      // dispatch load it and inject the rejection rationale (and any prior
      // approved diagnosis carried in the capsule) into the retry prompt.
      // Capped at `critic_retry.max_retries` (default 0 = unchanged legacy
      // behavior); never an unbounded loop.
      const maxCriticRetries = config.critic_retry?.max_retries ?? 0;
      const priorCriticRetries = manager.getNodeInfo(campaign_id, nodeId)?.critic_retry_count ?? 0;
      const configuredRetryEligible = !scopeBlocked && maxCriticRetries > 0 && priorCriticRetries < maxCriticRetries;
      // E-3 (arXiv 2607.05391): `reviewed` tier only — a BLOCK with
      // confidence < 0.5 routes to this SAME bounded-retry seam instead of
      // terminal failure, even when `critic_retry` was never configured
      // (bounded to at least one retry via `Math.max(maxCriticRetries, 1)`).
      // `governed` tier is deliberately untouched: `isReviewedTier` is false
      // there, so this can never widen governed's retry eligibility beyond
      // what `critic_retry` alone already grants. Confidence only ever
      // gates a RETRY, never converts BLOCK to APPROVE. Absent or malformed
      // confidence (never parsed onto the verdict in the first place) means
      // this is always false — exactly today's terminal-BLOCK behavior.
      const isReviewedTier = config.execution_strategy?.kind === "direct_single_action"
        && config.execution_strategy.review !== "waived";
      const confidence = critic.verdict?.confidence;
      const lowConfidenceReviewedBlock = isReviewedTier && confidence !== undefined && confidence < 0.5;
      const confidenceRetryEligible = lowConfidenceReviewedBlock && priorCriticRetries < Math.max(maxCriticRetries, 1);
      const maxScopeRetries = config.scope_retry?.max_retries ?? 0;
      const priorScopeRetries = manager.getNodeInfo(campaign_id, nodeId)?.scope_retry_count ?? 0;
      const scopeRetryEligible = scopeBlocked && maxScopeRetries > 0 && priorScopeRetries < maxScopeRetries;
      if (scopeRetryEligible) {
        manager.reviveNodeForScopeRetry(campaign_id, nodeId);
        log({ type: "scope_retry", node_id: nodeId, attempt: priorScopeRetries + 1, max_retries: maxScopeRetries, paths: blockedScopePaths });
      } else if (configuredRetryEligible || confidenceRetryEligible) {
        manager.reviveNodeForRetry(campaign_id, nodeId);
        log({ type: "critic_retry", node_id: nodeId, attempt: priorCriticRetries + 1, max_retries: Math.max(maxCriticRetries, confidenceRetryEligible ? 1 : 0) });
        // E-2: expand the turn budget ONLY when this retry was caused by a
        // failed machine verification — never for a plain critic rejection
        // or a low-confidence-BLOCK retry (E-3) with no verification
        // failure behind it.
        if (machineVerificationFailed) {
          const currentBudget = turnBudgetByNode.get(nodeId) ?? config.turn_budget_estimate ?? TURN_BUDGET_EXPANSION_CEILING;
          turnBudgetByNode.set(nodeId, Math.min(currentBudget * 2, TURN_BUDGET_EXPANSION_CEILING));
        }
      }
    }

    // A task stop is permitted only after the canonical result transition has
    // durably returned `verified`. `tree_search` and the legacy undefined
    // strategy retain exhaustive behavior. Pending ALTERNATIVE candidates do
    // not block the stop — abandoning them is exactly what `first_verified`
    // means — but a pending DEPENDENT action (`depends_on`, i.e. a plan step
    // sequenced after the work that just verified, admitted by
    // `recordResult`'s own deferred-action release moments ago) is part of
    // the same task, not an alternative to it. Observed live: an
    // implementation node verified via the shallow declared-outputs check
    // and this halt fired with the plan's actual `node --test` verification
    // action still pending. Halt only when no dependent step remains.
    if (recorded.state === "verified" && config.execution_strategy !== undefined
      && config.execution_strategy.kind !== "tree_search") {
      const snapshot = manager.getCampaignSnapshot(campaign_id);
      const dependentWorkRemains = (snapshot?.nodes ?? []).some((node) => {
        if (node.state !== "pending" && node.state !== "expanding" && node.state !== "awaiting_review") return false;
        const info = manager.getNodeInfo(campaign_id, node.id);
        return (info?.action?.depends_on?.length ?? 0) > 0;
      });
      if (!dependentWorkRemains) {
        report.halted = true;
        report.halt_reason = "verified_result";
        manager.completeAutoHalt(campaign_id, "verified_result");
        log({ type: "halt", reason: "verified_result" });
        break;
      }
    }

    // Track pruning — count nodes pruned via the tree.
    report.pruned = countPruned(manager, campaign_id);
    } catch (criticPhaseError) {
      // B2 containment boundary (see the comment above `try {`, above): a
      // context-overflow signal or a genuine cancellation keep their
      // existing, more specific outer-catch handling (interrupt records,
      // cancellation bookkeeping) — re-throw those unchanged. Everything
      // else is an unexpected throw during the critic phase; the candidate
      // is already durable (`recordCandidate`, above `try`), so this
      // classifies it as an `internal_error` NodeError and routes it
      // through the same `recordReviewFailure` path a classified critic-
      // transport error already uses, instead of letting it escape
      // `runCampaign` and silently kill the whole supervised job.
      if (criticPhaseError instanceof ContextOverflowError) throw criticPhaseError;
      if (signal?.aborted) throw criticPhaseError;
      const message = criticPhaseError instanceof Error ? criticPhaseError.message : String(criticPhaseError);
      const stackHead = criticPhaseError instanceof Error && criticPhaseError.stack
        ? criticPhaseError.stack.split("\n").slice(0, 3).join("\n")
        : undefined;
      const internalError: NodeError = {
        kind: "internal_error",
        provenance: { tag: "generated", generator: "arbor-loop-critic-guard", input_hash: sha256Hex(message) },
        message: stackHead ? `${message}\n${stackHead}` : message,
        recoverable: true,
      };
      manager.recordReviewFailure(campaign_id, nodeId, internalError);
      log({ type: "review_pending", node_id: nodeId, reason: "internal_error" });
      report.review_pending++;
      continue;
    }
    } catch (error) {
      if (error instanceof ContextOverflowError) {
        if (!config.interruptions) { unwindingOnThrow = true; throw error; }
        await config.interruptions?.interrupt({
          campaign_id, node_id: nodeId, scope: "node", reason: error.message,
          cause: "context_overflow", phase: error.phase, epoch_id: error.epoch_id,
        });
        report.interrupted++;
        log({ type: "cancelled", reason: error.message });
        break;
      }
      if (signal?.aborted) {
        await config.interruptions?.interrupt({
          campaign_id, node_id: nodeId, scope: "subtree", reason: cancellationReason(signal.reason),
          cause: "cancellation", phase: "dispatch",
        });
        markCancelled(report, signal);
        report.interrupted++;
        log({ type: "cancelled", reason: report.cancellation_reason! });
        break;
      }
      // A genuinely unexpected throw (not a classified NodeError, not a
      // handled ContextOverflowError/cancellation) is about to escape
      // `runCampaign` entirely — the node never reached `recordResult` and
      // stays "expanding" with no evidence trail an operator could resume
      // from in-process. Unlike `interrupted`/`awaiting_review` below, there
      // is no controlled path left to hold the lease open for; release it
      // now so it doesn't leak, and rely on ADR-012's staleness-based
      // reconciliation (not this `finally`) to arbitrate the orphaned
      // "expanding" node on the next run.
      unwindingOnThrow = true;
      throw error;
    } finally {
      if (config.use_worktrees && lease?.active) {
        // Capture the node's worktree changes before the worktree is removed,
        // so a verified result can later be adopted into the main tree. Passive
        // and best-effort — it never fails the loop or advances the tree.
        const info = manager.getNodeInfo(campaign_id, nodeId);
        if (config.result_capture) {
          try {
            const provenance = info?.provenance;
            const highRiskScope = info?.action.high_risk_tool_scope;
            const declaredWritePaths = highRiskScope?.write_paths;
            config.result_capture.capture({
              campaign_id,
              node_id: nodeId,
              worktree_path: lease.path,
              verified: info?.state === "verified",
              score: info?.score ?? 0,
              ...(provenance == null ? {} : { verification_provenance: provenance }),
              ...(capturedVerificationCommand === undefined ? {} : { verification_command_argv: capturedVerificationCommand }),
              ...(declaredWritePaths === undefined ? {} : { declared_write_paths: declaredWritePaths }),
            });
          } catch { /* capture must never break cleanup */ }
        }
        // A node that ends this iteration still live — `awaiting_review`
        // (critic transport failed but the candidate is durable) or
        // `interrupted` (recoverable operational stop) — keeps its lease.
        // Releasing it here would let a concurrent or later dispatch reuse
        // the same worktree path while this node's uncommitted changes are
        // still the only copy of its work, with no guaranteed capture (the
        // block above is best-effort and swallows its own failures by
        // design). Only a terminal node (verified/claimed/failed/pruned/
        // abandoned — see `TERMINAL_NODE_STATES`) or a genuinely uncaught
        // throw (no controlled path left, see the comment above `throw
        // error` in the catch block) releases the lease.
        const nodeIsTerminal = info ? isTerminalNodeState(info.state) : true;
        if ((unwindingOnThrow || nodeIsTerminal) && worktrees.releaseLease(nodeId)) report.cleanup.leases_released++;
      }
    }
  }

  // The loop's per-iteration counters are the source of truth for
  // verified/claimed/failed; the audit trail would double-count.
  // pruned is read fresh from the manager (it's only set by pruneNode).
  report.pruned = countPruned(manager, campaign_id);

  if (!report.halted && !report.cancelled && !report.awaiting_user_input) {
    report.halted = true;
    report.halt_reason = "max_iterations";
    manager.completeAutoHalt(campaign_id, "max_iterations");
  }

  return report;
}

// ============================================================
// REPORT SHAPE
// ============================================================

export interface CampaignReport {
  campaign_id: string;
  iterations: number;
  verified: number;
  claimed: number;
  failed: number;
  pruned: number;
  /** Nodes split via the "decompose" recovery instead of recorded as a terminal failure (G-08). */
  decomposed: number;
  /**
   * Nodes left `"awaiting_review"` — real specialist work with a durably
   * captured candidate, but no critic verdict yet because dispatching the
   * critic itself failed (transport/timeout, tranche1 §13 item 3). Never
   * folded into `failed`: no failure was recorded for these nodes.
   */
  review_pending: number;
  halted: boolean;
  halt_reason: string | null;
  best_score: number;
  kb_entries_written: number;
  /** The path of verified/claimed nodes — the winning chain. */
  path: { node_id: string; state: "verified" | "claimed" | "failed"; score: number }[];
  /** Cancellation is distinct from a canonical campaign halt or timeout. */
  cancelled: boolean;
  cancellation_reason: string | null;
  /** Recoverable interruption outcomes applied; never counted as critic failure. */
  interrupted: number;
  /** G-08 bounded operational retries applied (see `OPERATIONAL_RETRY_CEILING`); each also counted once in `failed`, matching `critic_retry`'s existing precedent of counting the failed attempt itself. */
  operational_retried: number;
  cleanup: { leases_released: number };
  /**
   * True when the loop stopped early because a `RequestUserInput` answer is
   * outstanding (ADR-019) — either the top-of-loop guard found one already
   * pending, or this run's own specialist/critic raised one. Distinct from
   * `halted`/`cancelled`: the campaign can resume once the human answers, it
   * was not exhausted or aborted.
   */
  awaiting_user_input: boolean;
}

// ============================================================
// HELPERS
// ============================================================

/**
 * Narrow a `TokenUsageResult` to real `TokenUsage`. `TokenUsage` carries no
 * `kind` field of its own (it predates this union), so the discriminant check
 * is structural (`in`) rather than a literal-tag comparison.
 */
function hasTokenUsage(usage: TokenUsageResult): usage is TokenUsage {
  return !("kind" in usage);
}

/**
 * Raise the ADR-019 `RequestUserInput` ledger transition. Lead-only question
 * authority (see `isLeadNode`): only a plan-level (root's direct child) node
 * may raise a *blocking* question; a delegated sibling's question goes
 * through the identical ledger transition but tagged
 * `delegated_needs_input`/`async` — it never gains blocking authority by
 * itself. Blocking is derived here, once, from tree position, rather than
 * scattered per-caller conditionals (4D.8).
 */
function raiseUserInput(params: {
  manager: CampaignManagerPort;
  campaign_id: string;
  node_id: string;
  is_lead: boolean;
  signal: NeedsUserInputSignal;
}): void {
  const authority: UserInputAuthority = params.is_lead ? "lead" : "delegated_needs_input";
  const blocking: UserInputBlocking = params.is_lead ? "blocking" : "async";
  params.manager.askForUserInput({
    campaign_id: params.campaign_id,
    node_id: params.node_id,
    operation_id: `${params.campaign_id}:${params.node_id}:needs-input`,
    question: params.signal.question,
    options: params.signal.options,
    authority,
    blocking,
    requester_role: params.signal.requester_role,
    ...(params.signal.origin_session_id === undefined ? {} : { origin_session_id: params.signal.origin_session_id }),
    idempotency_key: params.signal.idempotency_key,
    as_of: new Date().toISOString(),
  });
}

/**
 * B3: dispatch the CRITIC — never the specialist — for every node
 * `manager.resumableReviewNodes` reports stranded in `"awaiting_review"`
 * with a durable candidate, and record the verdict through the same
 * evidence-gated `recordResult`/`recordReviewFailure` paths the main
 * per-node critic phase uses (checks-and-balances, provenance, and evidence
 * rules are all unchanged — this reuses the identical downstream recording,
 * just sourced from the durable candidate instead of a fresh specialist
 * result). Runs once per `runCampaign` entry, before iteration 1, so a
 * campaign re-entered after a stranded review (B2's containment boundary,
 * a killed process, or anything else that left review incomplete) has real
 * work to resume instead of `selectNode` finding nothing pending.
 *
 * Deliberately does not re-derive the governed-overlay/communications
 * context a fresh dispatch samples at selection time — a resumed review is
 * not a new selection, and KB injection (the one non-negotiable per
 * AGENTS.md's "mandatory before every specialist + critic dispatch") is
 * still applied via `manager.kbInject` below.
 */
async function resumeStrandedReviews(params: {
  manager: CampaignManagerPort;
  campaign_id: string;
  executor: LoopExecutor;
  config: CampaignLoopConfig;
  log: (e: LoopEvent) => void;
  report: CampaignReport;
  signal?: AbortSignal;
}): Promise<void> {
  const { manager, campaign_id, executor, config, log, report, signal } = params;
  const nodeIds = manager.resumableReviewNodes(campaign_id);
  for (const nodeId of nodeIds) {
    if (signal?.aborted) {
      // This runs before the per-node `for` loop even starts (see the
      // module doc above), so a `max_iterations: 0` (or an already-aborted
      // signal on entry) means that loop's own `signal?.aborted` check
      // never executes and would otherwise leave `report.cancelled` false —
      // the run would misreport a genuine cancellation as `max_iterations`
      // exhaustion. Mark it here, honestly, the same way the main loop does.
      markCancelled(report, signal);
      log({ type: "cancelled", reason: report.cancellation_reason! });
      return;
    }
    const info = manager.getNodeInfo(campaign_id, nodeId);
    const candidate = info?.candidate;
    // Resolved (or the candidate vanished) between listing and dispatch —
    // nothing left to resume for this id.
    if (!info || !candidate) continue;
    const action = info.action;
    const category = action?.category ?? "unknown";
    const criticPrompt = manager.kbInject(
      `${config.critic_base_prompt}\n\nSpecialist output:\n${candidate.specialist_output}`,
      campaign_id,
      config.critic_cap,
      nodeId,
    );
    const criticAgent = "lenticel";
    log({ type: "critic_dispatched", node_id: nodeId, agent: criticAgent });
    let critic: Awaited<ReturnType<LoopExecutor["review"]>>;
    try {
      critic = await executor.review({
        campaign_id,
        node_id: nodeId,
        action: action ?? emptyAction(category),
        specialist_output: candidate.specialist_output,
        specialist_agent: candidate.specialist_agent,
        prompt: criticPrompt,
        critic_agent: criticAgent,
        signal,
      });
    } catch (resumeError) {
      // A genuine cancellation must not be recorded as a fabricated
      // "internal_error" review verdict — mirrors the main per-node critic
      // phase's own `if (signal?.aborted) throw` boundary (B2, above). The
      // candidate is already durable and untouched; report it the same
      // honest way the pre-dispatch abort check above does.
      if (signal?.aborted) {
        markCancelled(report, signal);
        log({ type: "cancelled", reason: report.cancellation_reason! });
        return;
      }
      // Same containment as B2's critic-phase boundary: an unexpected throw
      // must not re-strand (or worse, crash the whole resume pass) a
      // candidate that is already durable. Leave it awaiting_review.
      const message = resumeError instanceof Error ? resumeError.message : String(resumeError);
      manager.recordReviewFailure(campaign_id, nodeId, {
        kind: "internal_error",
        provenance: { tag: "generated", generator: "arbor-loop-review-resume", input_hash: sha256Hex(message) },
        message,
        recoverable: true,
      });
      log({ type: "review_pending", node_id: nodeId, reason: "internal_error" });
      report.review_pending++;
      continue;
    }
    if (critic.error) {
      manager.recordReviewFailure(campaign_id, nodeId, critic.error);
      log({ type: "review_pending", node_id: nodeId, reason: critic.error.kind });
      report.review_pending++;
      continue;
    }
    const effectiveCriticAgent = critic.verdict?.critic ?? critic.critic_agent ?? criticAgent;
    const recorded = manager.recordResult(campaign_id, nodeId, {
      specialist_output: candidate.specialist_output,
      specialist_agent: candidate.specialist_agent,
      provenance: candidate.provenance,
      critic_agent: effectiveCriticAgent,
      critic_approved: critic.approved,
      critic_rationale: critic.verdict?.rationale ?? critic.rationale,
      critic_root_cause: critic.verdict?.root_cause ?? critic.root_cause,
      ...(critic.verdict ? { critic_verdict: critic.verdict } : {}),
      score_ctx: config.score_ctx(campaign_id),
    });
    if (recorded.state === "verified" || recorded.state === "claimed") {
      const score = manager.getNodeInfo(campaign_id, nodeId)?.score ?? 0;
      report.path.push({ node_id: nodeId, state: recorded.state, score });
      if (recorded.state === "verified") {
        report.verified++;
        log({ type: "node_verified", node_id: nodeId, score });
      } else {
        report.claimed++;
        log({ type: "node_claimed", node_id: nodeId, score });
      }
      if (score > report.best_score) report.best_score = score;
      if (recorded.kb_entry_id) report.kb_entries_written++;
    } else if (recorded.state === "failed") {
      report.failed++;
      report.kb_entries_written++;
      log({ type: "node_failed", node_id: nodeId, root_cause: critic.root_cause ?? critic.rationale });
      if (recorded.backtrack_parent) {
        log({ type: "backtracked", node_id: nodeId, parent_id: recorded.backtrack_parent });
      }
    }
  }
}

/**
 * Record a classified `NodeError` (G-08) as the node's failure — the same
 * evidence-gated `recordResult` path an isolation-gate rejection uses — and
 * emit the fault matrix's telemetry outcome instead of the generic
 * success/failure binary. No critic verdict is manufactured: `critic_agent`
 * names whichever side actually observed the failure (the loop itself for a
 * specialist-boundary error, the real critic agent for a critic-boundary one).
 */
function recordClassifiedError(params: {
  manager: CampaignManagerPort;
  campaign_id: string;
  node_id: string;
  epoch: number;
  emitPhase: (input: Parameters<LoopTelemetryPort["recordPhaseTiming"]>[0]) => void;
  log: (e: LoopEvent) => void;
  specialist_output: string;
  specialist_agent: string;
  provenance: Provenance;
  critic_agent: string;
  error: NodeError;
  score_ctx: ScoreContext;
}): void {
  const mapped = FAULT_MATRIX[params.error.kind];
  // A timeout's `NodeError` now carries the real observed wall-clock elapsed
  // time (see the frozen `NodeError.timeout.elapsed_ms` field populated by
  // both connector executors) — use it instead of fabricating a zero
  // duration for what was frequently the longest-running call in the
  // campaign. Every other failure kind has no comparable elapsed-time
  // evidence today, so it honestly keeps reporting 0 rather than guessing.
  const duration_ms = params.error.kind === "timeout" ? params.error.elapsed_ms : 0;
  params.emitPhase({
    campaign_id: params.campaign_id,
    node_id: params.node_id,
    operation_id: `${params.campaign_id}:${params.node_id}:${params.error.kind}`,
    epoch: params.epoch,
    phase: "backprop",
    outcome: mapped.telemetry_outcome,
    duration_ms,
    source_evidence_id: "",
  });
  const recorded = params.manager.recordResult(params.campaign_id, params.node_id, {
    specialist_output: params.specialist_output,
    specialist_agent: params.specialist_agent,
    provenance: params.provenance,
    critic_agent: params.critic_agent,
    critic_approved: false,
    critic_rationale: `${params.error.kind}: ${params.error.message}`,
    // U3: `critic_root_cause` previously dropped `params.error.message`,
    // leaving only the bare error kind (e.g. "timeout") on the node/report
    // surface with no indication of what actually happened.
    critic_root_cause: `${params.error.kind}: ${params.error.message}`,
    node_error: params.error,
    score_ctx: params.score_ctx,
  });
  params.log({ type: "node_failed", node_id: params.node_id, root_cause: `${params.error.kind}: ${params.error.message}` });
  if (recorded.backtrack_parent) {
    params.log({ type: "backtracked", node_id: params.node_id, parent_id: recorded.backtrack_parent });
  }
}

type DecomposeAttempt =
  | { ok: true; children_ids: string[]; depth: number; provenance: Extract<Provenance, { tag: "generated" }> }
  | { ok: false; reason: string };

/**
 * G-08 decompose recovery: called only when `FAULT_MATRIX` maps the observed
 * `NodeErrorKind` to `"decompose"` (timeout today) and the loop was
 * configured with a `decomposer`. The port only proposes; every guarantee
 * that keeps this from looping or mutating the tree on bad input is enforced
 * here, never trusted from the request or response:
 *
 *   - depth is read from the node's OWN persisted `action.decomposition_depth`
 *     (real, durable tree state) — never from anything the port returns, and
 *     never reset by a fresh process (survives campaign resume).
 *   - idempotency: a node that already has children cannot be decomposed
 *     again. This can only be true if this exact node was decomposed before:
 *     `branch_actions` never fires on a node still "expanding", so the only
 *     way an in-flight node acquires children is through this function.
 *   - fanout, shape, self-identity, and duplicate-sibling checks are
 *     `validateDecomposition`'s job (decompose-policy.ts); a single violation
 *     rejects the whole decomposition, never a partial or clamped one.
 *
 * On any rejection this returns `{ok: false, reason}` and the caller falls
 * through to the pre-existing typed-failure path (`recordClassifiedError`)
 * unchanged — a rejected decomposition is never a silent fall-through.
 */
async function attemptDecomposition(params: {
  manager: CampaignManagerPort;
  campaign_id: string;
  node_id: string;
  node: ReturnType<CampaignManagerPort["getNodeInfo"]>;
  decomposer: DecomposerPort;
  signal?: AbortSignal;
  max_depth?: number;
}): Promise<DecomposeAttempt> {
  const { manager, campaign_id, node_id, node, decomposer, signal } = params;
  if (!node) return { ok: false, reason: "node metadata unavailable" };
  if (node.children_ids.length > 0) {
    return { ok: false, reason: "node already has children (already decomposed once)" };
  }
  const maxDepth = params.max_depth ?? MAX_DECOMPOSITION_DEPTH;
  if (depthBoundReached(node.action, maxDepth)) {
    return { ok: false, reason: `decomposition depth bound (${maxDepth}) already reached` };
  }

  const depth = decompositionDepthOf(node.action);
  const result = await decomposer.decompose({
    campaign_id,
    node_id,
    action: node.action,
    reason: "timeout",
    depth,
    signal,
  });
  if (!result.ok) return { ok: false, reason: `decomposer declined: ${result.reason}` };

  const validated = validateDecomposition(node.action, result.children, maxDepth);
  if (!validated.ok) return { ok: false, reason: `invalid decomposition: ${validated.reason}` };

  const childActions = [...validated.children];
  const children_ids = manager.branch(campaign_id, node_id, childActions);
  return {
    ok: true,
    children_ids,
    depth: depth + 1,
    provenance: decompositionProvenance(campaign_id, node_id, node.action, childActions),
  };
}

function emptyAction(category: string): Action {
  return {
    description: "(action metadata unavailable)",
    estimated_gain: 0,
    estimated_cost: 0,
    category,
    delegate_to: "seed",
  };
}

/** Count pruned nodes from the audit stats. */
function countPruned(manager: CampaignManagerPort, campaign_id: string): number {
  try {
    const stats = manager.auditCampaign(campaign_id) as { pruned?: number };
    return stats.pruned ?? 0;
  } catch {
    return 0;
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw signal.reason instanceof Error ? signal.reason : new Error("Campaign loop cancelled");
  }
}

function markCancelled(report: CampaignReport, signal: AbortSignal): void {
  report.cancelled = true;
  report.cancellation_reason = cancellationReason(signal.reason);
}

function cancellationReason(reason: unknown): string {
  if (reason instanceof Error && reason.message) return reason.message;
  if (typeof reason === "string" && reason) return reason;
  return "Campaign loop cancelled";
}

function enforceTokenDispatch(
  dispatch: TokenDispatchPreparation | undefined,
  campaignId: string,
  nodeId: string,
  phase: string,
  log: (event: LoopEvent) => void,
): void {
  if (!dispatch) return;
  if (dispatch.warning === "claimed") log({ type: "token_budget_warning", node_id: nodeId, epoch_id: dispatch.epoch.epoch_id });
  if (dispatch.management === "claimed") log({ type: "context_management_claimed", node_id: nodeId, epoch_id: dispatch.epoch.epoch_id });
  if (dispatch.overflow_retry === "recovered") log({ type: "overflow_recovered", node_id: nodeId, epoch_id: dispatch.epoch.epoch_id, recovered_from_tokens: dispatch.recovered_from_overflow_tokens, retries_used: 1 });
  if (dispatch.status === "suppressed_overflow") {
    log({ type: "dispatch_suppressed", node_id: nodeId, reason: "eligible_context_overflow", overflow_tokens: dispatch.overflow_tokens, retry: dispatch.overflow_retry });
    throw overflowError(campaignId, nodeId, phase, dispatch);
  }
}

function overflowError(campaignId: string, nodeId: string, phase: string, dispatch: TokenDispatchPreparation): ContextOverflowError {
  return new ContextOverflowError(campaignId, nodeId, phase, dispatch.epoch.epoch_id, dispatch.overflow_tokens);
}
