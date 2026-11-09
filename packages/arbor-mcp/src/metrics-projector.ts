import { compareCodeUnits } from "@arbor/core";
import { AuditIntegrityError, type EvidenceLedger, type TelemetryObservationRecord } from "@arbor/audit";

export const PHASE_DURATION_BUCKETS_MS = [10, 50, 100, 500, 1_000, 5_000, 30_000, 120_000] as const;

export interface MetricEvidencePointer {
  record_id: string;
  content_hash: string;
}

export interface MetricCounterRow {
  name: "arbor.phase.observations" | "arbor.provider.calls";
  campaign_id: string;
  node_id: string;
  tags: Readonly<Record<string, string>>;
  value: number;
  evidence: readonly MetricEvidencePointer[];
}

export interface PhaseHistogramRow {
  name: "arbor.phase.duration_ms";
  campaign_id: string;
  node_id: string;
  tags: Readonly<{ phase: string; outcome: string }>;
  count: number;
  sum_ms: number;
  max_ms: number;
  /** Cumulative counts corresponding to PHASE_DURATION_BUCKETS_MS, plus overflow. */
  buckets: readonly number[];
  evidence: readonly MetricEvidencePointer[];
}

interface UsageCostRowBase {
  name: "arbor.provider.usage_cost";
  campaign_id: string;
  node_id: string;
  calls: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  evidence: readonly MetricEvidencePointer[];
}

/**
 * Provider usage/cost rows are aggregated separately by pricing status: a
 * priced series carries a real summed amount and its price-source evidence; an
 * unpriced series carries the reasons instead of a fabricated zero (G-09).
 * The two shapes are structurally distinct so a priced row can never be
 * missing its amount and an unpriced row can never claim one.
 */
export type UsageCostRow =
  | (UsageCostRowBase & {
      tags: Readonly<{ provider: string; model_family: string; phase: string; agent: string; pricing: "priced"; currency: string; minor_unit_exponent: string }>;
      cost_minor_units: number;
      price_source_ids: readonly string[];
    })
  | (UsageCostRowBase & {
      tags: Readonly<{ provider: string; model_family: string; phase: string; agent: string; pricing: "unpriced" }>;
      unpriced_reasons: readonly string[];
    });

export interface ContextEconomyRow {
  name: "arbor.context.economy";
  campaign_id: string;
  node_id: string;
  tags: Readonly<{ phase: string; outcome: string }>;
  observations: number;
  offered_tokens: number;
  retained_tokens: number;
  pruned_tokens: number;
  indexed_reference_tokens: number;
  stable_prefix_tokens: number;
  dynamic_tokens: number;
  evidence: readonly MetricEvidencePointer[];
}

export interface ToolEconomyRow {
  name: "arbor.tool.economy";
  campaign_id: string;
  node_id: string;
  tags: Readonly<{ phase: string; outcome: string }>;
  observations: number;
  offered_calls: number;
  host_executions: number;
  reused_reads: number;
  avoided_output_bytes: number;
  evidence: readonly MetricEvidencePointer[];
}

export interface CampaignPricedSubtotal {
  currency: string;
  /** Exact minor-unit exponent as a number (audit validation bounds it 0..9). */
  minor_unit_exponent: number;
  cost_minor_units: number;
  price_source_ids: readonly string[];
}

/**
 * Campaign-level usage/cost totals folded from ledger `usage_cost` records
 * only — never from a mutable counter. Token counts are always observed when
 * at least one usage record exists; priced subtotals stay grouped by
 * (currency, exponent) so differently-denominated amounts are never converted
 * or merged. When every record is unpriced, `priced` is empty and the typed
 * reasons carry the absence instead of a fabricated zero (G-09). With zero
 * usage records the totals are `unavailable`, never zero.
 */
export type CampaignTotals =
  | {
      state: "observed";
      calls: number;
      input_tokens: number;
      output_tokens: number;
      cache_read_tokens: number;
      cache_write_tokens: number;
      priced: readonly CampaignPricedSubtotal[];
      unpriced_calls: number;
      unpriced_reasons: readonly string[];
      evidence: readonly MetricEvidencePointer[];
    }
  | { state: "unavailable"; reason: string };

