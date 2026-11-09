import type { EvidenceLedger } from "@arbor/audit";
import type { Provenance, VerificationCheckBreadth } from "@arbor/core";

export interface RunManifestInput {
  campaign_id: string;
  environment_digest: `sha256:${string}`;
  run_date: string;
  sampling_rule: string;
  aggregation_rule: string;
}

export interface EvalRunManifest {
  schema: "arbor.eval-run-manifest/v3";
  campaign_id: string;
  environment_digest: `sha256:${string}`;
  run_date: string;
  models: readonly { role: "specialist" | "critic"; model_id: string }[];
  sampling_rule: string;
  aggregation_rule: string;
  cost: {
    input_tokens: number; output_tokens: number; cache_read_tokens: number; cache_write_tokens: number;
    tool_calls: number; wall_clock_ms: number;
    priced: readonly { currency: string; minor_unit_exponent: number; minor_units: number; price_source_id: string }[];
    unpriced_calls: number;
    by_phase: readonly TokenEconomyBreakdown[];
    by_role: readonly (TokenEconomyBreakdown & { role: "specialist" | "critic" })[];
    by_agent: readonly AgentTokenEconomyBreakdown[];
  };
  context_economy: {
    observations: number;
    offered_tokens: number;
    retained_tokens: number;
    pruned_tokens: number;
    indexed_reference_tokens: number;
    stable_prefix_tokens: number;
    dynamic_tokens: number;
    retention_ratio: number | null;
    by_source: readonly { source: import("@arbor/audit").ContextEconomySource; offered_tokens: number; retained_tokens: number; pruned_tokens: number; retention_ratio: number | null }[];
  };
  tool_economy: {
    observations: number;
    offered_calls: number;
    host_executions: number;
    reused_reads: number;
    avoided_output_bytes: number;
    reuse_ratio: number | null;
  };
  cache_economy: {
    /** Provider-observed prompt tokens eligible for ordinary prefix reuse. */
    eligible_input_tokens: number;
    cache_read_tokens: number;
    cache_write_tokens: number;
    cache_read_ratio: number | null;
    cache_write_ratio: number | null;
  };
  efficiency: {
    /** Declared scalar policy: effective tokens are comparable only under the same weights. */
    effective_token_policy: { input: number; cache_read: number; cache_write: number; output: number; unit: "weighted_token" };
    effective_tokens: number;
    verified_progress_units: number;
    verified_progress_per_effective_token: number | null;
  };
  failures: readonly { category: string; count: number; node_ids: readonly string[] }[];
}

export interface TokenEconomyBreakdown {
  readonly phase: import("@arbor/audit").TelemetryPhase;
  readonly calls: number;
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly cache_read_tokens: number;
  readonly cache_write_tokens: number;
  readonly effective_tokens: number;
}
export interface AgentTokenEconomyBreakdown extends Omit<TokenEconomyBreakdown, "phase"> { readonly agent_id: string }

const DEFAULT_EFFECTIVE_TOKEN_POLICY = Object.freeze({ input: 1, cache_read: 0.1, cache_write: 1.25, output: 4, unit: "weighted_token" as const });

