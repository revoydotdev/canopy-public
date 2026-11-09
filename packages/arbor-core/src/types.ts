// arbor-shared — Core types shared across all arbor packages
// Clean-room design: derived from published concepts (Arbor arXiv 2606.12563v1,
// revoy-spec provenance model). No code copied from any source.

import type { TokenUsage } from "./token-economy.js";
import type { RuntimeGateRefusalV2 } from "./runtime-contracts.js";
import type { BackedUpReward } from "./reward.js";

// ============================================================
// PROVENANCE TYPES (from revoy-spec's !verified/!claimed/!generated model)
// ============================================================

/**
 * Provenance tag for any artifact in the system.
 *
 * - `verified`: A command was run and exited with the expected code. Machine-checkable.
 * - `claimed`: Asserted by an agent but not machine-verified.
 * - `critic_approved`: Approved by the Critic without a verification command.
 * - `generated`: Machine-generated artifact (tree state, projections).
 *
 * Only `verified` results can mark a tree node as 'verified' (retire a branch as successful).
 */
export type VerificationCheckKind = "shell_command" | "internal_integrity";
export type VerificationCheckBreadth = "suite" | "subset" | "single";
export interface VerificationCheck {
  /** Closed machine-readable class; never a path or free-text description. */
  kind: VerificationCheckKind;
  breadth: VerificationCheckBreadth;
}

export function isVerificationCheck(value: unknown): value is VerificationCheck {
  if (typeof value !== "object" || value === null) return false;
  const check = value as Record<string, unknown>;
  return (check.kind === "shell_command" || check.kind === "internal_integrity")
    && (check.breadth === "suite" || check.breadth === "subset" || check.breadth === "single");
}

/**
 * E-4 (arXiv 2605.17029/2501.01054, cascades 2607.13918): WHAT a `verified`
 * provenance actually observed. `"command_executed"` means the plan's real
 * declared acceptance command ran and its exit code was checked.
 * `"outputs_check"` means only declared-output artifact existence was
 * checked — no acceptance command ran. Optional/absent means a pre-E-4
 * provenance record, or a verifier that has not been updated to declare its
 * strength; both are honestly treated as the stronger claim was NOT made
 * (callers must not assume `"command_executed"` from absence).
 */
export type VerificationStrength = "command_executed" | "outputs_check";

export type Provenance =
  | { tag: "verified"; cmd: string; exit: number; stdout_hash: string; check?: VerificationCheck; strength?: VerificationStrength }
  | { tag: "claimed"; claimant: string }
  | { tag: "critic_approved"; critic: string; rationale: string }
  | { tag: "generated"; generator: string; input_hash: string };

// ============================================================
// ABSENCE-TYPED PROVIDER FACTS (Phase 6.4 — absence is a value, not a default)
// ============================================================

/**
 * Provider-observed token usage for an expansion, or a typed statement of why
 * it is unavailable. Never a silent `undefined`: an executor that cannot
 * recover usage (e.g. it shells out to a CLI and only sees stdout) must say
 * why, so the cost writer can distinguish "not measured" from "free".
 */
export type TokenUsageResult = TokenUsage | { kind: "unavailable"; reason: string };

/**
 * A provider call's cost: a priced exact-integer amount with its currency and
 * price-schedule evidence, or a typed statement of why no price is attached.
 * Never a hardcoded zero — a genuinely free call and an unpriced call must
 * stay distinguishable downstream.
 */
export type Cost =
  | {
      kind: "priced";
      minor_units: number;
      currency: string;
      minor_unit_exponent: number;
      price_source_id: string;
    }
  | { kind: "unpriced"; reason: string };

// ============================================================
// ENVELOPE (from revoy-spec's REVOY-Q envelope: value+provenance+as_of+id+absence)
// ============================================================

/**
 * Reason a value is absent. Distinguishes "not found" from "not yet attempted"
 * from "capability required" from "retracted".
 */
export type AbsenceReason =
  | "not_found"
  | "not_yet_attempted"
  | "capability_required"
  | "retracted";

/**
 * Every read from the KB returns an envelope — never raw data.
 * The envelope lets the scoring function reason about freshness, trust, and access.
 */
export interface Envelope<T> {
  value: T | null;
  provenance: Provenance | null;
  as_of: string; // Cursor: 'iter:N' or 'sha:XXXXXXX' or 'ts:ISO8601'
  id: string; // Stable identifier for this fact
  absence: AbsenceReason | null; // Non-null when value is null
}

// ============================================================
// CAPABILITY TIERS (from revoy-spec's senior/junior/auditor model)
// ============================================================

/**
 * Agent tier determines what KB entries are visible.
 * - specialist: sees only verdicts and constraints, never critic reasoning
 * - critic: sees everything including other critics' findings
 * - auditor: independent, sees everything, never self-clears
 */
export type AgentTier = "orchestrator" | "specialist" | "critic" | "auditor";

/**
 * Capability context carried on every KB read request.
 * Determined by the caller's tier — enforced by the KB layer.
 */
export interface CapabilityContext {
  tier: AgentTier;
  token?: string; // Present for orchestrator/critic/auditor tiers
}

// ============================================================
// ACTION TREE (from Arbor paper §4 — stateful tree search)
// ============================================================

