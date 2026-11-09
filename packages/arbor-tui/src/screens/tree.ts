/**
 * Tree screen (wave1/tui-contracts follow-up to G-31/G-32).
 *
 * `"tree"` was a declared `ScreenId` with no `ScreenModule` — `tree.branch`/
 * `tree.prune` (both `supported:true` per RUNTIME_CATALOG) had no screen to
 * select a node from, so neither control had any way to be issued. This
 * screen closes that gap: it is the sole topology surface for the bounded
 * `campaign.tree` projection, with one row marked as the operator's current selection
 * (`ctx.selected_id`, threaded from `AppModel.selection.get("tree")` — see
 * `update.ts`/`operator-selection.ts`). Selection itself is UI-only state;
 * this module stays a pure projection and never tracks it.
 *
 * Leaf module. Depends only on @arbor/core (via widgets) and the
 * runtime-port/screen contracts — never @arbor/mcp.
 */

import { clipDisplay, displayWidth, renderTree, wrapDisplay } from "../widgets.js";
import { deriveTheme, semanticGlyph, toForegroundSgr, type RunTheme, type ColorMode } from "../theme.js";
import type { TreeRow } from "../widgets.js";
import type { RowIdentity, ScreenId, ScreenModule, ScreenProjection } from "./screen.js";
import { buildScreenPipeline, defineVariant } from "./registry.js";
import { clipLabelWithEllipsis } from "./region.js";
import { applyUctEvents, emptyUctGraph, type UctGraphModel, type UctLifecycleEvent, type UctModelNode } from "../uct-model.js";
import type { TuiReadModel } from "../read-model.js";
import type { UctReaderState } from "../uct-model.js";

const MAX_TREE_ROWS = 500;
const DEFAULT_TREE_THEME = deriveTheme(undefined);
type TreeTone = "text" | "accent" | "muted" | "success" | "warning" | "info";
type TreePaint = (line: string, tone: TreeTone, bold?: boolean) => string;

function nodeTone(state: unknown): TreeTone {
  if (state === "verified") return "success";
  if (state === "expanding") return "accent";
  if (state === "claimed" || state === "awaiting_review" || state === "failed" || state === "interrupted") return "warning";
  if (state === "pruned" || state === "abandoned") return "muted";
  return "text";
}

/**
 * A node's displayed lifecycle state must be backed by its provenance. Core
 * (`verifyNode`) only reaches `verified` with a `!verified` provenance record;
 * a wire node that claims `verified` while carrying a `claimed`,
 * `critic_approved` or `generated` provenance (or none at all, in the
 * snapshot) is not machine-verified and must not wear verified styling. It is
 * shown as `claimed` — approved or asserted, not machine verified.
 *
 * `eventSourced` marks a state advanced by a post-snapshot event: the
 * snapshot's provenance is then legitimately stale (still null), so only a
 * concrete non-verified tag is a contradiction.
 */
export function evidencedNodeState(node: Record<string, unknown>, state: string, eventSourced = false): string {
  if (state !== "verified") return state;
  const record = node.provenance;
  const tag = record !== null && typeof record === "object" && typeof (record as Record<string, unknown>).tag === "string"
    ? (record as Record<string, unknown>).tag
    : node.provenance_tag;
  if (typeof tag === "string") return tag === "verified" ? state : "claimed";
  return tag === null && !eventSourced ? "claimed" : state;
}

/** Provenance tag carried by a node, or "" when none is reported. */
function nodeProvenanceTag(node: Record<string, unknown>): string {
  const record = node.provenance;
  if (record !== null && typeof record === "object" && typeof (record as Record<string, unknown>).tag === "string") return String((record as Record<string, unknown>).tag);
  return typeof node.provenance_tag === "string" ? node.provenance_tag : "";
}

export interface ShapeTree {
  readonly campaign_id?: string;
  readonly decomposed?: number;
  readonly halted?: boolean;
  readonly halt_reason?: string | null;
  readonly nodes?: readonly Record<string, unknown>[];
  readonly event_cursor?: { readonly stream_id: string; readonly sequence: number };
}

export function isTreeShape(result: unknown): result is ShapeTree {
  return (
    typeof result === "object" &&
    result !== null &&
    "nodes" in result &&
    // A campaign with no nodes is a real, empty tree result rather than an
    // unavailable query. Keep that distinction visible to the operator.
    Array.isArray((result as ShapeTree).nodes)
  );
}

