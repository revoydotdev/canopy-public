/** Deterministic, fixture-backed report lane for advanced eval analytics. */
import { canonicalizeForHash, isVerificationCheck, type Provenance } from "@arbor/core";
import { createHash } from "node:crypto";
import { runAgentUctExperiment, type AgentUctExperimentPolicy, type AgentUctExperimentResult, type AgentUctFixture } from "./agent-uct.js";
import { computeCriticReliability } from "./metrics.js";
import { loadPrefixReuseLedgerResult, persistPrefixReuseObservation, summarizePrefixReuseLedger, type EvalReuseLedgerPersistenceDiagnostic } from "./reuse-ledger.js";
import { validateRunManifest, type EvalRunManifest } from "./trajectory-metrics.js";
import type { CriticReliabilityMetrics, CriticReliabilitySample, EvalPrefixObservationInput, EvalPrefixReuseSummary } from "./types.js";

export interface EvalAnalyticsFixture {
  readonly schema: "arbor.eval-analytics-fixture/v1";
  readonly agent_uct: { readonly fixture: AgentUctFixture; readonly policy: AgentUctExperimentPolicy; readonly iteration_budget: number };
  readonly critic_reliability_samples: readonly CriticReliabilitySample[];
  /** An independently captured manifest may be included for schema validation and reporting. */
  readonly run_manifest?: unknown;
  /**
   * Evidence records that may be replayed into an explicitly selected
   * evaluation ledger. They remain fixture inputs; they never affect Crown
   * scoring or campaign state.
   */
  readonly reuse_ledger_observations?: readonly EvalPrefixObservationInput[];
}

export interface EvalAnalyticsDiagnostic {
  readonly code: "missing_reuse_ledger" | "invalid_run_manifest" | EvalReuseLedgerPersistenceDiagnostic["code"];
  readonly message: string;
  readonly path?: string;
}

export interface EvalAnalyticsReport {
  readonly schema: "arbor.eval-analytics-report/v1";
  readonly provenance: Extract<Provenance, { tag: "generated" }>;
  readonly agent_uct: AgentUctExperimentResult;
  readonly critic_reliability: CriticReliabilityMetrics;
  readonly reuse_ledger: EvalPrefixReuseSummary | null;
  readonly run_manifest: EvalRunManifest | null;
  readonly diagnostics: readonly EvalAnalyticsDiagnostic[];
}

export class EvalAnalyticsInputError extends Error {
  constructor(message: string) { super(message); this.name = "EvalAnalyticsInputError"; }
}