/**
 * State of a tree node in the search.
 * - pending: created but not yet expanded
 * - expanding: a Specialist is working on it
 * - verified: passed Critic gate AND has !verified provenance
 * - claimed: passed Critic gate but only !claimed provenance
 * - failed: Specialist or Critic rejected it
 * - pruned: backtracked from; will not be revisited
 * - interrupted: recoverable operational stop; requires fresh retry authority
 * - abandoned: operator/auditor-authorized recovery outcome; not a Critic failure
 * - awaiting_review: a specialist's output was captured (see `CandidateArtifact`)
 *   but the Critic has not yet returned a usable verdict — e.g. dispatch is
 *   still in flight, or the prior attempt hit a critic transport failure and
 *   is pending retry. The captured work is durable in this state; it is not
 *   discarded or scored as a failure merely because review has not resolved.
 */
export type NodeState =
  | "pending"
  | "expanding"
  | "verified"
  | "claimed"
  | "failed"
  | "pruned"
  | "interrupted"
  | "abandoned"
  | "awaiting_review";

/**
 * The node states from which a node never re-expands.
 *
 * WHY ONE CONSTANT. Four call sites carried four different answers, and two of
 * them disagreed outright: `manager.ts`'s `isTerminalNodeState` counted
 * `claimed` but not `abandoned`, while the same file's parent/child-thread gate
 * counted `abandoned` but not `claimed`. `surveillance-monitor.ts` matched the
 * second; the product dashboard used a three-member list omitting both, so a
 * campaign whose root was `abandoned` still counted as active.
 *
 * The union is the union of what each site meant: a claimed node does not
 * re-expand, and neither does an abandoned one. `interrupted` and
 * `awaiting_review` are deliberately NOT terminal — both are recoverable and
 * both are expected to move again.
 */
export const TERMINAL_NODE_STATES: ReadonlySet<NodeState> = new Set<NodeState>([
  "verified", "claimed", "failed", "pruned", "abandoned",
]);

/** True when a node will never re-expand. Read `TERMINAL_NODE_STATES` for why. */
export function isTerminalNodeState(state: NodeState): boolean {
  return TERMINAL_NODE_STATES.has(state);
}

/**
 * The node states whose conversation thread no longer accepts direct operator
 * input. Deliberately NOT the same set as `TERMINAL_NODE_STATES`.
 *
 * WHY THESE DIFFER, AND WHY MERGING THEM IS A BUG. "Terminal" answers *will
 * this node re-expand?*; this answers *can a human still talk to this node's
 * thread?*. They differ on exactly one member: a `claimed` node is finished
 * expanding but its thread stays reachable, because a claim is the point at
 * which an operator is most likely to have something to say about the result.
 *
 * The two predicates were merged on 2026-08-27 on the theory that they had
 * drifted apart. They had not — they were answering different questions that
 * happened to share the word "terminal", and
 * `tests/parent-child-thread-runtime.test.ts` caught the merge by asserting a
 * claimed node still accepts input. They are kept adjacent here so the
 * distinction is visible to the next reader who notices they disagree.
 */
export const STATES_CLOSED_TO_DIRECT_INPUT: ReadonlySet<NodeState> = new Set<NodeState>([
  "verified", "failed", "pruned", "abandoned",
]);

/** True when a node's thread no longer accepts operator input. See the constant's note. */
export function isClosedToDirectInput(state: NodeState): boolean {
  return STATES_CLOSED_TO_DIRECT_INPUT.has(state);
}

/** Streaming append phase is deliberately smaller than the node lifecycle. */
export type MessagePhase = "commentary" | "final";

/**
 * Review-dispatch lifecycle for a captured candidate, independent of the
 * final NodeOutcome verdict. A candidate can be `awaiting_review` for a long
 * time (e.g. across a critic transport failure and retry) without ever being
 * lost — that persistence, not the review outcome, is what this type exists
 * to make durable.
 */
export type ReviewStatus = "not_dispatched" | "dispatched" | "awaiting_review" | "resolved";

/**
 * A specialist's completed output, captured and persisted BEFORE critic
 * dispatch — so a critic transport failure cannot discard already-completed
 * work. Never itself a verdict: `review_status` tracks where this candidate
 * is in the review lifecycle; `NodeOutcome`/`critic_verdict` (on TreeNode)
 * remain the source of truth for the FINAL disposition once review resolves.
 */
export interface CandidateArtifact {
  readonly specialist_output: string;
  readonly specialist_agent: string;
  readonly provenance: Provenance;
  /** ISO 8601 timestamp of capture, not of any later review event. */
  readonly captured_at: string;
  readonly review_status: ReviewStatus;
  /**
   * Q4: the specialist's observed token usage, captured alongside the
   * candidate so it survives even when review never completes (a critic
   * transport failure, a stranded `"awaiting_review"` node, ...). Optional
   * and additive — absent on candidates captured before this field existed,
   * and the snapshot validator (`persist.ts`) accepts both shapes.
   */
  readonly token_usage?: TokenUsageResult;
}

/** A routing signal, not a verdict or node state. */
export interface ContextOverflowSignal {
  kind: "context_overflow";
  observed_tokens: number;
  context_limit: number;
  message: string;
}

export interface ProvenanceBackedOutcome {
  provenance: Provenance;
  message: string;
}

/** Exhaustive operational error discriminants; none of these manufacture a Critic verdict. */
export const NODE_ERROR_KINDS = [
  "timeout",
  "context_window_exceeded",
  "quota_exceeded",
  "transport_error",
  "internal_error",
  "policy_refused",
] as const;
export type NodeErrorKind = typeof NODE_ERROR_KINDS[number];

/** Exhaustive outcome discriminants; governs the closed union during replay. */
export const OUTCOME_KINDS = ["verdict", "interrupted", "error"] as const;
export type OutcomeKind = typeof OUTCOME_KINDS[number];