export interface TelemetryProjection {
  campaign_id: string;
  source_record_count: number;
  campaign_totals: CampaignTotals;
  counters: readonly MetricCounterRow[];
  phase_histograms: readonly PhaseHistogramRow[];
  usage_cost: readonly UsageCostRow[];
  context_economy: readonly ContextEconomyRow[];
  tool_economy: readonly ToolEconomyRow[];
}

export interface TelemetryProjectionOptions {
  limit?: number;
  max_series?: number;
}

/**
 * Deterministically rebuild metrics from ledger authority. A projection refuses
 * to silently truncate or create unbounded series.
 */
export function projectTelemetry(
  ledger: EvidenceLedger,
  campaignId: string,
  options: TelemetryProjectionOptions = {},
): TelemetryProjection {
  if (!campaignId.trim()) throw new AuditIntegrityError("telemetry projection requires a campaign");
  const integrity = ledger.verifyIntegrity();
  if (!integrity.valid) throw new AuditIntegrityError(`cannot project untrusted telemetry ledger: ${integrity.error}`);
  const limit = bounded(options.limit ?? 10_000, 1, 10_000, "telemetry projection limit");
  const maxSeries = bounded(options.max_series ?? 256, 1, 1_024, "telemetry projection max_series");
  const records = ledger.getRecords(campaignId).filter((record): record is TelemetryObservationRecord =>
    record.kind === "telemetry_observation");
  if (records.length > limit) throw new AuditIntegrityError(`telemetry projection has ${records.length} records; limit is ${limit}`);

  const counter = new Map<string, MutableCounter>();
  const histograms = new Map<string, MutableHistogram>();
  // Priced and unpriced usage series are tracked in separate maps — kept apart
  // by construction rather than by a runtime tag check on a shared value type
  // — so a priced row can never lose its amount and an unpriced row can never
  // acquire a fabricated one.
  const usagePriced = new Map<string, MutableUsagePriced>();
  const usageUnpriced = new Map<string, MutableUsageUnpriced>();
  const contextEconomy = new Map<string, MutableContextEconomy>();
  const toolEconomy = new Map<string, MutableToolEconomy>();
  const totals: MutableCampaignTotals = { calls: 0, input_tokens: 0, output_tokens: 0,
    cache_read_tokens: 0, cache_write_tokens: 0, priced: new Map<string, MutablePricedSubtotal>(),
    unpriced_calls: 0, unpriced_reasons: new Set<string>(), evidence: [] };
  for (const record of records) {
    const pointer = { record_id: record.id, content_hash: record.content_hash };
    const commonTags = { phase: record.observation.phase, outcome: record.observation.outcome };
    addCounter(counter, "arbor.phase.observations", record.campaign_id, record.node_id, commonTags, pointer);
    if (record.observation.type === "phase_timing") {
      const key = seriesKey("arbor.phase.duration_ms", commonTags, record.campaign_id, record.node_id);
      const row: MutableHistogram = histograms.get(key) ?? { name: "arbor.phase.duration_ms",
        campaign_id: record.campaign_id, node_id: record.node_id, tags: commonTags,
        count: 0, sum_ms: 0, max_ms: 0, buckets: Array(PHASE_DURATION_BUCKETS_MS.length + 1).fill(0), evidence: [] };
      row.count = safeAdd(row.count, 1);
      row.sum_ms = safeAdd(row.sum_ms, record.observation.duration_ms);
      row.max_ms = Math.max(row.max_ms, record.observation.duration_ms);
      for (let index = 0; index < PHASE_DURATION_BUCKETS_MS.length; index++) {
        if (record.observation.duration_ms <= PHASE_DURATION_BUCKETS_MS[index]) row.buckets[index] = safeAdd(row.buckets[index], 1);
      }
      row.buckets[PHASE_DURATION_BUCKETS_MS.length] = safeAdd(row.buckets[PHASE_DURATION_BUCKETS_MS.length], 1);
      row.evidence.push(pointer);
      histograms.set(key, row);
    } else if (record.observation.type === "usage_cost") {
      const cost = record.observation.cost;
      const { provider, model_family, phase } = record.observation;
      const agent = record.observation.agent_id?.trim() || "unattributed";
      const usageFields = {
        input_tokens: record.observation.input_tokens,
        output_tokens: record.observation.output_tokens,
        cache_read_tokens: record.observation.cache_read_tokens,
        cache_write_tokens: record.observation.cache_write_tokens,
      };
      if (cost.kind === "priced") {
        const tags = { provider, model_family, phase, agent, pricing: "priced" as const, currency: cost.currency, minor_unit_exponent: String(cost.minor_unit_exponent) };
        addCounter(counter, "arbor.provider.calls", record.campaign_id, record.node_id, tags, pointer);
        const key = seriesKey("arbor.provider.usage_cost", tags, record.campaign_id, record.node_id);
        const row: MutableUsagePriced = usagePriced.get(key) ?? { name: "arbor.provider.usage_cost",
          campaign_id: record.campaign_id, node_id: record.node_id, tags, calls: 0, input_tokens: 0,
          output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, cost_minor_units: 0,
          price_source_ids: new Set<string>(), evidence: [] };
        row.calls = safeAdd(row.calls, 1);
        row.input_tokens = safeAdd(row.input_tokens, usageFields.input_tokens);
        row.output_tokens = safeAdd(row.output_tokens, usageFields.output_tokens);
        row.cache_read_tokens = safeAdd(row.cache_read_tokens, usageFields.cache_read_tokens);
        row.cache_write_tokens = safeAdd(row.cache_write_tokens, usageFields.cache_write_tokens);
        row.cost_minor_units = safeAdd(row.cost_minor_units, cost.minor_units);
        row.price_source_ids.add(cost.price_source_id);
        row.evidence.push(pointer);
        usagePriced.set(key, row);
        foldPricedTotal(totals, cost.currency, cost.minor_unit_exponent, cost.minor_units, cost.price_source_id);
      } else {
        const tags = { provider, model_family, phase, agent, pricing: "unpriced" as const };
        addCounter(counter, "arbor.provider.calls", record.campaign_id, record.node_id, tags, pointer);
        const key = seriesKey("arbor.provider.usage_cost", tags, record.campaign_id, record.node_id);
        const row: MutableUsageUnpriced = usageUnpriced.get(key) ?? { name: "arbor.provider.usage_cost",
          campaign_id: record.campaign_id, node_id: record.node_id, tags, calls: 0, input_tokens: 0,
          output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0,
          unpriced_reasons: new Set<string>(), evidence: [] };
        row.calls = safeAdd(row.calls, 1);
        row.input_tokens = safeAdd(row.input_tokens, usageFields.input_tokens);
        row.output_tokens = safeAdd(row.output_tokens, usageFields.output_tokens);
        row.cache_read_tokens = safeAdd(row.cache_read_tokens, usageFields.cache_read_tokens);
        row.cache_write_tokens = safeAdd(row.cache_write_tokens, usageFields.cache_write_tokens);
        row.unpriced_reasons.add(cost.reason);
        row.evidence.push(pointer);
        usageUnpriced.set(key, row);
        totals.unpriced_calls = safeAdd(totals.unpriced_calls, 1);
        totals.unpriced_reasons.add(cost.reason);
      }
      totals.calls = safeAdd(totals.calls, 1);
      totals.input_tokens = safeAdd(totals.input_tokens, usageFields.input_tokens);
      totals.output_tokens = safeAdd(totals.output_tokens, usageFields.output_tokens);
      totals.cache_read_tokens = safeAdd(totals.cache_read_tokens, usageFields.cache_read_tokens);
      totals.cache_write_tokens = safeAdd(totals.cache_write_tokens, usageFields.cache_write_tokens);
      totals.evidence.push(pointer);
    } else if (record.observation.type === "context_economy") {
      const key = seriesKey("arbor.context.economy", commonTags, record.campaign_id, record.node_id);
      const row: MutableContextEconomy = contextEconomy.get(key) ?? {
        name: "arbor.context.economy", campaign_id: record.campaign_id, node_id: record.node_id,
        tags: commonTags, observations: 0, offered_tokens: 0, retained_tokens: 0, pruned_tokens: 0,
        indexed_reference_tokens: 0, stable_prefix_tokens: 0, dynamic_tokens: 0, evidence: [],
      };
      row.observations = safeAdd(row.observations, 1);
      row.offered_tokens = safeAdd(row.offered_tokens, record.observation.offered_tokens);
      row.retained_tokens = safeAdd(row.retained_tokens, record.observation.retained_tokens);
      row.pruned_tokens = safeAdd(row.pruned_tokens, record.observation.pruned_tokens);
      row.indexed_reference_tokens = safeAdd(row.indexed_reference_tokens, record.observation.indexed_reference_tokens);
      row.stable_prefix_tokens = safeAdd(row.stable_prefix_tokens, record.observation.stable_prefix_tokens);
      row.dynamic_tokens = safeAdd(row.dynamic_tokens, record.observation.dynamic_tokens);
      row.evidence.push(pointer);
      contextEconomy.set(key, row);
    } else if (record.observation.type === "tool_economy") {
      const key = seriesKey("arbor.tool.economy", commonTags, record.campaign_id, record.node_id);
      const row: MutableToolEconomy = toolEconomy.get(key) ?? {
        name: "arbor.tool.economy", campaign_id: record.campaign_id, node_id: record.node_id,
        tags: commonTags, observations: 0, offered_calls: 0, host_executions: 0, reused_reads: 0,
        avoided_output_bytes: 0, evidence: [],
      };
      row.observations = safeAdd(row.observations, 1);
      row.offered_calls = safeAdd(row.offered_calls, record.observation.offered_calls);
      row.host_executions = safeAdd(row.host_executions, record.observation.host_executions);
      row.reused_reads = safeAdd(row.reused_reads, record.observation.reused_reads);
      row.avoided_output_bytes = safeAdd(row.avoided_output_bytes, record.observation.avoided_output_bytes);
      row.evidence.push(pointer);
      toolEconomy.set(key, row);
    }
    if (counter.size + histograms.size + usagePriced.size + usageUnpriced.size + contextEconomy.size + toolEconomy.size > maxSeries) {
      throw new AuditIntegrityError(`telemetry projection exceeds ${maxSeries} metric series`);
    }
  }

  const byKey = <T extends { name: string; campaign_id: string; node_id: string; tags: Readonly<Record<string, string>> }>(left: T, right: T) =>
    compareCodeUnits(
      seriesKey(left.name, left.tags, left.campaign_id, left.node_id),
      seriesKey(right.name, right.tags, right.campaign_id, right.node_id),
    );
  return {
    campaign_id: campaignId,
    source_record_count: records.length,
    campaign_totals: cloneTotals(totals),
    counters: [...counter.values()].sort(byKey).map(cloneCounter),
    phase_histograms: [...histograms.values()].sort(byKey).map((row) => ({ ...row, tags: { ...row.tags },
      buckets: [...row.buckets], evidence: row.evidence.map((item) => ({ ...item })) })),
    usage_cost: [...usagePriced.values()].map(clonePricedUsage)
      .concat([...usageUnpriced.values()].map(cloneUnpricedUsage))
      .sort(byKey),
    context_economy: [...contextEconomy.values()].sort(byKey).map(cloneEconomy),
    tool_economy: [...toolEconomy.values()].sort(byKey).map(cloneEconomy),
  };
}