/**
 * Keep the semantic role glyph, then add a compact ASCII state mnemonic. A
 * tree node's lifecycle state is more specific than its color category
 * (several terminal outcomes share the failure role), so the mnemonic keeps
 * every canonical NodeState distinct in monochrome and Unicode output.
 */
function nodeStateIcon(state: string, unicode = true, provenance = ""): string {
  switch (state) {
    case "pending":
      return `${semanticGlyph("waiting", unicode)}p`;
    case "expanding":
      return `${semanticGlyph("active", unicode)}e`;
    case "verified":
      return `${semanticGlyph("success", unicode)}v`;
    case "claimed":
      // Critic-approved without a verification command is a different
      // evidence level from a bare claim, and from machine verification.
      return `${semanticGlyph("governance", unicode)}${provenance === "critic_approved" ? "k" : "c"}`;
    case "failed":
      return `${semanticGlyph("failure", unicode)}f`;
    case "pruned":
      return `${semanticGlyph("muted", unicode)}r`;
    case "interrupted":
      return `${semanticGlyph("failure", unicode)}i`;
    case "abandoned":
      return `${semanticGlyph("failure", unicode)}a`;
    case "awaiting_review":
      return `${semanticGlyph("waiting", unicode)}q`;
    default:
      // Kept for wire payloads this build does not know about; the
      // `NodeState` union itself is covered by
      // tests/screens-node-state-exhaustiveness.test.ts.
      return "?";
  }
}

function rowCountCaption(caption: string, count: number): string {
  return count > 0 ? `${caption} (${count})` : `no ${caption.toLowerCase()}`;
}

/**
 * `campaign.tree`'s REAL nodes (`CampaignManager.getCampaignSnapshot`,
 * arbor-mcp/src/manager.ts) never carry a `label` field at all — they carry
 * `action_description`, the specialist's own free-text description of the
 * action that node represents, `action_category`, and `action_delegate`.
 * Falling straight back to `n.id` (the only prior fallback) therefore fired
 * on EVERY real node, not as a rare edge case, and sibling ids share a long
 * generated prefix (verified against `.arbor/devtools/devtools.log`: a real
 * campaign's eight children of one call render as `node_msds9ktu_1` through
 * `node_msds9ktu_8` — indistinguishable once clipped to a narrow column).
 * `action_description` is what the operator actually needs to tell them
 * apart; `id` stays the last-resort fallback for a genuinely bare/malformed
 * node.
 */
function nodeLabel(n: Record<string, unknown>): string {
  if (typeof n.label === "string" && n.label.length > 0) return n.label;
  if (typeof n.action_description === "string" && n.action_description.length > 0) return n.action_description;
  return n.id as string;
}

/**
 * Real nodes also never carry `has_children` — they carry `children_ids`
 * (`string[]`), the actual source of truth. Derive from it when the
 * (never-real) `has_children` flag is absent, rather than defaulting to
 * `false` for every real node and permanently hiding the expand/collapse
 * indicator `renderTree` (widgets.ts) draws from this field.
 */
function nodeHasChildren(n: Record<string, unknown>): boolean {
  if (typeof n.has_children === "boolean") return n.has_children;
  return Array.isArray(n.children_ids) && n.children_ids.length > 0;
}

/**
 * Full provenance detail for the inspector — the verification command/exit,
 * the critic's rationale, or the generator id, none of which the tree/state
 * icon alone conveys (audit finding 6). `manager.ts`'s node projection now
 * sends the real `Provenance` object, not just its `tag`.
 */
function describeProvenance(n: Record<string, unknown>): string {
  const p = n.provenance;
  if (p === null || typeof p !== "object") return "—";
  const tag = (p as Record<string, unknown>).tag;
  switch (tag) {
    case "verified": {
      const r = p as Record<string, unknown>;
      // `outputs_check` only proved declared outputs exist; no acceptance
      // command ran. An undeclared strength is not read as the stronger claim.
      const strength = r.strength === "command_executed" ? "" : r.strength === "outputs_check" ? ", outputs checked only — no acceptance command ran" : ", strength not declared";
      return `verified (cmd: ${String(r.cmd)}, exit: ${String(r.exit)}, stdout: ${String(r.stdout_hash)}${strength})`;
    }
    case "claimed":
      return `claimed by ${String((p as Record<string, unknown>).claimant)}`;
    case "critic_approved": {
      const r = p as Record<string, unknown>;
      return `critic_approved by ${String(r.critic)}: ${String(r.rationale)} [critic approval, not machine verified]`;
    }
    case "generated": {
      const r = p as Record<string, unknown>;
      return `generated by ${String(r.generator)} (input: ${String(r.input_hash)})`;
    }
    default:
      return "—";
  }
}