/** Exhaustive operational errors; none of these manufacture a Critic verdict. */
export type NodeError =
  | (ProvenanceBackedOutcome & {
      kind: "timeout";
      /** Real wall-clock time elapsed before the kill, not the configured ceiling. */
      elapsed_ms: number;
      /** Output salvaged from the process before it was killed, if any. */
      partial_output: string | null;
      /** Token usage salvaged before the kill; `unavailable` when the process died before reporting it. */
      usage: TokenUsageResult;
    })
  | (ProvenanceBackedOutcome & { kind: "context_window_exceeded"; signal: ContextOverflowSignal })
  | (ProvenanceBackedOutcome & { kind: "quota_exceeded" })
  | (ProvenanceBackedOutcome & { kind: "transport_error"; recoverable: boolean })
  /**
   * `remedy` is present when the failure was an authority's refusal (a budget
   * ceiling, a tool veto) rather than a crash: the canonical v2 typed remedy
   * naming the actor that can clear it, carried to the operator surfaces that
   * read node outcomes.
   */
  | (ProvenanceBackedOutcome & { kind: "internal_error"; recoverable: boolean; remedy?: RuntimeGateRefusalV2 })
  /**
   * A deterministic policy refusal (an action-scope denial or approval
   * denial) that the model never worked around before turns/budget ran
   * out. `code` is the real string the refusing host produced (e.g.
   * `action_scope_path_denied`) — deliberately `string`, not a second
   * closed enum, so this type does not import the policy-code vocabulary
   * owned by native-tool-host.ts and neighboring hosts. See ADR-120.
   */
  | (ProvenanceBackedOutcome & { kind: "policy_refused"; code: string; recoverable: boolean; remedy?: RuntimeGateRefusalV2 });

/** One closed node result: governance verdict, interruption, or operational error. */
export type NodeOutcome =
  | (ProvenanceBackedOutcome & { kind: "verdict"; approved: boolean })
  | (ProvenanceBackedOutcome & { kind: "interrupted"; operation_id: string; scope: "node" | "subtree"; partial_evidence_ids: readonly string[] })
  | { kind: "error"; error: NodeError };

/** Closed policy controlling how runtime memory is projected for a node. */
export type MemoryMode = "accumulate" | "consolidate";

/**
 * Runtime-owned recovery linkage retained on the node without importing audit,
 * leases, or transport concerns into core. IDs point to durable runtime/audit
 * evidence owned by higher layers; they are never authority by themselves.
 */
export interface RecoveryAttempt {
  action: "retry" | "abandon";
  operation_id: string;
  prior_operation_id: string;
  actor_id: string;
  reason: string;
  expected_version: string;
  lease_id?: string;
  recorded_at: string;
}

/** Abandonment is operational governance, independently authorized upstream. */
export interface RecoveryAbandonment extends RecoveryAttempt {
  action: "abandon";
  actor_role: "operator" | "auditor";
}

/**
 * A node in the action tree.
 * The tree is the shared working memory across all agent classes (Arbor §4).
 */
export interface TreeNode {
  id: string;
  action: Action;
  score: number;
  state: NodeState;
  parent_id: string | null;
  children_ids: string[];
  visit_count: number;
  /**
   * ADR-106: edge-local visit count accumulated by `backpropagate` as
   * terminal outcomes complete along this node's own path — distinct from
   * `visit_count` (which `beginExpansion` bumps once, at expansion time)
   * and from `selectNode`'s whole-tree `categoryVisits` bandit count. Zero
   * until `createChild` initializes it and `backpropagate` walks past it.
   * Reuses the field already named/typed for `AgentUctScoreEvidence`
   * (above) rather than introducing a second name for the same concept.
   */
  edge_visit_count: number;
  /**
   * ADR-106: running-average outcome value backpropagated up this node's
   * ancestor chain on every terminal transition (`verifyNode`/`failNode`).
   * Zero until `createChild` initializes it and the first backpropagation
   * updates it. Bounded to a finite, non-negative running average — never
   * NaN, never negative.
   */
  value_estimate: number;
  /**
   * ADR-185: the full measured reward this node's terminal transition backed
   * up (value, source, measured flag, provenance, per-observation
   * contributions), so replay and audit can read WHY `value_estimate` moved.
   * Absent on non-terminal nodes and on every node persisted before this
   * field existed; the loader validates its shape when present.
   */
  reward?: BackedUpReward;
  verified_ref?: string; // Git ref / worktree hash of last verified state
  provenance: Provenance | null; // How this node's result was established
  kb_entries_extracted: number;
  specialist_output?: string;
  critic_verdict?: CriticVerdict;
  /** Specialist output captured before critic dispatch; see `CandidateArtifact`. */
  candidate?: CandidateArtifact;
  /** Closed result projection; durable audit evidence remains authoritative. */
  outcome?: NodeOutcome;
  created_at: string; // ISO 8601
  gate_records: GateRecord[]; // Process gate checkpoints
  /** Persisted per-node policy; children inherit the parent's value at branch time. */
  memory_mode: MemoryMode;
  /** Monotonic compare-and-set version for governed memory-mode transitions. */
  memory_mode_version: number;
  /** Append-only recovery linkage; it must not manufacture result evidence. */
  recovery_attempts?: RecoveryAttempt[];
  /**
   * ADR-062 (arbiter intake, `direct` governance tier): present only when
   * this node's result was recorded WITHOUT a real critic verdict — the
   * checks-and-balances invariant (no agent both proposes and approves) was
   * explicitly waived by the arbiter, not silently violated. Absent for
   * every ordinarily-reviewed node (`reviewed`/`governed` tiers, and every
   * node persisted before this field existed).
   */
  review_waived?: { readonly by: string; readonly reason: string };
  /**
   * ADR-062: number of bounded critic-block retries already spent on this
   * node (loop-owned, capped by `CampaignLoopConfig.critic_retry`). Absent
   * or 0 means no retry has happened yet.
   */
  critic_retry_count?: number;
  /**
   * Number of bounded corrective retries spent after trusted write-scope
   * enforcement blocked this node. Kept separate from critic retries so an
   * authorization failure can never be misreported as a design rejection.
   */
  scope_retry_count?: number;
  /**
   * ADR-119 O3: durable, replayable record of every intent-entry
   * (`HighRiskCommandIntent`) bound to a literal argv at first use, written
   * to the node's own persisted state at THE MOMENT the bind happens —
   * before the call it authorizes returns a result — so a later read never
   * depends on a still-live session or transcript. `intent_index` is the
   * entry's position within THIS node's own `action.high_risk_tool_scope
   * .command_argv` at bind time; stable because `Action` is immutable once
   * persisted. Append-only and monotonic: an `intent_index` already present
   * here is never rebound (`CampaignManager.recordScopeIntentBind`).
   */
  bound_scope_intents?: readonly BoundHighRiskIntent[];
}