interface MutableCounter extends MetricCounterRow { evidence: MetricEvidencePointer[] }
interface MutableHistogram extends Omit<PhaseHistogramRow, "buckets" | "evidence"> { buckets: number[]; evidence: MetricEvidencePointer[] }
interface MutableUsagePriced extends UsageCostRowBase {
  tags: Readonly<{ provider: string; model_family: string; phase: string; agent: string; pricing: "priced"; currency: string; minor_unit_exponent: string }>;
  cost_minor_units: number;
  price_source_ids: Set<string>;
  evidence: MetricEvidencePointer[];
}
interface MutableUsageUnpriced extends UsageCostRowBase {
  tags: Readonly<{ provider: string; model_family: string; phase: string; agent: string; pricing: "unpriced" }>;
  unpriced_reasons: Set<string>;
  evidence: MetricEvidencePointer[];
}
interface MutableContextEconomy extends ContextEconomyRow { evidence: MetricEvidencePointer[] }
interface MutableToolEconomy extends ToolEconomyRow { evidence: MetricEvidencePointer[] }
interface MutablePricedSubtotal { currency: string; minor_unit_exponent: number; cost_minor_units: number; price_source_ids: Set<string> }
interface MutableCampaignTotals {
  calls: number; input_tokens: number; output_tokens: number; cache_read_tokens: number; cache_write_tokens: number;
  priced: Map<string, MutablePricedSubtotal>;
  unpriced_calls: number; unpriced_reasons: Set<string>;
  evidence: MetricEvidencePointer[];
}

