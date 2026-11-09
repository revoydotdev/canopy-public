// arbor-core/tree — Action tree controller: selection, expansion, backtracking
// Clean-room from MCTS algorithm (Browne et al. 2012 — public domain).

import type { TreeNode, Action, ScoreContext, ScoreConfig, CampaignState, RecoveryAttempt, RecoveryAbandonment, Provenance } from "./types.js";
import { scoreAction } from "./scoring.js";
import { canonicalizeForHash } from "./canonical.js";

/**
 * Select the highest-scoring pending or expandable leaf node via UCT.
 * Returns null if no expandable nodes exist (all verified/failed/pruned).
 */
export function selectNode(
  tree: Map<string, TreeNode>,
  ctx: ScoreContext,
  config: ScoreConfig,
): string | null {
  let bestId: string | null = null;
  let bestScore = -Infinity;

  // Cache of ancestor-path validity: shared between the category-count and
  // scoring passes below, so each candidate's O(depth) ancestor walk runs at
  // most once instead of twice. `false` entries are never re-derived.
  const validity = new Map<string, boolean>();

  // Count visits per category for UCB — but only over nodes that are still
  // alive (pending-with-valid-ancestor or expanding). Counting dead nodes
  // (verified/failed/pruned) would let a category's burial of failures
  // suppress exploration of its remaining viable arms, so exclude them.
  const categoryVisits = new Map<string, number>();
  const isAlive = (id: string, node: TreeNode): boolean => {
    if (!node.parent_id) return true;
    const cached = validity.get(id);
    if (cached !== undefined) return cached;
    const result = isAncestorPathValid(tree, id);
    validity.set(id, result);
    return result;
  };
  for (const node of tree.values()) {
    if (node.state !== "expanding" && node.state !== "pending") continue;
    // `failNode` (unlike `pruneNode`) does not cascade into an
    // already-terminal node's children, so an "expanding" node (e.g. one
    // decomposed with children of its own — see arbor-opencode's
    // attemptDecomposition, which leaves the decomposed node permanently
    // "expanding") can be left alive-looking under a parent that later
    // fails. Apply the same ancestor-path check to "expanding" nodes that
    // "pending" nodes already get, so a stranded expanding descendant of a
    // dead ancestor cannot inflate its category's UCB denominator.
    if (!isAlive(node.id, node)) continue;
    categoryVisits.set(node.action.category, (categoryVisits.get(node.action.category) ?? 0) + node.visit_count);
  }

  for (const [id, node] of tree) {
    // Only select pending nodes that haven't been expanded yet
    if (node.state !== "pending") continue;

    // Skip nodes whose parent failed or was pruned
    if (!isAlive(id, node)) continue;

    const catVisits = categoryVisits.get(node.action.category) ?? 0;
    const score = scoreAction(node.action, ctx, catVisits, config);

    if (score > bestScore) {
      bestScore = score;
      bestId = id;
    }
  }

  return bestId;
}

/**
 * Create a new child node under a parent.
 * Called when Crown decides to branch.
 */
export function createChild(
  tree: Map<string, TreeNode>,
  parentId: string,
  action: Action,
): string {
  const parent = tree.get(parentId);
  if (!parent) throw new Error(`Parent node ${parentId} not found`);

  const id = generateNodeId();
  const child: TreeNode = {
    id,
    action,
    score: 0,
    state: "pending",
    parent_id: parentId,
    children_ids: [],
    visit_count: 0,
    edge_visit_count: 0,
    value_estimate: 0,
    provenance: null,
    kb_entries_extracted: 0,
    created_at: new Date().toISOString(),
    gate_records: [],
    memory_mode: parent.memory_mode,
    memory_mode_version: 1,
  };

  tree.set(id, child);
  parent.children_ids.push(id);
  return id;
}

/**
 * Mark a node as expanding — a Specialist is working on it.
 */
export function beginExpansion(tree: Map<string, TreeNode>, nodeId: string): void {
  const node = tree.get(nodeId);
  if (!node) throw new Error(`Node ${nodeId} not found`);
  if (node.state !== "pending") throw new Error(`Node ${nodeId} is not pending (state: ${node.state})`);
  node.state = "expanding";
  node.visit_count++;
}

