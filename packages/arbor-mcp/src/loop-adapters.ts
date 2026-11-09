import { createHash } from "node:crypto";
import type { NodeCommunication, NodeCommunicationRecord } from "@arbor/audit";
import type { Cost, Provenance } from "@arbor/core";
import type { OutputEvidenceStore } from "@arbor/audit";
import type { PhaseMessageInput } from "@arbor/audit";
import type { CampaignManager } from "./manager.js";

export type CommunicationCapabilityTier = NodeCommunication["capability_tier"];

/** Structural match for @arbor/opencode's read-only selection port. */
export interface ManagerSelectionCommunicationPort {
  projectSelection(params: {
    campaign_id: string;
    node_id: string;
    tier: CommunicationCapabilityTier;
    limit: number;
    as_of: string;
  }): readonly NodeCommunicationRecord[];
}

/** Structural match for @arbor/opencode's durable output capture port. */
export interface ManagerOutputEvidenceCapturePort {
  capture(input: {
    campaign_id: string;
    node_id: string;
    kind: "specialist" | "critic" | "tool";
    content: string;
    provenance: Provenance;
  }): Promise<{ evidence_pointer: string }>;
}

/** Directly spreadable into CampaignLoopConfig without importing OpenCode here. */
export interface CanonicalLoopPorts {
  communications: ManagerSelectionCommunicationPort;
  output_evidence: ManagerOutputEvidenceCapturePort;
  model_capabilities: RuntimeModelCapabilityAdapter;
  /** Durable epoch repository; adapters supply provider policy around it. */
  token_epochs: import("./token-epoch-service.js").TokenEpochService;
  /** Live, ledger-derived scoring context. Supplies real regression rates, never hardcoded zeros. */
  score_ctx: (campaignId: string) => import("@arbor/core").ScoreContext;
  interruptions: {
    interrupt(input: { campaign_id: string; node_id: string; scope: "node" | "subtree"; reason: string; cause: "cancellation" | "context_overflow"; phase: string; epoch_id?: string }): void;
  };
  telemetry?: ManagerTelemetryPort;
}

/** Structural match for @arbor/opencode's ledger-backed telemetry emission. */
export interface ManagerTelemetryPort {
  recordPhaseTiming(input: {
    campaign_id: string;
    node_id: string;
    operation_id: string;
    epoch: number;
    phase: "select" | "expand" | "gate" | "critic" | "backprop";
    outcome: "success" | "failure" | "cancelled" | "timeout";
    duration_ms: number;
    source_evidence_id: string;
  }): string;
  recordUsageCost(input: {
    campaign_id: string;
    node_id: string;
    operation_id: string;
    epoch: number;
    phase: "select" | "expand" | "gate" | "critic" | "backprop";
    outcome: "success" | "failure" | "cancelled" | "timeout";
    source_evidence_id: string;
    agent_id: string;
    provider: import("@arbor/audit").TelemetryProvider;
    model_family: import("@arbor/audit").TelemetryModelFamily;
    input_tokens: number;
    output_tokens: number;
    cache_read_tokens: number;
    cache_write_tokens: number;
    cost: Cost;
  }): string;
  recordRoleModelIdentity(input: {
    campaign_id: string; node_id: string; operation_id: string; epoch: number;
    phase: "expand" | "critic"; outcome: "success"; source_evidence_id: string;
    role: "specialist" | "critic"; model_id: string;
  }): string;
  /** ADR-067 (X-2): one durable race-outcome record per staggered specialist race. `source_evidence_id` is the caller's witness — the ledger refuses an unfounded observation. */
  recordRaceOutcome(input: import("@arbor/core").RaceOutcomeObservation & { campaign_id: string; node_id: string; operation_id: string; epoch: number; source_evidence_id: string }): string;
  recordNodeCostAttribution(input: import("@arbor/audit").NodeCostAttributionObservation & { campaign_id: string; node_id: string }): string;
  recordContextEconomy(input: import("@arbor/audit").ContextEconomyObservation & { campaign_id: string; node_id: string }): string;
  recordToolEconomy(input: import("@arbor/audit").ToolEconomyObservation & { campaign_id: string; node_id: string }): string;
  /** ADR-016: the specialist's completed output, journaled as ledger phase-message evidence. */
  recordPhaseMessage(input: PhaseMessageInput): string;
}

