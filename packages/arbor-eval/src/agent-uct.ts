import { canonicalizeForHash, scoreAgentUct, type Cost, type Provenance } from "@arbor/core";
import { createHash } from "node:crypto";
import { createPrefixReuseLedger, recordPrefixReuseObservation, summarizePrefixReuseLedger } from "./reuse-ledger.js";
import type { EvalPrefixReuseSummary } from "./types.js";

const GENERATED_PROVENANCE_GENERATOR = "arbor-eval/agent-uct";
const UNIT_COST: Cost = Object.freeze({ kind: "unpriced", reason: "logical prefix-cost units" });

function hashCanonical(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalizeForHash(value)).digest("hex")}`;
}

function prefixKey(prefix: readonly string[]): string {
  return prefix.join(" ⟫ ");
}

function terminalKey(config: readonly string[]): string {
  return prefixKey(config);
}

function lexicographic(a: readonly string[], b: readonly string[]): number {
  return prefixKey(a).localeCompare(prefixKey(b));
}

export interface AgentUctFixtureDimension {
  readonly dimension_id: string;
  readonly options: readonly string[];
}

export interface AgentUctFixtureCluster {
  readonly cluster_id: string;
  readonly weight: number;
  readonly item_ids: readonly string[];
}

/**
 * Deterministic eval-only configuration search fixture.
 *
 * This is intentionally narrower than production Revoy trees: it models the
 * paper's compositional workflow-search shape so equal-budget policy
 * comparisons can be replayed without touching governed campaign selection.
 */
export interface AgentUctFixture {
  readonly fixture_id: string;
  readonly dimensions: readonly AgentUctFixtureDimension[];
  readonly clusters: readonly AgentUctFixtureCluster[];
  /** Marginal logical cost units for materializing each prefix once per target. */
  readonly prefix_cost_units: Readonly<Record<string, number>>;
  /** Reward table keyed by complete configuration, then cluster, then item. */
  readonly rewards: Readonly<Record<string, Readonly<Record<string, Readonly<Record<string, number>>>>>>;
}

export interface AgentUctExperimentPolicy {
  readonly mode: "classic" | "agent_uct" | "budget_annealed";
  readonly exploration_constant: number;
  readonly lambda_0?: number;
  readonly cost_scale?: number;
}

export interface AgentUctBatch {
  readonly cluster_id: string;
  readonly item_ids: readonly string[];
}

export interface AgentUctPolicyCandidate {
  readonly prefix: readonly string[];
  readonly reward_estimate: number;
  readonly state_visit_count: number;
  readonly edge_visit_count: number;
  readonly marginal_cost_estimate: number;
  readonly score: number;
}

export interface AgentUctIterationTrace {
  readonly iteration: number;
  readonly selected_prefix: readonly string[];
  readonly evaluated_configuration: readonly string[];
  readonly batch: readonly AgentUctBatch[];
  readonly reward: number;
  readonly logical_cost_units: number;
  readonly materialized_edges: number;
  readonly reused_edges: number;
  readonly candidate_scores: readonly AgentUctPolicyCandidate[];
}

export interface AgentUctExperimentResult {
  readonly fixture_id: string;
  readonly policy: AgentUctExperimentPolicy;
  readonly iterations: readonly AgentUctIterationTrace[];
  readonly best_configuration: readonly string[];
  readonly best_reward: number;
  readonly total_logical_cost_units: number;
  readonly total_materialized_edges: number;
  readonly total_reused_edges: number;
  readonly reuse_summary: EvalPrefixReuseSummary;
  readonly replay_hash: string;
}

interface SearchNode {
  prefix: readonly string[];
  visit_count: number;
  total_reward: number;
  children: Map<string, SearchNode>;
}

interface CandidateChoice {
  child: SearchNode;
  score: AgentUctPolicyCandidate;
}

function createNode(prefix: readonly string[]): SearchNode {
  return {
    prefix,
    visit_count: 0,
    total_reward: 0,
    children: new Map(),
  };
}

function generatedProvenance(input: unknown): Provenance {
  return {
    tag: "generated",
    generator: GENERATED_PROVENANCE_GENERATOR,
    input_hash: hashCanonical(input),
  };
}

function getFullPoolBatch(fixture: AgentUctFixture): readonly AgentUctBatch[] {
  return fixture.clusters.map((cluster) => Object.freeze({
    cluster_id: cluster.cluster_id,
    item_ids: [...cluster.item_ids],
  }));
}

function estimateMarginalCost(
  fixture: AgentUctFixture,
  batch: readonly AgentUctBatch[],
  observedEdges: ReadonlySet<string>,
  prefix: readonly string[],
): number {
  const costUnits = fixture.prefix_cost_units[prefixKey(prefix)] ?? 0;
  if (costUnits <= 0) return 0;
  let total = 0;
  for (const clusterBatch of batch) {
    const cluster = fixture.clusters.find((entry) => entry.cluster_id === clusterBatch.cluster_id);
    if (!cluster) throw new Error(`Unknown cluster ${JSON.stringify(clusterBatch.cluster_id)}`);
    const itemWeight = cluster.weight / Math.max(clusterBatch.item_ids.length, 1);
    for (const itemId of clusterBatch.item_ids) {
      const edgeKey = `${prefixKey(prefix)}::${cluster.cluster_id}::${itemId}`;
      if (!observedEdges.has(edgeKey)) total += costUnits * itemWeight;
    }
  }
  return total;
}

function classicScore(rewardEstimate: number, stateVisitCount: number, edgeVisitCount: number, explorationConstant: number): number {
  return rewardEstimate + explorationConstant * Math.sqrt(Math.log(Math.max(stateVisitCount, 0) + 1) / (Math.max(edgeVisitCount, 0) + 1));
}

function scoreCandidate(
  policy: AgentUctExperimentPolicy,
  prefix: readonly string[],
  rewardEstimate: number,
  stateVisitCount: number,
  edgeVisitCount: number,
  marginalCostEstimate: number,
  iteration: number,
  iterationBudget: number,
): AgentUctPolicyCandidate {
  return Object.freeze({
    prefix,
    reward_estimate: rewardEstimate,
    state_visit_count: stateVisitCount,
    edge_visit_count: edgeVisitCount,
    marginal_cost_estimate: marginalCostEstimate,
    score: policy.mode === "classic"
      ? classicScore(rewardEstimate, stateVisitCount, edgeVisitCount, policy.exploration_constant)
      : policy.mode === "agent_uct" ? scoreAgentUct(
          {
            source: "measured_prefix_reuse",
            reward_estimate: rewardEstimate,
            state_visit_count: stateVisitCount,
            edge_visit_count: edgeVisitCount,
            marginal_cost_estimate: marginalCostEstimate,
            iteration,
          },
          { exploration_constant: policy.exploration_constant },
          { lambda_0: policy.lambda_0 ?? 1, cost_scale: policy.cost_scale ?? 1 },
        ) : budgetAnnealedScore(rewardEstimate, iteration, iterationBudget),
  });
}

/** BAVT eval-only comparator: broad early, increasingly greedy as budget depletes. */
export function budgetAnnealedScore(value: number, iteration: number, iterationBudget: number): number {
  if (!Number.isFinite(value) || !Number.isSafeInteger(iteration) || !Number.isSafeInteger(iterationBudget) || iteration < 1 || iterationBudget < iteration) throw new Error("invalid budget-annealed score input");
  const remainingRatio = Math.max((iterationBudget - iteration + 1) / iterationBudget, Number.EPSILON);
  return Math.max(value, 0) ** (1 / remainingRatio);
}

/** Residual-value critic comparator; production critic scoring remains unchanged. */
export function clippedResidualValue(previous: number, observed: number): number {
  if (!Number.isFinite(previous) || !Number.isFinite(observed)) throw new Error("residual values must be finite");
  return Math.max(-4, Math.min(4, observed - previous));
}

function chooseBestCandidate(candidates: readonly CandidateChoice[]): CandidateChoice {
  return [...candidates].sort((a, b) =>
    b.score.score - a.score.score
    || lexicographic(a.child.prefix, b.child.prefix))[0]!;
}

function completeConfiguration(fixture: AgentUctFixture, prefix: readonly string[]): readonly string[] {
  const config = [...prefix];
  for (let depth = prefix.length; depth < fixture.dimensions.length; depth++) {
    config.push(fixture.dimensions[depth]!.options[0]!);
  }
  return Object.freeze(config);
}

function materializeCompletionPath(
  fixture: AgentUctFixture,
  start: SearchNode,
  path: SearchNode[],
): readonly string[] {
  const configuration = completeConfiguration(fixture, start.prefix);
  let current = start;
  for (let depth = start.prefix.length; depth < configuration.length; depth++) {
    const option = configuration[depth]!;
    const existing = current.children.get(option) ?? createNode(Object.freeze([...current.prefix, option]));
    if (!current.children.has(option)) current.children.set(option, existing);
    current = current.children.get(option)!;
    path.push(current);
  }
  return configuration;
}

function evaluateConfiguration(
  fixture: AgentUctFixture,
  configuration: readonly string[],
  batch: readonly AgentUctBatch[],
): number {
  const configRewards = fixture.rewards[terminalKey(configuration)];
  if (!configRewards) throw new Error(`Missing reward table for configuration ${JSON.stringify(configuration)}`);
  let total = 0;
  for (const clusterBatch of batch) {
    const clusterRewards = configRewards[clusterBatch.cluster_id];
    const cluster = fixture.clusters.find((entry) => entry.cluster_id === clusterBatch.cluster_id);
    if (!clusterRewards || !cluster) throw new Error(`Missing reward table for cluster ${JSON.stringify(clusterBatch.cluster_id)}`);
    const average =
      clusterBatch.item_ids.reduce((sum, itemId) => sum + (clusterRewards[itemId] ?? 0), 0) /
      Math.max(clusterBatch.item_ids.length, 1);
    total += cluster.weight * average;
  }
  return total;
}

function recordEvaluationReuse(
  fixture: AgentUctFixture,
  ledgerId: string,
  ledgerNow: ReturnType<typeof createPrefixReuseLedger>,
  observedEdges: Set<string>,
  configuration: readonly string[],
  batch: readonly AgentUctBatch[],
  iteration: number,
): {
  ledger: ReturnType<typeof createPrefixReuseLedger>;
  logicalCostUnits: number;
  materializedEdges: number;
  reusedEdges: number;
} {
  let ledger = ledgerNow;
  let logicalCostUnits = 0;
  let materializedEdges = 0;
  let reusedEdges = 0;
  for (const clusterBatch of batch) {
    for (const itemId of clusterBatch.item_ids) {
      for (let depth = 1; depth <= configuration.length; depth++) {
        const prefix = configuration.slice(0, depth);
        const key = `${prefixKey(prefix)}::${clusterBatch.cluster_id}::${itemId}`;
        const costUnits = fixture.prefix_cost_units[prefixKey(prefix)] ?? 0;
        const observationKind = observedEdges.has(key) ? "reused" : "materialized";
        if (observationKind === "materialized") {
          logicalCostUnits += costUnits;
          materializedEdges++;
          observedEdges.add(key);
        } else {
          reusedEdges++;
        }
        ledger = recordPrefixReuseObservation(ledger, {
          operation_id: `${ledgerId}:iter${iteration}:${clusterBatch.cluster_id}:${itemId}:d${depth}`,
          observed_at: `2026-08-10T00:00:${String(iteration).padStart(2, "0")}Z`,
          observation_kind: observationKind,
          prefix: {
            prefix_text: prefixKey(prefix),
            prompt_template_id: `agent-uct/${fixture.fixture_id}`,
            model_family: "eval-only",
            context_signature: `depth:${depth}`,
            token_units: costUnits,
            byte_length: prefixKey(prefix).length,
          },
          target: {
            cluster_id: clusterBatch.cluster_id,
            item_id: itemId,
            config_id: fixture.fixture_id,
          },
          marginal_cost_token_units: observationKind === "materialized" ? costUnits : 0,
          marginal_cost: UNIT_COST,
          provenance: generatedProvenance({ fixture: fixture.fixture_id, configuration, cluster_id: clusterBatch.cluster_id, item_id: itemId, depth, observationKind }),
        });
      }
    }
  }
  return { ledger, logicalCostUnits, materializedEdges, reusedEdges };
}

function backpropagate(path: readonly SearchNode[], reward: number): void {
  for (const node of path) {
    node.visit_count += 1;
    node.total_reward += reward;
  }
}

/**
 * Run a deterministic, replayable Agent-UCT-vs-classic experiment over a
 * compositional workflow-search fixture.
 *
 * Expansion of untried actions uses the same policy scorer with a zero-reward
 * prior so cost-aware experiments can meaningfully differ before every child
 * has empirical rewards. That choice is a Revoy-owned eval convention, not a
 * claim about the paper's exact implementation.
 */
export function runAgentUctExperiment(
  fixture: AgentUctFixture,
  policy: AgentUctExperimentPolicy,
  iterationBudget: number,
): AgentUctExperimentResult {
  const ledgerId = `${fixture.fixture_id}-${policy.mode}`;
  let ledger = createPrefixReuseLedger(ledgerId, { now: "2026-08-10T00:00:00Z" });
  const observedEdges = new Set<string>();
  const root = createNode(Object.freeze([]));
  const batch = getFullPoolBatch(fixture);
  const traces: AgentUctIterationTrace[] = [];
  let bestReward = Number.NEGATIVE_INFINITY;
  let bestConfiguration: readonly string[] = Object.freeze([]);

  for (let iteration = 1; iteration <= iterationBudget; iteration++) {
    const path: SearchNode[] = [root];
    let current = root;
    const candidateScores: AgentUctPolicyCandidate[] = [];
    while (current.prefix.length < fixture.dimensions.length) {
      const depth = current.prefix.length;
      const dimension = fixture.dimensions[depth]!;
      const untriedOptions = dimension.options.filter((option) => !current.children.has(option));
      const optionPool = untriedOptions.length > 0 ? untriedOptions : dimension.options;
      const candidates = optionPool.map((option) => {
        const nextPrefix = Object.freeze([...current.prefix, option]);
        const existing = current.children.get(option) ?? createNode(nextPrefix);
        const rewardEstimate = existing.visit_count === 0 ? 0 : existing.total_reward / existing.visit_count;
        const marginalCostEstimate = estimateMarginalCost(fixture, batch, observedEdges, nextPrefix);
        return {
          child: existing,
          score: scoreCandidate(
            policy,
            nextPrefix,
            rewardEstimate,
            current.visit_count,
            existing.visit_count,
            marginalCostEstimate,
            iteration,
            iterationBudget,
          ),
        };
      });
      const chosen = chooseBestCandidate(candidates);
      candidateScores.push(...candidates.map((entry) => entry.score));
      if (!current.children.has(chosen.child.prefix[chosen.child.prefix.length - 1]!)) {
        current.children.set(chosen.child.prefix[chosen.child.prefix.length - 1]!, chosen.child);
      }
      current = current.children.get(chosen.child.prefix[chosen.child.prefix.length - 1]!)!;
      path.push(current);
      if (current.visit_count === 0) break;
    }

    const configuration = materializeCompletionPath(fixture, current, path);
    const reward = evaluateConfiguration(fixture, configuration, batch);
    const replay = recordEvaluationReuse(fixture, ledgerId, ledger, observedEdges, configuration, batch, iteration);
    ledger = replay.ledger;
    backpropagate(path, reward);
    if (reward > bestReward || (reward === bestReward && lexicographic(configuration, bestConfiguration) < 0)) {
      bestReward = reward;
      bestConfiguration = configuration;
    }
    traces.push(Object.freeze({
      iteration,
      selected_prefix: current.prefix,
      evaluated_configuration: configuration,
      batch,
      reward,
      logical_cost_units: replay.logicalCostUnits,
      materialized_edges: replay.materializedEdges,
      reused_edges: replay.reusedEdges,
      candidate_scores: candidateScores.sort((a, b) => b.score - a.score || lexicographic(a.prefix, b.prefix)),
    }));
  }

  const reuseSummary = summarizePrefixReuseLedger(ledger);
  const payload = Object.freeze({
    fixture_id: fixture.fixture_id,
    policy,
    iterations: traces,
    best_configuration: bestConfiguration,
    best_reward: bestReward,
    total_logical_cost_units: traces.reduce((sum, trace) => sum + trace.logical_cost_units, 0),
    total_materialized_edges: traces.reduce((sum, trace) => sum + trace.materialized_edges, 0),
    total_reused_edges: traces.reduce((sum, trace) => sum + trace.reused_edges, 0),
    reuse_summary: reuseSummary,
  });
  return Object.freeze({
    ...payload,
    replay_hash: hashCanonical(payload),
  });
}