function foldPricedTotal(totals: MutableCampaignTotals, currency: string, exponent: number, minorUnits: number, priceSourceId: string): void {
  const key = `${currency}${exponent}`;
  const subtotal: MutablePricedSubtotal = totals.priced.get(key) ?? { currency, minor_unit_exponent: exponent,
    cost_minor_units: 0, price_source_ids: new Set<string>() };
  subtotal.cost_minor_units = safeAdd(subtotal.cost_minor_units, minorUnits);
  subtotal.price_source_ids.add(priceSourceId);
  totals.priced.set(key, subtotal);
}

function cloneTotals(totals: MutableCampaignTotals): CampaignTotals {
  if (totals.calls === 0) return { state: "unavailable", reason: "no provider usage-cost series is projected" };
  const priced: CampaignPricedSubtotal[] = [...totals.priced.values()]
    .map((subtotal) => ({ currency: subtotal.currency, minor_unit_exponent: subtotal.minor_unit_exponent,
      cost_minor_units: subtotal.cost_minor_units, price_source_ids: [...subtotal.price_source_ids].sort() }))
    .sort((left, right) => compareCodeUnits(`${left.currency}${left.minor_unit_exponent}`, `${right.currency}${right.minor_unit_exponent}`));
  return {
    state: "observed",
    calls: totals.calls,
    input_tokens: totals.input_tokens,
    output_tokens: totals.output_tokens,
    cache_read_tokens: totals.cache_read_tokens,
    cache_write_tokens: totals.cache_write_tokens,
    priced,
    unpriced_calls: totals.unpriced_calls,
    unpriced_reasons: [...totals.unpriced_reasons].sort(),
    evidence: totals.evidence.map((item) => ({ ...item })),
  };
}

