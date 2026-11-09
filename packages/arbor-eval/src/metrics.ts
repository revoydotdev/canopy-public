/**
 * arbor-eval/metrics — computes the 4 key metrics from campaign state.
 *
 * All metrics are deterministic given the same campaign state.
 */

import type { CampaignManager } from "@arbor/mcp";
import type { NodeState } from "@arbor/core";
import type { CampaignMetrics, CriticReliabilityMetrics, CriticReliabilitySample } from "./types.js";

/** Evaluate `(1-p)cr > pfb` over adjudicated post-W1a observations. */
export function computeCriticReliability(samples: readonly CriticReliabilitySample[]): CriticReliabilityMetrics {
  if (samples.length === 0) throw new Error("critic reliability requires at least one post-W1a sample");
  const ordered = [...samples].sort((a, b) => a.observed_at.localeCompare(b.observed_at));
  if (ordered.some((sample) => Number.isNaN(Date.parse(sample.observed_at)))) throw new Error("critic reliability samples require ISO timestamps");
  const correct = samples.filter((sample) => sample.artifact_correct_before);
  const defective = samples.filter((sample) => sample.later_defect_found || !sample.artifact_correct_before);
  const flaggedDefects = defective.filter((sample) => sample.critic_flagged);
  const falseAlarms = correct.filter((sample) => sample.critic_flagged);
  const rate = (numerator: number, denominator: number): number => denominator === 0 ? 0 : numerator / denominator;
  const p = rate(correct.length, samples.length);
  const c = rate(flaggedDefects.length, defective.length);
  const r = rate(flaggedDefects.filter((sample) => sample.correction_attempted && sample.artifact_correct_after).length, flaggedDefects.length);
  const f = rate(falseAlarms.length, correct.length);
  const b = rate(falseAlarms.filter((sample) => sample.correction_attempted && !sample.artifact_correct_after).length, falseAlarms.length);
  const gain = (1 - p) * c * r;
  const harm = p * f * b;
  return {
    data_window: { starts_at: ordered[0]!.observed_at, ends_at: ordered.at(-1)!.observed_at, samples: samples.length },
    p_correct: round4(p), c_catch_rate: round4(c), r_repair_rate: round4(r), f_false_alarm_rate: round4(f), b_breakage_rate: round4(b),
    reliability_gain: round4(gain), reliability_harm: round4(harm), inequality_holds: gain > harm,
  };
}

function round4(value: number): number { return Math.round(value * 10_000) / 10_000; }

/**
 * Compute the 4 roadmap metrics from a completed campaign.
 *
 * Metrics:
 *  1. branching_factor: avg children per expanded decision node (excludes root)
 *  2. backtrack_rate: fraction of expanded branches that failed
 *  3. kb_hit_rate: fraction of KB injections that were relevant (stub-tracked)
 *  4. convergence_quality: did it halt with a good result?
 */
export function computeMetrics(
  campaignId: string,
  manager: CampaignManager,
  kbInjectionsRelevant: number,
  kbInjectionsTotal: number,
): CampaignMetrics {
  // Walk the tree to gather stats. We need to bypass CampaignManager's
  // private access and read nodes directly via getNodeInfo.
  const haltStatus = manager.haltStatus(campaignId);
  const campaign = manager.getCampaignSnapshot(campaignId);
  if (!campaign) throw new Error(`Campaign not found while computing metrics: ${campaignId}`);

  // Best-scoring verified/claimed node's raw score, straight from the tree —
  // NOT `campaign.best_score`. As of manager.ts's `isAcceptedForMemory` gate
  // (fix(core,mcp): close campaign false-completion gaps), `campaign.best_score`
  // itself only rises on a genuinely `verified` result, to stop an unverified
  // "claimed" result from corrupting the campaign's own scoring baseline. That
  // is correct for the campaign's live scoring frontier, but it means
  // `campaign.best_score` reads 0 for any campaign (like this eval harness,
  // which is claimed-only by design — see benchmark.ts's G-25 comment) that
  // never produces a machine-verified node. `getBestPath` has no such gate: it
  // walks every `verified`/`claimed` node's own `score` (set unconditionally
  // in `verifyNode`, tree.ts) and returns the chain to the highest-scoring one
  // — the honest "what did the tree search actually find" signal for
  // evaluation purposes, independent of the memory-pollution concern that
  // motivates gating `campaign.best_score`.
  const bestPath = manager.getBestPath(campaignId);
  const bestScore = bestPath.length > 0 ? bestPath[bestPath.length - 1]!.score : 0;

  // Gather node stats by walking known nodes via getBestPath + inspection.
  const nodes = collectNodes(manager, campaignId);

  // Exclude the root node (the plan) from expansion/decision metrics.
  // The root is the admitted plan (claimed), not a branch that was explored.
  const branchNodes = nodes.filter((n) => n.parent_id !== null);

  const verifiedCount = branchNodes.filter((n) => n.state === "verified").length;
  const claimedCount = branchNodes.filter((n) => n.state === "claimed").length;
  const failedCount = branchNodes.filter((n) => n.state === "failed").length;
  const prunedCount = branchNodes.filter((n) => n.state === "pruned").length;

  // Child counts from nodes that were expanded (decisions that produced children)
  const decisionNodes = branchNodes.filter(
    (n) => n.state === "verified" || n.state === "claimed",
  );
  const totalChildren = decisionNodes.reduce((sum, n) => sum + n.children_ids.length, 0);
  const branchingFactor = decisionNodes.length > 0
    ? totalChildren / decisionNodes.length
    : 0;

  // Backtrack rate: failed / (verified + claimed + failed)
  const finishedNodes = verifiedCount + claimedCount + failedCount;
  const backtrackRate = finishedNodes > 0
    ? failedCount / finishedNodes
    : 0;

  // KB hit rate: how many KB injections were relevant
  const kbHitRate = kbInjectionsTotal > 0
    ? kbInjectionsRelevant / kbInjectionsTotal
    : 0;

  // Convergence quality
  const convergenceQuality = convergenceQualityScore(haltStatus.reason);

  return {
    branchingFactor: round2(branchingFactor),
    backtrackRate: round2(backtrackRate),
    kbHitRate: round2(kbHitRate),
    convergenceQuality,
    haltReason: haltStatus.reason,
    // `haltStatus.best_score` is intentionally verification-gated (safe for a
    // halt decision) and `campaign.best_score` is intentionally
    // memory-pollution-gated (safe for cross-campaign learning) — neither is
    // meant to answer "what score did the search actually reach." See
    // `bestPath` above for the ungated source this uses instead.
    bestScore: round2(bestScore),
    iterationsCompleted: haltStatus.iterations_completed,
    verifiedCount,
    claimedCount,
    failedCount,
    prunedCount,
    kbEntriesWritten: 0, // filled in by caller
    kbInjectionsRelevant,
    kbInjectionsTotal,
  };
}

