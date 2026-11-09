/**
 * A pure, responsive right-sidebar projection for the unified coding surface.
 *
 * This is deliberately not a screen.  The composition root owns runtime
 * queries, event subscription, preference persistence, and interaction; this
 * leaf takes already-received projections and produces an honest, bounded
 * sidebar that a screen may dock or render as an overlay.  Keeping those
 * concerns separate preserves ADR-011's one-way projection boundary.
 *
 * The input shapes mirror the `governance.snapshot` and `agent.list` catalog
 * results structurally.  `@arbor/tui` must not import their `@arbor/mcp`
 * implementations.  A future session/feed projection may supply
 * `agent_updates`; it is matched only against a live agent's stable task or
 * operation identity and never creates a synthetic live instance.  When a
 * session list and campaign tree are both present, an exact session/node join
 * identifies the switchable agent feed without guessing from agent names.
 *
 * Layout follows the OpenCode interaction model: auto mode docks only at a
 * wide breakpoint; an explicit operator request below that breakpoint becomes
 * an overlay; explicit hidden always wins.  The caller owns the actual overlay
 * mechanics, while this module makes that decision deterministic and testable.
 */

import { displayWidth, sanitizeUntrustedTerminalText, selectedRowMarker, wrapDisplay } from "./widgets.js";
import { clipLabelWithEllipsis } from "./screens/region.js";
import { ANSI, stripAnsi } from "./player-piano.js";
import { deriveTheme, toForegroundSgr, type ColorMode, type PaletteRole, type RunTheme } from "./theme.js";
import type { InspectSummary } from "./read-model.js";

export const RESPONSIVE_SIDEBAR_WIDE_BREAKPOINT = 120;
export const RESPONSIVE_SIDEBAR_WIDTH = 42;

const MAX_FINDINGS = 3;
/** The ADR inspector is a navigation list, not the old three-row summary. */
const MAX_DECISION_RECORDS = 50;

/** The fields `orderDecisionRecordsForDisplay` needs to rank a governance record. */
export interface DecisionRecordDisplayOrderInput {
  readonly id: string;
  readonly status: string;
  readonly record_number: number;
}

/**
 * Canonical ADR-record display order: proposed/draft first, then newest
 * record number, id as the final tiebreak -- capped to `MAX_DECISION_RECORDS`
 * exactly as the rendered rail is. This is the single source of truth for
 * that order: `projectGovernance` renders records in exactly this sequence,
 * and any other consumer (the sticky default selection and Up/Down cycling
 * behind the inspector rail, `packages/arbor-mcp/src/tui.ts`'s
 * `consoleAdrRecords`) must call this same function rather than re-deriving
 * an independent sort -- two orderings that must be kept in sync is exactly
 * the bug this closes (a raw ascending-by-record-number list backed
 * selection while the rail displayed descending order, so the sticky default
 * landed at the visual bottom and Up/Down moved opposite to the screen).
 */
export function orderDecisionRecordsForDisplay<T extends DecisionRecordDisplayOrderInput>(records: readonly T[]): T[] {
  return [...records]
    .sort((left, right) => {
      const leftActive = left.status === "proposed" || left.status === "draft" ? 1 : 0;
      const rightActive = right.status === "proposed" || right.status === "draft" ? 1 : 0;
      return rightActive - leftActive || right.record_number - left.record_number || left.id.localeCompare(right.id);
    })
    .slice(0, MAX_DECISION_RECORDS);
}
const MAX_LIVE_AGENTS = 8;
const MAX_DEVTOOLS_LINES = 50;
const DECISION_ORDER = ["accepted", "proposed", "draft", "rejected", "superseded"] as const;

/** Operator-owned preference.  `shown` deliberately overrides auto breakpoints. */
export type ResponsiveSidebarVisibility = "auto" | "shown" | "hidden";
/**
 * The persistent right-inspector's explicit, composition-owned tab state.
 * `git` / `governance` / `inspect` are the M2 rail tabs (ui-spec §4);
 * `project` / `docs` / `devtools` are the pre-M2 tabs, still valid values
 * (reachable through the palette or the equivalent full screen — nothing
 * routes to them by default any more) so no stored preference or in-flight
 * projection becomes invalid.
 */
export type ResponsiveInspectorTab = "project" | "adrs" | "docs" | "devtools" | "git" | "governance" | "inspect";

/** The M2 rail's own three tabs (ui-spec §4): its own tab bar and hit-testing render only these. */
export const RAIL_TABS: readonly ResponsiveInspectorTab[] = ["git", "governance", "inspect"];

/**
 * Every tab `Tab`/Left/Right cycle through, in cycle order. The M2 tabs come
 * first (they are where a fresh rail opens, `initialModel`'s
 * `focus.rail_tab: "git"`); the pre-M2 tabs are not removed from the cycle
 * (ui-spec §4: "nothing is deleted without a replacement route") — they are
 * simply no longer the default landing tabs.
 */
export const ALL_INSPECTOR_TABS: readonly ResponsiveInspectorTab[] = [...RAIL_TABS, "project", "adrs", "docs", "devtools"];

/** `overlay` is visible but must not consume the transcript's layout width. */
export type ResponsiveSidebarMode = "docked" | "overlay" | "hidden";

export interface ResponsiveSidebarSelection {
  readonly task_id?: string;
  readonly operation_id?: string;
  readonly session_id?: string;
  /** Exact governance record identity, never a title-derived surrogate. */
  readonly adr_id?: string;
}

/** A terse, streaming-compatible agent update supplied by the composition layer. */
export interface ResponsiveSidebarAgentUpdate {
  readonly agent?: string;
  readonly task_id?: string;
  readonly operation_id?: string;
  readonly session_id?: string;
  readonly summary?: string;
}

export interface ResponsiveSidebarInput {
  readonly width: number;
  readonly visibility: ResponsiveSidebarVisibility;
  /** Result envelope or bare `GovernanceSnapshot`; the source is runtime-owned. */
  readonly governance?: unknown;
  /** Result envelope or bare `AgentRegistryView`; the source is runtime-owned. */
  readonly agents?: unknown;
  /** Result envelope or bare `harness.session.list` value. */
  readonly sessions?: unknown;
  /** Result envelope or bare `campaign.tree` value for the selected campaign. */
  readonly campaign_tree?: unknown;
  /** Real ADR-076 registry projection (`project.registry.list`), not a filesystem tree. */
  readonly project_registry?: unknown;
  /** Composition-owned, bounded observation of the current checkout. */
  readonly repository_tree?: unknown;
  /** Bounded `devtools.stream` projection; never a substitute transcript. */
  readonly devtools?: unknown;
  /** Defaults to the project registry because it is the operator's contextual landing view. */
  readonly tab?: ResponsiveInspectorTab;
  readonly focused?: boolean;
  readonly documents?: readonly { readonly path: string; readonly title: string }[];
  readonly selected_document?: string | null;
  readonly document?: { readonly title: string; readonly source_path: string; readonly content: string } | null;
  readonly scroll_offset?: number;
  /** Optional incremental summaries associated with a real live agent. */
  readonly agent_updates?: readonly ResponsiveSidebarAgentUpdate[];
  /** Stable selection supplied by a feed/session controller. */
  readonly selected?: ResponsiveSidebarSelection;
  /**
   * Unresolved-interview count for the Governance tab (ui-spec §4:
   * "add unresolved-interview count"). `undefined` when the composition
   * root has not supplied a real count — the tab must then say "unavailable",
   * never fabricate a zero.
   */
  readonly interview_unresolved_count?: number;
  /** ADR-161 read-model projection for the Inspect tab; `undefined` before the composition root has folded any events. */
  readonly inspect?: InspectSummary;
  /** M6 authoritative action lookup, shown alongside the folded event read model. */
  readonly inspect_action?: unknown;
  /** Durable M6 side-query history; bounded by the composition root to the latest records. */
  readonly inspect_history?: readonly unknown[];
  /** Active side-question or promotion-reason input prompt. */
  readonly inspect_prompt?: string | null;
}

