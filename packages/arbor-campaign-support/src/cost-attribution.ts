import type { NodeCostAttributionObservation, NodeCostSpan } from "@arbor/audit";
import type { Cost, TokenUsageResult } from "@arbor/core";

export interface AttributableCall {
  readonly span_id: string;
  readonly kind: NodeCostSpan["kind"];
  readonly usage: TokenUsageResult;
  readonly cost: Cost;
}

export function buildNodeCostAttribution(input: {
  readonly identity: Omit<NodeCostAttributionObservation, "type" | "total_cost" | "total_tokens" | "top_cost_spans" | "redundant_tool_calls" | "produced_verified_progress" | "pruning_signal">;
  readonly calls: readonly AttributableCall[];
  readonly tool_call_signatures: readonly string[];
  readonly produced_verified_progress: boolean;
  readonly expensive_threshold_minor_units?: number;
}): NodeCostAttributionObservation {
  const spans = input.calls.flatMap((call): NodeCostSpan[] => "kind" in call.usage ? [] : [{
    span_id: call.span_id, kind: call.kind, input_tokens: call.usage.input_tokens,
    output_tokens: call.usage.output_tokens, cache_read_tokens: call.usage.cached_input_tokens,
    cache_write_tokens: call.usage.cache_write_input_tokens, cost: call.cost,
  }]);
  const totalCost = addCosts(spans.map((span) => span.cost));
  const threshold = input.expensive_threshold_minor_units;
  const expensive = threshold !== undefined && totalCost.kind === "priced" && totalCost.minor_units >= threshold;
  return Object.freeze({ ...input.identity, type: "node_cost_attribution", total_cost: totalCost,
    total_tokens: Object.freeze({ input: sum(spans, "input_tokens"), output: sum(spans, "output_tokens"), cache_read: sum(spans, "cache_read_tokens"), cache_write: sum(spans, "cache_write_tokens") }),
    top_cost_spans: Object.freeze([...spans].sort(compareSpanCost).slice(0, 10).map((span) => Object.freeze(span))),
    redundant_tool_calls: Object.freeze(detectRedundantToolCalls(input.tool_call_signatures)),
    produced_verified_progress: input.produced_verified_progress,
    pruning_signal: expensive && !input.produced_verified_progress ? "expensive_unproductive" : "retain" } as const);
}

/** Heuristic only: normalized edit similarity >= .8 groups repeated calls. */
export function detectRedundantToolCalls(signatures: readonly string[]): readonly { normalized_signature: string; count: number }[] {
  const clusters: { normalized_signature: string; members: string[] }[] = [];
  for (const raw of signatures) {
    const signature = normalize(raw);
    const cluster = clusters.find((candidate) => similarity(candidate.normalized_signature, signature) >= 0.8);
    if (cluster) cluster.members.push(signature); else clusters.push({ normalized_signature: signature, members: [signature] });
  }
  return clusters.filter((cluster) => cluster.members.length >= 2).map((cluster) => Object.freeze({ normalized_signature: cluster.normalized_signature, count: cluster.members.length }));
}

function addCosts(costs: readonly Cost[]): Cost {
  if (costs.length === 0) return { kind: "unpriced", reason: "node has no attributable priced calls" };
  const first = costs[0]!;
  if (first.kind !== "priced" || !costs.every((cost) => cost.kind === "priced" && cost.currency === first.currency && cost.minor_unit_exponent === first.minor_unit_exponent && cost.price_source_id === first.price_source_id)) return { kind: "unpriced", reason: "node calls do not share one attributable configured price schedule" };
  const total = costs.reduce((value, cost) => value + (cost.kind === "priced" ? cost.minor_units : 0), 0);
  return Number.isSafeInteger(total) ? { ...first, minor_units: total } : { kind: "unpriced", reason: "node cost exceeds safe integer range" };
}
function sum(spans: readonly NodeCostSpan[], field: "input_tokens" | "output_tokens" | "cache_read_tokens" | "cache_write_tokens"): number { return spans.reduce((value, span) => value + span[field], 0); }
function compareSpanCost(left: NodeCostSpan, right: NodeCostSpan): number {
  if (left.cost.kind === "priced" && right.cost.kind === "priced") return right.cost.minor_units - left.cost.minor_units || left.span_id.localeCompare(right.span_id);
  return left.cost.kind === "priced" ? -1 : right.cost.kind === "priced" ? 1 : left.span_id.localeCompare(right.span_id);
}
function normalize(value: string): string { return value.trim().toLowerCase().replace(/\s+/g, " "); }
function similarity(left: string, right: string): number {
  const longest = Math.max(left.length, right.length); if (longest === 0) return 1;
  const row = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i++) { let diagonal = row[0]!; row[0] = i; for (let j = 1; j <= right.length; j++) { const prior = row[j]!; row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, diagonal + (left[i - 1] === right[j - 1] ? 0 : 1)); diagonal = prior; } }
  return 1 - row[right.length]! / longest;
}