export function buildRunManifest(ledger: EvidenceLedger, input: RunManifestInput): EvalRunManifest {
  const records = ledger.getRecords(input.campaign_id);
  const telemetry = records.filter((record) => record.kind === "telemetry_observation");
  const models = new Map<string, { role: "specialist" | "critic"; model_id: string }>();
  let inputTokens = 0; let outputTokens = 0; let cacheRead = 0; let cacheWrite = 0; let wallClock = 0; let toolCalls = 0; let unpricedCalls = 0;
  let contextObservations = 0; let offeredTokens = 0; let retainedTokens = 0; let prunedTokens = 0; let indexedTokens = 0; let stableTokens = 0; let dynamicTokens = 0;
  let toolEconomyObservations = 0; let offeredToolCalls = 0; let hostExecutions = 0; let reusedReads = 0; let avoidedOutputBytes = 0;
  const contextBySource = new Map<import("@arbor/audit").ContextEconomySource, { offered_tokens: number; retained_tokens: number }>();
  const priced = new Map<string, { currency: string; minor_unit_exponent: number; minor_units: number; price_source_id: string }>();
  const byPhase = new Map<import("@arbor/audit").TelemetryPhase, MutableTokenBreakdown>();
  const byAgent = new Map<string, MutableAgentBreakdown>();
  for (const record of telemetry) {
    const observation = record.observation;
    if (observation.type === "role_model_identity") models.set(`${observation.role}\0${observation.model_id}`, { role: observation.role, model_id: observation.model_id });
    if (observation.type === "phase_timing") wallClock += observation.duration_ms;
    if (observation.type === "usage_cost") {
      inputTokens += observation.input_tokens; outputTokens += observation.output_tokens;
      cacheRead += observation.cache_read_tokens; cacheWrite += observation.cache_write_tokens;
      const phase = byPhase.get(observation.phase) ?? emptyBreakdown(observation.phase);
      phase.calls += 1; phase.input_tokens += observation.input_tokens; phase.output_tokens += observation.output_tokens;
      phase.cache_read_tokens += observation.cache_read_tokens; phase.cache_write_tokens += observation.cache_write_tokens;
      byPhase.set(observation.phase, phase);
      if (observation.agent_id) {
        const agent = byAgent.get(observation.agent_id) ?? emptyAgentBreakdown(observation.agent_id);
        agent.calls += 1; agent.input_tokens += observation.input_tokens; agent.output_tokens += observation.output_tokens;
        agent.cache_read_tokens += observation.cache_read_tokens; agent.cache_write_tokens += observation.cache_write_tokens;
        byAgent.set(observation.agent_id, agent);
      }
      if (observation.cost.kind === "unpriced") unpricedCalls++;
      else {
        const key = `${observation.cost.currency}\0${observation.cost.minor_unit_exponent}\0${observation.cost.price_source_id}`;
        const prior = priced.get(key);
        priced.set(key, { ...observation.cost, minor_units: (prior?.minor_units ?? 0) + observation.cost.minor_units });
      }
    }
    if (observation.type === "node_cost_attribution") toolCalls += observation.top_cost_spans.filter((span) => span.kind === "tool").length;
    if (observation.type === "context_economy") {
      contextObservations++; offeredTokens += observation.offered_tokens; retainedTokens += observation.retained_tokens;
      prunedTokens += observation.pruned_tokens; indexedTokens += observation.indexed_reference_tokens;
      stableTokens += observation.stable_prefix_tokens; dynamicTokens += observation.dynamic_tokens;
      for (const row of observation.per_source) {
        const prior = contextBySource.get(row.source) ?? { offered_tokens: 0, retained_tokens: 0 };
        contextBySource.set(row.source, { offered_tokens: prior.offered_tokens + row.offered_tokens, retained_tokens: prior.retained_tokens + row.retained_tokens });
      }
    }
    if (observation.type === "tool_economy") {
      toolEconomyObservations++; offeredToolCalls += observation.offered_calls; hostExecutions += observation.host_executions;
      reusedReads += observation.reused_reads; avoidedOutputBytes += observation.avoided_output_bytes;
    }
  }
  const failures = new Map<string, Set<string>>();
  const verifiedNodes = new Set<string>();
  for (const record of records) {
    if (record.kind === "trace" && record.node_state_after === "verified") verifiedNodes.add(record.node_id);
    if (record.kind !== "trace" || record.node_state_after !== "failed") continue;
    const category = record.critic_root_cause?.trim() || "unclassified";
    const nodes = failures.get(category) ?? new Set<string>(); nodes.add(record.node_id); failures.set(category, nodes);
  }
  const effectiveTokens = inputTokens * DEFAULT_EFFECTIVE_TOKEN_POLICY.input + cacheRead * DEFAULT_EFFECTIVE_TOKEN_POLICY.cache_read
    + cacheWrite * DEFAULT_EFFECTIVE_TOKEN_POLICY.cache_write + outputTokens * DEFAULT_EFFECTIVE_TOKEN_POLICY.output;
  const phaseBreakdowns = [...byPhase.values()].map(finalizeBreakdown).sort((a, b) => a.phase.localeCompare(b.phase));
  const roleBreakdowns: Array<TokenEconomyBreakdown & { role: "specialist" | "critic" }> = [];
  for (const breakdown of phaseBreakdowns) {
    if (breakdown.phase === "expand") roleBreakdowns.push({ ...breakdown, role: "specialist" });
    if (breakdown.phase === "critic") roleBreakdowns.push({ ...breakdown, role: "critic" });
  }
  return {
    schema: "arbor.eval-run-manifest/v3", campaign_id: input.campaign_id, environment_digest: input.environment_digest,
    run_date: input.run_date, models: [...models.values()].sort(compareModel), sampling_rule: input.sampling_rule, aggregation_rule: input.aggregation_rule,
    cost: { input_tokens: inputTokens, output_tokens: outputTokens, cache_read_tokens: cacheRead, cache_write_tokens: cacheWrite, tool_calls: toolCalls, wall_clock_ms: wallClock,
      priced: [...priced.values()].sort((a, b) => a.price_source_id.localeCompare(b.price_source_id)), unpriced_calls: unpricedCalls,
      by_phase: phaseBreakdowns, by_role: roleBreakdowns,
      by_agent: [...byAgent.values()].map(finalizeAgentBreakdown).sort((a, b) => a.agent_id.localeCompare(b.agent_id)) },
    context_economy: { observations: contextObservations, offered_tokens: offeredTokens, retained_tokens: retainedTokens, pruned_tokens: prunedTokens,
      indexed_reference_tokens: indexedTokens, stable_prefix_tokens: stableTokens, dynamic_tokens: dynamicTokens, retention_ratio: nullableRatio(retainedTokens, offeredTokens),
      by_source: [...contextBySource].map(([source, counts]) => ({ source, ...counts, pruned_tokens: counts.offered_tokens - counts.retained_tokens, retention_ratio: nullableRatio(counts.retained_tokens, counts.offered_tokens) })).sort((a, b) => a.source.localeCompare(b.source)) },
    tool_economy: { observations: toolEconomyObservations, offered_calls: offeredToolCalls, host_executions: hostExecutions,
      reused_reads: reusedReads, avoided_output_bytes: avoidedOutputBytes, reuse_ratio: nullableRatio(reusedReads, offeredToolCalls) },
    cache_economy: { eligible_input_tokens: inputTokens + cacheRead, cache_read_tokens: cacheRead, cache_write_tokens: cacheWrite,
      cache_read_ratio: nullableRatio(cacheRead, inputTokens + cacheRead), cache_write_ratio: nullableRatio(cacheWrite, inputTokens + cacheRead) },
    efficiency: { effective_token_policy: DEFAULT_EFFECTIVE_TOKEN_POLICY, effective_tokens: effectiveTokens, verified_progress_units: verifiedNodes.size,
      verified_progress_per_effective_token: nullableRatio(verifiedNodes.size, effectiveTokens) },
    failures: [...failures].map(([category, nodes]) => ({ category, count: nodes.size, node_ids: [...nodes].sort() })).sort((a, b) => a.category.localeCompare(b.category)),
  };
}