/** Latest gate checkpoint, with bypass detail when the gate was bypassed rather than passed (audit finding 7). */
function describeGates(n: Record<string, unknown>): string {
  const records = Array.isArray(n.gate_records) ? n.gate_records : [];
  if (records.length === 0) return "(none)";
  const latest = records[records.length - 1] as Record<string, unknown>;
  const deficit = typeof latest.bypass_evidence_deficit === "string" ? ` [bypass: ${latest.bypass_evidence_deficit}]` : "";
  return `${records.length} recorded, latest: ${String(latest.gate)}=${String(latest.result)}${deficit}`;
}

/** Every durable checkpoint, in recorded order — never a synthesized pass. */
function describeGateHistory(n: Record<string, unknown>): string {
  const records = Array.isArray(n.gate_records) ? n.gate_records : [];
  if (records.length === 0) return "(none)";
  return records.map((value, index) => {
    const record = value !== null && typeof value === "object" ? value as Record<string, unknown> : {};
    const deficit = typeof record.bypass_evidence_deficit === "string" ? `; deficit=${record.bypass_evidence_deficit}` : "";
    return `#${index + 1} ${String(record.gate)}=${String(record.result)} @ ${String(record.checked_at)}: ${String(record.detail)}${deficit}`;
  }).join(" | ");
}

/** Full persisted critic verdict, including the five individual checks. */
function describeCritic(n: Record<string, unknown>): string {
  const verdict = n.critic_verdict;
  if (verdict === null || typeof verdict !== "object") return "(not recorded)";
  const v = verdict as Record<string, unknown>;
  const checks = Array.isArray(v.checks) ? v.checks.map((value) => {
    const check = value !== null && typeof value === "object" ? value as Record<string, unknown> : {};
    return `${String(check.name)}=${String(check.passed)} (${String(check.detail)})`;
  }).join("; ") : "(no checks recorded)";
  return `${String(v.approved)} by ${String(v.critic)}: ${String(v.rationale)}; measurement=${String(v.measurement_validated)}, guardrails=${String(v.guardrails_enforced)}, introspection=${String(v.introspection_passed)}, stability=${String(v.stability_ok)}; checks: ${checks}`;
}

/** Closed result projection: verdict, interruption, or classified operational error (audit finding 16). */
function describeOutcome(n: Record<string, unknown>): string {
  const o = n.outcome;
  if (o === null || typeof o !== "object") {
    // A critic rejection or a root-cause failure sets no `outcome`; the
    // reason lives in `specialist_output` as "FAILED: <root cause>" (tree.ts
    // failNode). Rendering "—" here left a failed node unexplained while the
    // reason sat in the projection unread (EC-061).
    const output = typeof n.specialist_output === "string" ? n.specialist_output : "";
    const failed = /^FAILED:\s*/u.exec(output);
    if (failed !== null) return `failed: ${output.slice(failed[0].length).split("\n")[0]}`;
    return "—";
  }
  const kind = (o as Record<string, unknown>).kind;
  switch (kind) {
    case "verdict":
      return `verdict: ${String((o as Record<string, unknown>).approved)} — ${String((o as Record<string, unknown>).message)}`;
    case "interrupted":
      return `interrupted (${String((o as Record<string, unknown>).scope)}): ${String((o as Record<string, unknown>).message)}`;
    case "error": {
      const err = (o as Record<string, unknown>).error;
      if (err === null || typeof err !== "object") return "error: (unavailable)";
      const e = err as Record<string, unknown>;
      return `error: ${String(e.kind)} — ${String(e.message)}`;
    }
    default:
      return "—";
  }
}

/** Recovery attempt history — write path is wired elsewhere; this closes the read-back gap (audit finding 11). */
function describeRecovery(n: Record<string, unknown>): string {
  const attempts = Array.isArray(n.recovery_attempts) ? n.recovery_attempts : [];
  if (attempts.length === 0) return "(none)";
  const latest = attempts[attempts.length - 1] as Record<string, unknown>;
  return `${attempts.length} recorded, latest: ${String(latest.action)} by ${String(latest.actor_id)} (${String(latest.reason)})`;
}