/**
 * Bridges the loop's telemetry emission onto the canonical manager ledger,
 * building stable generated provenance and an idempotency key per observation.
 */
export class ManagerTelemetryAdapter implements ManagerTelemetryPort {
  constructor(private readonly manager: import("./manager.js").CampaignManager) {}

  recordPhaseTiming(input: Parameters<ManagerTelemetryPort["recordPhaseTiming"]>[0]): string {
    const idempotency_key = `phase:${input.operation_id}:${input.phase}:${input.epoch}`;
    const provenance = generatedProvenance(input);
    return this.manager.recordTelemetryObservation({
      campaign_id: input.campaign_id, node_id: input.node_id,
      operation_id: input.operation_id, epoch: input.epoch,
      type: "phase_timing", phase: input.phase, outcome: input.outcome,
      duration_ms: input.duration_ms, source_evidence_id: input.source_evidence_id,
      idempotency_key, provenance,
    });
  }

  recordUsageCost(input: Parameters<ManagerTelemetryPort["recordUsageCost"]>[0]): string {
    const idempotency_key = `cost:${input.operation_id}:${input.phase}:${input.epoch}`;
    const provenance = generatedProvenance(input);
    return this.manager.recordTelemetryObservation({
      campaign_id: input.campaign_id, node_id: input.node_id,
      operation_id: input.operation_id, epoch: input.epoch,
      type: "usage_cost", phase: input.phase, outcome: input.outcome,
      source_evidence_id: input.source_evidence_id,
      idempotency_key, provenance,
      provider: input.provider, model_family: input.model_family, agent_id: input.agent_id,
      input_tokens: input.input_tokens, output_tokens: input.output_tokens,
      cache_read_tokens: input.cache_read_tokens, cache_write_tokens: input.cache_write_tokens,
      cost: input.cost,
    });
  }

  recordRoleModelIdentity(input: Parameters<ManagerTelemetryPort["recordRoleModelIdentity"]>[0]): string {
    const idempotency_key = `model:${input.operation_id}:${input.role}:${input.epoch}`;
    return this.manager.recordTelemetryObservation({
      ...input,
      type: "role_model_identity",
      idempotency_key,
      provenance: generatedProvenance(input),
    });
  }

  recordRaceOutcome(input: Parameters<ManagerTelemetryPort["recordRaceOutcome"]>[0]): string {
    const idempotency_key = `race:${input.operation_id}:${input.epoch}`;
    return this.manager.recordTelemetryObservation({
      campaign_id: input.campaign_id, node_id: input.node_id, operation_id: input.operation_id, epoch: input.epoch,
      type: "race_outcome", phase: "expand", outcome: "success", source_evidence_id: input.source_evidence_id,
      forked_at_ms: input.forked_at_ms, winner: input.winner, loser_wall_ms: input.loser_wall_ms, cancelled: input.cancelled,
      ...(input.loser_usage_unavailable_reason === undefined ? {} : { loser_usage_unavailable_reason: input.loser_usage_unavailable_reason }),
      ...(input.threshold_ms === undefined ? {} : { threshold_ms: input.threshold_ms }),
      ...(input.threshold_source === undefined ? {} : { threshold_source: input.threshold_source }),
      ...(input.threshold_observations === undefined ? {} : { threshold_observations: input.threshold_observations }),
      ...(input.tie_break === undefined ? {} : { tie_break: input.tie_break }),
      idempotency_key,
      provenance: generatedProvenance(input),
    });
  }