/**
 * An explicit, authority-neutral native specialist role requested by a task.
 * Botanical `delegate_to` remains the durable agent identity; this only
 * selects a least-authority execution profile at a compatible host boundary.
 */
export type ActionExecutionRole = "architect" | "documentation-writer";

/**
 * Durable declaration of the exact high-risk effects an admitted action may
 * request. It is intentionally data only: composition turns it into a fresh
 * session/worktree-bound host scope, and no model context reference can add
 * entries after the action is persisted.
 */
export interface ActionHighRiskToolScope {
  readonly write_paths: readonly string[];
  readonly command_argv: readonly HighRiskCommandArgvEntry[];
  /**
   * Set ONCE, at admission, by `task-composer.ts`'s
   * `classifyAndRepairMutatingActions` — the only place that knows whether
   * this scope arrived already authored on the action (non-empty
   * `write_paths`/`command_argv`) or was mined/repaired there via
   * `extractDeclaredScope`. `"authored"` means the planner/operator declared
   * it; `"mined"` means it was derived from the action's own description or
   * acceptance checks. Absent for a scope constructed outside the task
   * composer (direct `admitCampaignPlan`, `root_action`, pre-existing
   * persisted campaigns) — callers must fall back to their own prior
   * (tier-based) approximation in that case, never assume either value.
   */
  readonly scope_provenance?: "authored" | "mined";
}

/**
 * ADR-119: a plan-time-knowable command INTENT, valid alongside a literal
 * full argv array wherever `command_argv` is declared. `argv_prefix` names
 * only the leading tokens the planner actually knows at plan time (e.g.
 * `["npm", "create"]`); `purpose` is the same free-text rationale every
 * declared action already carries elsewhere. The executor may run a command
 * whose argv starts with `argv_prefix`, but only for the FIRST such call —
 * see `native-tool-host.ts`'s bind-on-first-use enforcement, which pins the
 * intent to the exact observed argv from then on. Available at `direct`/
 * `reviewed` governance tier only; `governed`'s fully-literal
 * declare-and-reject posture never admits one (ADR-119 Decision §3).
 */
export interface HighRiskCommandIntent {
  readonly argv_prefix: readonly string[];
  readonly purpose: string;
}

/** One `command_argv` entry: an exact argv the executor will run, or (ADR-119) an intent bound to a literal argv at first use. */
export type HighRiskCommandArgvEntry = readonly string[] | HighRiskCommandIntent;

/** Type guard distinguishing an ADR-119 intent entry from a literal argv entry. */
export function isHighRiskCommandIntent(entry: HighRiskCommandArgvEntry): entry is HighRiskCommandIntent {
  return !Array.isArray(entry);
}

/** ADR-119 O3: one durable record of an intent-entry bound to a literal argv. See `TreeNode.bound_scope_intents`. */
export interface BoundHighRiskIntent {
  readonly intent_index: number;
  readonly argv_prefix: readonly string[];
  readonly purpose: string;
  readonly bound_argv: readonly string[];
  readonly bound_at: string; // ISO 8601
  readonly session_id: string;
}

/** One planner-authored acceptance criterion and every executable action it governs. */
export interface AcceptanceCheckAssignment {
  readonly criterion: string;
  /** Exact descriptions of actions in the same admitted plan. */
  readonly action_descriptions: readonly string[];
}

/**
 * An action proposed for the tree.
 */
