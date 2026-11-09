/**
 * decompose-policy — deterministic bounding & validation for the FAULT_MATRIX
 * "decompose" recovery (loop.ts).
 *
 * WHY THIS EXISTS. Real campaigns against an oversized "epic" leaf action
 * (a multi-hour human task seeded where the tree search expected a
 * completable unit) time out even at a 900s dispatch ceiling — there is
 * nothing left to decompose because the tree treats the epic as a leaf.
 * `DecomposerPort` (arbor-core/types.ts) lets an LLM propose a split. This
 * module is the other half: the LLM only proposes, this decides. Everything
 * that keeps decomposition from becoming an unbounded loop or a fabricated
 * tree mutation is enforced here, in pure functions independent of what any
 * model returns.
 */
import { canonicalizeForHash, type Action, type Provenance } from "@arbor/core";
import { createHash } from "node:crypto";

/** Depth bound: at most this many consecutive decompose hops along one unbroken chain (Action.decomposition_depth). */
export const MAX_DECOMPOSITION_DEPTH = 3;
/** Fanout bound (inclusive): a decomposition must produce between this many children. */
export const MIN_DECOMPOSITION_FANOUT = 2;
export const MAX_DECOMPOSITION_FANOUT = 6;

export type DecompositionOutcome =
  | { readonly ok: true; readonly children: readonly Action[] }
  | { readonly ok: false; readonly reason: string };

/** The node's own decomposition depth (see `Action.decomposition_depth`'s doc). Absent means 0 — an ordinarily-authored action. */
export function decompositionDepthOf(action: Action): number {
  return action.decomposition_depth ?? 0;
}

/** True once a node has already exhausted the depth bound and must not decompose further. */
export function depthBoundReached(action: Action, maxDepth = MAX_DECOMPOSITION_DEPTH): boolean {
  return decompositionDepthOf(action) >= maxDepth;
}

function normalize(description: string): string {
  return description.trim().toLowerCase().replace(/\s+/g, " ");
}

/** Structural validation against `Action`'s own invariants (arbor-core/types.ts:228). Returns the violation, or null if valid. */
function actionShapeViolation(action: Action): string | null {
  if (typeof action.description !== "string" || normalize(action.description).length === 0) {
    return "empty description";
  }
  if (typeof action.estimated_gain !== "number" || !Number.isFinite(action.estimated_gain) || action.estimated_gain <= 0) {
    return `estimated_gain must be finite and positive (got ${String(action.estimated_gain)})`;
  }
  if (typeof action.estimated_cost !== "number" || !Number.isFinite(action.estimated_cost) || action.estimated_cost <= 0) {
    return `estimated_cost must be finite and positive (got ${String(action.estimated_cost)})`;
  }
  if (typeof action.category !== "string" || action.category.trim().length === 0) {
    return "empty category";
  }
  if (typeof action.delegate_to !== "string" || action.delegate_to.trim().length === 0) {
    return "empty delegate_to";
  }
  return null;
}

/**
 * Validate a decomposer's proposed children against the parent action and the
 * termination bounds, and — only on total success — stamp each child with its
 * own `decomposition_depth` so the bound is durably tree-derived the next
 * time (if ever) one of these children itself times out.
 *
 * Any single violation rejects the WHOLE decomposition: no silent dedup, no
 * partial application, no clamping. A rejected or invalid decomposition is a
 * typed outcome the caller records as the node's failure — never a reason to
 * fabricate children to keep the tree moving.
 */
export function validateDecomposition(parent: Action, candidates: readonly Action[], maxDepth = MAX_DECOMPOSITION_DEPTH): DecompositionOutcome {
  if (depthBoundReached(parent, maxDepth)) {
    return { ok: false, reason: `decomposition depth bound (${maxDepth}) already reached` };
  }
  if (candidates.length < MIN_DECOMPOSITION_FANOUT || candidates.length > MAX_DECOMPOSITION_FANOUT) {
    return { ok: false, reason: `fanout ${candidates.length} outside bound [${MIN_DECOMPOSITION_FANOUT}, ${MAX_DECOMPOSITION_FANOUT}]` };
  }

  const parentKey = normalize(parent.description);
  const seen = new Set<string>();
  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i]!;
    const violation = actionShapeViolation(candidate);
    if (violation) return { ok: false, reason: `child ${i}: ${violation}` };
    const key = normalize(candidate.description);
    if (key === parentKey) return { ok: false, reason: `child ${i} is identical to its parent action (non-decomposition)` };
    if (seen.has(key)) return { ok: false, reason: `child ${i} duplicates an earlier sibling` };
    seen.add(key);
  }

  const childDepth = decompositionDepthOf(parent) + 1;
  const children: Action[] = candidates.map((candidate) => ({ ...candidate, decomposition_depth: childDepth }));
  return { ok: true, children };
}

/**
 * Provenance for the decomposition event itself (not the resulting pending
 * tree nodes, which stay `provenance: null` like any other freshly-branched
 * pending node until their own specialist runs). Decomposition children are
 * model-proposed, so this is always `!generated` — never `claimed` or
 * `verified`; this repository's provenance ladder is a type, not a comment.
 * The hash goes through `canonicalizeForHash` (arbor-core/canonical.ts),
 * "the single canonical serializer for every hashed value in revoy2".
 */
export function decompositionProvenance(
  campaignId: string,
  nodeId: string,
  parent: Action,
  children: readonly Action[],
): Extract<Provenance, { tag: "generated" }> {
  const input = canonicalizeForHash({ campaign_id: campaignId, node_id: nodeId, parent, children });
  return {
    tag: "generated",
    generator: "arbor-opencode.decompose-policy@1",
    input_hash: createHash("sha256").update(input).digest("hex"),
  };
}