/** Score halt quality: 1.0 = converged, 0.5 = budget, 0.3 = below_threshold, 0.0 = other. */
function convergenceQualityScore(reason: string | null): number {
  switch (reason) {
    case "converged":
      return 1.0;
    case "budget_exhausted":
      return 0.5;
    case "below_threshold":
      return 0.3;
    default:
      return 0.0;
  }
}

/** Collect all nodes we can reach through the best path + known IDs. */
interface NodeSnapshot {
  id: string;
  state: NodeState;
  children_ids: string[];
  parent_id: string | null;
}

function collectNodes(manager: CampaignManager, campaignId: string): NodeSnapshot[] {
  const seen = new Set<string>();
  const nodes: NodeSnapshot[] = [];

  // Start from best path to discover core nodes
  const bestPath = manager.getBestPath(campaignId);
  const queue: string[] = bestPath.map((p) => p.node_id);

  // Also try root
  queue.push("root");

  while (queue.length > 0) {
    const id = queue.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);

    const info = manager.getNodeInfo(campaignId, id);
    if (!info) continue;

    nodes.push({
      id: info.id,
      state: info.state,
      children_ids: info.children_ids,
      parent_id: info.parent_id,
    });

    // Queue children
    for (const childId of info.children_ids) {
      if (!seen.has(childId)) queue.push(childId);
    }
  }

  return nodes;
}

/** Round to 2 decimal places. */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Compute aggregated metrics across N runs. */
export function aggregateMetrics(
  taskId: string,
  taskDescription: string,
  perRunMetrics: CampaignMetrics[],
): {
  taskId: string;
  taskDescription: string;
  runs: number;
  avgBranchingFactor: number;
  avgBacktrackRate: number;
  avgKbHitRate: number;
  avgConvergenceQuality: number;
  convergenceRate: number;
  avgBestScore: number;
  avgIterations: number;
  perRunMetrics: CampaignMetrics[];
} {
  const n = perRunMetrics.length;
  if (n === 0) {
    return {
      taskId,
      taskDescription,
      runs: 0,
      avgBranchingFactor: 0,
      avgBacktrackRate: 0,
      avgKbHitRate: 0,
      avgConvergenceQuality: 0,
      convergenceRate: 0,
      avgBestScore: 0,
      avgIterations: 0,
      perRunMetrics,
    };
  }

  const sum = (vals: number[]) => vals.reduce((a, b) => a + b, 0);

  return {
    taskId,
    taskDescription,
    runs: n,
    avgBranchingFactor: round2(sum(perRunMetrics.map((m) => m.branchingFactor)) / n),
    avgBacktrackRate: round2(sum(perRunMetrics.map((m) => m.backtrackRate)) / n),
    avgKbHitRate: round2(sum(perRunMetrics.map((m) => m.kbHitRate)) / n),
    avgConvergenceQuality: round2(sum(perRunMetrics.map((m) => m.convergenceQuality)) / n),
    convergenceRate: round2(perRunMetrics.filter((m) => m.haltReason === "converged").length / n),
    avgBestScore: round2(sum(perRunMetrics.map((m) => m.bestScore)) / n),
    avgIterations: Math.round(sum(perRunMetrics.map((m) => m.iterationsCompleted)) / n),
    perRunMetrics,
  };
}
