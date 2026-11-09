import type { OperationRecord } from "@arbor/core";

/**
 * `operation.list` — the enumeration query the `operations` TUI screen needs
 * and the catalog previously lacked (see runtime-catalog.ts's RUNTIME_CATALOG
 * entry and tui.ts's refreshScreenData for the history: `operation.get` and
 * `output.descriptor` each require a specific id, and nothing could enumerate
 * one to select from). Backed by the real
 * `packages/arbor-core/src/operation-registry.ts`'s `OperationRegistry.list`
 * — its only enumeration surface — never a synthesized or fabricated shape.
 *
 * Follows the same minimal per-kind contracts shape as `config-contracts.ts`/
 * `agent-contracts.ts`/`job-contracts.ts` (query-only, no command side).
 */
export interface OperationListQueryEnvelope {
  schema_version: 1;
  query_id: string;
  query: { kind: "operation.list"; include_terminal?: boolean };
}

/**
 * `OperationRegistry.list(includeTerminal)` is already bounded by the
 * registry's own `terminal_retention` (default 100) — this projection adds no
 * separate limit/cursor of its own, the same precedent `job.list` sets for a
 * bounded live-registry enumeration.
 */
export type OperationListProjection = readonly OperationRecord[];

export function isOperationListQueryEnvelope(value: unknown): value is OperationListQueryEnvelope {
  return object(value) && object(value.query) && value.query.kind === "operation.list";
}

export function validateOperationListQuery(value: OperationListQueryEnvelope): string[] {
  const failures: string[] = [];
  if (value.schema_version !== 1) failures.push("schema_version must be 1");
  if (!text(value.query_id)) failures.push("query_id must be non-empty");
  if (value.query.include_terminal !== undefined && typeof value.query.include_terminal !== "boolean") failures.push("query.include_terminal must be a boolean");
  return failures;
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function text(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