export interface Action {
  description: string;
  estimated_gain: number; // g(a) — expected improvement
  estimated_cost: number; // c(a) — estimated token/time cost
  category: string; // For UCB category bonus
  delegate_to: string; // Agent name (e.g. "seed", "heartwood")
  constraints?: string[]; // MUST DO / MUST NOT DO
  /** Exact acceptance criteria materialized from the plan's explicit assignment map. */
  acceptance_checks?: readonly string[];
  /**
   * Optional operator/task-authored execution-profile request. This is not an
   * agent identity, approval, capability grant, or model-provided authority:
   * hosts must intersect it with their actual tools and policies.
   */
  execution_role?: ActionExecutionRole;
  /** Exact immutable declarative skill identity; both fields are present or both absent. */
  skill_id?: string;
  skill_version?: string;
  /** Explicit operator-command arguments for descriptor-declared skill inputs. */
  skill_inputs?: Readonly<Record<string, string>>;
  /** Binds those values to the immutable user command and protects against planner-authored substitution. */
  skill_inputs_provenance?: { readonly tag: "claimed"; readonly claimant: "cli-command"; readonly command_name: string; readonly command_descriptor_hash: string; readonly input_hash: string };
  /** Optional exact high-risk effects; omitted means native high-risk tools deny. */
  high_risk_tool_scope?: ActionHighRiskToolScope;
  /**
   * Closed mutation-intent classification. Set ONLY by the task composer's
   * own text classification at plan-materialization time
   * (`task-composer.ts`'s `classifyAndRepairMutatingActions`, reusing
   * `arbiter-intake.ts`'s `MUTATING_VERBS`/`READ_ONLY_INTENTS` heuristic) —
   * never trusted from planner/model-authored proposal JSON:
   * `task-composer-contracts.ts`'s `validateAction` does not list
   * `"mutating"` among the fields an incoming proposal may carry, so a
   * planner that emits one is rejected as an unsupported field rather than
   * adopted. A `"mutating"` action with no `high_risk_tool_scope` is not a
   * materializable action — the composer either derives (mines) a scope for
   * it or rejects the plan at admission; a stuck-at-runtime native
   * specialist is the failure mode this closes. `"read_only"` carries no
   * such requirement, matching the pre-existing "omitted scope means native
   * high-risk tools deny" contract. Optional/absent for every action
   * constructed outside the task composer (direct `admitCampaignPlan`
   * callers, fixtures, and every action persisted before this field
   * existed) — those paths are unaffected by the composer's admission
   * check.
   */
  mutating?: "read_only" | "mutating";
  /**
   * Set ONLY on an action produced by decomposing an over-large parent that
   * timed out (FAULT_MATRIX's `timeout -> "decompose"` recovery, arbor-opencode's
   * loop.ts). Counts consecutive decompose hops along this node's own
   * unbroken decompose chain: absent/0 for every ordinarily-authored action
   * (including one produced by the normal `branch_actions` happy path, even
   * if some ancestor was itself decomposition-produced — a genuine verified/
   * claimed branch is real forward progress and earns a fresh budget). This
   * is the sole durable record of decomposition depth: the loop derives its
   * termination bound by reading this field off the persisted tree node, and
   * never trusts a depth value handed back by a `DecomposerPort` caller.
   */
  decomposition_depth?: number;
  /**
   * Optional prerequisite links within the SAME plan admission, keyed by the
   * exact `description` string of the sibling action(s) that must reach a
   * `verified` tree state before this action becomes eligible to admit as an
   * executable tree node. `description` is the only stable per-action
   * reference the plan schema carries (no separate `id`/`label` field
   * exists), so it doubles as the dependency key — plans must keep sibling
   * descriptions unique when using `depends_on`.
   *
   * Absent/empty means no prerequisite: the action is created as an
   * executable child of root at admission time, exactly as before this
   * field existed. A non-empty list means the action is NOT created at
   * admission time; the campaign manager defers it and re-checks eligibility
   * on every scheduling pass, admitting it only once every named dependency
   * has reached `verified`. This is the root fix for plans where a
   * synthesis/rollup action could run before the investigations it depends
   * on ever produced a result.
   */
  depends_on?: readonly string[];
}

/**
 * Derived, non-persisted projection of a campaign's real-world outcome —
 * distinct from `HaltReason`, which only records WHY the loop stopped
 * scheduling, not whether the halt represents genuine success. A campaign can
 * halt with reason `"no_nodes"` (nothing left to schedule) while having
 * verified zero nodes; without this field that halt reads identically to a
 * halt after real, accepted work. `terminal_outcome` closes that gap:
 *
 * - `"in_progress"`: the campaign has not halted yet.
 * - `"completed"`: halted, at least one node reached `verified` state (which
 *   implies it passed the critic's real acceptance gate), and no action is
 *   still waiting on an unresolved `depends_on` prerequisite.
 * - `"failed"`: halted, zero nodes ever reached `verified`, and nothing is
 *   waiting on a dependency (i.e. the halt is not explained by legitimate
 *   pending prerequisites — it is a genuine hollow halt).
 * - `"partial"`: everything else — some verified progress but an unresolved
 *   dependency remains, or nothing verified yet but the halt is explained by
 *   actions still waiting on a prerequisite rather than by exhaustion.
 */
export type TerminalOutcome = "completed" | "partial" | "failed" | "in_progress";

// ============================================================
// DECOMPOSITION PORT (FAULT_MATRIX "decompose" recovery — G-08 extension)
// ============================================================

/**
 * A request to decompose one over-large action into completable leaves.
 * Constructed only by the canonical loop (arbor-opencode's loop.ts), never by
 * the `DecomposerPort` implementation itself.
 */
export interface DecompositionRequest {
  readonly campaign_id: string;
  readonly node_id: string;
  readonly action: Action;
  readonly reason: "timeout" | "operator";
  /**
   * How many ancestors of this node were already produced by decomposition.
   * Drives the depth bound. Always derived by the caller from the node's own
   * persisted `action.decomposition_depth` — a real tree-ancestry fact, not a
   * value round-tripped from anywhere else.
   */
  readonly depth: number;
  readonly signal?: AbortSignal;
}

/**
 * The decomposer's proposal. `ok: true` is not itself a green light — the
 * caller must still validate every child against `Action`'s invariants,
 * reject a child identical to its parent, reject duplicate siblings, and
 * enforce the fanout bound before any child becomes a real tree node.
 */