function addCounter(rows: Map<string, MutableCounter>, name: MetricCounterRow["name"], campaignId: string,
  nodeId: string, tags: Record<string, string>, pointer: MetricEvidencePointer): void {
  const key = seriesKey(name, tags, campaignId, nodeId);
  const row = rows.get(key) ?? { name, campaign_id: campaignId, node_id: nodeId, tags, value: 0, evidence: [] };
  row.value = safeAdd(row.value, 1);
  row.evidence.push(pointer);
  rows.set(key, row);
}

function cloneCounter(row: MutableCounter): MetricCounterRow {
  return { ...row, tags: { ...row.tags }, evidence: row.evidence.map((item) => ({ ...item })) };
}

function clonePricedUsage(row: MutableUsagePriced): UsageCostRow {
  return { ...row, tags: { ...row.tags }, price_source_ids: [...row.price_source_ids].sort(),
    evidence: row.evidence.map((item) => ({ ...item })) };
}

function cloneUnpricedUsage(row: MutableUsageUnpriced): UsageCostRow {
  return { ...row, tags: { ...row.tags }, unpriced_reasons: [...row.unpriced_reasons].sort(),
    evidence: row.evidence.map((item) => ({ ...item })) };
}

function cloneEconomy<T extends ContextEconomyRow | ToolEconomyRow>(row: T): T {
  return { ...row, tags: { ...row.tags }, evidence: row.evidence.map((item) => ({ ...item })) };
}

function seriesKey(name: string, tags: Readonly<Record<string, string>>, campaignId = "", nodeId = ""): string {
  return `${name}|campaign=${campaignId}|node=${nodeId}|${Object.entries(tags).sort(([left], [right]) => compareCodeUnits(left, right))
    .map(([key, value]) => `${key}=${value}`).join("|")}`;
}

function bounded(value: number, minimum: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new AuditIntegrityError(`${label} must be from ${minimum} to ${maximum}`);
  }
  return value;
}

function safeAdd(left: number, right: number): number {
  const total = left + right;
  if (!Number.isSafeInteger(total)) throw new AuditIntegrityError("telemetry aggregate exceeds safe integer range");
  return total;
}