  recordNodeCostAttribution(input: Parameters<ManagerTelemetryPort["recordNodeCostAttribution"]>[0]): string {
    return this.manager.recordTelemetryObservation(input);
  }

  recordContextEconomy(input: Parameters<ManagerTelemetryPort["recordContextEconomy"]>[0]): string {
    return this.manager.recordTelemetryObservation(input);
  }

  recordToolEconomy(input: Parameters<ManagerTelemetryPort["recordToolEconomy"]>[0]): string {
    return this.manager.recordTelemetryObservation(input);
  }

  recordPhaseMessage(input: Parameters<ManagerTelemetryPort["recordPhaseMessage"]>[0]): string {
    return this.manager.recordPhaseMessage(input);
  }
}

function generatedProvenance(input: { operation_id: string; campaign_id: string; node_id: string }): Provenance {
  const digest = createHash("sha256").update(JSON.stringify({
    operation_id: input.operation_id, campaign_id: input.campaign_id, node_id: input.node_id,
  })).digest("hex");
  return { tag: "generated", generator: "arbor-loop-telemetry", input_hash: digest };
}

/**
 * Derives a live, campaign-scoped ScoreContext from the canonical manager's
 * observed tree state. Regression rates are fractions of encountered outcomes
 * (failed -> accuracy regression signal, interrupted/abandoned -> crash
 * signal), never hardcoded zeros. Absent a campaign the context degrades to
 * neutral values rather than fabricating signal.
 */
export class ManagerScoreContextAdapter {
  constructor(private readonly manager: import("./manager.js").CampaignManager) {}

  score_ctx(campaignId: string): import("@arbor/core").ScoreContext {
    const snapshot = this.manager.getCampaignSnapshot(campaignId);
    if (!snapshot || snapshot.nodes.length === 0) {
      return { accuracy_regression_rate: 0, crash_regression_rate: 0, best_known: 0, total_visits: 0 };
    }
    let visited = 0;
    let failed = 0;
    let crashed = 0;
    // best_score now carries the measured reward (1 once anything verifies), so
    // reading it here would shift exploitation weight. ADR-131 forbids changing
    // selection without live evidence: keep the prior-scale value it used to be,
    // the best selection score among verified nodes.
    let best_known = 0;
    for (const node of snapshot.nodes) {
      if (node.state === "verified" && node.score > best_known) best_known = node.score;
      if (node.visit_count > 0) visited++;
      if (node.state === "failed") failed++;
      if (node.state === "interrupted" || node.state === "abandoned") crashed++;
    }
    const base = visited > 0 ? visited : snapshot.nodes.length;
    return {
      accuracy_regression_rate: base > 0 ? failed / base : 0,
      crash_regression_rate: base > 0 ? crashed / base : 0,
      best_known,
      total_visits: visited,
    };
  }
}

export interface ProviderModelCapabilityPort {
  maxOutputTokens(input: { model?: string }): { value: number; source: "runtime" | "snapshot" } | null;
  /** Advertised context window for the named provider model, when known. */
  contextCapacity?(input: { model?: string }): { value: number; source: "runtime" | "snapshot" } | null;
  /** Provider/model-aware estimation only. Absence is explicit; no char heuristic is substituted. */
  estimateTokens?: (input: { model?: string; content: string }) => number | Promise<number>;
}

/** The resolved output-token limit after applying provider caps. */
export interface ResolvedOutputLimit {
  requested_max_output_tokens: number;
  effective_max_output_tokens: number;
  limit_source: "requested" | "runtime" | "snapshot";
  provider_max_output_tokens: number | null;
}

/** Optional bridge to live provider metadata; safe to expose even when no provider is attached. */
export class RuntimeModelCapabilityAdapter {
  constructor(private readonly provider: ProviderModelCapabilityPort | null = null) {}