export type DecompositionResult =
  | { readonly ok: true; readonly children: readonly Action[] }
  | { readonly ok: false; readonly reason: string };

/**
 * The LLM-backed proposer. It only proposes — the deterministic bounding and
 * validation live entirely on the caller's side (arbor-opencode's
 * decompose-policy.ts), per this repo's checks-and-balances doctrine
 * (ADR-001): the tree/loop decides, an agent only suggests.
 */
export interface DecomposerPort {
  decompose(request: DecompositionRequest): Promise<DecompositionResult>;
}

/**
 * The Critic's verdict on a node expansion.
 */
export interface CriticVerdict {
  approved: boolean;
  critic: string; // Agent name
  rationale: string;
  root_cause?: string; // If rejected: WHY (not just "it failed")
  measurement_validated: boolean; // Were tests/measurements uncontaminated?
  guardrails_enforced: boolean; // Did the action stay in scope?
  introspection_passed: boolean; // Was the Specialist's reasoning consistent?
  stability_ok: boolean; // Is the loop oscillating?
  checks: CriticCheck[]; // The five-point mandate results
  /**
   * E-3 (arXiv 2607.05391): the critic's continuous confidence in this
   * verdict, in [0, 1]. Absent means an older verdict, a verdict the critic
   * gave no usable confidence signal for, or one whose confidence failed
   * validation (out of range / non-numeric) -- never coerced to a number.
   * Confidence only ever affects whether a BLOCK gets a bounded retry
   * (ADR-062's critic-block seam); it never converts BLOCK to APPROVE.
   */
  confidence?: number;
  /**
   * Where `confidence` came from. `"logprobs"` when derived from provider
   * token log-probabilities; `"self_report"` when the model was asked to
   * emit a numeric self-score in its structured verdict JSON. Present iff
   * `confidence` is present.
   */
  confidence_source?: "logprobs" | "self_report";
}

/**
 * Individual check in the Critic's five-point mandate (Arbor Appendix A4).
 *
 * X-2 (patch-overfitting #2, arXiv 2306.09896): `completeness` is an
 * additional, OPTIONAL check name a critic may report alongside the
 * five-point mandate -- does the change address every site/aspect of the
 * root cause, not merely enough to satisfy the declared test? It is never
 * required and carries no dedicated top-level `CriticVerdict` field; a
 * present-but-failed `completeness` check is treated exactly like a failed
 * mandate check by existing approval-gating logic.
 */
export interface CriticCheck {
  name: "root_cause" | "measurement_validation" | "guardrail_enforcement" | "introspection" | "stability_monitoring" | "completeness";
  passed: boolean;
  detail: string;
}

// ============================================================
// PROCESS GATES (from revoy-spec's process_gate.v1, ADR-086)
// ============================================================

/**
 * Typed process gate wrapping the tree-search loop.
 * Each gate has a pass/fail/bypass record in the audit trail.
 */
export type GateType =
  | "admission" // Before campaign start
  | "isolation" // Before Specialist expansion
  | "evidence" // After Critic approval, before node verification
  | "audit"; // After campaign halt

export interface GateRecord {
  gate: GateType;
  result: "pass" | "fail" | "bypass";
  checked_at: string; // ISO 8601
  detail: string;
  bypass_evidence_deficit?: string; // If bypassed: what evidence is missing
}

// ============================================================
// SCORING (from Arbor paper — UCT with regression-aware priors)
// ============================================================

/**
 * Context for scoring an action via the UCT function.
 */
export interface ScoreContext {
  accuracy_regression_rate: number; // r_acc: 0..1
  crash_regression_rate: number; // r_crash: 0..1
  best_known: number; // Best result achieved so far
  total_visits: number; // N in UCB formula
}

/**
 * Configuration for the scoring function.
 */
export interface ScoreConfig {
  exploration_constant: number; // C in UCB — tunable, default sqrt(2) ≈ 1.414
}

export const DEFAULT_SCORE_CONFIG: ScoreConfig = {
  exploration_constant: Math.SQRT2,
};

/**
 * Minimal structural marginal-cost measurement for ledger-derived projections.
 *
 * This carries the exact observed amounts behind an experimental Agent-UCT
 * marginal-cost estimate while staying package-local and transport-agnostic.
 */
export interface MarginalCostObservation {
  source: "ledger_projection";
  full_cost_minor_units: number;
  marginal_cost_minor_units: number;
  currency: string;
  minor_unit_exponent: number;
}

/**
 * Feature-gated Agent-UCT evidence for evaluation-only scoring experiments.
 *
 * These fields map directly to the paper's selection term:
 * - reward_estimate: empirical reward estimate \hat{Q}_t(s, a)
 * - state_visit_count: N_t(s)
 * - edge_visit_count: N_t(s, a)
 * - marginal_cost_estimate: \widehat{\Delta C}_t(s, a)
 * - iteration: t, used for the decaying lambda schedule
 *
 * Production selection remains on classic Arbor UCT unless a caller
 * explicitly opts into this experimental policy.
 */
export interface AgentUctScoreEvidence {
  source: "measured_prefix_reuse";
  reward_estimate: number;
  state_visit_count: number;
  edge_visit_count: number;
  marginal_cost_estimate: number;
  iteration: number;
  marginal_cost_observation?: MarginalCostObservation;
}

/**
 * Experimental Agent-UCT controls.
 *
 * `lambda_0` is the paper's base regularization coefficient and decays as
 * `lambda_0 / sqrt(t)`. `cost_scale` is a Revoy-owned normalization knob so
 * eval lanes can compare logical-cost units without changing measured evidence.
 */
