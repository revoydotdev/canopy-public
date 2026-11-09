import { clipDisplay, displayWidth } from "./widgets.js";
import type {
  ContextEconomyRow,
  MetricCounterRow,
  MetricEvidencePointer,
  PhaseHistogramRow,
  TelemetrySnapshot,
  ToolEconomyRow,
  UsageCostRow,
} from "./telemetry-types.js";

export const PHASE_DURATION_BUCKETS_MS = [10, 50, 100, 500, 1_000, 5_000, 30_000, 120_000] as const;

/**
 * Format exact minor-unit cost into a display string.
 * Example: `formatCost(1234, 2, "USD")` → `"12.34 USD"`
 * No floating-point arithmetic — pure string formatting over safe integers.
 */
export function formatCost(minorUnits: number, exponent: number, currency: string): string {
  if (!Number.isSafeInteger(minorUnits)) throw new Error("cost_minor_units must be a safe integer");
  if (!Number.isSafeInteger(exponent) || exponent < 0) throw new Error("minor_unit_exponent must be a non-negative safe integer");
  if (!currency.trim()) throw new Error("currency must be non-empty");
  const whole = String(minorUnits);
  if (exponent === 0) return `${whole} ${currency}`;
  const pad = whole.padStart(exponent + 1, "0");
  const intPart = pad.slice(0, -exponent) || "0";
  const fracPart = pad.slice(-exponent);
  return `${intPart}.${fracPart} ${currency}`;
}

function padRight(value: string, width: number): string {
  return value + " ".repeat(Math.max(0, width - displayWidth(value)));
}

// ── Phase histogram ──────────────────────────────────────────────────────────

const HISTOGRAM_BUCKET_LABELS: readonly string[] = (() => {
  const labels = PHASE_DURATION_BUCKETS_MS.map((ms) =>
    ms < 1_000 ? `≤${ms}` : `≤${ms / 1_000}s`,
  );
  labels.push(">120s");
  return labels;
})();

export interface TelemetryRenderOptions {
  readonly width: number;
  readonly height: number;
}

// ── Operator evaluation / proof summary ────────────────────────────────────

/**
 * A bounded, read-only evaluation fact. `unavailable` is a first-class
 * result: telemetry has no terminal campaign, recovery, intervention, or
 * expected-evidence-set series, so a zero or pass there would be fabricated.
 */
export type EvaluationProofMetric =
  | { readonly state: "observed"; readonly label: string; readonly detail: string; readonly evidence_records: number }
  | { readonly state: "unavailable"; readonly label: string; readonly reason: string };

export interface EvaluationProofProjection {
  readonly completion: EvaluationProofMetric;
  readonly recovery: EvaluationProofMetric;
  readonly evidence_completeness: EvaluationProofMetric;
  readonly interventions: EvaluationProofMetric;
  readonly latency: EvaluationProofMetric;
  readonly cost: EvaluationProofMetric;
}

const unavailable = (label: string, reason: string): EvaluationProofMetric => ({ state: "unavailable", label, reason });

function uniqueEvidenceCount(snapshot: TelemetrySnapshot): number {
  const pointers = [
    ...snapshot.counters.flatMap((row) => row.evidence),
    ...snapshot.phase_histograms.flatMap((row) => row.evidence),
    ...snapshot.usage_cost.flatMap((row) => row.evidence),
    ...snapshot.context_economy.flatMap((row) => row.evidence),
    ...snapshot.tool_economy.flatMap((row) => row.evidence),
  ];
  return new Set(pointers.map((pointer) => `${pointer.record_id}\u0000${pointer.content_hash}`)).size;
}

// ── Token/tool economy ─────────────────────────────────────────────────────

/** Render context selection facts without exposing prompt content. */
export function renderContextEconomy(rows: readonly ContextEconomyRow[], options: TelemetryRenderOptions): string[] {
  if (!Number.isSafeInteger(options.width) || options.width < 1) throw new Error("width must be a positive safe integer");
  if (!Number.isSafeInteger(options.height) || options.height < 1) throw new Error("height must be a positive safe integer");
  const widths = [10, 12, 12, 12, 12, 12, 12];
  const labels = ["phase", "kept/offered", "pruned", "stable", "dynamic", "indexed", "observations"];
  const result = [clipDisplay(labels.map((label, index) => padRight(label, widths[index]!)).join(""), options.width)];
  for (const row of rows.slice(0, Math.max(0, options.height - 1))) {
    const values = [row.tags.phase, `${row.retained_tokens}/${row.offered_tokens}`, String(row.pruned_tokens),
      String(row.stable_prefix_tokens), String(row.dynamic_tokens), String(row.indexed_reference_tokens), String(row.observations)];
    result.push(clipDisplay(values.map((value, index) => padRight(clipDisplay(value, widths[index]! - 1), widths[index]!)).join(""), options.width));
  }
  return result;
}