/**
 * Mark a node as verified — passed Critic gate AND has !verified provenance.
 * Only !verified provenance allows this state.
 */
export function verifyNode(
  tree: Map<string, TreeNode>,
  nodeId: string,
  provenance: TreeNode["provenance"],
  specialistOutput: string,
  score: number,
): void {
  const node = tree.get(nodeId);
  if (!node) throw new Error(`Node ${nodeId} not found`);
  if (node.state === "verified") {
    const identicalReplay = provenance?.tag === "verified" && node.provenance?.tag === "verified"
      && node.score === score && node.specialist_output === specialistOutput
      && canonicalizeForHash(node.provenance) === canonicalizeForHash(provenance);
    if (identicalReplay) return;
    throw new Error(`Node ${nodeId} is verified and cannot receive a different Critic result`);
  }
  if (node.state !== "expanding" && node.state !== "awaiting_review") throw new Error(`Node ${nodeId} cannot receive a Critic result from state ${node.state}`);
  if (!Number.isFinite(score) || typeof specialistOutput !== "string") throw new Error(`Node ${nodeId} has an invalid Critic result`);

  node.score = score;
  node.specialist_output = specialistOutput;

  if (provenance?.tag === "verified") {
    node.state = "verified";
  } else if (provenance?.tag === "critic_approved") {
    node.state = "claimed"; // Critic approved but no verification command
  } else {
    node.state = "claimed"; // Default to claimed for non-verified
  }
  node.provenance = provenance;
  if (provenance) node.outcome = { kind: "verdict", approved: true, provenance, message: "Critic approved node result" };
}

/**
 * Mark a node as failed and backtrack to parent.
 * Records the failure and makes the parent available for new branches.
 */
export function failNode(
  tree: Map<string, TreeNode>,
  nodeId: string,
  rootCause: string,
): string | null {
  const node = tree.get(nodeId);
  if (!node) throw new Error(`Node ${nodeId} not found`);
  if (node.state === "abandoned" || node.state === "interrupted") throw new Error(`Node ${nodeId} is ${node.state} and cannot become a Critic failure`);
  // Symmetric with `verifyNode`'s own re-verification guard: "verified"
  // retires a branch (see `createCampaign`'s root-state comment) and must
  // not be overwritable by a late or duplicate failure evidence delivery
  // for the same node id landing after the node already verified.
  if (node.state === "verified") throw new Error(`Node ${nodeId} is verified and cannot be marked failed`);

  node.state = "failed";
  node.specialist_output = `FAILED: ${rootCause}`;

  // Walk up the ancestor chain to find the nearest node still valid to branch
  // from (verified/claimed/expanding). A child failing under an already-failed
  // parent must not strand the campaign with a null backtrack target when a
  // valid grandparent (or the root) exists higher up.
  if (node.parent_id) {
    let cursor: TreeNode | null = tree.get(node.parent_id) ?? null;
    while (cursor) {
      if (cursor.state === "verified" || cursor.state === "claimed" || cursor.state === "expanding") {
        return cursor.id;
      }
      cursor = cursor.parent_id ? tree.get(cursor.parent_id) ?? null : null;
    }
  }
  return null;
}

