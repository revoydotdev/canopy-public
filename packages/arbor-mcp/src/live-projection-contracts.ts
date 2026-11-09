import type { ForegroundProjection, NodeCard } from "@arbor/core";
import type { A2AAgentCard } from "./a2a-contracts.js";

/** Read-only envelopes backed by the canonical live campaign snapshot. */
export type LiveProjectionQuery =
  | { kind: "foreground.derive"; campaign_id: string; node_id: string }
  | { kind: "nodecard.resolve"; campaign_id: string; node_id: string }
  | { kind: "a2a.cards"; campaign_id: string };

export interface LiveProjectionQueryEnvelope {
  schema_version: 1;
  query_id: string;
  query: LiveProjectionQuery;
}

export type NodeCardProjection = { campaign_id: string; node_id: string; card: NodeCard };
export type ForegroundProjectionResult = { campaign_id: string; node_id: string; foreground: ForegroundProjection };
export type A2ACardsProjection = { campaign_id: string; cards: readonly (A2AAgentCard & { readonly wire: import("./a2a-wire.js").WireAgentCard })[] };

export function isLiveProjectionQueryEnvelope(value: unknown): value is LiveProjectionQueryEnvelope {
  if (!record(value) || !record(value.query)) return false;
  return value.query.kind === "foreground.derive" || value.query.kind === "nodecard.resolve" || value.query.kind === "a2a.cards";
}

export function validateLiveProjectionQuery(envelope: LiveProjectionQueryEnvelope): string[] {
  const failures: string[] = [];
  if (envelope.schema_version !== 1) failures.push("schema_version must be 1");
  if (!text(envelope.query_id)) failures.push("query_id must be non-empty");
  if (!text(envelope.query.campaign_id)) failures.push("campaign_id must be non-empty");
  if (envelope.query.kind !== "a2a.cards" && !text(envelope.query.node_id)) failures.push("node_id must be non-empty");
  return failures;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function text(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