/** Render suppressed/reused native tool work and avoided output volume. */
export function renderToolEconomy(rows: readonly ToolEconomyRow[], options: TelemetryRenderOptions): string[] {
  if (!Number.isSafeInteger(options.width) || options.width < 1) throw new Error("width must be a positive safe integer");
  if (!Number.isSafeInteger(options.height) || options.height < 1) throw new Error("height must be a positive safe integer");
  const widths = [10, 12, 12, 12, 16, 12];
  const labels = ["phase", "offered", "executed", "reused", "avoided_bytes", "observations"];
  const result = [clipDisplay(labels.map((label, index) => padRight(label, widths[index]!)).join(""), options.width)];
  for (const row of rows.slice(0, Math.max(0, options.height - 1))) {
    const values = [row.tags.phase, String(row.offered_calls), String(row.host_executions), String(row.reused_reads),
      String(row.avoided_output_bytes), String(row.observations)];
    result.push(clipDisplay(values.map((value, index) => padRight(clipDisplay(value, widths[index]! - 1), widths[index]!)).join(""), options.width));
  }
  return result;
}

/**
 * Derive only facts the injected, ledger-derived snapshot proves. Completion,
 * recovery, intervention, and evidence completeness need separate canonical
 * projections and are explicitly unavailable until those ports exist.
 */
export function deriveEvaluationProof(snapshot: TelemetrySnapshot): EvaluationProofProjection {
  const evidence = uniqueEvidenceCount(snapshot);
  return {
    completion: unavailable("Completion", "no terminal campaign-outcome series is projected"),
    recovery: unavailable("Recovery", "no recovery-decision series is projected"),
    evidence_completeness: unavailable("Evidence completeness", `no expected evidence set is projected (${evidence} referenced ledger record${evidence === 1 ? "" : "s"})`),
    interventions: unavailable("Interventions", "no operator-intervention series is projected"),
    latency: deriveLatencyProof(snapshot),
    cost: deriveCostProof(snapshot),
  };
}

function deriveLatencyProof(snapshot: TelemetrySnapshot): EvaluationProofMetric {
  if (snapshot.phase_histograms.length === 0) return unavailable("Phase latency", "no phase-timing series is projected");
  let count = 0;
  let duration = 0;
  let max = 0;
  const evidence = new Set<string>();
  for (const row of snapshot.phase_histograms) {
    if (!Number.isSafeInteger(row.count) || !Number.isSafeInteger(row.sum_ms) || !Number.isSafeInteger(row.max_ms)
      || !Number.isSafeInteger(count + row.count) || !Number.isSafeInteger(duration + row.sum_ms)) {
      return unavailable("Phase latency", "phase-timing aggregate exceeds safe integer range");
    }
    count += row.count;
    duration += row.sum_ms;
    max = Math.max(max, row.max_ms);
    for (const pointer of row.evidence) evidence.add(`${pointer.record_id}\u0000${pointer.content_hash}`);
  }
  if (count === 0) return unavailable("Phase latency", "phase-timing rows contain no observations");
  return {
    state: "observed",
    label: "Phase latency",
    detail: `${duration} ms across ${count} observations; mean ${Math.round(duration / count)} ms (rounded); max ${max} ms`,
    evidence_records: evidence.size,
  };
}