/** Loop-owned bounded retries, separated by the authority that caused them. */
function describeRetries(n: Record<string, unknown>): string {
  const scope = typeof n.scope_retry_count === "number" ? n.scope_retry_count : 0;
  const critic = typeof n.critic_retry_count === "number" ? n.critic_retry_count : 0;
  return scope === 0 && critic === 0 ? "none" : `scope ${scope}, critic ${critic}`;
}

/** Redacted durable authority summary; exact tool paths/argv stay at the host boundary. */
function describeHighRiskScope(value: unknown): string {
  if (value === null || typeof value !== "object") return "none";
  const scope = value as Record<string, unknown>;
  if (scope.declared !== true) return "none";
  const writes = typeof scope.write_path_count === "number" ? scope.write_path_count : 0;
  const commands = typeof scope.command_argv_count === "number" ? scope.command_argv_count : 0;
  return `${writes} write path(s), ${commands} command(s) (durable declaration)`;
}

export function projectTree(shape: ShapeTree, limit: number, readModel?: TuiReadModel, reader?: UctReaderState): Omit<ScreenProjection, "variant"> {
  const rawNodes = (shape.nodes ?? []) as readonly Record<string, unknown>[];
  const sliced = rawNodes.slice(0, limit).filter((n) => typeof n.id === "string");
  const uct = liveUctModel(shape, sliced, readModel);
  const semanticNodes = uct === null ? null : uct.nodes;
  const mappedAll: readonly Readonly<Record<string, unknown>>[] = sliced
    .map((n) => ({
      id: n.id as string,
      label: nodeLabel(n),
      depth: typeof n.depth === "number" && Number.isSafeInteger(n.depth) ? n.depth : 0,
      // The snapshot remains authoritative for topology and rich metadata;
      // canonical post-snapshot tree events advance only lifecycle state.
      state: (() => {
        const live = semanticNodes?.get(n.id as string)?.state;
        const snapshot = typeof n.state === "string" ? n.state : "unknown";
        return evidencedNodeState(n, live ?? snapshot, live !== undefined && live !== snapshot);
      })(),
      has_children: nodeHasChildren(n),
      expanded:
        typeof n.state === "string" ? n.state === "expanding" || evidencedNodeState(n, n.state) === "verified" : false,
      // `campaign.tree` already sends these over the wire (manager.ts's node
      // projection) — reading them here is the cheapest of this audit's
      // findings to close: no new backend/catalog work, purely unused fields
      // the screen was already iterating past.
      category: typeof n.action_category === "string" ? n.action_category : "",
      score: typeof n.score === "number" ? n.score.toFixed(2) : "",
      provenance: nodeProvenanceTag(n),
      visit_count: typeof n.visit_count === "number" ? n.visit_count : 0,
      scope_retry_count: typeof n.scope_retry_count === "number" ? n.scope_retry_count : 0,
      critic_retry_count: typeof n.critic_retry_count === "number" ? n.critic_retry_count : 0,
      // Not table columns — carried on the row for the selected-node inspector
      // panel only (renderTreeScreen), which needs the full records, not a
      // clipped scalar. Findings 6, 7, 11, 12, 13, 16.
      _inspector: {
        description: nodeLabel(n),
        action_delegate: typeof n.action_delegate === "string" ? n.action_delegate : "—",
        action_estimated_gain: typeof n.action_estimated_gain === "number" ? n.action_estimated_gain : "—",
        action_estimated_cost: typeof n.action_estimated_cost === "number" ? n.action_estimated_cost : "—",
        high_risk_scope: describeHighRiskScope(n.high_risk_tool_scope),
        visit_count: typeof n.visit_count === "number" ? n.visit_count : "—",
        decomposition_depth: typeof n.decomposition_depth === "number" ? n.decomposition_depth : "—",
        provenance: describeProvenance(n),
        gates: describeGates(n),
        gate_history: describeGateHistory(n),
        critic: describeCritic(n),
        outcome: describeOutcome(n),
        recovery: describeRecovery(n),
        retries: describeRetries(n),
        memory_mode: typeof n.memory_mode === "string" ? n.memory_mode : "—",
        memory_mode_version: typeof n.memory_mode_version === "number" ? n.memory_mode_version : "—",
        kb_entries_extracted: typeof n.kb_entries_extracted === "number" ? n.kb_entries_extracted : "—",
      },
    }));
  const visibleIndices = sliced.map((node, index) => ({ node, index, row: mappedAll[index]! }))
    .filter(({ row }) => reader?.filter === undefined || reader.filter === "" || `${String(row.id)} ${String(row.label)} ${String(row.state)}`.toLowerCase().includes(reader.filter.toLowerCase()));
  const mapped = visibleIndices.map(({ row }) => row);

  return {
    screen: "tree",
    rows: mapped,
    reader_status: [reader?.follow_active === false ? "follow off" : "", reader?.filter ? `filter ${reader.filter}` : "", reader?.modal ? "editing filter" : ""].filter(Boolean).join(" · "),
    columns: [
      { key: "id", title: "ID", width: 12, truncate: "middle" },
      { key: "label", title: "Node", width: 28 },
      { key: "depth", title: "D", width: 3 },
      { key: "state", title: "State", width: 12 },
      { key: "has_children", title: "Ch", width: 3 },
      { key: "category", title: "Category", width: 10 },
      { key: "score", title: "Score", width: 6 },
      { key: "provenance", title: "Prov", width: 10 },
    ],
    caption: `${treeProgressCaption(shape, mappedAll)}${uct === null ? "" : uct.status === "gap" ? " · UCT resync required" : ` · UCT seq ${uct.sequence}`}`,
    row_ids: visibleIndices.map(({ node: n }): RowIdentity => ({
      id: n.id as string,
      context: typeof shape.campaign_id === "string"
        ? { campaign_id: shape.campaign_id, ...(typeof n.parent_id === "string" ? { parent_node_id: n.parent_id } : {}) }
        : undefined,
    })),
  };
}