export interface ResponsiveSidebarDecisionCount {
  readonly status: string;
  readonly count: number;
}

export interface ResponsiveSidebarDecisionRecord {
  readonly id: string;
  readonly title: string;
  readonly status: string;
  readonly source_path: string;
  /** Semantic tone only; the caller decides how/if terminal colour is emitted. */
  readonly tone: "success" | "warning" | "danger" | "muted";
  readonly selected: boolean;
}

export interface ResponsiveSidebarProjectEntry {
  readonly project_id: string;
  readonly path: string;
  readonly verified_at_revision: string;
  readonly expires: string;
  readonly ok: boolean;
  readonly failure_codes: readonly string[];
}

export interface ResponsiveSidebarDevToolsLine {
  readonly seq: number;
  readonly event_kind: string;
  readonly node_id: string | null;
  readonly node_state: string | null;
  readonly synthetic: boolean;
}

export interface ResponsiveSidebarFinding {
  readonly rule_id: string;
  readonly severity: string;
  readonly subject: string;
  readonly detail: string;
}

/**
 * Session-backed rows are the only rows with an exact, switchable feed
 * identity.  Task/operation identities remain useful truthful fallback status
 * when no session/tree join can be proven.
 */
export interface ResponsiveSidebarAgentRow {
  readonly id: string;
  readonly source: "session" | "agent";
  readonly agent: string;
  readonly task_id?: string;
  readonly operation_id?: string;
  readonly session_id?: string;
  readonly campaign_id?: string;
  readonly node_id?: string;
  readonly switchable: boolean;
  readonly state: string;
  readonly kind: string;
  readonly work: string;
  readonly selected: boolean;
}