export interface AgentUctScoreConfig {
  lambda_0: number;
  cost_scale: number;
}

export const DEFAULT_AGENT_UCT_SCORE_CONFIG: AgentUctScoreConfig = {
  lambda_0: 1,
  cost_scale: 1,
};

/**
 * Explicit scoring-policy gate.
 *
 * The default is classic Arbor UCT. Agent-UCT is a separate experimental/
 * evaluation policy and cannot activate implicitly from config alone; it
 * requires measured reward/visit/cost evidence in-band.
 */
export type ScorePolicy =
  | { mode: "classic" }
  | {
      mode: "agent_uct";
      evidence: AgentUctScoreEvidence;
      agent_uct_config?: AgentUctScoreConfig;
    };

export const DEFAULT_SCORE_POLICY: ScorePolicy = { mode: "classic" };

// ============================================================
// CAMPAIGN (the top-level unit of work)
// ============================================================

/**
 * Configuration for a tree-search campaign.
 */
export interface CampaignConfig {
  max_seconds: number;
  min_score: number;
  convergence_iterations: number; // Halt after N iterations with no new KB entry
  score_config: ScoreConfig;
}

export const DEFAULT_CAMPAIGN_CONFIG: CampaignConfig = {
  /** Zero disables the campaign wall-clock budget; positive values opt in. */
  max_seconds: 0,
  min_score: 0.1,
  convergence_iterations: 2,
  score_config: DEFAULT_SCORE_CONFIG,
};

/** The reasons halt_check itself derives; `HaltStatus["reason"]` is this plus null. */
export const HALT_STATUS_REASONS = ["budget_exhausted", "below_threshold", "converged", "manual"] as const;

/**
 * Halt status returned by halt_check.
 */
export interface HaltStatus {
  halted: boolean;
  reason: typeof HALT_STATUS_REASONS[number] | null;
  iterations_completed: number;
  iterations_without_kb_entry: number;
  best_score: number;
  elapsed_seconds: number;
}

/**
 * Reasons a campaign can record as halted. Superset of HaltStatus["reason"]:
 * the halt_check returns the authority-derived reasons, while the canonical
 * loop additionally records no_nodes (tree exhausted), verified_result (a
 * task's first governed result), scope_unadoptable (a command-verified result
 * whose observed writes exceed its declared scope), stranded_work
 * (`selectNode` found nothing pending, but the tree is NOT actually
 * exhausted — a node is parked `interrupted` or `awaiting_review`, states
 * `selectNode` cannot see; reporting `no_nodes` here would be dishonest,
 * since real work still exists, just not currently selectable), and
 * max_iterations (budget in the loop, not the halt_check), and unknown as an
 * explicit stop when no reason is derivable. CampaignState.halt_reason and
 * the manager snapshots use this widened union so a halt is never lost to
 * typing.
 *
 * The union is derived from `HALT_REASONS`, and the snapshot validator
 * (`validateCampaignSnapshot`) admits exactly that array, so a reason added
 * here is persistable by construction. A hand-kept whitelist there once
 * omitted `stranded_work`: the loop recorded it, the next load quarantined
 * the snapshot, and `arbor report` answered not_found (UCT Stage 0,
 * 2026-10-07).
 */
export const HALT_REASONS = [
  ...HALT_STATUS_REASONS,
  "no_nodes",
  "verified_result",
  "scope_unadoptable",
  "stranded_work",
  "max_iterations",
  "unknown",
] as const;
export type HaltReason = typeof HALT_REASONS[number] | null;

/** True when `value` is a `HaltReason` a campaign snapshot may record (null included). */
export function isHaltReason(value: unknown): value is HaltReason {
  return value === null || (typeof value === "string" && (HALT_REASONS as readonly string[]).includes(value));
}

/**
 * A plan action admitted with a `depends_on` prerequisite that has not yet
 * fully verified — held out of the tree until every named sibling
 * `description` it names reaches `verified` (see `Action.depends_on`).
 */
export interface DeferredAction {
  readonly action: Action;
  /** Sibling action `description` strings this action is still waiting on. */
  readonly depends_on: readonly string[];
}

/**
 * The top-level campaign state.
 *
 * `deferredActions` is schema version 2 of this shape (version 1 predates
 * DAG-admission and never carried it): optional and omitted from disk when
 * empty, so a version-1 snapshot loads unchanged and a version-2 snapshot's
 * pending DAG admissions survive a process restart instead of resetting to
 * "no deferred actions" every time `persistence_dir` reloads a campaign.
 */
export interface CampaignState {
  id: string;
  plan_path: string;
  config: CampaignConfig;
  tree: Map<string, TreeNode>;
  root_id: string;
  started_at: string;
  iterations_completed: number;
  iterations_without_kb_entry: number;
  best_score: number;
  halted: boolean;
  halt_reason: HaltReason;
  /** Absent/empty means either schema version 1 or no pending DAG admissions. */
  deferredActions?: readonly DeferredAction[];
  /**
   * B2 (item 3): a durable diagnostic for the most recent `campaign.run`
   * job failure — the real error message plus a bounded stack-trace head.
   * Additive and optional: absent when the campaign has never had a failed
   * run, or was persisted before this field existed. This lives on the
   * durable campaign snapshot (rather than only in a supervisor task's
   * transient in-memory settlement) so `arbor report`/`arbor doctor` and a
   * later process can see WHY a job died instead of just THAT it died.
   */
  run_diagnostic?: { message: string; stack_head?: string; recorded_at: string };
  /**
   * ADR-062: the arbiter's (or operator's) governance-tier decision for this
   * campaign, persisted durably at admission time so `arbor report`/audits
   * can answer "why was governance skipped" without re-deriving it.
   * Absent = pre-ADR-062 snapshot, or a campaign admitted through a path
   * that never runs the arbiter (defaults to the unchanged `governed`
   * behavior either way).
   */
  governance?: ArbiterDecision;
}