/**
 * Seed from the cursor-stamped canonical tree query, then fold the exact
 * ordered runtime envelopes retained by the TUI read model. Non-tree events
 * still advance the global cursor; dropping them would turn unrelated
 * campaign activity into a false sequence gap. A missing/truncated tail is
 * disclosed instead of projecting lifecycle state across an unproven gap.
 */
function liveUctModel(
  shape: ShapeTree,
  nodes: readonly Record<string, unknown>[],
  readModel?: TuiReadModel,
): UctGraphModel | null {
  const cursor = shape.event_cursor;
  if (!cursor || !Number.isSafeInteger(cursor.sequence) || cursor.sequence < 0 || typeof cursor.stream_id !== "string") return null;
  const snapshotNodes: UctModelNode[] = nodes.map((node) => ({
    id: node.id as string,
    parent_id: typeof node.parent_id === "string" ? node.parent_id : null,
    state: typeof node.state === "string" ? node.state : "unknown",
    label: nodeLabel(node),
    ...(typeof node.visit_count === "number" ? { visit_count: node.visit_count } : {}),
  }));
  let graph = applyUctEvents(emptyUctGraph(), [{ sequence: cursor.sequence, kind: "snapshot", nodes: snapshotNodes }]);
  if (!readModel || (readModel.watermark?.sequence ?? 0) <= cursor.sequence) return graph;
  if (readModel.stream_id !== cursor.stream_id || readModel.status !== "ok") return { ...graph, status: "gap" };

  const tail = readModel.eventTail.filter((envelope) => envelope.cursor.sequence > cursor.sequence);
  if (tail.length === 0 || tail[0]!.cursor.sequence !== cursor.sequence + 1 || tail.at(-1)!.cursor.sequence !== readModel.watermark?.sequence) {
    return { ...graph, status: "gap" };
  }
  const known = new Set(snapshotNodes.map((node) => node.id));
  const events: UctLifecycleEvent[] = tail.map((envelope) => {
    const event = envelope.event;
    if (event.kind === "tree.node_changed" && event.campaign_id === shape.campaign_id && known.has(event.node_id)) {
      return { sequence: envelope.cursor.sequence, kind: "node_changed", node: { id: event.node_id, state: event.state } };
    }
    return { sequence: envelope.cursor.sequence, kind: "watermark" };
  });
  graph = applyUctEvents(graph, events);
  return graph;
}