export interface ResponsiveSidebarProjection {
  readonly documents?: ResponsiveSidebarInput["documents"];
  readonly selected_document?: string | null;
  readonly document?: ResponsiveSidebarInput["document"];
  readonly scroll_offset?: number;
  readonly mode: ResponsiveSidebarMode;
  readonly tab: ResponsiveInspectorTab;
  readonly focused: boolean;
  readonly inspect_action?: unknown;
  readonly inspect_history?: readonly unknown[];
  readonly inspect_prompt?: string | null;
  readonly project: {
    readonly state: "ready" | "pending" | "failed" | "unrecognised";
    readonly present?: boolean;
    readonly total?: number;
    readonly entries: readonly ResponsiveSidebarProjectEntry[];
    readonly repository_root?: string;
    readonly repository_entries: readonly { readonly path: string; readonly status: string; readonly kind: string }[];
    readonly message?: string;
  };
  readonly adr: {
    readonly state: "ready" | "pending" | "failed" | "unrecognised";
    readonly total?: number;
    readonly decisions: readonly ResponsiveSidebarDecisionCount[];
    /** Proposed/draft decisions first, then newest records, from the live corpus scan. */
    readonly records: readonly ResponsiveSidebarDecisionRecord[];
    readonly findings: readonly ResponsiveSidebarFinding[];
    readonly message?: string;
    /** `undefined` means the composition root did not supply interview data (Governance tab shows "unavailable"), never a guessed zero. */
    readonly interview_unresolved_count?: number;
  };
  readonly agents: {
    readonly state: "ready" | "pending" | "failed" | "unrecognised";
    readonly active_count?: number;
    readonly rows: readonly ResponsiveSidebarAgentRow[];
    readonly message?: string;
  };
  readonly devtools: {
    readonly state: "ready" | "pending" | "failed" | "unrecognised";
    readonly campaign_id: string | null;
    readonly lines: readonly ResponsiveSidebarDevToolsLine[];
    readonly message?: string;
  };
  /** ADR-161 read-model projection for the Inspect tab; `undefined` before it is wired. */
  readonly inspect?: InspectSummary;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function text(value: unknown, fallback = "?"): string {
  return typeof value === "string" && value.trim().length > 0
    ? sanitizeUntrustedTerminalText(value).trim()
    : fallback;
}

function subject(value: unknown): string {
  if (!isRecord(value)) return "?";
  if (typeof value.record_id === "string") return text(value.record_id);
  if (typeof value.kind === "string" && typeof value.path === "string") return `${text(value.kind)}:${text(value.path)}`;
  return "?";
}

type EnvelopeState =
  | { readonly kind: "pending" }
  | { readonly kind: "failed"; readonly message: string }
  | { readonly kind: "value"; readonly value: unknown };

function unwrap(value: unknown): EnvelopeState {
  if (value === undefined || value === null) return { kind: "pending" };
  if (!isRecord(value)) return { kind: "value", value };
  if (value.ok !== false && value.ok !== true) return { kind: "value", value };
  if (value.ok === false) {
    const error = isRecord(value.error) ? value.error : undefined;
    return { kind: "failed", message: text(error?.message, "unknown runtime failure") };
  }
  return { kind: "value", value: value.value };
}

function sidebarMode(width: number, visibility: ResponsiveSidebarVisibility): ResponsiveSidebarMode {
  if (visibility === "hidden") return "hidden";
  if (width > RESPONSIVE_SIDEBAR_WIDE_BREAKPOINT) return "docked";
  return visibility === "shown" ? "overlay" : "hidden";
}

function adrTone(status: string): ResponsiveSidebarDecisionRecord["tone"] {
  if (status === "accepted") return "success";
  if (status === "proposed" || status === "draft") return "warning";
  if (status === "rejected") return "danger";
  return "muted";
}

function projectGovernance(value: unknown, selected: ResponsiveSidebarSelection | undefined, interviewUnresolvedCount: number | undefined): ResponsiveSidebarProjection["adr"] {
  const envelope = unwrap(value);
  if (envelope.kind === "pending") return { state: "pending", decisions: [], records: [], findings: [], interview_unresolved_count: interviewUnresolvedCount };
  if (envelope.kind === "failed") return { state: "failed", decisions: [], records: [], findings: [], message: envelope.message, interview_unresolved_count: interviewUnresolvedCount };
  if (!isRecord(envelope.value)) return { state: "unrecognised", decisions: [], records: [], findings: [], message: "unrecognised governance projection", interview_unresolved_count: interviewUnresolvedCount };
  if (envelope.value.governance_absence === true) {
    return {
      state: "ready",
      total: 0,
      decisions: [],
      records: [],
      findings: [],
      message: text(envelope.value.message, "No canonical ADRs yet."),
      interview_unresolved_count: interviewUnresolvedCount,
    };
  }

  const distribution = isRecord(envelope.value.decision_status_distribution) ? envelope.value.decision_status_distribution : undefined;
  const counts = isRecord(envelope.value.repository_counts) ? envelope.value.repository_counts : undefined;
  const findingsInput = Array.isArray(envelope.value.policy_findings) ? envelope.value.policy_findings : undefined;
  const recordsInput = Array.isArray(envelope.value.records) ? envelope.value.records : undefined;
  if (distribution === undefined && counts === undefined && findingsInput === undefined) {
    return { state: "unrecognised", decisions: [], records: [], findings: [], message: "unrecognised governance projection" };
  }

  const decisions: ResponsiveSidebarDecisionCount[] = [];
  if (distribution !== undefined) {
    for (const status of DECISION_ORDER) {
      const count = distribution[status];
      if (finite(count)) decisions.push({ status, count });
    }
  }
  const findings: ResponsiveSidebarFinding[] = [];
  if (findingsInput !== undefined) {
    for (const raw of findingsInput.slice(0, MAX_FINDINGS)) {
      if (!isRecord(raw)) continue;
      findings.push({
        rule_id: text(raw.rule_id),
        severity: text(raw.severity),
        subject: subject(raw.subject),
        detail: text(raw.detail),
      });
    }
  }
  const unorderedRecords = (recordsInput ?? [])
    .flatMap((raw): Array<Omit<ResponsiveSidebarDecisionRecord, "tone" | "selected"> & { readonly record_number: number }> => {
      if (!isRecord(raw)) return [];
      const id = text(raw.id, "");
      const sourcePath = text(raw.source_path, "");
      const status = text(raw.decision, "");
      if (id === "" || sourcePath === "" || status === "") return [];
      return [{
        id,
        title: text(raw.title, "untitled decision"),
        status,
        source_path: sourcePath,
        record_number: finite(raw.record_number) ? raw.record_number : -1,
      }];
    });
  const records = orderDecisionRecordsForDisplay(unorderedRecords)
    .map(({ record_number: _recordNumber, ...value }) => ({
      ...value,
      tone: adrTone(value.status),
      selected: selected?.adr_id === value.id,
    }));
  return {
    state: "ready",
    total: finite(counts?.adr_total) ? counts.adr_total : undefined,
    decisions,
    records,
    findings,
    interview_unresolved_count: interviewUnresolvedCount,
  };
}

function projectRegistry(value: unknown, repositoryTree: unknown): ResponsiveSidebarProjection["project"] {
  // A registry projection itself has an `ok` field, so it must be recognised
  // before generic envelope unwrapping. Otherwise a healthy bare projection
  // is mistaken for `{ok:true,value:undefined}` and becomes an invented
  // "unrecognised" state.
  const envelope = isRecord(value) && typeof value.present === "boolean" && Array.isArray(value.entries)
    ? { kind: "value" as const, value }
    : unwrap(value);
  const tree = isRecord(repositoryTree) && Array.isArray(repositoryTree.entries) ? repositoryTree : null;
  const treeEntries: readonly unknown[] = tree === null ? [] : tree.entries as readonly unknown[];
  const repositoryEntries = treeEntries.slice(0, 200).flatMap((raw): Array<{ path: string; status: string; kind: string }> => {
    if (!isRecord(raw) || typeof raw.path !== "string") return [];
    return [{ path: text(raw.path), status: text(raw.status, "tracked"), kind: text(raw.kind, "file") }];
  });
  const treeFields = {
    ...(typeof tree?.root === "string" ? { repository_root: text(tree.root) } : {}),
    repository_entries: Object.freeze(repositoryEntries),
  };
  if (envelope.kind === "pending") return { state: "pending", entries: [], ...treeFields };
  if (envelope.kind === "failed") return { state: "failed", entries: [], message: envelope.message, ...treeFields };
  if (!isRecord(envelope.value) || typeof envelope.value.present !== "boolean" || !Array.isArray(envelope.value.entries)) {
    return { state: "unrecognised", entries: [], message: "unrecognised project registry projection", ...treeFields };
  }
  const entries = envelope.value.entries.slice(0, MAX_DECISION_RECORDS).flatMap((raw): ResponsiveSidebarProjectEntry[] => {
    if (!isRecord(raw) || typeof raw.project_id !== "string" || typeof raw.path !== "string" || typeof raw.ok !== "boolean") return [];
    const failures = Array.isArray(raw.failures) ? raw.failures.flatMap((failure) => isRecord(failure) && typeof failure.code === "string" ? [text(failure.code)] : []) : [];
    return [{
      project_id: text(raw.project_id), path: text(raw.path),
      verified_at_revision: text(raw.verified_at_revision, "not reported"),
      expires: text(raw.expires, "not reported"), ok: raw.ok,
      failure_codes: Object.freeze(failures),
    }];
  });
  return {
    state: "ready", present: envelope.value.present,
    total: typeof envelope.value.entry_count === "number" && Number.isFinite(envelope.value.entry_count) ? envelope.value.entry_count : entries.length,
    entries: Object.freeze(entries), ...treeFields,
  };
}

function projectDevtools(value: unknown): ResponsiveSidebarProjection["devtools"] {
  const envelope = unwrap(value);
  if (envelope.kind === "pending") return { state: "pending", campaign_id: null, lines: [] };
  if (envelope.kind === "failed") return { state: "failed", campaign_id: null, lines: [], message: envelope.message };
  if (!isRecord(envelope.value) || !Array.isArray(envelope.value.lines)) {
    return { state: "unrecognised", campaign_id: null, lines: [], message: "unrecognised DevTools stream" };
  }
  const lines = envelope.value.lines.slice(-MAX_DEVTOOLS_LINES).flatMap((raw): ResponsiveSidebarDevToolsLine[] => {
    if (!isRecord(raw) || !finite(raw.seq) || typeof raw.event_kind !== "string") return [];
    return [{
      seq: raw.seq, event_kind: text(raw.event_kind),
      node_id: typeof raw.node_id === "string" ? text(raw.node_id) : null,
      node_state: typeof raw.node_state === "string" ? text(raw.node_state) : null,
      synthetic: raw.synthetic === true,
    }];
  });
  return {
    state: "ready",
    campaign_id: typeof envelope.value.campaign_id === "string" ? text(envelope.value.campaign_id) : null,
    lines: Object.freeze(lines),
  };
}

function updateFor(
  updates: readonly ResponsiveSidebarAgentUpdate[],
  agent: string,
  identity: { readonly task_id?: string; readonly operation_id?: string; readonly session_id?: string },
): ResponsiveSidebarAgentUpdate | undefined {
  return (identity.session_id === undefined ? undefined : updates.find((update) => update.session_id === identity.session_id))
    ?? (identity.task_id === undefined ? undefined : updates.find((update) => update.task_id === identity.task_id))
    ?? (identity.operation_id === undefined ? undefined : updates.find((update) => update.operation_id === identity.operation_id))
    ?? updates.find((update) => update.agent === agent);
}

function isSelected(row: Omit<ResponsiveSidebarAgentRow, "selected">, selected: ResponsiveSidebarSelection | undefined): boolean {
  if (selected === undefined) return false;
  return (row.task_id !== undefined && selected.task_id === row.task_id)
    || (row.operation_id !== undefined && selected.operation_id === row.operation_id)
    || (row.session_id !== undefined && selected.session_id === row.session_id);
}

function projectAgentRegistryRows(
  value: unknown,
  updates: readonly ResponsiveSidebarAgentUpdate[],
  selected: ResponsiveSidebarSelection | undefined,
): ResponsiveSidebarProjection["agents"] {
  const envelope = unwrap(value);
  if (envelope.kind === "pending") return { state: "pending", rows: [] };
  if (envelope.kind === "failed") return { state: "failed", rows: [], message: envelope.message };
  if (!isRecord(envelope.value) || !Array.isArray(envelope.value.live)) {
    return { state: "unrecognised", rows: [], message: "unrecognised agent registry" };
  }

  const rows: ResponsiveSidebarAgentRow[] = [];
  for (const raw of envelope.value.live.slice(0, MAX_LIVE_AGENTS)) {
    if (!isRecord(raw)) continue;
    // A live instance without canonical supervisor ids cannot even be an
    // honest fallback status row.  Do not manufacture one from its display
    // text or role name.
    if (typeof raw.agent !== "string" || typeof raw.task_id !== "string" || typeof raw.operation_id !== "string") continue;
    const agent = text(raw.agent);
    const taskId = text(raw.task_id);
    const operationId = text(raw.operation_id);
    const update = updateFor(updates, agent, { task_id: taskId, operation_id: operationId });
    const stable = {
      id: taskId,
      source: "agent" as const,
      agent,
      task_id: taskId,
      operation_id: operationId,
      // `agent.list` does not prove a task-to-session relation.  Even if an
      // auxiliary update happens to mention a session id, retain it only as
      // matching input above; never publish it as a feed target here.
      switchable: false,
      state: text(raw.state),
      kind: text(raw.kind),
      work: text(update?.summary, `${text(raw.state)} · ${text(raw.kind)}`),
    };
    rows.push({ ...stable, selected: isSelected(stable, selected) });
  }
  return {
    state: "ready",
    active_count: finite(envelope.value.active_agent_count) ? envelope.value.active_agent_count : undefined,
    rows,
  };
}

/**
 * Join only a live harness session to the tree node with the same campaign
 * and node identity. `action_delegate` then supplies the agent label.  An
 * approximate agent/task match is intentionally rejected: neither catalog
 * response proves it, and an unprovable row must not become a feed target.
 */
function projectSessionRows(
  sessionsValue: unknown,
  treeValue: unknown,
  updates: readonly ResponsiveSidebarAgentUpdate[],
  selected: ResponsiveSidebarSelection | undefined,
): readonly ResponsiveSidebarAgentRow[] {
  const sessions = unwrap(sessionsValue);
  const tree = unwrap(treeValue);
  if (sessions.kind !== "value" || tree.kind !== "value" || !isRecord(sessions.value) || !isRecord(tree.value)) return [];
  if (!Array.isArray(sessions.value.sessions) || !Array.isArray(tree.value.nodes) || typeof tree.value.campaign_id !== "string") return [];
  const campaignId = text(tree.value.campaign_id);
  const delegates = new Map<string, string>();
  for (const rawNode of tree.value.nodes) {
    if (!isRecord(rawNode) || typeof rawNode.id !== "string" || typeof rawNode.action_delegate !== "string") continue;
    delegates.set(rawNode.id, text(rawNode.action_delegate));
  }
  const rows: ResponsiveSidebarAgentRow[] = [];
  for (const rawSession of sessions.value.sessions.slice(0, MAX_LIVE_AGENTS)) {
    if (!isRecord(rawSession)) continue;
    // `null` terminal is the live-session contract. A missing/malformed
    // terminal cannot safely be presented as an in-flight feed.
    if (rawSession.terminal !== null) continue;
    if (typeof rawSession.session_id !== "string" || typeof rawSession.campaign_id !== "string" || typeof rawSession.node_id !== "string") continue;
    if (rawSession.campaign_id !== campaignId) continue;
    const delegate = delegates.get(rawSession.node_id);
    if (delegate === undefined) continue;
    const sessionId = text(rawSession.session_id);
    const state = text(rawSession.state);
    const operation = text(rawSession.operation);
    const update = updateFor(updates, delegate, { session_id: sessionId });
    const stable = {
      id: sessionId,
      source: "session" as const,
      agent: delegate,
      session_id: sessionId,
      campaign_id: campaignId,
      node_id: text(rawSession.node_id),
      switchable: true,
      state,
      kind: operation,
      work: text(update?.summary, `${state} · ${operation}`),
    };
    rows.push({ ...stable, selected: isSelected(stable, selected) });
  }
  return rows;
}

function projectAgents(
  agentsValue: unknown,
  sessionsValue: unknown,
  treeValue: unknown,
  updates: readonly ResponsiveSidebarAgentUpdate[],
  selected: ResponsiveSidebarSelection | undefined,
): ResponsiveSidebarProjection["agents"] {
  const sessionRows = projectSessionRows(sessionsValue, treeValue, updates, selected);
  // Session rows are preferred because they are the only rows whose agent
  // role comes from the exact delegated node and have a real session target.
  if (sessionRows.length > 0) return { state: "ready", active_count: sessionRows.length, rows: sessionRows };
  return projectAgentRegistryRows(agentsValue, updates, selected);
}

/** Projects runtime-owned ADR and agent snapshots into a bounded sidebar model. */
export function projectResponsiveSidebar(input: ResponsiveSidebarInput): ResponsiveSidebarProjection {
  return {
    mode: sidebarMode(Math.max(0, input.width), input.visibility),
    tab: input.tab ?? "project",
    focused: input.focused === true,
    inspect_action: input.inspect_action,
    inspect_history: input.inspect_history,
    inspect_prompt: input.inspect_prompt,
    documents: input.documents,
    selected_document: input.selected_document,
    document: input.document,
    scroll_offset: input.scroll_offset,
    project: projectRegistry(input.project_registry, input.repository_tree),
    adr: projectGovernance(input.governance, input.selected, input.interview_unresolved_count),
    agents: projectAgents(input.agents, input.sessions, input.campaign_tree, input.agent_updates ?? [], input.selected),
    devtools: projectDevtools(input.devtools),
    inspect: input.inspect,
  };
}

function pad(value: string, width: number): string {
  return value + " ".repeat(Math.max(0, width - displayWidth(stripAnsi(value))));
}

function separator(width: number): string {
  return "─".repeat(Math.max(1, width));
}

/**
 * Rail content is frequently wider than the 40-column rail (repository roots
 * and long file paths especially). A plain clip cut them mid-token with no
 * mark, so a truncated absolute path read as a complete one — the operator had
 * no way to tell `/mnt/sda2/revoy2/tui-walk-2026-09-02/s1-` from a real
 * directory name. ADR-126 Decision 2's convention for this file's own clipping
 * is that truncation must be VISIBLE, so the ellipsis form is used here.
 */
function line(value: string, width: number): string {
  return clipLabelWithEllipsis(value, Math.max(1, width));
}

function framed(lines: readonly string[], width: number, focused: boolean, theme: RunTheme | null, mode: ColorMode): readonly string[] {
  const actual = Math.max(1, width);
  if (actual < 3) return lines.map((value) => line(value, actual));
  const inner = actual - 2;
  const border = (value: string): string => styled(value, focused ? "accent" : "border", theme, mode);
  const vertical = focused ? "║" : "│";
  const top = focused ? clipLabelWithEllipsis(" FOCUSED ", inner).padEnd(inner, "═") : separator(inner);
  return [
    border(`${focused ? "╔" : "┌"}${top}${focused ? "╗" : "┐"}`),
    ...lines.map((value) => `${border(vertical)}${pad(line(value, inner), inner)}${border(vertical)}`),
    border(focused ? `╚${"═".repeat(inner)}╝` : `└${separator(inner)}┘`),
  ];
}

function styled(value: string, role: PaletteRole, theme: RunTheme | null, mode: ColorMode): string {
  return theme === null ? value : `${toForegroundSgr(theme.colors[role], mode)}${value}${ANSI.reset}`;
}

/**
 * EC-059: at 40 columns the rail cannot show three full labels, and the
 * frame's clip elided the ACTIVE one (`PROJECT | ADRS | [DE…`). The active
 * label is the one fact the strip exists to convey, so it wins the width and
 * the inactive labels compress to initials when the full strip does not fit.
 */
export function tabBar(tab: ResponsiveInspectorTab, theme: RunTheme | null, mode: ColorMode, width = Number.POSITIVE_INFINITY): string {
  const tabs: readonly [ResponsiveInspectorTab, string][] = RAIL_TABS.includes(tab)
    ? [["git", "GIT"], ["governance", "GOVERNANCE"], ["inspect", "INSPECT"]]
    : [["project", "PROJECT"], ["adrs", "ADRS"], ["docs", "DOCS"], ["devtools", "DEVTOOLS"]];
  const compose = (compact: boolean): string => tabs
    .map(([id, label]) => (id === tab ? styled(`[${label}]`, "accent", theme, mode) : styled(compact ? label[0]! : label, "muted", theme, mode)))
    .join(" | ");
  const plainWidth = (compact: boolean): number => displayWidth(tabs.map(([id, label]) => (id === tab ? `[${label}]` : compact ? label[0]! : label)).join(" | "));
  return plainWidth(false) <= width ? compose(false) : compose(true);
}

/** Resolve a zero-based interior column against the labels actually painted. */
export function sidebarTabAtColumn(tab: ResponsiveInspectorTab, column: number, width: number): ResponsiveInspectorTab | null {
  if (!Number.isInteger(column) || column < 0 || column >= width) return null;
  const ids = RAIL_TABS.includes(tab) ? RAIL_TABS : (["project", "adrs", "docs", "devtools"] as const);
  const labels = tabBar(tab, null, "truecolor", width).split(" | ");
  let start = 0;
  for (let index = 0; index < labels.length; index++) {
    const end = start + displayWidth(labels[index]!);
    if (column >= start && column < end) return ids[index] ?? null;
    start = end + 3;
  }
  return null;
}

function stateMessage(state: "pending" | "failed" | "unrecognised", message: string | undefined, subject: string): string {
  return state === "pending" ? `${subject} awaiting projection.` : `${subject} ${state}: ${message ?? "unknown"}`;
}

/**
 * Human wording for a `git status --porcelain=v1` code.
 *
 * The previous mapping matched only the exact single letters "M", "A" and "D",
 * so every COMPOUND code fell through and was printed raw: a file staged and
 * then edited again showed as `main.go · AM` beside neighbours reading
 * `added` and `new`. That is git plumbing leaking into an operator surface,
 * and the inconsistency is worse than either vocabulary alone.
 *
 * Porcelain codes are two columns, X (index) and Y (worktree); the upstream
 * observation trims them, so "A " arrives as "A" and " M" as "M". Conflict and
 * rename states are checked before the plain letters because they carry the
 * more important fact. An unrecognised code is returned VERBATIM rather than
 * guessed at -- a wrong word about the operator's working tree is worse than
 * an opaque one.
 */
function checkoutStatusLabel(code: string): string {
  const raw = code.trim();
  if (raw === "" || raw === "new" || raw === "tracked") return raw === "" ? "modified" : raw;
  if (raw === "??") return "new";
  if (raw === "UU" || raw === "AA" || raw === "DD" || raw.includes("U")) return "conflicted";
  const index = raw[0] ?? "";
  const worktree = raw.length > 1 ? raw[1]! : "";
  const word = (letter: string): string | null => letter === "M" ? "modified"
    : letter === "A" ? "added"
    : letter === "D" ? "deleted"
    : letter === "R" ? "renamed"
    : letter === "C" ? "copied"
    : letter === "T" ? "retyped"
    : null;
  const staged = word(index);
  const unstaged = word(worktree);
  if (staged !== null && unstaged !== null) return staged === unstaged ? staged : `${staged}, ${unstaged} since`;
  return staged ?? unstaged ?? raw;
}

function projectTabBody(projection: ResponsiveSidebarProjection, width: number, theme: RunTheme | null, mode: ColorMode): string[] {
  const body = [styled("PROJECT REPO", "info", theme, mode)];
  if (projection.project.repository_root !== undefined) body.push(styled(projection.project.repository_root, "muted", theme, mode));
  if (projection.project.repository_entries.length === 0) body.push("Repository clean; no generated changes.");
  else {
    body.push("", styled("LIVE FILE TREE", "info", theme, mode));
    let priorDirectories: string[] = [];
    for (const entry of projection.project.repository_entries) {
      const segments = entry.path.split("/");
      const leaf = segments.pop() ?? entry.path;
      let shared = 0;
      while (shared < segments.length && priorDirectories[shared] === segments[shared]) shared += 1;
      for (let index = shared; index < segments.length; index += 1) {
        body.push(styled(`${"  ".repeat(Math.min(3, index))}▸ ${segments[index]}`, "info", theme, mode));
      }
      const status = checkoutStatusLabel(entry.status);
      const tone: PaletteRole = status.includes("conflicted") || status.includes("deleted") ? "danger"
        : status === "added" || status === "new" ? "success" : status.includes("modified") ? "warning" : "text";
      body.push(styled(`${"  ".repeat(Math.min(3, segments.length))}${entry.kind === "directory" ? "▸" : "└"} ${leaf} · ${status}`, tone, theme, mode));
      priorDirectories = segments;
    }
  }
  body.push("", styled("GOVERNANCE · ADRs → ADRS tab", "special", theme, mode));
  if (projection.project.state === "ready") {
    const count = projection.project.total ?? projection.project.entries.length;
    body.push(projection.project.present === false
      ? "No project registry exists yet."
      : `${count} enrolled project${count === 1 ? "" : "s"} · fresh discharge`);
    if (projection.project.entries.length === 0) {
      body.push("No governed projects reported.");
    } else {
      for (const entry of projection.project.entries) {
        const disposition = entry.ok ? "✓ discharged" : `! ${entry.failure_codes.join(", ") || "discharge failed"}`;
        body.push(styled(`${entry.project_id} · ${disposition}`, entry.ok ? "success" : "danger", theme, mode), styled(`  ${entry.path}`, "muted", theme, mode), styled(`  revision ${entry.verified_at_revision} · expires ${entry.expires}`, "muted", theme, mode));
      }
    }
  } else if (projection.project.repository_entries.length === 0) {
    body.push(...wrapDisplay(stateMessage(projection.project.state, projection.project.message, "Project registry"), Math.max(1, width - 2)));
  }

  return body;
}

function statusGlyph(status: string): string {
  if (status === "accepted") return "✓";
  if (status === "proposed") return "•";
  if (status === "draft") return "○";
  if (status === "rejected") return "!";
  if (status === "superseded") return "↻";
  return "?";
}

export function adrTabBody(projection: ResponsiveSidebarProjection, width: number, theme: RunTheme | null, mode: ColorMode): string[] {
  const body = [styled("ARCHITECTURAL DECISIONS", "info", theme, mode)];
  if (projection.adr.state === "ready") {
    const headline = [projection.adr.total === undefined ? undefined : `${projection.adr.total} ADRs`, ...projection.adr.decisions.map((item) => `${item.status} ${item.count}`)]
      .filter((value): value is string => value !== undefined).join(" · ");
    body.push(headline || "ADR status reported without counts");
    if (projection.adr.message !== undefined) body.push(...wrapDisplay(projection.adr.message, Math.max(1, width - 2)));
    // Say "there are none" ONCE. With a message present the rail read
    // an empty count / "No canonical ADRs yet — the first governed decision will
    // create the project decision store." / "No governed ADR records
    // reported." — the same fact three times in four lines, which reads as a
    // fault rather than an empty state. The headline already carries the
    // count, so this line is only needed when nothing else explained the
    // absence.
    if (projection.adr.records.length === 0) {
      // Say "there are none" ONCE, and never advertise an action with nothing
      // to act on. The rail previously repeated the empty count / "No canonical ADRs yet
      // — the first governed decision will create the project decision store."
      // / "No governed ADR records reported." — the same fact three times in
      // four lines. The headline already carries the count and `message`
      // explains the absence when present, so this line is only the fallback
      // for when nothing else did. `ENTER · OPEN DETAIL` stays with the
      // records it belongs to.
      if (projection.adr.message === undefined) body.push("No governed ADR records reported.");
    } else {
      body.push("", styled("ENTER · OPEN DETAIL", "accent", theme, mode));
      for (const decision of projection.adr.records) {
        // Tone is retained on the record for the color-capable caller; the
        // glyph keeps the status legible in monochrome terminals too.
        body.push(styled(`${selectedRowMarker(decision.selected)} ${statusGlyph(decision.status)} ${decision.id} · ${decision.status}`, decision.tone, theme, mode), `  ${decision.title}`);
      }
    }
    if (projection.adr.findings.length > 0) {
      body.push("", styled("POLICY FINDINGS", "warning", theme, mode));
      for (const finding of projection.adr.findings) body.push(styled(`${finding.severity} ${finding.rule_id} · ${finding.subject}`, "warning", theme, mode), `  ${finding.detail}`);
    }
  } else body.push(...wrapDisplay(stateMessage(projection.adr.state, projection.adr.message, "ADR status"), Math.max(1, width - 2)));
  return body;
}

function devtoolsTabBody(projection: ResponsiveSidebarProjection, width: number, theme: RunTheme | null, mode: ColorMode): string[] {
  const body = [styled("DEVTOOLS · SUPPLEMENTAL DIAGNOSTICS", "info", theme, mode)];
  if (projection.devtools.state === "ready") {
    body.push(styled(projection.devtools.campaign_id === null ? "No campaign scoped by the stream." : `campaign ${projection.devtools.campaign_id}`, projection.devtools.campaign_id === null ? "warning" : "muted", theme, mode));
    if (projection.devtools.lines.length === 0) body.push("No DevTools events reported.");
    else for (const event of projection.devtools.lines) {
      const identity = [event.node_id, event.node_state].filter((value): value is string => value !== null).join(" · ");
      const tone: PaletteRole = event.synthetic ? "warning"
        : event.node_state === "failed" || /(?:failed|rejected|error)/.test(event.event_kind) ? "danger"
        : event.node_state === "verified" || event.event_kind === "loop.node_verified" ? "success"
        : /(?:claimed|backtrack|interrupt|halt)/.test(event.event_kind) ? "warning"
        : event.event_kind.startsWith("kb.") ? "special"
        : /(?:tool|dispatch|branch|tree\.)/.test(event.event_kind) ? "info" : "muted";
      body.push(styled(`${event.synthetic ? "~" : "·"} ${event.seq} ${event.event_kind}${identity ? ` · ${identity}` : ""}`, tone, theme, mode));
    }
  } else body.push(...wrapDisplay(stateMessage(projection.devtools.state, projection.devtools.message, "DevTools"), Math.max(1, width - 2)));
  return body;
}

/**
 * Git tab (ui-spec §4, M2): re-homes the existing porcelain file list
 * (`projectTabBody`'s "LIVE FILE TREE" section, `responsive-sidebar.ts:628-
 * 661` pre-M2) plus branch/HEAD when the product surface carries it. No
 * producer supplies a branch/HEAD fact today, so this states that plainly
 * rather than omitting the line or guessing at `git symbolic-ref`.
 */
function gitTabBody(projection: ResponsiveSidebarProjection, theme: RunTheme | null, mode: ColorMode): string[] {
  const body = [styled("GIT", "info", theme, mode)];
  if (projection.project.repository_root !== undefined) body.push(styled(projection.project.repository_root, "muted", theme, mode));
  body.push(styled("branch: unavailable", "muted", theme, mode));
  if (projection.project.repository_entries.length === 0) {
    body.push("", "Repository clean; no generated changes.");
    return body;
  }
  body.push("", styled("LIVE FILE TREE", "info", theme, mode));
  let priorDirectories: string[] = [];
  for (const entry of projection.project.repository_entries) {
    const segments = entry.path.split("/");
    const leaf = segments.pop() ?? entry.path;
    let shared = 0;
    while (shared < segments.length && priorDirectories[shared] === segments[shared]) shared += 1;
    for (let index = shared; index < segments.length; index += 1) {
      body.push(styled(`${"  ".repeat(Math.min(3, index))}▸ ${segments[index]}`, "info", theme, mode));
    }
    const status = checkoutStatusLabel(entry.status);
    const tone: PaletteRole = status.includes("conflicted") || status.includes("deleted") ? "danger"
      : status === "added" || status === "new" ? "success" : status.includes("modified") ? "warning" : "text";
    body.push(styled(`${"  ".repeat(Math.min(3, segments.length))}${entry.kind === "directory" ? "▸" : "└"} ${leaf} · ${status}`, tone, theme, mode));
    priorDirectories = segments;
  }
  return body;
}

/**
 * Governance tab (ui-spec §4, M2): re-homes `adrTabBody` verbatim and adds
 * an unresolved-interview count line when the composition root supplied one
 * (`interview_unresolved_count`); says "unavailable" rather than a guessed
 * zero when it did not.
 */
function governanceTabBody(projection: ResponsiveSidebarProjection, width: number, theme: RunTheme | null, mode: ColorMode): string[] {
  const body = adrTabBody(projection, width, theme, mode);
  const count = projection.adr.interview_unresolved_count;
  body.push(
    "",
    styled(
      count === undefined ? "unresolved interviews: unavailable" : `unresolved interviews: ${count}`,
      count === undefined ? "muted" : count > 0 ? "warning" : "muted",
      theme,
      mode,
    ),
  );
  return body;
}

/**
 * Inspect tab (ui-spec §4, M2): structured state of the selected/most-recent
 * task from the ADR-161 read model. Always shows the watermark, and never
 * renders "nothing running" while `resync_required` — a resync means the
 * projection cannot prove nothing is running, a weaker and different claim
 * (see `InspectSummary`'s own doc comment, read-model.ts).
 */
function inspectTabBody(projection: ResponsiveSidebarProjection, theme: RunTheme | null, mode: ColorMode): string[] {
  const body = [styled("INSPECT", "info", theme, mode)];
  const appendAction = (): void => {
    const action = projection.inspect_action;
    if (!isRecord(action)) return;
    body.push("", styled("ACTION SNAPSHOT", "info", theme, mode), `id ${text(action.action_id, "unknown")} · ${text(action.lifecycle, "unknown")}`, `owner ${text(action.owner, "unknown")} · as of ${text(action.as_of, "unknown")}`);
    const evidence = Array.isArray(action.evidence_ids) ? action.evidence_ids.filter((id): id is string => typeof id === "string") : [];
    body.push(`evidence ${evidence.length === 0 ? "unknown" : evidence.join(", ")}`);
    const dependencies = Array.isArray(action.dependencies) ? action.dependencies.filter((id): id is string => typeof id === "string") : [];
    body.push(`dependencies ${dependencies.length === 0 ? "unknown" : dependencies.join(", ")}`);
  };
  const appendSideHistory = (): void => {
    const history = projection.inspect_history ?? [];
    for (const value of history.slice(-3)) {
      if (!isRecord(value)) continue;
      const answer = isRecord(value.answer) ? value.answer : null;
      body.push("", `${text(value.status, "unknown").toUpperCase()} · ${text(value.request_id, "side query")}`);
      body.push(`Q ${text(value.question, "question unavailable")}`);
      if (answer !== null) body.push(`A ${text(answer.text, "answer unavailable")}`);
      if (typeof value.promoted_command_id === "string") body.push(`promoted ${value.promoted_command_id}`);
    }
    if (projection.inspect_prompt !== undefined && projection.inspect_prompt !== null) {
      body.push("", styled(projection.inspect_prompt, "warning", theme, mode));
    } else {
      body.push("", styled("? ask · p promote latest answer", "muted", theme, mode));
    }
  };
  const inspect = projection.inspect;
  if (inspect === undefined) {
    body.push(styled("read model not yet wired", "muted", theme, mode));
    appendAction();
    appendSideHistory();
    return body;
  }
  body.push(styled(`watermark seq ${inspect.watermark_seq}`, "muted", theme, mode));
  if (inspect.status === "resync_required") {
    body.push(styled(inspect.resync_note ?? "resync required", "warning", theme, mode));
    appendAction();
    appendSideHistory();
    return body;
  }
  if (inspect.resync_note !== null) body.push(styled(inspect.resync_note, "muted", theme, mode));
  if (inspect.task === null) {
    body.push("", "No task selected or observed yet.");
    appendAction();
    appendSideHistory();
    return body;
  }
  const task = inspect.task;
  body.push(
    "",
    styled(`${task.kind} · owner ${task.owner_scope_id}`, "info", theme, mode),
    `task ${task.task_id} · operation ${task.operation_id}`,
    `retry_attempt ${task.retry_attempt} · state ${task.state}`,
    `started ${task.started_at ?? "unknown"} · deadline ${task.deadline_at ?? "none"}`,
  );
  if (inspect.gates.length > 0) {
    body.push("", styled("LATEST GATE RESULTS", "info", theme, mode));
    for (const gate of inspect.gates) {
      const tone: PaletteRole = gate.result === "pass" ? "success" : gate.result === "fail" ? "danger" : "warning";
      body.push(styled(`${gate.gate}${gate.node_id === null ? "" : ` · ${gate.node_id}`} · ${gate.result}`, tone, theme, mode));
    }
  }
  appendAction();
  appendSideHistory();
  return body;
}

/** Renders one selected inspector tab; the caller composes it docked or overlayed. */
function sidebarViewportStart(length: number, selected: number, offset: number, contentBudget: number): number {
  let start = Math.min(Math.max(0, offset), Math.max(0, length - contentBudget));
  if (selected >= start + contentBudget - 1) start = Math.max(0, selected - contentBudget + 3);
  if (selected >= 0 && selected < start) start = selected;
  return start;
}

/** Exact frame-local document row identities; never match truncated labels. */
export function sidebarDocumentRows(projection: ResponsiveSidebarProjection, height: number): readonly { row: number; path: string }[] {
  if (projection.mode === "hidden" || projection.tab !== "docs" || projection.document || height <= 0) return [];
  const documents = projection.documents ?? [];
  if (documents.length === 0) return [];
  const selected = documents.findIndex((entry) => entry.path === projection.selected_document);
  const length = 3 + documents.length;
  const start = sidebarViewportStart(length, selected < 0 ? -1 : selected + 3, projection.scroll_offset ?? 0, Math.max(1, height - 5));
  const overflow = 3 + length - start > Math.max(1, height - 2);
  return documents.flatMap((entry, index) => {
    const row = 7 + index - start;
    return row >= 4 && row < height - (overflow ? 2 : 1) ? [{ row, path: entry.path }] : [];
  });
}

/**
 * Exact frame-local ADR row identities, the rail's `adrs`-tab counterpart to
 * `sidebarDocumentRows` above. There was previously no such function at all:
 * a mouse click over an ADR row in the rail had nowhere to land, unlike a
 * click on a Docs row (`onNativePaneHit`'s `inspector_document_rows` lookup,
 * `tui.ts`). Rather than re-deriving `adrTabBody`'s line count by hand (a
 * second, driftable count of its header/message/findings preamble), this
 * locates each record's own marker line by its unique `decision.id` text
 * inside the SAME content array `adrTabBody` produces for real rendering,
 * then reuses the identical viewport/overflow arithmetic
 * `sidebarDocumentRows` already established for this rail.
 */
export function sidebarAdrRows(
  projection: ResponsiveSidebarProjection,
  height: number,
  width: number,
  theme: RunTheme | null,
  mode: ColorMode,
): readonly { row: number; id: string }[] {
  if (projection.mode === "hidden" || (projection.tab !== "adrs" && projection.tab !== "governance") || projection.document || height <= 0) return [];
  if (projection.adr.state !== "ready" || projection.adr.records.length === 0) return [];
  const boundedWidth = Math.max(1, Math.min(RESPONSIVE_SIDEBAR_WIDTH, width));
  const content = adrTabBody(projection, boundedWidth, theme, mode);
  // Each record's marker line is unique because it interpolates the
  // record's own id directly (`adrTabBody`'s `${marker} ${glyph} ${id} · ${status}`);
  // no other line in this body can contain it.
  const contentIndexById = new Map<string, number>();
  for (const record of projection.adr.records) {
    const index = content.findIndex((line) => line.includes(record.id));
    if (index >= 0) contentIndexById.set(record.id, index);
  }
  const selectedRecord = projection.adr.records.find((record) => record.selected === true);
  const selected = selectedRecord === undefined ? -1 : contentIndexById.get(selectedRecord.id) ?? -1;
  const start = sidebarViewportStart(content.length, selected, projection.scroll_offset ?? 0, Math.max(1, height - 5));
  const overflow = 3 + content.length - start > Math.max(1, height - 2);
  const rows: { row: number; id: string }[] = [];
  for (const [id, contentIndex] of contentIndexById) {
    const row = 4 + contentIndex - start;
    if (row >= 4 && row < height - (overflow ? 2 : 1)) rows.push({ row, id });
  }
  return rows;
}

/** Same theme/width defaulting `renderResponsiveSidebar` uses, exposed so a row-identity lookup (`sidebarAdrRows`) renders the identical content array a click is actually resolved against. */
export function resolveRailRenderOptions(options: { width?: number; color?: boolean; theme?: RunTheme; color_mode?: ColorMode }): { width: number; theme: RunTheme | null; mode: ColorMode } {
  return {
    width: Math.max(1, Math.min(RESPONSIVE_SIDEBAR_WIDTH, options.width ?? RESPONSIVE_SIDEBAR_WIDTH)),
    theme: options.color === true ? options.theme ?? deriveTheme(undefined) : null,
    mode: options.color_mode ?? "truecolor",
  };
}

export function renderResponsiveSidebar(projection: ResponsiveSidebarProjection, options: { width?: number; height: number; color?: boolean; theme?: RunTheme; color_mode?: ColorMode; supplemental_lines?: readonly string[] }): readonly string[] {
  if (projection.mode === "hidden" || options.height <= 0) return [];
  const width = Math.max(1, Math.min(RESPONSIVE_SIDEBAR_WIDTH, options.width ?? RESPONSIVE_SIDEBAR_WIDTH));
  const theme = options.color === true ? options.theme ?? deriveTheme(undefined) : null;
  const mode = options.color_mode ?? "truecolor";
  // Advertise only what this tab can actually do. `↑/↓ select` and
  // `Enter open` are wired for the ADR list alone (`tui.ts` handles up/down
  // and Enter under `consoleInspectorTab === "adrs"`), so showing them while
  // the PROJECT or DEVTOOLS tab is focused promised the operator a selection
  // and an open that no key would ever perform -- and on an empty ADR store
  // there is likewise nothing to open.
  const adrSelectable = (projection.tab === "adrs" || projection.tab === "governance") && projection.adr.state === "ready" && projection.adr.records.length > 0;
  // "Esc close" was wrong and was introduced by the very change that removed
  // the other false affordances here. `tui.ts`'s `toggleConsoleRailFocus` does
  // not alter sidebar VISIBILITY at all despite its name — it swaps focus
  // between the rail and the composer — so Escape returns the operator to the
  // composer and leaves the rail on screen. Applying EC-004 #8 (hints must
  // name an action that exists; Claude Code phrases these as "esc to cancel"
  // / "esc to clear input", OpenCode supplies them per dialog via
  // `footerHints`).
  const selectable = adrSelectable || (projection.tab === "docs" && (projection.documents?.length ?? 0) > 0);
  const focusedHint = projection.document ? "↑/↓ scroll · ? query · Esc back"
    : selectable ? "↑/↓ select · Enter open · ? query" : "←/→ tabs · Esc return to screen";
  const header = [tabBar(projection.tab, theme, mode, Math.max(1, width - 2)), styled(projection.focused ? focusedHint : "Ctrl+B focus · Tab switch tabs", projection.focused ? "accent" : "muted", theme, mode), ""];
  const content = projection.document
    ? [styled(projection.document.title, "info", theme, mode), ...(projection.document.source_path === projection.document.title ? [] : [styled(projection.document.source_path, "muted", theme, mode)]), "", ...projection.document.content.split("\n").flatMap((value) => wrapDisplay(value, Math.max(1, width - 2)))]
    : projection.tab === "docs"
    ? [styled("PROJECT DOCUMENTS", "info", theme, mode), styled("Root and docs/ · bounded local index", "muted", theme, mode), "", ...(projection.documents?.length
      ? projection.documents.map((entry) => styled(`${selectedRowMarker(entry.path === projection.selected_document)} ${entry.path}`, entry.path === projection.selected_document ? "accent" : "text", theme, mode))
      : ["No supported documents found."])]
    : (projection.tab === "project"
    ? projectTabBody(projection, width, theme, mode)
    : projection.tab === "adrs" ? adrTabBody(projection, width, theme, mode)
    : projection.tab === "git" ? gitTabBody(projection, theme, mode)
    : projection.tab === "governance" ? governanceTabBody(projection, width, theme, mode)
    : projection.tab === "inspect" ? inspectTabBody(projection, theme, mode)
    : [...(options.supplemental_lines ?? []), ...devtoolsTabBody(projection, width, theme, mode)]);
  const contentBudget = Math.max(1, options.height - 2 - header.length);
  const selected = !projection.document && selectable ? content.findIndex((value) => value.includes(selectedRowMarker(true))) : -1;
  const start = sidebarViewportStart(content.length, selected, projection.scroll_offset ?? 0, contentBudget);
  const body = [...header, ...content.slice(start)];
  // `framed(...).slice(0, height)` cut the rail twice over when the body was
  // taller than the pane: it dropped the overflowing rows with no mark, and it
  // sliced off the closing border so the box hung open. Both are silent
  // failures -- at 100x30 the file tree simply stopped mid-list and the
  // operator had no way to know more paths existed. Trim the CONTENT instead,
  // leaving a visible count, so the frame always closes and the cut is stated.
  const bodyBudget = Math.max(1, options.height - 2);
  if (body.length > bodyBudget) {
    const kept = body.slice(0, Math.max(0, bodyBudget - 1));
    const hidden = body.length - kept.length;
    return framed([...kept, styled(`+${hidden} more · PgDn scroll`, "warning", theme, mode)], width, projection.focused, theme, mode).slice(0, options.height);
  }
  return framed([...body, ...Array.from({ length: Math.max(0, bodyBudget - body.length) }, () => "")], width, projection.focused, theme, mode).slice(0, options.height);
}