/** Closed governance-tier vocabulary (ADR-062). See `decisions/` for the ADR. */
export type GovernanceTier = "direct" | "reviewed" | "governed";

/** Who made the governance-tier call. */
export type ArbiterDecisionSource = "arbiter" | "operator_forced";

/** The declared blast radius backing an arbiter tier decision. */
export interface ArbiterBlastRadius {
  readonly write_paths?: readonly string[];
  readonly command_argv?: readonly (readonly string[])[];
  readonly reversibility: "reversible" | "irreversible" | "unknown";
}

/**
 * A durable governance-tier decision (ADR-062): either the arbiter's own
 * cheap classification at task intake, or an operator's explicit `--tier`
 * override. Persisted on both the task-composer draft and the admitted
 * campaign so a later report/audit can reconstruct exactly why a task ran
 * `direct`/`reviewed` instead of the full `governed` path.
 */
export interface ArbiterDecision {
  readonly tier: GovernanceTier;
  readonly rationale: string;
  readonly blast_radius: ArbiterBlastRadius;
  readonly source: ArbiterDecisionSource;
  readonly decided_at: string;
  /**
   * E-2 (arXiv 2607.13034, manifest item E3): a cheap heuristic estimate of
   * how many specialist turns this tier's dispatch needs. Consumed by the
   * connector as the specialist's max-turns ceiling (an env override still
   * wins over it, exactly as it wins over today's flat default). Absent
   * means a pre-E-2 decision; callers must fall back to their own existing
   * default, never assume a value.
   */
  readonly turn_budget_estimate?: number;
}

/**
 * X-2 (ADR-067): telemetry for a staggered first-verified-wins specialist
 * race (X-1, `@arbor/opencode`'s `race.ts`). Emitted at most once per node
 * dispatch, and only when the race gate actually engaged (env-gated,
 * `direct`/`reviewed` tier only, executor supports `deferred_verification`)
 * — never for a plain unraced dispatch. `winner: "none"` means neither
 * attempt's independent machine verification settled successfully before
 * the loop fell back to attempt 1's result (today's semantics). This is a
 * new, additive observation shape; it does not join arbor-audit's
 * `TelemetryObservation` union in this cycle (arbor-audit is out of this
 * package's ownership for this change) — a caller wires it into its own
 * ledger sink via `LoopTelemetryPort.recordRaceOutcome` (opencode/loop.ts).
 */
export interface RaceOutcomeObservation {
  /** Wall time from attempt 1's dispatch to the fork, or `null` if no fork occurred. */
  readonly forked_at_ms: number | null;
  /** Which attempt's machine verification won, or `"none"` if neither did. */
  readonly winner: "primary" | "fork" | "none";
  /** Wall time the losing (cancelled/discarded) attempt ran before it was superseded, or `null` if there was no loser. */
  readonly loser_wall_ms: number | null;
  /** True when the losing attempt was actively aborted via its `AbortSignal` (never true for `winner: "none"`, where both attempts ran to natural completion). */
  readonly cancelled: boolean;
  /**
   * Honest reason the losing attempt's token usage could not be journaled as
   * a real `usage_cost` row (e.g. its specialist dispatch was aborted
   * mid-flight before it returned any provider-observed usage). Absent when
   * the loser's usage was recoverable and journaled through the normal
   * `usage_cost` path instead.
   */
  readonly loser_usage_unavailable_reason?: string;
  /**
   * Additive (ADR-069, X-1): the fork threshold actually used for this
   * race, and its provenance. Absent on observations recorded before this
   * field existed -- always optional, never required by any existing
   * consumer. `arbor-audit`'s `race_outcome` validator does not yet accept
   * these fields; a caller journaling through a real `EvidenceLedger` must
   * not set them until that acceptance lands (documented integration point,
   * ADR-069's Consequences).
   */
  readonly threshold_ms?: number;
  /** `"learned"` (ledger-derived p50), `"env"` (explicit override), or `"default"` (fixed fallback) -- see `race-threshold.ts`. */
  readonly threshold_source?: "learned" | "env" | "default";
  /** Observation count backing a `"learned"` threshold; `0` for `"env"`/`"default"`. */
  readonly threshold_observations?: number;
  /**
   * Additive (ADR-071, X): which unverified result an optional tie-breaker
   * seam handed to the critic when a forked race ended `winner: "none"`
   * (both attempts fully settled, neither verified). `"none_default"` means
   * no tie-breaker was supplied, or it returned `null`, or it threw —
   * attempt 1 flows through exactly as before this field existed.
   * `"primary"`/`"fork"` mean the tie-breaker actively chose that attempt's
   * unverified result. Absent whenever `winner` is `"primary"` or `"fork"`
   * (verification alone decided) or the race never forked at all — a
   * tie-breaker is consulted ONLY on the forked `winner: "none"` path.
   * `arbor-audit`'s `race_outcome` validator does not yet accept this field;
   * a caller journaling through a real `EvidenceLedger` must not set it
   * until that acceptance lands (documented integration point, ADR-071's
   * Consequences).
   */
  readonly tie_break?: "primary" | "fork" | "none_default";
}