function treeProgressCaption(shape: ShapeTree, rows: readonly Readonly<Record<string, unknown>>[]): string {
  const total = rows.length;
  const count = (state: string): number => rows.filter((row) => row.state === state).length;
  const verified = count("verified"); const frontier = count("pending"); const expanding = count("expanding"); const claimed = count("claimed");
  const closed = count("failed") + count("pruned") + count("interrupted") + count("abandoned");
  const depth = rows.reduce((max, row) => typeof row.depth === "number" ? Math.max(max, row.depth) : max, 0);
  const scopeRetries = rows.reduce((sum, row) => sum + (typeof row.scope_retry_count === "number" ? row.scope_retry_count : 0), 0);
  const criticRetries = rows.reduce((sum, row) => sum + (typeof row.critic_retry_count === "number" ? row.critic_retry_count : 0), 0);
  const retryStatus = scopeRetries + criticRetries > 0 ? ` · retries scope ${scopeRetries} / critic ${criticRetries}` : "";
  const filled = total === 0 ? 0 : Math.round((verified / total) * 10);
  const rail = `${"█".repeat(filled)}${"░".repeat(10 - filled)}`;
  return `${rowCountCaption(`Tree: ${shape.campaign_id ?? "?"}`, total)} · ${rail} ${verified}/${total} verified${retryStatus} · expanding ${expanding} · claimed ${claimed} · frontier ${frontier} · closed ${closed} · depth ${depth} · decomposed ${typeof shape.decomposed === "number" ? shape.decomposed : "?"}`;
}

function renderTreeScreen(
  projection: ScreenProjection,
  width: number,
  height: number,
  selectedId: string | undefined,
  offset?: number,
  color = false,
  theme: RunTheme = DEFAULT_TREE_THEME,
  colorMode: ColorMode = "truecolor",
  unicode = true,
): readonly string[] {
  const rows = projection.rows;
  const paint: TreePaint = (line, tone, bold = false) => color
    ? `${toForegroundSgr(theme.colors[tone], colorMode)}${bold ? "\u001b[1m" : ""}${line}${" ".repeat(Math.max(0, width - displayWidth(line)))}\u001b[0m`
    : line;
  if (rows.length === 0) {
    return [clipDisplay(projection.caption ?? "No tree data", width)];
  }

  const treeRows: TreeRow[] = rows.map((r) => {
    const id = String(r.id ?? "");
    const isSelected = selectedId !== undefined && id === selectedId;
    const cursor = isSelected ? `${semanticGlyph("selection", unicode)} ` : "  ";
    const scopeRetries = Number(r.scope_retry_count ?? 0);
    const criticRetries = Number(r.critic_retry_count ?? 0);
    const retryBadge = scopeRetries > 0 ? (unicode ? ` ↻S${scopeRetries}` : ` S${scopeRetries}`) : criticRetries > 0 ? (unicode ? ` ↻C${criticRetries}` : ` C${criticRetries}`) : "";
    const rowSeparator = unicode ? " · " : " | ";
    const missingScore = unicode ? "—" : "-";
    return {
      id,
      label: `${cursor}${nodeStateIcon(String(r.state ?? "?"), unicode, String(r.provenance ?? ""))} ${String(r.label ?? "?")}${retryBadge}${rowSeparator}s${String(r.score || missingScore)} v${String(r.visit_count ?? 0)}`,
      depth: typeof r.depth === "number" ? r.depth : 0,
      expanded: Boolean(r.expanded),
      has_children: Boolean(r.has_children),
      active: r.state === "expanding" || r.state === "claimed",
    };
  });

  const selectedRow = selectedId !== undefined ? rows.find((r) => String(r.id ?? "") === selectedId) : undefined;
  const legendSeparator = unicode ? " · " : " | ";
  const fullLegend = [
    `LEGEND ${semanticGlyph("selection", unicode)} selected`, `${semanticGlyph("governance", unicode)}c claimed`,
    `${semanticGlyph("governance", unicode)}k critic approved`,
    `${semanticGlyph("active", unicode)} expanding`, `${semanticGlyph("waiting", unicode)} awaiting review/pending`,
    `${semanticGlyph("success", unicode)} verified`, `${semanticGlyph("failure", unicode)} failed`,
    `${unicode ? "├─/└─" : "+-/\\-"} decomposition`, "siblings=alternatives",
  ].join(legendSeparator);
  const stateCount = (state: string) => rows.filter((row) => row.state === state).length;
  const scopeRetries = rows.reduce((sum, row) => sum + Number(row.scope_retry_count ?? 0), 0);
  const criticRetries = rows.reduce((sum, row) => sum + Number(row.critic_retry_count ?? 0), 0);
  const summaryTokens = [
    `SEARCH · ${stateCount("verified")}/${rows.length} verified`,
    `${stateCount("expanding")} expanding`,
    ...(scopeRetries + criticRetries > 0 ? [`retries scope ${scopeRetries} / critic ${criticRetries}`] : []),
    ...([ ["awaiting_review", "awaiting review"], ["failed", "failed"], ["claimed", "claimed"], ["pending", "pending"] ] as const)
      .filter(([state]) => stateCount(state) > 0).map(([state, label]) => `${stateCount(state)} ${label}`),
  ];
  const caption = width < 150 ? [projection.reader_status, ...summaryTokens].filter(Boolean).join(" · ") : projection.caption ?? "Tree";
  // The row glyph+letter is the only state key on a row, so a narrow legend
  // must keep it (it used to keep only the selection marker and the
  // connector key, leaving `§c`/`!f`/`✓v` unexplained). The key line comes
  // first; the palette hint drops out before the state key does.
  const stateKey = [
    `${semanticGlyph("success", unicode)}v verified`, `${semanticGlyph("governance", unicode)}k critic-ok`,
    `${semanticGlyph("governance", unicode)}c claimed`, `${semanticGlyph("failure", unicode)}f failed`,
    `${semanticGlyph("waiting", unicode)}p pending`,
  ].join(" ");
  const legend = width < 150
    ? [
      `${stateKey}${legendSeparator}up/down select${legendSeparator}Ctrl+P commands${legendSeparator}${semanticGlyph("selection", unicode)} selected`,
      `${stateKey}${legendSeparator}Ctrl+P commands`,
      stateKey,
    ].find((candidate) => displayWidth(candidate) <= width) ?? stateKey
    : fullLegend;
  const contentBudget = Math.max(0, height - 2);
  if (contentBudget === 0) return [clipDisplay(projection.caption ?? "Tree", width)].slice(0, height);

  try {
    // Detail is selected-node evidence, not decorative fill.  Still, when a
    // short tree has one selected node it should earn the otherwise-empty
    // lower pane: preserve a useful share for topology first, then donate all
    // genuinely unused rows to wrapped gate/critic/provenance detail.
    const naturalTree = renderTree(treeRows, { width, height: Math.max(1, treeRows.length), offset, unicode });
    const minimumTreeRows = Math.min(
      naturalTree.length,
      Math.max(1, Math.ceil(contentBudget * 0.45)),
    );
    const initialDetailBudget = selectedRow === undefined ? 0 : Math.max(0, contentBudget - minimumTreeRows);
    const initialInspector = selectedRow === undefined ? [] : renderNodeInspector(selectedRow, width, initialDetailBudget, paint);
    const treeHeight = Math.max(1, Math.min(naturalTree.length, contentBudget - initialInspector.length));
    const inspectorLines = selectedRow === undefined ? [] : renderNodeInspector(selectedRow, width, Math.max(0, contentBudget - treeHeight), paint);
    const lines = renderTree(treeRows, { width, height: treeHeight, offset, unicode });
    const firstRow = Math.min(offset ?? 0, Math.max(0, rows.length - 1));
    const styledRows = lines.map((line, index) => {
      const row = rows[firstRow + index];
      return paint(line, nodeTone(row?.state), row?.id === selectedId);
    });
    return [paint(clipLabelWithEllipsis(caption, width), "accent", true), paint(clipLabelWithEllipsis(legend, width), "muted"), ...styledRows, ...inspectorLines].slice(0, height);
  } catch {
    return [clipDisplay("(render error)", width)];
  }
}

