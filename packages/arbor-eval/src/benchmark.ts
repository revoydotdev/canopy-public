/**
 * arbor-eval/benchmark — drives CampaignManager with scripted outcomes.
 *
 * Runs N campaigns per task, each with a different seed for deterministic
 * scripted outcomes. Computes the 4 roadmap metrics per campaign and
 * aggregates across runs.
 */

import type { Action, ScoreContext, Provenance, CapabilityContext } from "@arbor/core";
import { CampaignManager } from "@arbor/mcp";
import type { EvalTask, CampaignMetrics } from "./types.js";
import { computeMetrics, aggregateMetrics } from "./metrics.js";

const scoreCtx: ScoreContext = {
  accuracy_regression_rate: 0,
  crash_regression_rate: 0,
  best_known: 100,
  total_visits: 5,
};

const specialistCap: CapabilityContext = { tier: "specialist" };
const criticCap: CapabilityContext = { tier: "critic" };

// G-25: the benchmark never runs a real "test" command — `outcomeGenerator`
// is a scripted success/failure decision, not a verification. `verified`
// provenance asserts a command genuinely ran and its stdout is content-
// hashed; `"sha256:eval-scripted-outcome"` was a fixed string wearing a hash
// shape, not a hash of anything. `claimed` is the honest tag for a scripted
// outcome; success vs. failure is already carried by `critic_approved`
// (manager.recordResult only reads the provenance tag to decide verified-vs-
// claimed within the *approved* branch, so this does not collapse the
// success/failure distinction — see CampaignManager.recordResult).
const claimedProv: Provenance = { tag: "claimed", claimant: "seed" };

/** Track what KB entries have been injected for a campaign. */
interface KbTracker {
  totalRelevant: number;
  total: number;
}

/**
 * Run a single campaign against a task with a specific seed.
 * Drives the CampaignManager through: start → branch → select → expand → recordResult.
 */
