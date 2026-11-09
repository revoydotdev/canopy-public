/**
 * TUI-owned telemetry projection types.
 * Structurally mirrors {@link @arbor/mcp#TelemetryProjection} from the canonical
 * {@link metrics-projector.ts} — this is a read-only snapshot, never a mutable
 * counter authority. The TUI holds only a bounded, frozen projection view.
 *
 * Follows ADR-017: telemetry is a ledger-derived projection.
 */

export interface MetricEvidencePointer {
  readonly record_id: string;
  readonly content_hash: string;
}

export interface MetricCounterRow {
  readonly name: "arbor.phase.observations" | "arbor.provider.calls";
  readonly campaign_id: string;
  readonly node_id: string;
  readonly tags: Readonly<Record<string, string>>;
  readonly value: number;
  readonly evidence: readonly MetricEvidencePointer[];
}

export interface PhaseHistogramRow {
  readonly name: "arbor.phase.duration_ms";
  readonly campaign_id: string;
  readonly node_id: string;
  readonly tags: Readonly<{ phase: string; outcome: string }>;
  readonly count: number;
  readonly sum_ms: number;
  readonly max_ms: number;
  /** Cumulative counts matching PHASE_DURATION_BUCKETS_MS plus overflow. */
  readonly buckets: readonly number[];
  readonly evidence: readonly MetricEvidencePointer[];
}

interface UsageCostRowBase {
  readonly name: "arbor.provider.usage_cost";
  readonly campaign_id: string;
  readonly node_id: string;
  readonly calls: number;
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly cache_read_tokens: number;
  readonly cache_write_tokens: number;
  readonly evidence: readonly MetricEvidencePointer[];
}

/**
 * Provider usage/cost rows are split by pricing status: a priced series
 * carries a real summed amount and its price-source evidence; an unpriced
 * series carries the reasons instead of a fabricated zero (G-09). The two
 * shapes are structurally distinct so a priced row can never be missing its
 * amount and an unpriced row can never claim one.
 */
export type UsageCostRow =
  | (UsageCostRowBase & {
      readonly tags: Readonly<{ provider: string; model_family: string; phase: string; agent: string; pricing: "priced"; currency: string; minor_unit_exponent: string }>;
      readonly cost_minor_units: number;
      readonly price_source_ids: readonly string[];
    })
  | (UsageCostRowBase & {
      readonly tags: Readonly<{ provider: string; model_family: string; phase: string; agent: string; pricing: "unpriced" }>;
      readonly unpriced_reasons: readonly string[];
    });

export interface ContextEconomyRow {
  readonly name: "arbor.context.economy";
  readonly campaign_id: string;
  readonly node_id: string;
  readonly tags: Readonly<{ phase: string; outcome: string }>;
  readonly observations: number;
  readonly offered_tokens: number;
  readonly retained_tokens: number;
  readonly pruned_tokens: number;
  readonly indexed_reference_tokens: number;
  readonly stable_prefix_tokens: number;
  readonly dynamic_tokens: number;
  readonly evidence: readonly MetricEvidencePointer[];
}

export interface ToolEconomyRow {
  readonly name: "arbor.tool.economy";
  readonly campaign_id: string;
  readonly node_id: string;
  readonly tags: Readonly<{ phase: string; outcome: string }>;
  readonly observations: number;
  readonly offered_calls: number;
  readonly host_executions: number;
  readonly reused_reads: number;
  readonly avoided_output_bytes: number;
  readonly evidence: readonly MetricEvidencePointer[];
}

export interface CampaignPricedSubtotal {
  readonly currency: string;
  readonly minor_unit_exponent: number;
  readonly cost_minor_units: number;
  readonly price_source_ids: readonly string[];
}

/**
 * Campaign-level usage/cost totals folded from ledger `usage_cost` records
 * only. Mirrors the canonical `CampaignTotals` in metrics-projector.ts.
 * Optional so snapshots produced before the totals projection keep rendering;
 * a missing value renders as `unavailable`, never zero.
 */
export type CampaignTotals =
  | {
      readonly state: "observed";
      readonly calls: number;
      readonly input_tokens: number;
      readonly output_tokens: number;
      readonly cache_read_tokens: number;
      readonly cache_write_tokens: number;
      readonly priced: readonly CampaignPricedSubtotal[];
      readonly unpriced_calls: number;
      readonly unpriced_reasons: readonly string[];
      readonly evidence: readonly MetricEvidencePointer[];
    }
  | { readonly state: "unavailable"; readonly reason: string };