  resolveOutputLimit(input: { requested_max_output_tokens: number; model?: string }): ResolvedOutputLimit {
    if (!Number.isSafeInteger(input.requested_max_output_tokens) || input.requested_max_output_tokens < 1) {
      throw new Error("requested_max_output_tokens must be a positive safe integer");
    }
    const advertised = this.provider?.maxOutputTokens(input) ?? null;
    if (!advertised) return {
      requested_max_output_tokens: input.requested_max_output_tokens,
      effective_max_output_tokens: input.requested_max_output_tokens,
      limit_source: "requested",
      provider_max_output_tokens: null,
    };
    if (!Number.isSafeInteger(advertised.value) || advertised.value < 1) {
      throw new Error("provider max output tokens must be a positive safe integer");
    }
    return {
      requested_max_output_tokens: input.requested_max_output_tokens,
      effective_max_output_tokens: Math.min(input.requested_max_output_tokens, advertised.value),
      limit_source: advertised.source,
      provider_max_output_tokens: advertised.value,
    };
  }

  async estimateTokens(input: { model?: string; content: string }): Promise<{ value: number; source: "provider" } | null> {
    if (!this.provider?.estimateTokens) return null;
    const value = await this.provider.estimateTokens(input);
    if (!Number.isSafeInteger(value) || value < 0) throw new Error("provider token estimate must be a non-negative safe integer");
    return { value, source: "provider" };
  }

  resolveContextCapacity(input: { model?: string }): { value: number; source: "runtime" | "snapshot" } | null {
    return this.provider?.contextCapacity?.(input) ?? null;
  }
}

const TIER_RANK: Record<CommunicationCapabilityTier, number> = {
  specialist: 0,
  critic: 1,
  auditor: 2,
  orchestrator: 3,
};

/**
 * Projects the canonical manager ledger at a fixed adapter authority. The
 * caller may request a less-privileged view, but cannot elevate its own tier.
 */
export class ManagerSelectionCommunicationAdapter implements ManagerSelectionCommunicationPort {
  constructor(
    private readonly manager: CampaignManager,
    private readonly authority: CommunicationCapabilityTier = "orchestrator",
  ) {}

  projectSelection(params: {
    campaign_id: string;
    node_id: string;
    tier: CommunicationCapabilityTier;
    limit: number;
    as_of: string;
  }): readonly NodeCommunicationRecord[] {
    if (TIER_RANK[params.tier] > TIER_RANK[this.authority]) {
      throw new Error(`communication tier ${params.tier} exceeds adapter authority ${this.authority}`);
    }
    return this.manager.getSelectionCommunications(params.campaign_id, params.node_id, params.tier, {
      limit: params.limit,
      as_of: params.as_of,
    });
  }
}

/** Maps loop output kinds onto the runtime's content-addressed evidence store. */
export class ManagerOutputEvidenceCaptureAdapter implements ManagerOutputEvidenceCapturePort {
  constructor(private readonly store: OutputEvidenceStore | null) {}

  async capture(input: {
    campaign_id: string;
    node_id: string;
    kind: "specialist" | "critic" | "tool";
    content: string;
    provenance: Provenance;
  }): Promise<{ evidence_pointer: string }> {
    if (!this.store) throw new Error("output evidence persistence is not configured");
    const operation_id = captureOperationId(input);
    const record = this.store.put({
      campaign_id: input.campaign_id,
      node_id: input.node_id,
      operation_id,
      stream: input.kind === "tool" ? "transcript" : "model",
      media_type: "text/plain; charset=utf-8",
      provenance: structuredClone(input.provenance),
    }, input.content);
    return { evidence_pointer: `audit://output-artifacts/${record.id}` };
  }
}

function captureOperationId(input: {
  campaign_id: string;
  node_id: string;
  kind: "specialist" | "critic" | "tool";
  content: string;
  provenance: Provenance;
}): string {
  const digest = createHash("sha256").update(JSON.stringify({
    campaign_id: input.campaign_id,
    node_id: input.node_id,
    kind: input.kind,
    provenance: input.provenance,
    content: input.content,
  })).digest("hex");
  return `loop-output-${digest}`;
}