/**
 * ADR-106/ADR-133: backpropagate a terminal outcome along the exact path
 * that was selected — the node itself and every ancestor up to the root,
 * walking `parent_id` the same way `failNode`'s backtrack-target search
 * does, generalized here to not stop at the first still-valid ancestor.
 * Each node on the path gets its edge-local `edge_visit_count` incremented
 * and its `value_estimate` updated via a min-form (weakest-link) update:
 * the node's first backpropagated outcome becomes its `value_estimate`
 * outright (there is no real prior observation to take a minimum against —
 * the `0` a freshly-created node initializes to is a placeholder, not a
 * recorded outcome), and every subsequent call takes
 * `min(priorValue, outcome)`. This replaces the running-average update
 * (`value += (outcome - value) / edge_visit_count`) ADR-106 introduced:
 * per ADR-133, mean-form credit assignment drags a node's value toward
 * noise at the low visit counts this tree operates at, and min-form makes
 * `value_estimate` "the worst outcome this subtree has ever produced" —
 * one bad result and a subtree never looks better than its worst member
 * again.
 *
 * Callers invoke this once per terminal transition (`verifyNode`/`failNode`
 * reaching a terminal state) — never mid-expansion, so `edge_visit_count`
 * reflects completed subtree evidence, not in-flight guesses. This is
 * strictly additive to `failNode`'s own ancestor walk: `failNode` still
 * selects its backtrack target by state validity alone, and this function
 * touches no field `failNode` reads for that decision.
 *
 * `outcome` is the real, measured reward for the terminal node — kept as a
 * plain finite number (not clamped to [0, 1] here) so a caller with a
 * richer reward signal (e.g. a verification score) is not forced through
 * this function's own opinion of the scale.
 */
export function backpropagate(tree: Map<string, TreeNode>, nodeId: string, outcome: number): void {
  if (!Number.isFinite(outcome)) throw new Error(`backpropagate outcome must be a finite number, got ${outcome}`);
  const start = tree.get(nodeId);
  if (!start) throw new Error(`Node ${nodeId} not found`);

  let cursor: TreeNode | null = start;
  while (cursor) {
    const priorVisits = (cursor.edge_visit_count ?? 0) + 1;
    cursor.edge_visit_count = priorVisits;
    const priorValue = cursor.value_estimate ?? 0;
    cursor.value_estimate = priorVisits === 1 ? outcome : Math.min(priorValue, outcome);
    cursor = cursor.parent_id ? tree.get(cursor.parent_id) ?? null : null;
  }
}

/**
 * ADR-062: revive a critic-rejected `"failed"` node back to `"pending"` so
 * the loop can bounded-retry it with the rejection rationale injected as
 * retry context, instead of leaving it terminal. Increments the node's own
 * `critic_retry_count` so the loop can enforce a hard cap
 * (`CampaignLoopConfig.critic_retry`) independent of this function — this
 * function itself performs no capping; the caller is the sole authority on
 * whether another retry is allowed.
 */
export function reviveFailedNode(tree: Map<string, TreeNode>, nodeId: string): void {
  const node = tree.get(nodeId);
  if (!node) throw new Error(`Node ${nodeId} not found`);
  if (node.state !== "failed") throw new Error(`Node ${nodeId} is not failed (state: ${node.state})`);
  node.state = "pending";
  node.critic_retry_count = (node.critic_retry_count ?? 0) + 1;
}

/** Revive one machine-blocked scope failure for a separately capped correction. */
export function reviveScopeBlockedNode(tree: Map<string, TreeNode>, nodeId: string): void {
  const node = tree.get(nodeId);
  if (!node) throw new Error(`Node ${nodeId} not found`);
  if (node.state !== "failed") throw new Error(`Node ${nodeId} is not failed (state: ${node.state})`);
  node.state = "pending";
  node.scope_retry_count = (node.scope_retry_count ?? 0) + 1;
}

/**
 * Prune a node — it will never be revisited.
 * Used after backtracking to prevent re-selection.
 */
export function pruneNode(tree: Map<string, TreeNode>, nodeId: string): void {
  const node = tree.get(nodeId);
  if (!node) return;
  if (node.state === "abandoned" || node.state === "interrupted") return;
  node.state = "pruned";

  // Recursively prune children
  for (const childId of node.children_ids) {
    pruneNode(tree, childId);
  }
}

export type InterruptScope = "node" | "subtree";
export interface InterruptNodeInput {
  operation_id: string;
  scope: InterruptScope;
  provenance: Provenance;
  reason: string;
  partial_evidence_ids?: readonly string[];
}
export interface InterruptNodeResult {
  scope: InterruptScope;
  requested_node_id: string;
  affected_node_ids: string[];
  unchanged_node_ids: string[];
}