function deriveCostProof(snapshot: TelemetrySnapshot): EvaluationProofMetric {
  if (snapshot.usage_cost.length === 0) return unavailable("Cost", "no provider usage-cost series is projected");
  const subtotals = new Map<string, { minor_units: number; exponent: number; currency: string }>();
  let unpriced = 0;
  const evidence = new Set<string>();
  for (const row of snapshot.usage_cost) {
    for (const pointer of row.evidence) evidence.add(`${pointer.record_id}\u0000${pointer.content_hash}`);
    if (!("cost_minor_units" in row)) { unpriced += 1; continue; }
    const exponent = Number.parseInt(row.tags.minor_unit_exponent, 10);
    const key = `${row.tags.currency}\u0000${exponent}`;
    const current = subtotals.get(key) ?? { minor_units: 0, exponent, currency: row.tags.currency };
    if (!Number.isSafeInteger(current.minor_units + row.cost_minor_units)) {
      return unavailable("Cost", "priced cost aggregate exceeds safe integer range");
    }
    subtotals.set(key, { ...current, minor_units: current.minor_units + row.cost_minor_units });
  }
  if (subtotals.size === 0) return unavailable("Cost", `${unpriced} unpriced usage series; no priced cost is recorded`);
  const formatted = [...subtotals.values()].map((subtotal) => formatCost(subtotal.minor_units, subtotal.exponent, subtotal.currency)).sort();
  return {
    state: "observed",
    label: "Cost",
    detail: `priced subtotal${formatted.length === 1 ? "" : "s"}: ${formatted.join(", ")}${unpriced === 0 ? "" : `; ${unpriced} unpriced usage series — total cost unavailable`}`,
    evidence_records: evidence.size,
  };
}

/** Render the data-backed evaluation/proof summary before lower-level series. */
export function renderEvaluationProof(proof: EvaluationProofProjection, options: TelemetryRenderOptions): string[] {
  if (!Number.isSafeInteger(options.width) || options.width < 1) throw new Error("width must be a positive safe integer");
  if (!Number.isSafeInteger(options.height) || options.height < 1) throw new Error("height must be a positive safe integer");
  const metrics = [proof.completion, proof.recovery, proof.evidence_completeness, proof.interventions, proof.latency, proof.cost];
  const lines = [clipDisplay("─ Evaluation & proof ─", options.width)];
  for (const metric of metrics.slice(0, Math.max(0, options.height - 1))) {
    const value = metric.state === "observed"
      ? `${metric.detail} · evidence ${metric.evidence_records}`
      : `unavailable — ${metric.reason}`;
    lines.push(clipDisplay(`${metric.label}: ${value}`, options.width));
  }
  return lines;
}

/**
 * Render phase histogram as a bounded table.
 * Header: phase | outcome | count | avg_ms | max_ms | <bucket_labels...>
 */
export function renderTelemetryPhaseHistogram(
  rows: readonly PhaseHistogramRow[],
  options: TelemetryRenderOptions,
): string[] {
  if (!Number.isSafeInteger(options.width) || options.width < 1) throw new Error("width must be a positive safe integer");
  if (!Number.isSafeInteger(options.height) || options.height < 1) throw new Error("height must be a positive safe integer");

  const result: string[] = [];
  const fixedWidth = 10 + 10 + 10 + 10 + 10;
  const maxWidth = options.width;
  const bucketColWidth = Math.max(5, Math.floor((maxWidth - fixedWidth) / HISTOGRAM_BUCKET_LABELS.length));

  // Header
  const headerParts = [
    padRight("phase", 10),
    padRight("outcome", 10),
    padRight("count", 10),
    padRight("avg_ms", 10),
    padRight("max_ms", 10),
    ...HISTOGRAM_BUCKET_LABELS.map((label) => padRight(label, bucketColWidth)),
  ];
  result.push(clipDisplay(headerParts.join(""), maxWidth));

  // Data rows
  const count = Math.min(rows.length, Math.max(0, options.height - 1));
  for (let i = 0; i < count; i++) {
    const row = rows[i];
    const avg = row.count > 0 ? Math.round(row.sum_ms / row.count) : 0;
    const parts = [
      padRight(clipDisplay(row.tags.phase, 9), 10),
      padRight(clipDisplay(row.tags.outcome, 9), 10),
      padRight(String(row.count), 10),
      padRight(String(avg), 10),
      padRight(String(row.max_ms), 10),
      ...row.buckets.map((value) => padRight(String(value), bucketColWidth)),
    ];
    result.push(clipDisplay(parts.join(""), maxWidth));
  }
  return result;
}

// ── Usage cost ───────────────────────────────────────────────────────────────