export function validateRunManifest(value: unknown): value is EvalRunManifest {
  if (!value || typeof value !== "object") return false;
  const manifest = value as Partial<EvalRunManifest>;
  return manifest.schema === "arbor.eval-run-manifest/v3" && nonempty(manifest.campaign_id)
    && typeof manifest.environment_digest === "string" && /^sha256:[a-f0-9]{64}$/.test(manifest.environment_digest)
    && typeof manifest.run_date === "string" && !Number.isNaN(Date.parse(manifest.run_date))
    && nonempty(manifest.sampling_rule) && nonempty(manifest.aggregation_rule)
    && validModels(manifest.models) && validFailures(manifest.failures)
    && manifest.cost !== undefined && counts([manifest.cost.input_tokens, manifest.cost.output_tokens, manifest.cost.cache_read_tokens, manifest.cost.cache_write_tokens, manifest.cost.tool_calls, manifest.cost.wall_clock_ms, manifest.cost.unpriced_calls])
    && validPricedCosts(manifest.cost.priced)
    && Array.isArray(manifest.cost.by_phase) && manifest.cost.by_phase.every(validBreakdown)
    && Array.isArray(manifest.cost.by_role) && manifest.cost.by_role.every((row) => (row.role === "specialist" || row.role === "critic") && validBreakdown(row))
    && Array.isArray(manifest.cost.by_agent) && manifest.cost.by_agent.every(validAgentBreakdown)
    && manifest.context_economy !== undefined && counts([manifest.context_economy.observations, manifest.context_economy.offered_tokens, manifest.context_economy.retained_tokens, manifest.context_economy.pruned_tokens, manifest.context_economy.indexed_reference_tokens, manifest.context_economy.stable_prefix_tokens, manifest.context_economy.dynamic_tokens])
    && validContextEconomySources(manifest.context_economy.by_source)
    && (manifest.context_economy.retention_ratio === null || validRatio(manifest.context_economy.retention_ratio))
    && manifest.tool_economy !== undefined && counts([manifest.tool_economy.observations, manifest.tool_economy.offered_calls, manifest.tool_economy.host_executions, manifest.tool_economy.reused_reads, manifest.tool_economy.avoided_output_bytes])
    && manifest.tool_economy.host_executions + manifest.tool_economy.reused_reads <= manifest.tool_economy.offered_calls
    && (manifest.tool_economy.reuse_ratio === null || validRatio(manifest.tool_economy.reuse_ratio))
    && manifest.cache_economy !== undefined && counts([manifest.cache_economy.eligible_input_tokens, manifest.cache_economy.cache_read_tokens, manifest.cache_economy.cache_write_tokens])
    && manifest.cache_economy.cache_read_tokens <= manifest.cache_economy.eligible_input_tokens
    && (manifest.cache_economy.cache_read_ratio === null || validRatio(manifest.cache_economy.cache_read_ratio))
    && (manifest.cache_economy.cache_write_ratio === null || validRatio(manifest.cache_economy.cache_write_ratio))
    && manifest.efficiency !== undefined && manifest.efficiency.effective_token_policy?.unit === "weighted_token"
    && finiteNonNegative([manifest.efficiency.effective_token_policy.input, manifest.efficiency.effective_token_policy.cache_read, manifest.efficiency.effective_token_policy.cache_write, manifest.efficiency.effective_token_policy.output, manifest.efficiency.effective_tokens])
    && Number.isSafeInteger(manifest.efficiency.verified_progress_units) && manifest.efficiency.verified_progress_units >= 0
    && (manifest.efficiency.verified_progress_per_effective_token === null || Number.isFinite(manifest.efficiency.verified_progress_per_effective_token));
}