/** Pure, deterministic interruption. Pending descendants become non-selectable too. */
export function interruptNode(tree: Map<string, TreeNode>, nodeId: string, input: InterruptNodeInput): InterruptNodeResult {
  const requested = tree.get(nodeId);
  if (!requested) throw new Error(`Node ${nodeId} not found`);
  if (!input.operation_id.trim() || !input.reason.trim()) throw new Error("Interruption requires operation_id and reason");
  if (input.scope !== "node" && input.scope !== "subtree") throw new Error(`Invalid interruption scope ${String(input.scope)}`);
  const ids: string[] = [];
  const visit = (id: string): void => {
    ids.push(id);
    if (input.scope === "subtree") {
      const node = tree.get(id)!;
      for (const child of [...node.children_ids].sort()) visit(child);
    }
  };
  visit(nodeId);
  for (const id of ids) {
    const node = tree.get(id)!;
    if (node.state !== "interrupted") continue;
    if (node.outcome?.kind !== "interrupted" || node.outcome.operation_id !== input.operation_id) {
      throw new Error(`Node ${id} is already interrupted by a different operation`);
    }
    if (node.outcome.scope !== input.scope || node.outcome.message !== input.reason
      || JSON.stringify(node.outcome.partial_evidence_ids) !== JSON.stringify(input.partial_evidence_ids ?? [])
      || JSON.stringify(node.outcome.provenance) !== JSON.stringify(input.provenance)) {
      throw new Error(`Conflicting interruption replay for operation ${input.operation_id}`);
    }
  }
  const affected: string[] = [];
  const unchanged: string[] = [];
  for (const id of ids) {
    const node = tree.get(id)!;
    if (node.state === "pending" || node.state === "expanding") {
      node.state = "interrupted";
      node.outcome = { kind: "interrupted", operation_id: input.operation_id, scope: input.scope, partial_evidence_ids: [...(input.partial_evidence_ids ?? [])], provenance: input.provenance, message: input.reason };
      affected.push(id);
    } else if (node.state === "interrupted" && node.outcome?.kind === "interrupted" && node.outcome.operation_id === input.operation_id) {
      unchanged.push(id);
    } else {
      unchanged.push(id);
    }
  }
  return { scope: input.scope, requested_node_id: nodeId, affected_node_ids: affected, unchanged_node_ids: unchanged };
}

/**
 * Records a fresh runtime-authorized retry attempt and returns an interrupted
 * node to pending. It deliberately does not dispatch work, acquire a lease,
 * or infer any Specialist/Critic outcome; those belong above core.
 */
export function retryInterruptedNode(tree: Map<string, TreeNode>, nodeId: string, attempt: RecoveryAttempt): void {
  const node = tree.get(nodeId);
  if (!node) throw new Error(`Node ${nodeId} not found`);
  // pending/expanding remain accepted for migration of ADR-012 snapshots written
  // before `interrupted` became an explicit persisted state.
  if (node.state !== "interrupted" && node.state !== "pending" && node.state !== "expanding") throw new Error(`Node ${nodeId} is not interrupted (state: ${node.state})`);
  validateRecoveryAttempt(attempt, "retry");
  assertRecoveryOperationIsNew(node, attempt.operation_id);
  node.state = "pending";
  if (node.outcome?.kind === "interrupted") node.outcome = undefined;
  appendRecoveryAttempt(node, attempt);
}

/**
 * Return exactly one model-paused expansion to selection after its durable
 * RequestUserInput answer exists.  This is not recovery: it records no lease,
 * no retry attempt, and no outcome; dispatch remains an explicit later loop
 * run.  A completed/failed sibling can never be made selectable here.
 */
export function resumeAwaitingUserInputNode(tree: Map<string, TreeNode>, nodeId: string): void {
  const node = tree.get(nodeId);
  if (!node) throw new Error(`Node ${nodeId} not found`);
  if (node.state !== "expanding") return;
  node.state = "pending";
}

/**
 * Creates a non-selectable recovery outcome without laundering it into critic
 * failure or pruning away preserved evidence/children. Runtime must authorize
 * the supplied operator/auditor declaration before calling this pure helper.
 */