/**
 * Detail panel for the selected node, applied to the fields `manager.ts`'s
 * node projection carries but no screen otherwise surfaces: full description,
 * provenance, gate history, critic evidence, closed outcome, recovery
 * attempts, memory mode, and KB extraction count.
 */
function renderNodeInspector(row: Readonly<Record<string, unknown>>, width: number, height: number, paint: TreePaint): readonly string[] {
  const detail = row._inspector;
  if (detail === null || typeof detail !== "object" || height <= 0) return [];
  const d = detail as Record<string, unknown>;
  const allFields = [
    { label: "Description", value: d.description },
    { label: "Delegate", value: d.action_delegate },
    { label: "Gain/Cost", value: `${String(d.action_estimated_gain)}/${String(d.action_estimated_cost)}` },
    { label: "High-risk authority", value: d.high_risk_scope },
    { label: "Visits", value: d.visit_count },
    { label: "Decompose depth", value: d.decomposition_depth },
    { label: "Provenance", value: d.provenance },
    // Why a node ended up where it did (outcome, critic verdict) outranks the
    // gate checkpoint trail: at 80x24 the failed node's root cause sat behind
    // two wrapped gate rows and was folded into "N more fields".
    { label: "Outcome", value: d.outcome },
    { label: "Critic verdict", value: d.critic },
    { label: "Gates", value: d.gates },
    { label: "Gate history", value: d.gate_history },
    { label: "Recovery", value: d.recovery },
    { label: "Corrective retries", value: d.retries },
    { label: "Memory mode", value: `${String(d.memory_mode)} v${String(d.memory_mode_version)}` },
    { label: "KB entries extracted", value: d.kb_entries_extracted },
  ];
  const isAbsent = (value: unknown): boolean => value == null || ["—", "none", "(none)", "(not recorded)", "—/—", "— v—"].includes(String(value));
  const absentFields = allFields.filter((field) => isAbsent(field.value));
  // Keep every value available, but do not give absent checkpoints the same
  // vertical and visual weight as the evidence an operator came to inspect.
  const fields = [
    ...allFields.filter((field) => !isAbsent(field.value)),
    ...(absentFields.length === 0 ? [] : [{
      label: "Not recorded / not applicable",
      value: absentFields.map((field) => `${field.label}: ${String(field.value ?? "—")}`).join(" · "),
    }]),
  ];
  const remaining = Math.max(0, height - 1);
  if (remaining === 0) return [paint(clipDisplay("— node detail —", width), "accent", true)];
  const lines: string[] = [paint(clipDisplay("— node detail —", width), "accent", true)];
  let truncatedField = false;
  let index = 0;
  for (; index < fields.length && lines.length < height; index += 1) {
    const field = fields[index]!;
    // `renderInspector` clips every value to one row, silently losing the
    // important part of a gate failure or critic rationale.  A selected-node
    // lower pane is precisely where this evidence belongs, so wrap it in the
    // real budget and let layout donate unused rows to it above.
    const wrapped = wrapDisplay(`${field.label}: ${String(field.value ?? "—")}`, Math.max(1, width));
    for (let part = 0; part < wrapped.length; part++) {
      if (lines.length >= height) { truncatedField = true; break; }
      const line = clipDisplay(wrapped[part]!, width);
      // Keep evidence prose readable, with a stronger first line for each
      // field. Missing data is explicitly present but visually subordinate.
      const absent = field.label === "Not recorded / not applicable";
      lines.push(paint(line, absent ? "muted" : part === 0 ? "info" : "text"));
    }
  }
  if ((index < fields.length || truncatedField) && lines.length > 1) {
    const notice = truncatedField ? "… more node-detail content (taller terminal shows more)" : `… ${fields.length - index} more node-detail field${fields.length - index === 1 ? "" : "s"} (taller terminal shows more)`;
    lines[lines.length - 1] = paint(clipDisplay(notice, width), "warning");
  }
  return lines;
}

