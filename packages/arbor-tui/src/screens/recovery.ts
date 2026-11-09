/**
 * Recovery screen: a bounded projection of durable interrupted/crashed nodes.
 * It deliberately owns no recovery logic; retry and abandonment are canonical
 * runtime commands issued by update.ts through the injected RuntimePort.
 */
import { clipDisplay, wrapDisplay } from "../widgets.js";
import type { RowIdentity, ScreenId, ScreenModule, ScreenProjection } from "./screen.js";
import { buildScreenPipeline, defineVariant } from "./registry.js";

const MAX_ROWS = 200;

type PendingShape = { campaign_id: string; nodes: readonly Record<string, unknown>[] };

function isPendingShape(value: unknown): value is PendingShape {
  return typeof value === "object" && value !== null
    && typeof (value as { campaign_id?: unknown }).campaign_id === "string"
    && Array.isArray((value as { nodes?: unknown }).nodes);
}

function projectPending(shape: PendingShape, input: { readonly granted_capabilities?: ReadonlySet<string> }): Omit<ScreenProjection, "variant"> {
  const nodes = shape.nodes.slice(0, MAX_ROWS);
  const capabilities = input.granted_capabilities ?? new Set<string>();
  return {
    screen: "recovery",
    rows: nodes.map((node) => ({
      id: typeof node.node_id === "string" ? node.node_id : "?",
      state: typeof node.state === "string" ? node.state : "?",
      source: "canonical/recovery.pending",
      summary: `Recover node ${typeof node.node_id === "string" ? node.node_id : "unavailable"}`,
      detail: recoveryDetail(node, capabilities),
      actions: recoveryActions(node, capabilities),
    })),
    columns: [
      { key: "summary", title: "Recovery target", width: 36 },
      { key: "state", title: "State", width: 13 },
      { key: "source", title: "Source", width: 28 },
    ],
    caption: nodes.length === 0 ? `Recovery: ${shape.campaign_id} (no recoverable nodes)` : `Recovery: ${shape.campaign_id} (${nodes.length})`,
    // Nodes without a durable prior operation are visible as crash evidence,
    // but intentionally unselectable: recovery commands must never invent it.
    row_ids: nodes.map((node): RowIdentity | null => (
      typeof node.node_id === "string" && typeof node.prior_operation_id === "string" && typeof node.expected_version === "string"
        ? { id: node.node_id, context: { campaign_id: shape.campaign_id, prior_operation_id: node.prior_operation_id, expected_version: node.expected_version } }
        : null
    )),
  };
}

function recoveryReason(node: Readonly<Record<string, unknown>>): string {
  if (typeof node.reason === "string" && node.reason.length > 0) return node.reason;
  const outcome = node.outcome;
  if (typeof outcome === "object" && outcome !== null) {
    const record = outcome as Record<string, unknown>;
    if (typeof record.message === "string" && record.message.length > 0) return record.message;
    const error = record.error;
    if (typeof error === "object" && error !== null && typeof (error as Record<string, unknown>).message === "string") return String((error as Record<string, unknown>).message);
  }
  return "reason unavailable";
}

function recoveryActions(node: Readonly<Record<string, unknown>>, capabilities: ReadonlySet<string>): string {
  if (typeof node.node_id !== "string" || typeof node.prior_operation_id !== "string" || typeof node.expected_version !== "string") {
    return "inspect only — retry/abandon unavailable: durable prior operation or version is missing";
  }
  return [
    capabilities.has("recovery.write") ? "r retry (recovery.write)" : "retry unavailable (requires recovery.write)",
    capabilities.has("recovery.abandon") ? "z abandon (recovery.abandon; confirmation required)" : "abandon unavailable (requires recovery.abandon)",
  ].join(" · ");
}

function recoveryDetail(node: Readonly<Record<string, unknown>>, capabilities: ReadonlySet<string>): string {
  const priorOperation = typeof node.prior_operation_id === "string" ? node.prior_operation_id : "unavailable";
  const version = typeof node.expected_version === "string" ? node.expected_version : "unavailable";
  return `${recoveryReason(node)} · prior operation ${priorOperation} · expected version ${version} · ${recoveryActions(node, capabilities)}`;
}

function recoveryGlyph(state: unknown): string {
  if (state === "failed") return "!";
  if (state === "interrupted") return "×";
  if (state === "pending") return "○";
  return "·";
}

function renderRecovery(projection: ScreenProjection, width: number, height: number, offset?: number, selectedId?: string): readonly string[] {
  if (projection.rows.length === 0) return wrapDisplay(projection.caption ?? "(no recovery targets)", width).slice(0, height);
  if (offset !== undefined && offset < 0) return [clipDisplay("(render error)", width)];
  const header = clipDisplay(`${projection.caption ?? "Recovery"} · canonical/recovery.pending`, width);
  const start = Math.min(Math.max(0, offset ?? 0), projection.rows.length);
  const lines: string[] = [];
  for (const row of projection.rows.slice(start)) {
    const selected = typeof row.id === "string" && row.id === selectedId ? "›" : " ";
    lines.push(...wrapDisplay(`${selected}${recoveryGlyph(row.state)} ${String(row.summary ?? "Recovery target")} · ${String(row.state ?? "observed")}`, width).slice(0, 2));
    lines.push(...wrapDisplay(`  ${String(row.source ?? "canonical/recovery.pending")}`, width).slice(0, 1));
    // The error/recovery explanation and exact canonical action identities
    // remain visible; retry/abandon authority still belongs to update.ts and
    // the injected RuntimePort, not this renderer.
    lines.push(...wrapDisplay(`  ${String(row.detail ?? "Recovery detail unavailable")}`, width).slice(0, 3));
    if (lines.length >= Math.max(0, height - 1)) break;
  }
  return [header, ...lines.slice(0, Math.max(0, height - 1))];
}

function emptyProjection(): Omit<ScreenProjection, "variant"> {
  return { screen: "recovery", rows: [], columns: [{ key: "id", title: "Node", width: 12, truncate: "middle" }], caption: "Recovery data unavailable — no retry target is inferred" };
}

export const recoveryScreen: ScreenModule = {
  id: "recovery" as ScreenId,
  title: "Recovery",
  // Recovery evidence is useful to a read-only operator. Retry and abandon
  // remain separately authorized by their canonical command capabilities.
  required_capabilities: ["recovery.read"],
  surface: { commands: ["recovery.retry", "recovery.abandon"], queries: ["recovery.pending"] },
  ...buildScreenPipeline([
    defineVariant({ match: isPendingShape, tag: "recovery.pending", project: projectPending, render: (projection, ctx) => renderRecovery(projection, ctx.width, ctx.height, ctx.scroll_offset, ctx.selected_id) }),
  ], { emptyProjection }),
};
