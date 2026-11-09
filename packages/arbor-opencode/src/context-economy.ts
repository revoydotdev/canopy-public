import type { ContextEconomyObservation } from "@arbor/audit";
import type { ExecutorContextComposition } from "./loop.js";

/**
 * Pure translation from an executor's privacy-safe context-composition
 * counts into a durable ledger observation. Mirrors `buildNodeCostAttribution`
 * in cost-attribution.ts: token counts only, never raw prompt text.
 */
export function buildContextEconomyObservation(input: {
  readonly identity: Omit<ContextEconomyObservation, "type" | "offered_tokens" | "retained_tokens" | "pruned_tokens" | "indexed_reference_tokens" | "stable_prefix_tokens" | "dynamic_tokens" | "per_source">;
  readonly composition: ExecutorContextComposition;
}): ContextEconomyObservation {
  return Object.freeze({
    ...input.identity,
    type: "context_economy",
    offered_tokens: input.composition.offered_tokens,
    retained_tokens: input.composition.retained_tokens,
    pruned_tokens: input.composition.pruned_tokens,
    indexed_reference_tokens: input.composition.indexed_reference_tokens,
    stable_prefix_tokens: input.composition.stable_prefix_tokens,
    dynamic_tokens: input.composition.dynamic_tokens,
    per_source: input.composition.per_source.map((row) => Object.freeze({ ...row })),
  } as const);
}