interface MutableTokenBreakdown {
  phase: import("@arbor/audit").TelemetryPhase;
  calls: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
}
interface MutableAgentBreakdown extends Omit<MutableTokenBreakdown, "phase"> { agent_id: string }
function emptyBreakdown(phase: import("@arbor/audit").TelemetryPhase): MutableTokenBreakdown { return { phase, calls: 0, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 }; }
function finalizeBreakdown(row: MutableTokenBreakdown): TokenEconomyBreakdown {
  return { ...row, effective_tokens: row.input_tokens * DEFAULT_EFFECTIVE_TOKEN_POLICY.input
    + row.cache_read_tokens * DEFAULT_EFFECTIVE_TOKEN_POLICY.cache_read
    + row.cache_write_tokens * DEFAULT_EFFECTIVE_TOKEN_POLICY.cache_write
    + row.output_tokens * DEFAULT_EFFECTIVE_TOKEN_POLICY.output };
}
function emptyAgentBreakdown(agent_id: string): MutableAgentBreakdown { return { agent_id, calls: 0, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 }; }
function finalizeAgentBreakdown(row: MutableAgentBreakdown): AgentTokenEconomyBreakdown {
  return { ...row, effective_tokens: row.input_tokens * DEFAULT_EFFECTIVE_TOKEN_POLICY.input
    + row.cache_read_tokens * DEFAULT_EFFECTIVE_TOKEN_POLICY.cache_read
    + row.cache_write_tokens * DEFAULT_EFFECTIVE_TOKEN_POLICY.cache_write
    + row.output_tokens * DEFAULT_EFFECTIVE_TOKEN_POLICY.output };
}
function validBreakdown(value: unknown): value is TokenEconomyBreakdown {
  if (!value || typeof value !== "object") return false;
  const row = value as Partial<TokenEconomyBreakdown>;
  return nonempty(row.phase) && counts([row.calls, row.input_tokens, row.output_tokens, row.cache_read_tokens, row.cache_write_tokens, row.effective_tokens]);
}
function validAgentBreakdown(value: unknown): value is AgentTokenEconomyBreakdown {
  if (!value || typeof value !== "object") return false;
  const row = value as Partial<AgentTokenEconomyBreakdown>;
  return nonempty(row.agent_id) && counts([row.calls, row.input_tokens, row.output_tokens, row.cache_read_tokens, row.cache_write_tokens, row.effective_tokens]);
}
function validModels(value: unknown): value is EvalRunManifest["models"] {
  return Array.isArray(value) && value.every((model) => {
    if (!model || typeof model !== "object") return false;
    const row = model as { role?: unknown; model_id?: unknown };
    return (row.role === "specialist" || row.role === "critic") && nonempty(row.model_id);
  });
}
function validFailures(value: unknown): value is EvalRunManifest["failures"] {
  return Array.isArray(value) && value.every((failure) => {
    if (!failure || typeof failure !== "object") return false;
    const row = failure as { category?: unknown; count?: unknown; node_ids?: unknown };
    return nonempty(row.category) && typeof row.count === "number" && Number.isSafeInteger(row.count) && row.count >= 0
      && Array.isArray(row.node_ids) && row.node_ids.every(nonempty) && row.count === row.node_ids.length;
  });
}
function validPricedCosts(value: unknown): value is EvalRunManifest["cost"]["priced"] {
  return Array.isArray(value) && value.every((cost) => {
    if (!cost || typeof cost !== "object") return false;
    const row = cost as { currency?: unknown; minor_unit_exponent?: unknown; minor_units?: unknown; price_source_id?: unknown };
    return nonempty(row.currency) && typeof row.minor_unit_exponent === "number" && Number.isSafeInteger(row.minor_unit_exponent) && row.minor_unit_exponent >= 0
      && typeof row.minor_units === "number" && Number.isSafeInteger(row.minor_units) && nonempty(row.price_source_id);
  });
}
function validContextEconomySources(value: unknown): value is EvalRunManifest["context_economy"]["by_source"] {
  return Array.isArray(value) && value.every((source) => {
    if (!source || typeof source !== "object") return false;
    const row = source as { source?: unknown; offered_tokens?: unknown; retained_tokens?: unknown; pruned_tokens?: unknown; retention_ratio?: unknown };
    return nonempty(row.source)
      && typeof row.offered_tokens === "number" && Number.isSafeInteger(row.offered_tokens) && row.offered_tokens >= 0
      && typeof row.retained_tokens === "number" && Number.isSafeInteger(row.retained_tokens) && row.retained_tokens >= 0
      && typeof row.pruned_tokens === "number" && Number.isSafeInteger(row.pruned_tokens) && row.pruned_tokens >= 0
      && row.retained_tokens <= row.offered_tokens && row.pruned_tokens === row.offered_tokens - row.retained_tokens
      && (row.retention_ratio === null || (typeof row.retention_ratio === "number" && validRatio(row.retention_ratio)));
  });
}