/**
 * Render provider usage cost table.
 * Header includes phase/agent attribution and provider cache-read efficiency.
 */
export function renderTelemetryUsageCost(
  rows: readonly UsageCostRow[],
  options: TelemetryRenderOptions,
): string[] {
  if (!Number.isSafeInteger(options.width) || options.width < 1) throw new Error("width must be a positive safe integer");
  if (!Number.isSafeInteger(options.height) || options.height < 1) throw new Error("height must be a positive safe integer");

  const result: string[] = [];
  // Dynamic column widths based on available space
  const colCount = 11;
  const minPerCol = 9;
  const maxWidth = options.width;
  const colWidth = Math.max(minPerCol, Math.floor(maxWidth / colCount));

  const headerParts = [
    padRight("provider", colWidth),
    padRight("model", colWidth),
    padRight("phase", colWidth),
    padRight("agent", colWidth),
    padRight("calls", colWidth),
    padRight("input_tok", colWidth),
    padRight("output_tok", colWidth),
    padRight("cache_read", colWidth),
    padRight("cache_write", colWidth),
    padRight("cache_%", colWidth),
    padRight("cost", colWidth),
  ];
  result.push(clipDisplay(headerParts.join(""), maxWidth));

  const count = Math.min(rows.length, Math.max(0, options.height - 1));
  for (let i = 0; i < count; i++) {
    const row = rows[i];
    const costDisplay = "cost_minor_units" in row
      ? formatCost(row.cost_minor_units, parseInt(row.tags.minor_unit_exponent, 10), row.tags.currency)
      : "unpriced";
    const cacheEligible = row.input_tokens + row.cache_read_tokens;
    const cacheRatio = Number.isSafeInteger(cacheEligible) && cacheEligible > 0
      ? `${Math.round((row.cache_read_tokens / cacheEligible) * 100)}%`
      : "—";
    const parts = [
      padRight(clipDisplay(row.tags.provider, colWidth - 1), colWidth),
      padRight(clipDisplay(row.tags.model_family, colWidth - 1), colWidth),
      padRight(clipDisplay(row.tags.phase, colWidth - 1), colWidth),
      padRight(clipDisplay(row.tags.agent, colWidth - 1), colWidth),
      padRight(String(row.calls), colWidth),
      padRight(String(row.input_tokens), colWidth),
      padRight(String(row.output_tokens), colWidth),
      padRight(String(row.cache_read_tokens), colWidth),
      padRight(String(row.cache_write_tokens), colWidth),
      padRight(cacheRatio, colWidth),
      padRight(clipDisplay(costDisplay, colWidth - 1), colWidth),
    ];
    result.push(clipDisplay(parts.join(""), maxWidth));
  }
  return result;
}

// ── Counters ─────────────────────────────────────────────────────────────────

/**
 * Render counter rows as a bounded list.
 */
export function renderTelemetryCounters(
  rows: readonly MetricCounterRow[],
  options: TelemetryRenderOptions,
): string[] {
  if (!Number.isSafeInteger(options.width) || options.width < 1) throw new Error("width must be a positive safe integer");
  if (!Number.isSafeInteger(options.height) || options.height < 1) throw new Error("height must be a positive safe integer");

  const result: string[] = [];
  result.push(clipDisplay(padRight("name", 30) + padRight("value", 10) + "tags", options.width));

  const count = Math.min(rows.length, Math.max(0, options.height - 1));
  for (let i = 0; i < count; i++) {
    const row = rows[i];
    const tagsStr = Object.entries(row.tags)
      .map(([k, v]) => `${k}=${v}`)
      .join(" ");
    result.push(
      clipDisplay(
        padRight(clipDisplay(row.name, 29), 30) +
          padRight(String(row.value), 10) +
          tagsStr,
        options.width,
      ),
    );
  }
  return result;
}

// ── Evidence ─────────────────────────────────────────────────────────────────

/**
 * Render evidence pointers as a bounded list.
 */
export function renderTelemetryEvidence(
  evidence: readonly MetricEvidencePointer[],
  options: TelemetryRenderOptions,
): string[] {
  if (!Number.isSafeInteger(options.width) || options.width < 1) throw new Error("width must be a positive safe integer");
  if (!Number.isSafeInteger(options.height) || options.height < 1) throw new Error("height must be a positive safe integer");

  const result: string[] = [];
  result.push(clipDisplay("evidence pointers", options.width));

  const count = Math.min(evidence.length, Math.max(0, options.height - 1));
  for (let i = 0; i < count; i++) {
    const ptr = evidence[i];
    result.push(
      clipDisplay(`  ${ptr.record_id}  hash=${ptr.content_hash}`, options.width),
    );
  }
  return result;
}

