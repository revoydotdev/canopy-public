/**
 * Fixture-backed deterministic comparison of an ungoverned linear agent loop
 * and revoy2's governed campaign path.  This is an evaluation harness, not a
 * claim about provider quality: all verdicts and token units come from the
 * supplied fixture and no model or network call is made.
 */

import type { Action, CapabilityContext, Provenance, ScoreContext } from "@arbor/core";
import { CampaignManager } from "@arbor/mcp";
import type {
  GovernedEvalScenario,
  GovernedScenarioComparison,
  GovernedScenarioMetrics,
} from "./types.js";

const scoreContext: ScoreContext = {
  accuracy_regression_rate: 0,
  crash_regression_rate: 0,
  best_known: 100,
  total_visits: 1,
};

const claimedProvenance: Provenance = { tag: "claimed", claimant: "eval-script" };
const specialistCapability: CapabilityContext = { tier: "specialist" };

function rootAction(description: string): Action {
  return {
    description: `Evaluate governed recovery: ${description}`,
    estimated_gain: 100,
    estimated_cost: 1,
    category: "root",
    delegate_to: "crown",
  };
}

function attemptAction(description: string, index: number): Action {
  return {
    description,
    estimated_gain: 50 - index,
    estimated_cost: 1,
    category: "refactor",
    delegate_to: "seed",
  };
}

function completeCost(scriptedTokenUnits: number): GovernedScenarioMetrics["cost"] {
  return {
    scripted_token_units: scriptedTokenUnits,
    provider_cost_usd: null,
    provider_cost_status: "not_measured",
  };
}

function evidence(required: number, durable: number): GovernedScenarioMetrics["evidence"] {
  return {
    required_records: required,
    durable_records: durable,
    completeness: required === 0 ? 1 : Math.min(1, durable / required),
  };
}

/**
 * Model the reference baseline's terminal linear behavior. It deliberately has
 * no ledger, gate, or Critic; the resulting zero evidence completeness is an
 * observable distinction, not a fabricated failure.
 */
function evaluateBaseline(scenario: GovernedEvalScenario): GovernedScenarioMetrics {
  let attemptsExecuted = 0;
  let tokenUnits = 0;
  let regressionsDetected = 0;
  let regressionsAccepted = 0;
  let completed = false;

  for (const attempt of scenario.attempts) {
    attemptsExecuted++;
    tokenUnits += attempt.scripted_token_units;
    if (attempt.regression_detected) {
      // A linear baseline can accept a regression as a successful step, but
      // cannot claim it detected one without the governed verdict/evidence.
      if (attempt.baseline_success) regressionsAccepted++;
    }
    if (!attempt.baseline_success) break;
    if (attempt.regression_detected) break;
    completed = true;
    break;
  }

  return {
    completed,
    attempts_executed: attemptsExecuted,
    regressions_detected: regressionsDetected,
    regressions_accepted: regressionsAccepted,
    recoveries_required: 0,
    recoveries_completed: 0,
    evidence: evidence(attemptsExecuted, 0),
    cost: completeCost(tokenUnits),
  };
}

/**
 * Execute the governed side through the real CampaignManager gates, tree,
 * failure KB extraction, and durable audit ledger. Fixture verdicts remain
 * deterministic, but they traverse the same local manager APIs as a scripted
 * campaign benchmark.
 */
function evaluateGoverned(scenario: GovernedEvalScenario): GovernedScenarioMetrics {
  const manager = new CampaignManager();
  const campaignId = `governed-scenario-${scenario.id}`;
  const start = manager.startCampaign(campaignId, `eval/scenarios/${scenario.id}.md`, rootAction(scenario.description), {
    max_seconds: 600,
    min_score: 0,
    convergence_iterations: scenario.attempts.length + 1,
  });
  if (!start.ok) throw new Error(`Could not start deterministic scenario ${scenario.id}`);

  const nodeIds = manager.branch(
    campaignId,
    "root",
    scenario.attempts.map((attempt, index) => attemptAction(attempt.description, index)),
  );

  let attemptsExecuted = 0;
  let tokenUnits = 0;
  let regressionsDetected = 0;
  let recoveriesRequired = 0;
  let recoveriesCompleted = 0;
  let pendingRecovery = false;
  let completed = false;

  for (const [index, attempt] of scenario.attempts.entries()) {
    const nodeId = nodeIds[index];
    const node = manager.getNodeInfo(campaignId, nodeId);
    if (!node) throw new Error(`Missing scenario node ${nodeId}`);
    const expanded = manager.expandNode(campaignId, nodeId, {
      worktree_isolated: true,
      starting_commit_correct: true,
      lease_acquired: true,
    });
    if (!expanded.ok) throw new Error(`Scenario isolation unexpectedly failed: ${expanded.gate.detail}`);

    attemptsExecuted++;
    tokenUnits += attempt.scripted_token_units;
    if (attempt.regression_detected) regressionsDetected++;
    if (!attempt.governed_success) recoveriesRequired++;

    // Query/inject after a prior failed branch to exercise the same failure
    // knowledge path used by the benchmark loop. The fixture, not this query,
    // remains the source of the later deterministic verdict.
    manager.kbInject(`Scenario action: ${attempt.description}`, campaignId, specialistCapability);
    manager.recordResult(campaignId, nodeId, {
      specialist_output: attempt.governed_success ? attempt.rationale : `FAILED: ${attempt.rationale}`,
      specialist_agent: node.action.delegate_to,
      provenance: claimedProvenance,
      critic_agent: "lenticel",
      critic_approved: attempt.governed_success,
      critic_rationale: attempt.rationale,
      critic_root_cause: attempt.root_cause,
      score_ctx: scoreContext,
    });

    if (!attempt.governed_success) {
      pendingRecovery = true;
      continue;
    }
    if (pendingRecovery) recoveriesCompleted++;
    completed = true;
    break;
  }

  // Start and every recorded result append multiple independent audit facts;
  // require only one per executed governed transition so the metric remains
  // stable if ledger internals gain additional evidence records.
  const durableRecords = manager.getAuditRecords(campaignId).length;
  return {
    completed,
    attempts_executed: attemptsExecuted,
    regressions_detected: regressionsDetected,
    regressions_accepted: 0,
    recoveries_required: recoveriesRequired,
    recoveries_completed: recoveriesCompleted,
    evidence: evidence(attemptsExecuted + 1, durableRecords),
    cost: completeCost(tokenUnits),
  };
}

/** Run one fixture scenario through both comparison paths. */
function evaluateGovernedScenario(scenario: GovernedEvalScenario): GovernedScenarioComparison {
  if (scenario.attempts.length === 0) throw new Error(`Scenario ${scenario.id} must include at least one attempt`);
  return {
    scenario_id: scenario.id,
    baseline: evaluateBaseline(scenario),
    governed: evaluateGoverned(scenario),
  };
}

/** Run a deterministic fixture suite; output order equals fixture order. */
export function evaluateGovernedScenarios(scenarios: readonly GovernedEvalScenario[]): GovernedScenarioComparison[] {
  return scenarios.map(evaluateGovernedScenario);
}