export interface TrajectoryOutcome { succeeded: boolean; correct: boolean; grounded: boolean }
export function rightForRightReasons(outcomes: readonly TrajectoryOutcome[]): { r4r: number; wdg: number } {
  if (outcomes.length === 0) return { r4r: 0, wdg: 0 };
  return {
    r4r: fraction(outcomes.filter((outcome) => outcome.succeeded && outcome.correct && outcome.grounded).length, outcomes.length),
    wdg: fraction(outcomes.filter((outcome) => !outcome.correct && outcome.grounded).length, outcomes.length),
  };
}

export type OracleClass = "deterministic" | "self_reflective" | "asserted" | "generated";
export interface VerificationOutcome { accepted: boolean; correct: boolean; provenance: Provenance }
export interface FalseAcceptanceRow { breadth: VerificationCheckBreadth | "unclassified"; oracle: OracleClass; accepted: number; false_acceptances: number; rate: number }
export function falseAcceptanceByVerification(outcomes: readonly VerificationOutcome[]): FalseAcceptanceRow[] {
  const groups = new Map<string, Omit<FalseAcceptanceRow, "rate">>();
  for (const outcome of outcomes) {
    const oracle = oracleClass(outcome.provenance);
    const breadth = outcome.provenance.tag === "verified" ? outcome.provenance.check?.breadth ?? "unclassified" : "unclassified";
    const key = `${breadth}\0${oracle}`;
    const row = groups.get(key) ?? { breadth, oracle, accepted: 0, false_acceptances: 0 };
    if (outcome.accepted) { row.accepted++; if (!outcome.correct) row.false_acceptances++; }
    groups.set(key, row);
  }
  return [...groups.values()].map((row) => ({ ...row, rate: fraction(row.false_acceptances, row.accepted) }))
    .sort((a, b) => `${a.breadth}:${a.oracle}`.localeCompare(`${b.breadth}:${b.oracle}`));
}

export interface EvalEstimate { config_id: string; lower: number; upper: number }
export type EvalComparison = { result: "winner"; config_id: string } | { result: "unresolved"; config_ids: [string, string] };
export function compareEvalEstimates(left: EvalEstimate, right: EvalEstimate): EvalComparison {
  if (left.lower > right.upper) return { result: "winner", config_id: left.config_id };
  if (right.lower > left.upper) return { result: "winner", config_id: right.config_id };
  return { result: "unresolved", config_ids: [left.config_id, right.config_id] };
}
export function unresolvedComparisonRate(comparisons: readonly EvalComparison[]): number {
  return fraction(comparisons.filter((comparison) => comparison.result === "unresolved").length, comparisons.length);
}

