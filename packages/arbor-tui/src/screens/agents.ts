/**
 * Agents screen (roadmap 4C, item 15).
 *
 * Bounded view of the agent registry from `agent.list`: STATIC definitions
 * (bounded) and LIVE instances derived from the supervisor (never
 * fabricated — a running task whose agent has no definition does not
 * surface). Liveness/availability is a projection over live/reconciled task
 * state, never a separate authoritative count.
 *
 * Leaf module. Depends only on @arbor/core (via widgets) and the
 * runtime-port/screen contracts — never @arbor/mcp.
 */

import { clipDisplay, renderTable } from "../widgets.js";
import type { TableColumn } from "../widgets.js";
import type { RowIdentity, ScreenId, ScreenModule, ScreenProjection } from "./screen.js";
import { buildScreenPipeline, defineVariant } from "./registry.js";
import { emptyCaption, unrecognisedCaption } from "./empty-state.js";
import { operatorStateLabel } from "../operator-view-model.js";

const MAX_ROWS = 200;

function isRegistryShape(result: unknown): result is { definitions?: readonly Record<string, unknown>[]; live?: readonly Record<string, unknown>[] } {
  return typeof result === "object" && result !== null && "definitions" in result && Array.isArray((result as { definitions?: unknown }).definitions);
}

function rowCountCaption(caption: string, count: number): string {
  return count > 0 ? `${caption} (${count})` : `no ${caption.toLowerCase()}`;
}

function projectDefinitions(defs: readonly Record<string, unknown>[], limit: number): Omit<ScreenProjection, "variant"> {
  const sliced = defs.slice(0, limit);
  const bounded = sliced.map((d) => ({
    name: typeof d.name === "string" ? d.name : "?",
    tier: typeof d.tier === "string" ? d.tier : "?",
    description: typeof d.description === "string" ? d.description : "—",
  }));
  return {
    screen: "agents",
    rows: bounded,
    columns: [
      { key: "name", title: "Agent", width: 14 },
      { key: "tier", title: "Tier", width: 12 },
      { key: "description", title: "Role", width: 40 },
    ],
    caption: rowCountCaption("Agent definitions", bounded.length),
    // A definition's `name` IS its stable registry key, even though no
    // command targets one directly today (surface.commands is empty).
    row_ids: sliced.map((d): RowIdentity | null => (typeof d.name === "string" ? { id: d.name } : null)),
  };
}

function projectLive(live: readonly Record<string, unknown>[], limit: number): Omit<ScreenProjection, "variant"> {
  const sliced = live.slice(0, limit);
  const bounded = sliced.map((i) => ({
    agent: typeof i.agent === "string" ? i.agent : "?",
    task_id: typeof i.task_id === "string" ? i.task_id : "?",
    state: operatorStateLabel(i.state, "state unavailable"),
    owner: typeof i.owner_scope_id === "string" ? i.owner_scope_id : "?",
  }));
  return {
    screen: "agents",
    rows: bounded,
    columns: [
      { key: "agent", title: "Agent", width: 14 },
      { key: "task_id", title: "Task", width: 18 },
      { key: "state", title: "State", width: 12 },
      { key: "owner", title: "Owner", width: 14 },
    ],
    caption: `${rowCountCaption("Live agent instances", bounded.length)} · canonical agent.list`,
    // A live instance's identity is the supervised task behind it — the same
    // id `tasks.ts`'s `task.retry` targets, so a click here and a click on
    // the matching tasks-screen row resolve to the same record.
    row_ids: sliced.map((i): RowIdentity | null => (typeof i.task_id === "string" ? { id: i.task_id } : null)),
  };
}

function renderTableX(projection: ScreenProjection, width: number, height: number, emptyText: string, offset?: number): readonly string[] {
  const rows = projection.rows;
  if (rows.length === 0) return [clipDisplay(emptyText, width)];
  try {
    const colCount = projection.columns.length;
    const colWidth = Math.max(1, Math.floor((width - (colCount - 1)) / colCount));
    const cols: TableColumn[] = projection.columns.map((c) => ({ key: c.key, title: c.title, width: Math.min(c.width, colWidth) }));
    const lines = renderTable(rows, cols, { height, offset });
    return [clipDisplay(projection.caption ?? "Agents", width), ...lines];
  } catch {
    return [clipDisplay("(render error)", width)];
  }
}

function emptyProjection(reason: "empty" | "unrecognised"): Omit<ScreenProjection, "variant"> {
  return {
    screen: "agents",
    rows: [],
    columns: [{ key: "name", title: "Agent", width: 10 }],
    caption: reason === "empty"
      ? emptyCaption({ what: "Agent registry not loaded", how: "reopen Agents (8) to refresh" })
      : unrecognisedCaption("Agents"),
  };
}

// Live-instance-first when there are running agents; otherwise definitions.
function isLiveShape(result: unknown): result is { definitions?: readonly Record<string, unknown>[]; live?: readonly Record<string, unknown>[] } {
  return isRegistryShape(result) && (result.live ?? []).length > 0;
}

const AGENTS_VARIANTS = [
  defineVariant({
    tag: "live",
    match: isLiveShape,
    project: (shape) => projectLive(shape.live ?? [], MAX_ROWS),
    render: (projection, ctx) => renderTableX(projection, ctx.width, ctx.height, "(no live agents)", ctx.scroll_offset),
  }),
  defineVariant({
    tag: "definitions",
    match: isRegistryShape,
    project: (shape) => projectDefinitions(shape.definitions ?? [], MAX_ROWS),
    render: (projection, ctx) => renderTableX(projection, ctx.width, ctx.height, "(no agent definitions)", ctx.scroll_offset),
  }),
];

export const agentsScreen: ScreenModule = {
  id: "agents" as ScreenId,
  title: "Agents",
  required_capabilities: ["agent.read"],

  surface: { commands: [], queries: ["agent.list"] },

  ...buildScreenPipeline(AGENTS_VARIANTS, { emptyProjection }),
};