export function abandonInterruptedNode(tree: Map<string, TreeNode>, nodeId: string, abandonment: RecoveryAbandonment): void {
  const node = tree.get(nodeId);
  if (!node) throw new Error(`Node ${nodeId} not found`);
  if (node.state !== "interrupted" && node.state !== "pending" && node.state !== "expanding") throw new Error(`Node ${nodeId} is not interrupted (state: ${node.state})`);
  validateRecoveryAttempt(abandonment, "abandon");
  if (abandonment.actor_role !== "operator" && abandonment.actor_role !== "auditor") throw new Error("abandonment requires operator or auditor authority");
  assertRecoveryOperationIsNew(node, abandonment.operation_id);
  node.state = "abandoned";
  appendRecoveryAttempt(node, abandonment);
}

/**
 * Initialize a new campaign with a root node.
 */
export function createCampaign(
  id: string,
  planPath: string,
  rootAction: Action,
): CampaignState {
  const tree = new Map<string, TreeNode>();
  const rootId = "root";
  const root: TreeNode = {
    id: rootId,
    action: rootAction,
    score: 0,
    // The root is the admitted plan, not a machine-verified result. It carries
    // claimed provenance, so it must be 'claimed' — marking it 'verified' would
    // launder claimed provenance into verified state and break the invariant
    // that only !verified provenance retires a branch.
    state: "claimed",
    parent_id: null,
    children_ids: [],
    visit_count: 0,
    edge_visit_count: 0,
    value_estimate: 0,
    provenance: { tag: "claimed", claimant: "planner" },
    kb_entries_extracted: 0,
    created_at: new Date().toISOString(),
    gate_records: [],
    memory_mode: "accumulate",
    memory_mode_version: 1,
  };
  tree.set(rootId, root);

  return {
    id,
    plan_path: planPath,
    config: {
      max_seconds: 0,
      min_score: 0.1,
      convergence_iterations: 2,
      score_config: { exploration_constant: Math.SQRT2 },
    },
    tree,
    root_id: rootId,
    started_at: new Date().toISOString(),
    iterations_completed: 0,
    iterations_without_kb_entry: 0,
    best_score: 0,
    halted: false,
    halt_reason: null,
  };
}

// --- Internal helpers ---

function isAncestorPathValid(tree: Map<string, TreeNode>, nodeId: string): boolean {
  let current: string | null = nodeId;
  const visited = new Set<string>();

  while (current) {
    if (visited.has(current)) return false; // Cycle detection
    visited.add(current);

    const node = tree.get(current);
    if (!node) return false;

    if (node.state === "failed" || node.state === "pruned" || node.state === "abandoned") return false;
    current = node.parent_id;
  }
  return true;
}

function appendRecoveryAttempt(node: TreeNode, attempt: RecoveryAttempt): void {
  const attempts = node.recovery_attempts ?? [];
  node.recovery_attempts = [...attempts, { ...attempt }];
}

function assertRecoveryOperationIsNew(node: TreeNode, operationId: string): void {
  if ((node.recovery_attempts ?? []).some((prior) => prior.operation_id === operationId)) {
    throw new Error(`Recovery operation ${operationId} is already linked to node ${node.id}`);
  }
}

function validateRecoveryAttempt(attempt: RecoveryAttempt, action: RecoveryAttempt["action"]): void {
  if (attempt.action !== action) throw new Error(`Recovery attempt action must be ${action}`);
  for (const [field, value] of Object.entries(attempt)) {
    if (field === "lease_id") continue;
    if (typeof value === "string" && value.trim().length === 0) throw new Error(`Recovery attempt ${field} must be non-empty`);
  }
  if (Number.isNaN(Date.parse(attempt.recorded_at))) throw new Error("Recovery attempt recorded_at must be an ISO timestamp");
  if (action === "retry" && (!attempt.lease_id || !attempt.lease_id.trim())) throw new Error("Retry recovery attempt requires a fresh lease_id");
}

let nodeCounter = 0;
function generateNodeId(): string {
  nodeCounter++;
  return `node_${Date.now().toString(36)}_${nodeCounter.toString(36)}`;
}