export interface TelemetrySnapshot {
  readonly campaign_id: string;
  readonly source_record_count: number;
  readonly campaign_totals?: CampaignTotals;
  readonly counters: readonly MetricCounterRow[];
  readonly phase_histograms: readonly PhaseHistogramRow[];
  readonly usage_cost: readonly UsageCostRow[];
  readonly context_economy: readonly ContextEconomyRow[];
  readonly tool_economy: readonly ToolEconomyRow[];
}

/**
 * Deep-freeze a telemetry snapshot so consuming renders cannot mutate the
 * shared projection. Returns a structurally-identical read-only copy.
 */
export function freezeTelemetrySnapshot(snapshot: TelemetrySnapshot): TelemetrySnapshot {
  return Object.freeze({
    campaign_id: snapshot.campaign_id,
    source_record_count: snapshot.source_record_count,
    ...(snapshot.campaign_totals === undefined ? {} : { campaign_totals: freezeCampaignTotals(snapshot.campaign_totals) }),
    counters: Object.freeze(snapshot.counters.map(freezeCounter)),
    phase_histograms: Object.freeze(snapshot.phase_histograms.map(freezePhaseHistogram)),
    usage_cost: Object.freeze(snapshot.usage_cost.map(freezeUsageCost)),
    context_economy: Object.freeze(snapshot.context_economy.map(freezeContextEconomy)),
    tool_economy: Object.freeze(snapshot.tool_economy.map(freezeToolEconomy)),
  });
}

function freezeCampaignTotals(totals: CampaignTotals): CampaignTotals {
  if (totals.state === "unavailable") return Object.freeze({ ...totals });
  return Object.freeze({ ...totals,
    priced: Object.freeze(totals.priced.map((subtotal) => Object.freeze({ ...subtotal,
      price_source_ids: Object.freeze([...subtotal.price_source_ids]) }))),
    unpriced_reasons: Object.freeze([...totals.unpriced_reasons]),
    evidence: Object.freeze(totals.evidence.map((e) => Object.freeze({ ...e }))) });
}

function freezeCounter(row: MetricCounterRow): MetricCounterRow {
  return Object.freeze({ ...row, tags: Object.freeze({ ...row.tags }), evidence: Object.freeze(row.evidence.map((e) => Object.freeze({ ...e }))) });
}

function freezePhaseHistogram(row: PhaseHistogramRow): PhaseHistogramRow {
  return Object.freeze({ ...row, tags: Object.freeze({ ...row.tags }), buckets: Object.freeze([...row.buckets]), evidence: Object.freeze(row.evidence.map((e) => Object.freeze({ ...e }))) });
}

function freezeUsageCost(row: UsageCostRow): UsageCostRow {
  const evidence = Object.freeze(row.evidence.map((e) => Object.freeze({ ...e })));
  // Discriminate on an own property, not the nested `tags.pricing` tag: TS
  // does not narrow a union through a chained property access.
  return "cost_minor_units" in row
    ? Object.freeze({ ...row, tags: Object.freeze({ ...row.tags }), price_source_ids: Object.freeze([...row.price_source_ids]), evidence })
    : Object.freeze({ ...row, tags: Object.freeze({ ...row.tags }), unpriced_reasons: Object.freeze([...row.unpriced_reasons]), evidence });
}

function freezeContextEconomy(row: ContextEconomyRow): ContextEconomyRow {
  return Object.freeze({ ...row, tags: Object.freeze({ ...row.tags }), evidence: Object.freeze(row.evidence.map((e) => Object.freeze({ ...e }))) });
}

function freezeToolEconomy(row: ToolEconomyRow): ToolEconomyRow {
  return Object.freeze({ ...row, tags: Object.freeze({ ...row.tags }), evidence: Object.freeze(row.evidence.map((e) => Object.freeze({ ...e }))) });
}

export interface TelemetrySourcePort {
  /**
   * Fetch the canonical telemetry projection for a campaign.
   * The projection is derived from ledger evidence (ADR-017); the TUI never
   * computes or stores mutable counters.
   */
  fetch(campaignId: string): Promise<TelemetrySnapshot>;
}
