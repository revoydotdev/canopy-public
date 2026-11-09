/**
 * Approvals screen (roadmap 4C, item 22).
 *
 * Bounded view of the durable approval workflow from `approval.list`.
 * Controls (approve/reject/expire) are surfaced ONLY where the canonical
 * capabilities exist (approval.decide). Checks-and-balances are structural:
 * the UI never offers self-approval — the backend forbids a proposer
 * deciding their own request (fail-closed). The screen only projects the
 * durable decision records.
 *
 * Leaf module. Depends only on @arbor/core (via widgets) and the
 * runtime-port/screen contracts — never @arbor/mcp.
 */

import { clipDisplay, renderTable, wrapDisplay } from "../widgets.js";
import type { TableColumn } from "../widgets.js";
import type { RowIdentity, ScreenId, ScreenModule, ScreenProjection } from "./screen.js";
import { buildScreenPipeline, defineVariant } from "./registry.js";

const MAX_ROWS = 200;

function isApprovalListShape(result: unknown): result is { records?: readonly Record<string, unknown>[] } {
  return typeof result === "object" && result !== null && "records" in result && Array.isArray((result as { records?: unknown }).records);
}

function statusIcon(status: string): string {
  switch (status) {
    case "pending": return "◔";
    case "approved": return "✓";
    case "rejected": return "✗";
    case "expired": return "⊘";
    default: return "?";
  }
}

function rowCountCaption(caption: string, count: number): string {
  return count > 0 ? `${caption} (${count})` : `no ${caption.toLowerCase()}`;
}

/**
 * `expires_at.slice(0, 10)` kept only the date (`YYYY-MM-DD`), discarding
 * time-of-day entirely — for a request expiring later the same day, every
 * row in the table showed the identical date and the operator had no way to
 * tell whether they had five minutes or five hours left. Kept to minute
 * precision (`YYYY-MM-DDTHH:MM`, 16 chars): this module has no injected wall
 * clock (`project()` is deterministic, no `Date.now()` side channel), so it
 * cannot render a relative "expires in Xh Ym" countdown honestly — the exact
 * timestamp is the most useful thing it can show without fabricating one.
 */
function formatExpiresAt(value: unknown): string {
  return typeof value === "string" && value.length >= 16 ? value.slice(0, 16) : (typeof value === "string" ? value : "?");
}

function actionPresentation(record: Record<string, unknown>): string {
  const subject = typeof record.subject === "string" ? record.subject : "?";
  switch (record.action) {
    case "campaign.halt": return `HALT campaign · ${subject}`;
    case "recovery.abandon": return `ABANDON recovery · ${subject}`;
    case "output.raw": return `DISCLOSE raw output · ${subject}`;
    case "permission.grant": return `GRANT permission · ${subject}`;
    default: return `OTHER action · ${subject}`;
  }
}

function memoryOptions(record: Record<string, unknown>): string {
  const base = "once (this request only) · session (until restart)";
  return typeof record.action_fingerprint === "string" && /^sha256:[a-f0-9]{64}$/.test(record.action_fingerprint)
    ? `${base} · persistent (survives restart)`
    : `${base} · persistent unavailable (action not canonical)`;
}

function projectApprovals(records: readonly Record<string, unknown>[], limit: number): Omit<ScreenProjection, "variant"> {
  const sliced = records.slice(0, limit);
  const bounded = sliced.map((r) => ({
    id: typeof r.request_id === "string" ? r.request_id : "?",
    action: actionPresentation(r),
    memory: memoryOptions(r),
    proposal: `${statusIcon(typeof r.status === "string" ? r.status : "?")} ${typeof r.status === "string" ? r.status : "?"}`,
    proposer: typeof r.proposer === "string" ? r.proposer : "?",
    resource: typeof r.resource_id === "string" ? r.resource_id : "resource unavailable",
    decided_by: typeof r.decided_by === "string" ? r.decided_by : "—",
    expires: formatExpiresAt(r.expires_at),
  }));
  return {
    screen: "approvals",
    rows: bounded,
    columns: [
      { key: "id", title: "Request", width: 14, truncate: "middle" },
      { key: "action", title: "Action-specific request", width: 30 },
      { key: "memory", title: "Approval durability", width: 36 },
      { key: "proposal", title: "Status", width: 12 },
      { key: "proposer", title: "Proposer", width: 12 },
      { key: "resource", title: "Resource", width: 16 },
      { key: "decided_by", title: "Decided", width: 12 },
      { key: "expires", title: "Expires", width: 16 },
    ],
    caption: `${rowCountCaption("Approvals", bounded.length)} · canonical approval.list`,
    // `approval.approve`/`approval.reject`/`approval.expire` need `request_id`.
    row_ids: sliced.map((r): RowIdentity | null => (typeof r.request_id === "string" ? { id: r.request_id } : null)),
  };
}