function emptyProjection(): Omit<ScreenProjection, "variant"> {
  return {
    screen: "tree",
    rows: [],
    columns: [{ key: "id", title: "ID", width: 10, truncate: "middle" }],
    // "select an active campaign and refresh" prescribed an action the
    // operator often cannot take: on a greenfield project no campaign exists
    // to select, so the remedy was unachievable — a false affordance wearing
    // empty-state clothing (EC-006). This screen only ever receives its own
    // `campaign.tree` result (ADR-011), so it cannot tell "no campaign exists"
    // from "one exists but none is selected" and must not guess between them.
    // Both exemplars state the absence instead of prescribing: Claude Code
    // uses a consistent "No X yet" family (`No changes yet`, `No commits yet`,
    // `No activity yet`), OpenCode `"No file changes yet"`. Say what is true
    // in either case, and what would produce a tree.
    caption: "No search tree yet — a tree appears once a campaign starts expanding nodes",
  };
}

const TREE_VARIANTS = [
  defineVariant({
    tag: "tree",
    match: isTreeShape,
    project: (shape, input) => projectTree(shape, MAX_TREE_ROWS, input.read_model, input.uct_reader),
    render: (projection, ctx) => renderTreeScreen(projection, ctx.width, ctx.height, ctx.selected_id, ctx.scroll_offset, ctx.color, ctx.theme, ctx.color_mode, ctx.unicode),
  }),
];

export const treeScreen: ScreenModule = {
  id: "tree" as ScreenId,
  title: "Tree",
  required_capabilities: ["tree.read", "tree.write"],

  surface: {
    commands: ["tree.branch", "tree.prune"],
    queries: ["campaign.tree"],
  },

  ...buildScreenPipeline(TREE_VARIANTS, { emptyProjection }),
};