/** A paired held-out result used to decide whether an economy policy is safe to activate. */
export interface EconomizationTaskOutcome extends TrajectoryOutcome {
  readonly task_id: string;
  readonly accepted: boolean;
}
export interface EconomizationArm {
  readonly config_id: string;
  readonly effective_tokens: number;
  readonly outcomes: readonly EconomizationTaskOutcome[];
  readonly cohort: EconomizationCohortEvidence;
}
export interface EconomizationCohortEvidence {
  readonly cohort_id: string;
  readonly scope: "calibration" | "held_out";
  /** Independent command evidence for the sealed task/label corpus. */
  readonly provenance: Provenance;
}
export interface EconomizationGuardPolicy {
  /** Maximum tolerated loss in right-for-right-reasons rate. */
  readonly max_r4r_regression: number;
  /** Maximum tolerated increase in false-acceptance rate. */
  readonly max_false_acceptance_increase: number;
  readonly min_token_reduction_ratio: number;
  /** Wilson interval confidence; defaults to 0.95. */
  readonly confidence?: number;
}
export interface EconomizationGuardResult {
  readonly decision: "eligible" | "unresolved" | "rejected";
  readonly reason: string;
  readonly paired_tasks: number;
  readonly token_reduction_ratio: number;
  readonly baseline: { readonly r4r: number; readonly false_acceptance_rate: number };
  readonly candidate: { readonly r4r: number; readonly false_acceptance_rate: number };
  readonly r4r_delta_interval: readonly [number, number];
  readonly false_acceptance_delta_interval: readonly [number, number];
}

/**
 * Accuracy-first activation gate for any token-saving policy. Task identities
 * must match exactly; a cheaper arm is never eligible when quality is
 * statistically unresolved. The conservative Newcombe interval subtracts
 * independent Wilson bounds, deliberately preferring false negatives over a
 * silent quality regression.
 */
export function evaluateEconomizationGuard(baseline: EconomizationArm, candidate: EconomizationArm, policy: EconomizationGuardPolicy): EconomizationGuardResult {
  validateEconomizationArm(baseline); validateEconomizationArm(candidate); validateEconomizationPolicy(policy);
  if (baseline.cohort.cohort_id !== candidate.cohort.cohort_id) throw new Error("economization arms must name the same cohort");
  const baselineByTask = new Map(baseline.outcomes.map((outcome) => [outcome.task_id, outcome]));
  const candidateByTask = new Map(candidate.outcomes.map((outcome) => [outcome.task_id, outcome]));
  if (baselineByTask.size !== candidateByTask.size || [...baselineByTask.keys()].some((task) => !candidateByTask.has(task))) {
    throw new Error("economization arms must contain the same unique held-out task ids");
  }
  const pairedTasks = baselineByTask.size;
  if (pairedTasks === 0) throw new Error("economization guard requires at least one paired task");
  const confidence = policy.confidence ?? 0.95;
  const baseR4r = countR4r([...baselineByTask.values()]); const candidateR4r = countR4r([...candidateByTask.values()]);
  const baseAccepted = countAccepted([...baselineByTask.values()]); const candidateAccepted = countAccepted([...candidateByTask.values()]);
  const baseFalse = countFalseAccepted([...baselineByTask.values()]); const candidateFalse = countFalseAccepted([...candidateByTask.values()]);
  const baseR4rInterval = wilson(baseR4r, pairedTasks, confidence); const candidateR4rInterval = wilson(candidateR4r, pairedTasks, confidence);
  const baseFalseInterval = wilson(baseFalse, Math.max(1, baseAccepted), confidence); const candidateFalseInterval = wilson(candidateFalse, Math.max(1, candidateAccepted), confidence);
  const r4rDelta = intervalDifference(candidateR4rInterval, baseR4rInterval);
  const falseDelta = intervalDifference(candidateFalseInterval, baseFalseInterval);
  const baselineR4r = fraction(baseR4r, pairedTasks); const candidateR4rRate = fraction(candidateR4r, pairedTasks);
  const baselineFalseRate = fraction(baseFalse, baseAccepted); const candidateFalseRate = fraction(candidateFalse, candidateAccepted);
  const reduction = baseline.effective_tokens === 0 ? 0 : (baseline.effective_tokens - candidate.effective_tokens) / baseline.effective_tokens;
  const common = {
    paired_tasks: pairedTasks, token_reduction_ratio: rounded(reduction),
    baseline: { r4r: baselineR4r, false_acceptance_rate: baselineFalseRate },
    candidate: { r4r: candidateR4rRate, false_acceptance_rate: candidateFalseRate },
    r4r_delta_interval: r4rDelta, false_acceptance_delta_interval: falseDelta,
  } as const;
  if (reduction < policy.min_token_reduction_ratio) return { ...common, decision: "rejected", reason: "candidate does not meet the minimum token reduction" };
  if (candidateR4rRate - baselineR4r < -policy.max_r4r_regression) return { ...common, decision: "rejected", reason: "candidate point estimate exceeds the allowed R4R regression" };
  if (candidateFalseRate - baselineFalseRate > policy.max_false_acceptance_increase) return { ...common, decision: "rejected", reason: "candidate point estimate exceeds the allowed false-acceptance increase" };
  if (baseline.cohort.scope !== "held_out" || candidate.cohort.scope !== "held_out"
    || baseline.cohort.provenance.tag !== "verified" || candidate.cohort.provenance.tag !== "verified") {
    return { ...common, decision: "unresolved", reason: "calibration or unverified cohort evidence cannot promote an economization policy" };
  }
  if (r4rDelta[0] >= -policy.max_r4r_regression && falseDelta[1] <= policy.max_false_acceptance_increase) {
    return { ...common, decision: "eligible", reason: "token reduction is material and both accuracy non-inferiority bounds pass" };
  }
  return { ...common, decision: "unresolved", reason: "token reduction is material but held-out accuracy bounds do not yet prove non-inferiority" };
}