function runSingleCampaign(
  task: EvalTask,
  seed: number,
  maxIterations: number,
): {
  manager: CampaignManager;
  campaignId: string;
  kbTracker: KbTracker;
} {
  const manager = new CampaignManager();
  const campaignId = `eval-${task.id}-${seed}`;

  // Start campaign
  const startResult = manager.startCampaign(campaignId, `eval/plans/${task.id}.md`, task.rootAction, {
    max_seconds: 600,
    min_score: 0,
    convergence_iterations: 2,
  });
  if (!startResult.ok) {
    throw new Error(`Failed to start campaign ${campaignId}: ${JSON.stringify(startResult)}`);
  }

  // Branch initial alternatives from root
  const branchActions: Action[] = [];
  for (let i = 0; i < task.branchCount; i++) {
    branchActions.push(task.branchActionGenerator(i));
  }
  manager.branch(campaignId, "root", branchActions);

  const kbTracker: KbTracker = { totalRelevant: 0, total: 0 };

  // Track branch indices per parent deterministically — the order the manager
  // selects children from a parent determines their branch index. Since UCT
  // scoring is deterministic and ties break by insertion order, the selection
  // order IS the insertion order. We count cumulatively per campaign.
  const branchIndexByNode = new Map<string, number>();
  let branchGlobalCounter = 0;

  /** Assign a stable branch index for a node (deterministic, no global state). */
  function getBranchIndex(nodeId: string): number {
    const existing = branchIndexByNode.get(nodeId);
    if (existing !== undefined) return existing;
    const idx = branchGlobalCounter++;
    branchIndexByNode.set(nodeId, idx);
    return idx;
  }

  // Track per-iteration KB state for post-hoc hit rate computation.
  const dispatchRecords: Array<{ hadPriorFailures: boolean; succeeded: boolean }> = [];

  // Main loop
  for (let iter = 0; iter < maxIterations; iter++) {
    // Halt check
    if (manager.haltStatus(campaignId).halted) break;

    // Select next node
    const nodeId = manager.selectNode(campaignId, scoreCtx);
    if (!nodeId) break;

    const nodeInfo = manager.getNodeInfo(campaignId, nodeId);
    if (!nodeInfo) break;

    // Expand
    const expandResult = manager.expandNode(campaignId, nodeId, {
      worktree_isolated: true,
      starting_commit_correct: true,
      lease_acquired: true,
    });
    if (!expandResult.ok) {
      // Record failure
      manager.recordResult(campaignId, nodeId, {
        specialist_output: `isolation gate failed: ${expandResult.gate.detail}`,
        specialist_agent: nodeInfo.action.delegate_to,
        provenance: claimedProv,
        critic_agent: "lenticel",
        critic_approved: false,
        critic_rationale: expandResult.gate.detail,
        critic_root_cause: "isolation gate failed",
        score_ctx: scoreCtx,
      });
      manager.incrementNoKbIteration(campaignId);
      continue;
    }

    // Simulate KB injection: check if prior failure entries exist in the KB
    // before the specialist dispatches. The KB injects prior failures into
    // the specialist's prompt, which helps avoid repeating known mistakes.
    const kbQueryBefore = manager.kbQuery(campaignId, { type: "failure_mode" }, specialistCap);
    const hadPriorFailures = kbQueryBefore.some((e) => e.value !== null);

    // Call kbInject to exercise the injection path (the return value isn't used
    // for hit detection — we query the KB directly below)
    manager.kbInject(
      `Action: ${nodeInfo.action.description}\nCategory: ${nodeInfo.action.category}`,
      campaignId,
      specialistCap,
    );

    // Get scripted outcome for this branch.
    // The branchIndex is deterministic: nodes are selected in insertion order
    // (UCT ties break by map iteration order), so the cumulative counter
    // produces a stable mapping that doesn't depend on the global nodeCounter.
    const branchIdx = getBranchIndex(nodeId);
    const outcome = task.outcomeGenerator(branchIdx, seed, hadPriorFailures);

    // Record dispatch state for post-hoc KB hit rate computation
    dispatchRecords.push({ hadPriorFailures, succeeded: false }); // will update

    // Record result
    const recorded = manager.recordResult(campaignId, nodeId, {
      specialist_output: outcome.success
        ? outcome.rationale
        : `FAILED: ${outcome.rationale}`,
      specialist_agent: nodeInfo.action.delegate_to,
      provenance: claimedProv,
      critic_agent: "lenticel",
      critic_approved: outcome.success,
      critic_rationale: outcome.success ? "approved: " + outcome.rationale : outcome.rationale,
      critic_root_cause: outcome.rootCause,
      score_ctx: scoreCtx,
    });

    // Update the dispatch record with actual outcome
    const lastRecord = dispatchRecords[dispatchRecords.length - 1];
    lastRecord.succeeded = outcome.success;

    // Convergence tracking
    if (recorded.kb_entry_id === null) {
      manager.incrementNoKbIteration(campaignId);
    }

    // If verified/claimed, branch children for next level of exploration
    if (recorded.state === "verified" || recorded.state === "claimed") {
      const grandchildActions: Action[] = [];
      const maxGrandchildren = 3;
      for (let j = 0; j < maxGrandchildren; j++) {
        grandchildActions.push(
          task.branchActionGenerator(branchIdx * maxGrandchildren + j + 100),
        );
      }
      if (!manager.haltStatus(campaignId).halted) {
        manager.branch(campaignId, nodeId, grandchildActions);
      }
    }
  }

  // Post-hoc KB hit rate: among dispatches where prior failures were known
  // and injected, what fraction of branches succeeded (the KB helped)?
  for (const record of dispatchRecords) {
    if (record.hadPriorFailures) {
      kbTracker.total++;
      if (record.succeeded) kbTracker.totalRelevant++;
    }
  }

  return { manager, campaignId, kbTracker };
}

/**
 * Run a full benchmark: N campaigns per task, compute all metrics.
 */
export function runBenchmark(
  tasks: EvalTask[],
  runsPerTask: number,
  maxIterations: number,
): {
  aggregatedResults: ReturnType<typeof aggregateMetrics>[];
} {
  const aggregatedResults: ReturnType<typeof aggregateMetrics>[] = [];

  for (const task of tasks) {
    const perRunMetrics: CampaignMetrics[] = [];

    for (let run = 0; run < runsPerTask; run++) {
      const seed = computeSeed(task.id, run);
      const { manager, campaignId, kbTracker } = runSingleCampaign(task, seed, maxIterations);

      const kbEntries = manager.kbQuery(campaignId, null, criticCap);
      const kbEntriesWritten = kbEntries.filter((e) => e.value !== null).length;

      const metrics = computeMetrics(
        campaignId,
        manager,
        kbTracker.totalRelevant,
        kbTracker.total,
      );
      metrics.kbEntriesWritten = kbEntriesWritten;
      perRunMetrics.push(metrics);
    }

    aggregatedResults.push(
      aggregateMetrics(task.id, task.description, perRunMetrics),
    );
  }

  return { aggregatedResults };
}

/** Deterministic seed: (taskId, run) → number. */
export function computeSeed(taskId: string, run: number): number {
  let h = 2166136261;
  const str = `${taskId}:${run}`;
  for (let i = 0; i < str.length; i++) {
    h = (h ^ str.charCodeAt(i)) * 16777619;
    h >>>= 0;
  }
  return h;
}