function hash(value: unknown): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(canonicalizeForHash(value)).digest("hex")}`;
}
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function nonEmpty(value: unknown): value is string { return typeof value === "string" && value.trim().length > 0; }
function safeNonNegative(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0; }
function isoTimestamp(value: unknown): value is string { return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value) && !Number.isNaN(Date.parse(value)); }

function isProvenance(value: unknown): value is EvalPrefixObservationInput["provenance"] {
  if (!isRecord(value) || !nonEmpty(value.tag)) return false;
  if (value.tag === "verified") return nonEmpty(value.cmd) && value.exit === 0 && nonEmpty(value.stdout_hash)
    && (value.check === undefined || isVerificationCheck(value.check));
  if (value.tag === "claimed") return nonEmpty(value.claimant);
  if (value.tag === "critic_approved") return nonEmpty(value.critic) && nonEmpty(value.rationale);
  return value.tag === "generated" && nonEmpty(value.generator) && nonEmpty(value.input_hash);
}

function isPrefixObservation(value: unknown): value is EvalPrefixObservationInput {
  if (!isRecord(value) || !nonEmpty(value.operation_id) || !isoTimestamp(value.observed_at)
    || (value.observation_kind !== "materialized" && value.observation_kind !== "reused")
    || !safeNonNegative(value.marginal_cost_token_units) || !isRecord(value.prefix) || !isRecord(value.target)
    || !isRecord(value.marginal_cost) || !isProvenance(value.provenance)) return false;
  const prefix = value.prefix;
  const target = value.target;
  const cost = value.marginal_cost;
  if (!nonEmpty(prefix.prefix_text) || !nonEmpty(prefix.prompt_template_id) || !safeNonNegative(prefix.token_units) || !safeNonNegative(prefix.byte_length)
    || !nonEmpty(target.cluster_id) || !nonEmpty(target.item_id) || !nonEmpty(target.config_id)) return false;
  if (prefix.tool_contract_id !== undefined && !nonEmpty(prefix.tool_contract_id)) return false;
  if (prefix.model_family !== undefined && !nonEmpty(prefix.model_family)) return false;
  if (prefix.context_signature !== undefined && !nonEmpty(prefix.context_signature)) return false;
  if (target.variant_id !== undefined && !nonEmpty(target.variant_id)) return false;
  return cost.kind === "unpriced"
    ? nonEmpty(cost.reason)
    : cost.kind === "priced" && Number.isSafeInteger(cost.minor_units) && nonEmpty(cost.currency)
      && safeNonNegative(cost.minor_unit_exponent) && nonEmpty(cost.price_source_id);
}

/** Parse untrusted JSON before it reaches the evaluator's deterministic kernels. */
export function parseEvalAnalyticsFixture(value: unknown): EvalAnalyticsFixture {
  if (!isRecord(value) || value.schema !== "arbor.eval-analytics-fixture/v1" || !isRecord(value.agent_uct)) throw new EvalAnalyticsInputError("analytics fixture must use schema arbor.eval-analytics-fixture/v1");
  const agent = value.agent_uct;
  if (!isRecord(agent.fixture) || !isRecord(agent.policy) || !safeNonNegative(agent.iteration_budget) || agent.iteration_budget === 0 || agent.iteration_budget > 1_000) throw new EvalAnalyticsInputError("analytics fixture requires an Agent-UCT fixture, policy, and iteration_budget from 1 to 1000");
  const fixture = agent.fixture;
  if (!nonEmpty(fixture.fixture_id) || !Array.isArray(fixture.dimensions) || fixture.dimensions.length === 0 || fixture.dimensions.length > 16 || !Array.isArray(fixture.clusters) || fixture.clusters.length === 0 || !isRecord(fixture.prefix_cost_units) || !isRecord(fixture.rewards)) throw new EvalAnalyticsInputError("analytics Agent-UCT fixture has invalid or unbounded dimensions");
  for (const dimension of fixture.dimensions) if (!isRecord(dimension) || !nonEmpty(dimension.dimension_id) || !Array.isArray(dimension.options) || dimension.options.length === 0 || dimension.options.length > 64 || !dimension.options.every(nonEmpty)) throw new EvalAnalyticsInputError("analytics fixture dimensions require 1 to 64 non-empty options");
  for (const cluster of fixture.clusters) if (!isRecord(cluster) || !nonEmpty(cluster.cluster_id) || typeof cluster.weight !== "number" || !Number.isFinite(cluster.weight) || cluster.weight < 0 || !Array.isArray(cluster.item_ids) || cluster.item_ids.length === 0 || !cluster.item_ids.every(nonEmpty)) throw new EvalAnalyticsInputError("analytics fixture clusters are invalid");
  if (agent.policy.mode !== "classic" && agent.policy.mode !== "agent_uct" && agent.policy.mode !== "budget_annealed") throw new EvalAnalyticsInputError("analytics policy mode is invalid");
  if (typeof agent.policy.exploration_constant !== "number" || !Number.isFinite(agent.policy.exploration_constant) || agent.policy.exploration_constant < 0) throw new EvalAnalyticsInputError("analytics policy exploration_constant must be finite and non-negative");
  if (!Array.isArray(value.critic_reliability_samples) || value.critic_reliability_samples.length === 0 || value.critic_reliability_samples.length > 10_000) throw new EvalAnalyticsInputError("analytics fixture requires 1 to 10000 critic reliability samples");
  for (const sample of value.critic_reliability_samples) if (!isRecord(sample) || !nonEmpty(sample.node_id) || !isoTimestamp(sample.observed_at) || typeof sample.artifact_correct_before !== "boolean" || typeof sample.critic_flagged !== "boolean" || typeof sample.correction_attempted !== "boolean" || typeof sample.artifact_correct_after !== "boolean" || typeof sample.later_defect_found !== "boolean") throw new EvalAnalyticsInputError("analytics critic reliability sample requires a valid ISO observed_at timestamp");
  if (value.reuse_ledger_observations !== undefined
    && (!Array.isArray(value.reuse_ledger_observations) || value.reuse_ledger_observations.length > 10_000 || !value.reuse_ledger_observations.every(isPrefixObservation))) {
    throw new EvalAnalyticsInputError("analytics reuse_ledger_observations must contain at most 10000 valid provenance-carrying observations");
  }
  return value as unknown as EvalAnalyticsFixture;
}

/** Runs all advanced analytics. Missing/corrupt persisted state is reported, never replaced with a silent empty ledger. */
export function evaluateAnalytics(fixture: EvalAnalyticsFixture, ledger?: { readonly dir: string; readonly id: string }): EvalAnalyticsReport {
  const parsed = parseEvalAnalyticsFixture(fixture);
  const diagnostics: EvalAnalyticsDiagnostic[] = [];
  let reuseLedger: EvalPrefixReuseSummary | null = null;
  let effectiveLedger: unknown = null;
  if (ledger) {
    if (!nonEmpty(ledger.dir) || !nonEmpty(ledger.id)) throw new EvalAnalyticsInputError("reuse ledger directory and id must be non-empty");
    let persistedLedger = null;
    const persistenceDiagnostics: EvalReuseLedgerPersistenceDiagnostic[] = [];
    for (const observation of parsed.reuse_ledger_observations ?? []) {
      const persisted = persistPrefixReuseObservation(ledger.dir, ledger.id, observation, { holder: "arbor-eval/analytics" });
      persistedLedger = persisted.ledger;
      persistenceDiagnostics.push(...persisted.diagnostics);
    }
    const loaded = persistedLedger === null ? loadPrefixReuseLedgerResult(ledger.id, ledger.dir) : null;
    const value = persistedLedger ?? loaded?.value ?? null;
    const ledgerDiagnostics = [...persistenceDiagnostics, ...(loaded?.diagnostics ?? [])];
    effectiveLedger = {
      ledger_id: ledger.id,
      replayed_observation_count: parsed.reuse_ledger_observations?.length ?? 0,
      value,
      diagnostics: ledgerDiagnostics,
    };
    if (value) reuseLedger = summarizePrefixReuseLedger(value);
    else if (ledgerDiagnostics.length === 0) diagnostics.push({ code: "missing_reuse_ledger", message: `reuse ledger ${JSON.stringify(ledger.id)} is absent` });
    diagnostics.push(...ledgerDiagnostics.map((diagnostic) => ({ code: diagnostic.code, message: diagnostic.message, path: diagnostic.path })));
  }
  let runManifest: EvalRunManifest | null = null;
  if (parsed.run_manifest !== undefined) {
    if (!validateRunManifest(parsed.run_manifest)) diagnostics.push({ code: "invalid_run_manifest", message: "run_manifest does not satisfy arbor.eval-run-manifest/v3" });
    else runManifest = parsed.run_manifest;
  }
  const agentUct = runAgentUctExperiment(parsed.agent_uct.fixture, parsed.agent_uct.policy, parsed.agent_uct.iteration_budget);
  const criticReliability = computeCriticReliability(parsed.critic_reliability_samples);
  return Object.freeze({ schema: "arbor.eval-analytics-report/v1", provenance: Object.freeze({ tag: "generated", generator: "arbor-eval/analytics", input_hash: hash({ fixture: parsed, effective_ledger: effectiveLedger, run_manifest: runManifest, diagnostics }) }), agent_uct: agentUct, critic_reliability: criticReliability, reuse_ledger: reuseLedger, run_manifest: runManifest, diagnostics: Object.freeze(diagnostics) });
}