export interface SiblingOutcomeSignal {
  parent_id: string;
  expanded_children: number;
  verified_rate: number;
  outcome_spread: number;
  critic_approved: boolean | null;
  disagrees_with_critic: boolean | null;
}

export function siblingOutcomeSignals(ledger: EvidenceLedger, campaignId: string): { signals: SiblingOutcomeSignal[]; critic_spread_correlation: number | null } {
  const traces = ledger.getCampaign(campaignId);
  const latest = new Map<string, (typeof traces)[number]>();
  for (const trace of traces) latest.set(trace.node_id, trace);
  const children = new Map<string, (typeof traces)[number][]>();
  for (const trace of latest.values()) {
    if (trace.parent_id === undefined || trace.parent_id === null) continue;
    const group = children.get(trace.parent_id) ?? []; group.push(trace); children.set(trace.parent_id, group);
  }
  const signals: SiblingOutcomeSignal[] = [];
  for (const [parentId, siblings] of children) {
    if (siblings.length < 2) continue;
    const outcomes: number[] = siblings.map((trace) => trace.node_state_after === "verified" ? 1 : 0);
    const verifiedRate = outcomes.reduce((sum, value) => sum + value, 0) / outcomes.length;
    const spread = Math.max(...outcomes) - Math.min(...outcomes);
    const verdict = latest.get(parentId)?.critic_verdict_approved ?? null;
    signals.push({ parent_id: parentId, expanded_children: siblings.length, verified_rate: fraction(outcomes.reduce((sum, value) => sum + value, 0), outcomes.length), outcome_spread: spread,
      critic_approved: verdict, disagrees_with_critic: verdict === null ? null : verdict !== (verifiedRate >= 0.5) });
  }
  signals.sort((a, b) => a.parent_id.localeCompare(b.parent_id));
  const paired = signals.filter((signal): signal is SiblingOutcomeSignal & { critic_approved: boolean } => signal.critic_approved !== null);
  return { signals, critic_spread_correlation: pearson(paired.map((signal) => signal.critic_approved ? 1 : 0), paired.map((signal) => signal.outcome_spread)) };
}

function oracleClass(provenance: Provenance): OracleClass {
  if (provenance.tag === "verified") return "deterministic";
  if (provenance.tag === "critic_approved") return "self_reflective";
  if (provenance.tag === "generated") return "generated";
  return "asserted";
}
function fraction(numerator: number, denominator: number): number { return denominator === 0 ? 0 : Math.round((numerator / denominator) * 10_000) / 10_000; }
function nullableRatio(numerator: number, denominator: number): number | null { return denominator === 0 ? null : Math.round((numerator / denominator) * 1_000_000) / 1_000_000; }
function counts(values: readonly unknown[]): boolean { return values.every((value) => Number.isSafeInteger(value) && (value as number) >= 0); }
function finiteNonNegative(values: readonly unknown[]): boolean { return values.every((value) => typeof value === "number" && Number.isFinite(value) && value >= 0); }
function validRatio(value: number): boolean { return Number.isFinite(value) && value >= 0 && value <= 1; }
function nonempty(value: unknown): value is string { return typeof value === "string" && value.trim().length > 0; }
function compareModel(left: { role: string; model_id: string }, right: { role: string; model_id: string }): number { return `${left.role}:${left.model_id}`.localeCompare(`${right.role}:${right.model_id}`); }
function pearson(xs: readonly number[], ys: readonly number[]): number | null {
  if (xs.length < 2 || xs.length !== ys.length) return null;
  const xMean = xs.reduce((sum, value) => sum + value, 0) / xs.length; const yMean = ys.reduce((sum, value) => sum + value, 0) / ys.length;
  const numerator = xs.reduce((sum, value, index) => sum + (value - xMean) * (ys[index]! - yMean), 0);
  const xVariance = xs.reduce((sum, value) => sum + (value - xMean) ** 2, 0); const yVariance = ys.reduce((sum, value) => sum + (value - yMean) ** 2, 0);
  const denominator = Math.sqrt(xVariance * yVariance);
  return denominator === 0 ? null : Math.round((numerator / denominator) * 10_000) / 10_000;
}