// ── Composite view ───────────────────────────────────────────────────────────

/**
 * Composite telemetry view: header, counters, phase histogram, usage cost,
 * and evidence — all bounded by terminal dimensions.
 */
export function renderTelemetryView(
  snapshot: TelemetrySnapshot,
  options: TelemetryRenderOptions,
): string[] {
  if (!Number.isSafeInteger(options.width) || options.width < 1) throw new Error("width must be a positive safe integer");
  if (!Number.isSafeInteger(options.height) || options.height < 1) throw new Error("height must be a positive safe integer");

  const result: string[] = [];
  const remaining = () => Math.max(0, options.height - result.length);
  if (remaining() <= 0) return result;

  // Header
  result.push(
    clipDisplay(
      `Telemetry: campaign=${snapshot.campaign_id}  records=${snapshot.source_record_count}  series=${snapshot.counters.length + snapshot.phase_histograms.length + snapshot.usage_cost.length + snapshot.context_economy.length + snapshot.tool_economy.length}`,
      options.width,
    ),
  );
  if (remaining() <= 0) return result;

  // Put the proof summary before individual metric tables: it distinguishes
  // what this projection proves from evaluation facts it does not contain,
  // without introducing a second telemetry authority.
  result.push(...renderEvaluationProof(deriveEvaluationProof(snapshot), { width: options.width, height: remaining() }));
  if (remaining() <= 0) return result;

  if (snapshot.context_economy.length > 0 && remaining() > 1) {
    result.push(clipDisplay("─ Context economy (tokens) ─", options.width));
    result.push(...renderContextEconomy(snapshot.context_economy, { width: options.width, height: remaining() }));
  }
  if (remaining() <= 0) return result;

  if (snapshot.tool_economy.length > 0 && remaining() > 1) {
    result.push(clipDisplay("─ Tool economy ─", options.width));
    result.push(...renderToolEconomy(snapshot.tool_economy, { width: options.width, height: remaining() }));
  }
  if (remaining() <= 0) return result;

  // Phase histogram
  if (snapshot.phase_histograms.length > 0 && remaining() > 1) {
    result.push(clipDisplay("─ Phase durations ─", options.width));
    const section = renderTelemetryPhaseHistogram(snapshot.phase_histograms, {
      width: options.width,
      height: remaining(),
    });
    result.push(...section);
  }
  if (remaining() <= 0) return result;

  // Usage cost
  if (snapshot.usage_cost.length > 0 && remaining() > 1) {
    result.push(clipDisplay("─ Provider usage & cost ─", options.width));
    const section = renderTelemetryUsageCost(snapshot.usage_cost, {
      width: options.width,
      height: remaining(),
    });
    result.push(...section);
  }
  if (remaining() <= 0) return result;

  // Counters
  if (snapshot.counters.length > 0 && remaining() > 1) {
    result.push(clipDisplay("─ Counters ─", options.width));
    const section = renderTelemetryCounters(snapshot.counters, {
      width: options.width,
      height: remaining(),
    });
    result.push(...section);
  }
  if (remaining() <= 0) return result;

  // Evidence pointers make the otherwise-derived metric rows traceable back
  // to their immutable ledger records.  They are bounded by the same viewport
  // and deliberately do not dereference any raw evidence in the TUI.
  const evidence = [
    ...snapshot.phase_histograms.flatMap((row) => row.evidence),
    ...snapshot.usage_cost.flatMap((row) => row.evidence),
    ...snapshot.context_economy.flatMap((row) => row.evidence),
    ...snapshot.tool_economy.flatMap((row) => row.evidence),
    ...snapshot.counters.flatMap((row) => row.evidence),
  ];
  if (evidence.length > 0 && remaining() > 1) {
    result.push(clipDisplay("─ Evidence pointers ─", options.width));
    result.push(...renderTelemetryEvidence(evidence, { width: options.width, height: remaining() }));
  }

  return result;
}