function renderApprovalCards(projection: ScreenProjection, width: number, height: number, offset?: number): readonly string[] {
  const rows = projection.rows;
  const start = Math.max(0, Math.min(offset ?? 0, rows.length - 1));
  const out: string[] = [clipDisplay(`${projection.caption ?? "Approvals"} · ${start + 1}/${rows.length}`, width)];
  for (let index = start; index < rows.length && out.length < height; index += 1) {
    const row = rows[index]!;
    projection.columns.forEach((column, columnIndex) => {
      const value = String(row[column.key] ?? "");
      const indent = columnIndex === 0 ? "" : "  ";
      const wrapped = wrapDisplay(`${column.title}: ${value}`, Math.max(1, width - indent.length - 2));
      wrapped.forEach((line, part) => {
        if (out.length < height) out.push(`${indent}${part === 0 ? "" : "  "}${line}`);
      });
    });
  }
  return out.slice(0, height);
}

function renderApprovalsTable(projection: ScreenProjection, width: number, height: number, offset?: number): readonly string[] {
  const rows = projection.rows;
  if (rows.length === 0) return [clipDisplay(projection.caption ?? "No approvals", width)];
  const naturalWidth = projection.columns.reduce((sum, column) => sum + column.width, 0) + Math.max(0, projection.columns.length - 1);
  // When the table cannot hold its columns at their natural width the old
  // equal split clipped EVERY cell (`seeded-… DISCLOS… once (t… pendi…`),
  // hiding the request, action and status behind ellipses. A stacked card
  // wraps each field instead, so nothing the decision rests on is dropped.
  if (naturalWidth > width) return renderApprovalCards(projection, width, height, offset);
  const colCount = projection.columns.length;
  const colWidth = Math.max(1, Math.floor((width - (colCount - 1)) / colCount));
  const cols: TableColumn[] = projection.columns.map((c) => ({ key: c.key, title: c.title, width: Math.min(c.width, colWidth) }));
  try {
    const lines = renderTable(rows, cols, { height, offset });
    return [clipDisplay(projection.caption ?? "Approvals", width), ...lines];
  } catch {
    return [clipDisplay("(render error)", width)];
  }
}

function emptyProjection(): Omit<ScreenProjection, "variant"> {
  return { screen: "approvals", rows: [], columns: [{ key: "id", title: "Request", width: 10, truncate: "middle" }], caption: "Approval data unavailable — no decision state is inferred" };
}

const APPROVALS_VARIANTS = [
  defineVariant({
    tag: "approvals",
    match: isApprovalListShape,
    project: (shape) => projectApprovals(shape.records ?? [], MAX_ROWS),
    render: (projection, ctx) => renderApprovalsTable(projection, ctx.width, ctx.height, ctx.scroll_offset),
  }),
];

export const approvalsScreen: ScreenModule = {
  id: "approvals" as ScreenId,
  title: "Approvals",
  required_capabilities: ["approval.read", "approval.request", "approval.decide"],

  surface: {
    commands: ["approval.request", "approval.approve", "approval.reject", "approval.expire"],
    queries: ["approval.list"],
  },

  ...buildScreenPipeline(APPROVALS_VARIANTS, { emptyProjection }),
};