function validateEconomizationArm(arm: EconomizationArm): void {
  if (!nonempty(arm.config_id) || !Number.isFinite(arm.effective_tokens) || arm.effective_tokens < 0) throw new Error("invalid economization arm");
  if (!nonempty(arm.cohort?.cohort_id) || (arm.cohort.scope !== "calibration" && arm.cohort.scope !== "held_out")) throw new Error("invalid economization cohort evidence");
  const ids = new Set<string>();
  for (const outcome of arm.outcomes) {
    if (!nonempty(outcome.task_id) || ids.has(outcome.task_id)) throw new Error("economization arm task ids must be unique and non-empty");
    if (![outcome.succeeded, outcome.correct, outcome.grounded, outcome.accepted].every((value) => typeof value === "boolean")) throw new Error("invalid economization outcome");
    ids.add(outcome.task_id);
  }
}
function validateEconomizationPolicy(policy: EconomizationGuardPolicy): void {
  const confidence = policy.confidence ?? 0.95;
  if (![policy.max_r4r_regression, policy.max_false_acceptance_increase, policy.min_token_reduction_ratio].every(validRatio)
    || !(confidence > 0 && confidence < 1)) throw new Error("invalid economization guard policy");
}
function countR4r(outcomes: readonly EconomizationTaskOutcome[]): number { return outcomes.filter((outcome) => outcome.succeeded && outcome.correct && outcome.grounded).length; }
function countAccepted(outcomes: readonly EconomizationTaskOutcome[]): number { return outcomes.filter((outcome) => outcome.accepted).length; }
function countFalseAccepted(outcomes: readonly EconomizationTaskOutcome[]): number { return outcomes.filter((outcome) => outcome.accepted && !outcome.correct).length; }
function intervalDifference(candidate: readonly [number, number], baseline: readonly [number, number]): readonly [number, number] {
  return Object.freeze([rounded(candidate[0] - baseline[1]), rounded(candidate[1] - baseline[0])] as const);
}
function wilson(successes: number, total: number, confidence: number): readonly [number, number] {
  const z = inverseNormal(0.5 + confidence / 2); const p = successes / total; const z2 = z * z;
  const center = (p + z2 / (2 * total)) / (1 + z2 / total);
  const margin = z * Math.sqrt((p * (1 - p) / total) + z2 / (4 * total * total)) / (1 + z2 / total);
  return Object.freeze([rounded(Math.max(0, center - margin)), rounded(Math.min(1, center + margin))] as const);
}
/** Acklam's inverse-normal approximation; deterministic and accurate well beyond metric precision. */
function inverseNormal(probability: number): number {
  const a = [-39.6968302866538, 220.946098424521, -275.928510446969, 138.357751867269, -30.6647980661472, 2.50662827745924];
  const b = [-54.4760987982241, 161.585836858041, -155.698979859887, 66.8013118877197, -13.2806815528857];
  const c = [-0.00778489400243029, -0.322396458041136, -2.40075827716184, -2.54973253934373, 4.37466414146497, 2.93816398269878];
  const d = [0.00778469570904146, 0.32246712907004, 2.445134137143, 3.75440866190742];
  const low = 0.02425;
  if (probability < low) { const q = Math.sqrt(-2 * Math.log(probability)); return (((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) / ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1); }
  if (probability > 1 - low) { const q = Math.sqrt(-2 * Math.log(1 - probability)); return -(((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) / ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1); }
  const q = probability - 0.5; const r = q * q;
  return (((((a[0]! * r + a[1]!) * r + a[2]!) * r + a[3]!) * r + a[4]!) * r + a[5]!) * q / (((((b[0]! * r + b[1]!) * r + b[2]!) * r + b[3]!) * r + b[4]!) * r + 1);
}
function rounded(value: number): number { return Math.round(value * 1_000_000) / 1_000_000; }
