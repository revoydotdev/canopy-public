import { selectConsoleReferenceAnswer, renderConsoleReferenceAnswer, type ConsoleReferenceAnswer } from "../console-reference-answer.js";
/**
 * Console screen — a single, opencode-like unified operator surface.
 *
 * Composes FOUR regions inside this screen's own `{width, height}` content
 * box: a one-line header (identity + live status), a two-column body
 * (transcript on the left, a tree-search + governance-activity aside on the
 * right), and a bordered inline input strip at the bottom. This is exactly
 * the technique the status bar and notification band already use elsewhere
 * (extra character rows composed inside a bounded rect) — nothing here
 * touches `navigation.ts`'s pane cap or `renderer.ts`'s "only
 * `layout.panes[0]` gets content" rule; every row below is drawn INSIDE the
 * one pane this screen is handed.
 *
 * Leaf module: depends only on @arbor/core (via widgets), the screen
 * contracts, and its sibling leaf screens (`tree.ts` for `projectTree`,
 * `governance.ts` for the governance shape, `product.ts` for the same
 * composite-fetch helpers `dashboard`/`cockpit` already use) — never
 * @arbor/mcp.
 *
 * Raw shape: `tui.ts`'s `refreshProductSurface("console", ...)` reuses the
 * exact same composite fetch (`campaign.list`, `governance.snapshot`,
 * `harness.connector.inventory`, and ledger-derived `usage_cost`) plus one
 * addition specific to this screen: the active/newest campaign's
 * `campaign.tree`. The inline input strip's buffer/cursor/focus is
 * screen-local UI state (mirrors `tui.ts`'s `resultFileSelection` bounded
 * inline-text idiom) merged into the same composite by `tui.ts` on every
 * keystroke, never a second query path.
 *
 * `project()` never queries anything itself (ADR-011): it only reads the one
 * `raw` value the composition root already fetched and handed it.
 */

import { clipDisplay, displayWidth, wrapDisplay } from "../widgets.js";
import { ANSI, clipAnsi, spinnerGlyph, stripAnsi } from "../player-piano.js";
import { deriveTheme, toForegroundSgr, type ColorMode, type PaletteRole, type RunTheme } from "../theme.js";
import { renderOperatorEvent } from "../operator-event-render.js";
import { selectConsoleClarification } from "../console-clarification.js";
import { selectConsolePlanPreview, consolePlanPreviewLines, type ConsolePlanPreview } from "../console-plan-preview.js";
import type { ScreenId, ScreenModule, ScreenProjection } from "./screen.js";
import { clipLabelWithEllipsis, pad, stackHorizontal } from "./region.js";
import { evidencedNodeState, isTreeShape } from "./tree.js";
import { reviewDocument } from "../console-review-document.js";
import { emptyCaption } from "./empty-state.js";
import { isGovernanceSnapshotShape } from "./governance.js";
import { buildOperatorViewModel, consoleOperatorProjectionInput, type EventView, type InspectorView } from "../operator-view-model.js";
import type { FrontierLiveEdgeState } from "../frontier-live-edge.js";
import { projectUctHeader, type UctGovernanceSignal, type UctHeaderNode } from "../uct-header.js";
import {
  projectResponsiveSidebar,
  renderResponsiveSidebar,
  RESPONSIVE_SIDEBAR_WIDTH,
  type ResponsiveSidebarProjection,
  type ResponsiveSidebarVisibility,
  type ResponsiveInspectorTab,
} from "../responsive-sidebar.js";
import {
  record,
  values,
  text as fallbackText,
  number as safeNumber,
  campaignRows,
  status as campaignStatus,
  costLabel,
  selectedConnector,
  draftTaskByCampaignId,
  campaignName,
  operatorFleetFacts,
  operatorPortfolioFacts,
  operatorOperationsFacts,
  completionManifestLines,
  type OperatorFact,
  type ProductSurfaceSnapshot,
  PRODUCT_SURFACE_QUERIES,
} from "./product.js";

// ── raw shape ────────────────────────────────────────────────────────────────

export interface ConsoleInputState {
  readonly text: string;
  readonly cursor: number;
  readonly focused: boolean;
  /** A live session accepts steering as a queue; otherwise this is governed task intake. */
  readonly action?: "send" | "queue" | "answer";
  /** Only true when the selected live session can receive an interrupt. */
  readonly interrupt_available?: boolean;
}

interface ConsoleRawShape {
  readonly focused_campaign_id?: string | null;
  readonly campaigns?: unknown;
  readonly drafts?: unknown;
  readonly governance?: unknown;
  readonly connector?: unknown;
  readonly approvals?: unknown;
  readonly tasks?: unknown;
  readonly agents?: unknown;
  readonly sessions?: unknown;
  readonly result_review?: unknown;
  readonly usage_cost?: unknown;
  /**
   * Already present in every `ProductSurfaceSnapshot` the composition root
   * builds — Console simply never declared them, so the fleet and portfolio
   * facts the Dashboard and Projects screens rendered were reaching this
   * screen and being dropped. Declaring them costs no extra query.
   */
  readonly backlog?: unknown;
  readonly jobs?: unknown;
  readonly readiness?: unknown;
  readonly project?: unknown;
  readonly project_registry?: unknown;
  readonly repository_tree?: unknown;
  readonly extensions?: unknown;
  readonly product_operations?: unknown;
  readonly tree?: unknown;
  readonly devtools?: unknown;
  readonly session_attach?: unknown;
  readonly output_list?: unknown;
  readonly operator_interviews?: unknown;
  readonly selected_session_id?: string | null;
  readonly sidebar_visibility?: ResponsiveSidebarVisibility;
  readonly shell_owns_uct?: boolean;
  readonly sidebar_tab?: ResponsiveInspectorTab;
  readonly sidebar_focused?: boolean;
  readonly sidebar_documents?: ResponsiveSidebarProjection["documents"];
  readonly selected_document?: string | null;
  readonly sidebar_scroll_offset?: number;
  readonly selected_adr_id?: string | null;
  readonly adr_document?: unknown;
  /** ADR-161 read model, pre-summarized by the composition root (`tui.ts`) via `summarizeForInspect`; this screen never reaches into `TuiReadModel` itself. */
  readonly read_model_summary?: import("../read-model.js").InspectSummary;
  readonly inspect_action?: unknown;
  readonly inspect_history?: readonly unknown[];
  readonly inspect_prompt?: string | null;
  /** Fresh TUI sessions render only the intake field until they create work. */
  readonly fresh_launch_empty?: boolean;
  /** A fresh task is accepted and planning, before its campaign exists. */
  readonly fresh_launch_planning?: boolean;
  /** Local accepted-input edge while the durable task draft catches up. */
  readonly submission_pending?: unknown;
  /** Operator cancellation intent while planning/admission resolves its target. */
  readonly cancellation_pending?: unknown;
  readonly clarification_answer_pending?: unknown;
  readonly console_input?: ConsoleInputState;
  readonly captured_at: string;
}

function isConsoleRawShape(value: unknown): value is ConsoleRawShape {
  return record(value) && typeof value.captured_at === "string";
}

// ── row shapes (flat, section-discriminated — same idiom governance.ts uses) ─

type ConsoleRow =
  | { readonly region: "reference-answer"; readonly reference: ConsoleReferenceAnswer }
  | { readonly region: "header"; readonly campaign: string; readonly status: string; readonly verified: number; readonly total: number; readonly connector: string | null; readonly cost: string }
  | { readonly region: "tree"; readonly id: string; readonly label: string; readonly depth: number; readonly has_children: boolean; readonly expanded: boolean; readonly active: boolean }
  | { readonly region: "governance"; readonly label: string; readonly value: string }
  | { readonly region: "operator-event"; readonly event: EventView; readonly review?: boolean }
  | { readonly region: "plan-preview"; readonly preview: ConsolePlanPreview }
  | { readonly region: "uct"; readonly nodes: readonly UctHeaderNode[]; readonly signals: readonly UctGovernanceSignal[]; readonly halted: boolean; readonly halt_reason: string | null }
  | { readonly region: "attention"; readonly label: string }
  | { readonly region: "objective"; readonly label: string }
  | { readonly region: "operator-inspector"; readonly inspector: InspectorView }
  | { readonly region: "fleet"; readonly fact: OperatorFact }
  | { readonly region: "portfolio"; readonly fact: OperatorFact }
  | { readonly region: "operations"; readonly fact: OperatorFact }
  | { readonly region: "completion"; readonly label: string; readonly value: string }
  | { readonly region: "adr-document"; readonly id: string; readonly title: string; readonly status: string; readonly source_path: string; readonly content: string }
  | { readonly region: "sidebar"; readonly projection: ResponsiveSidebarProjection }
  | { readonly region: "agent-status"; readonly label: string }
  | { readonly region: "submission"; readonly task: string }
  | { readonly region: "cancellation"; readonly task: string }
  | { readonly region: "run-control"; readonly state: "stopping" | "stopped" }
  | { readonly region: "input"; readonly text: string; readonly cursor: number; readonly focused: boolean; readonly action: "send" | "queue" | "answer"; readonly interrupt_available: boolean };

function bySection<T extends ConsoleRow["region"]>(rows: readonly Readonly<Record<string, unknown>>[], region: T): Extract<ConsoleRow, { region: T }>[] {
  return rows.filter((row): row is Extract<ConsoleRow, { region: T }> => row.region === region);
}

// ── header ───────────────────────────────────────────────────────────────────

function headerRow(shape: ConsoleRawShape): ConsoleRow[] {
  const campaigns = campaignRows(shape.campaigns);
  const active = typeof shape.focused_campaign_id === "string"
    ? campaigns.find((row) => row.id === shape.focused_campaign_id)
    : shape.focused_campaign_id === null ? undefined : campaigns.find((row) => row.halted !== true) ?? campaigns[0];
  if (active === undefined) return [];
  const taskByCampaignId = draftTaskByCampaignId(values(shape.drafts, "items"));
  const connector = selectedConnector(shape.connector);
  const control = runControlState(shape);
  return [{
    region: "header",
    campaign: campaignName(active, taskByCampaignId),
    status: control === "stopping" ? "Stopping" : control === "stopped" ? "Stopped" : humanCampaignStatus(campaignStatus(active)),
    verified: safeNumber(active.verified_nodes),
    total: safeNumber(active.total_nodes),
    connector: connector?.connectorId ?? null,
    cost: costLabel(shape.usage_cost),
  }];
}

function runControlState(shape: ConsoleRawShape): "stopping" | "stopped" | null {
  if (record(shape.cancellation_pending) && typeof shape.cancellation_pending.task === "string") return "stopping";
  const focusedJobIds = new Set(values(shape.drafts, "items")
    .filter((draft) => draft.campaign_id === shape.focused_campaign_id && typeof draft.job_id === "string")
    .map((draft) => draft.job_id));
  const jobs = [...values(shape.jobs, "jobs"), ...values(shape.jobs, "items")]
    .filter((job) => shape.focused_campaign_id === undefined
      || (typeof shape.focused_campaign_id === "string"
        && (job.campaign_id === shape.focused_campaign_id || focusedJobIds.has(job.id))));
  const states = jobs.map((job) => String(job.state ?? job.status ?? "").toLowerCase());
  if (states.some((state) => state === "cancel_requested")) return "stopping";
  const active = new Set(["accepted", "queued", "pending", "started", "running", "active", "retrying"]);
  const stopped = new Set(["cancelled", "canceled", "interrupted"]);
  return states.some((state) => stopped.has(state)) && !states.some((state) => active.has(state)) ? "stopped" : null;
}

/** Durable state values are machine vocabulary; Console chrome is operator prose. */
function humanCampaignStatus(value: string): string {
  switch (value.toLowerCase()) {
    case "expanding": return "Working";
    case "pending": return "Queued";
    case "claimed": return "Claimed, not verified";
    case "verified": return "Completed";
    case "failed": return "Needs attention";
    case "pruned": return "Pruned";
    case "abandoned": return "Stopped";
    case "idle": return "Waiting";
    default: return value.replaceAll("_", " ");
  }
}

/**
 * Fleet and portfolio facts, absorbed from the retired Dashboard and Projects
 * screens (ADR-149 Decision 7). Both delegate to `product.ts` rather than
 * recomputing, so the truthfulness caveats those screens carried stay in one
 * place and cannot drift.
 */
function fleetRows(shape: ConsoleRawShape): ConsoleRow[] {
  return operatorFleetFacts(shape as unknown as ProductSurfaceSnapshot).map((fact) => ({ region: "fleet" as const, fact }));
}

function portfolioRows(shape: ConsoleRawShape): ConsoleRow[] {
  return operatorPortfolioFacts(shape as unknown as ProductSurfaceSnapshot).map((fact) => ({ region: "portfolio" as const, fact }));
}

/**
 * Completion is a result-review manifest, not an operator-fact strip. The
 * producer already bounds every disclosure; preserve its labels so a summary,
 * changed files, verification, evidence/provenance, adoption state, and next
 * action remain distinct rather than collapsing into an untrustworthy slogan.
 */
function captureRows(shape: ConsoleRawShape): ConsoleRow[] {
  return completionManifestLines(shape.result_review).map((line) => ({
    region: "completion" as const,
    label: line.label,
    value: line.value,
  }));
}

function operationsRows(shape: ConsoleRawShape): ConsoleRow[] {
  return operatorOperationsFacts(shape as unknown as ProductSurfaceSnapshot).map((fact) => ({ region: "operations" as const, fact }));
}

function adrDocumentRows(shape: ConsoleRawShape): ConsoleRow[] {
  if (!record(shape.adr_document)) return [];
  const document = shape.adr_document;
  if (typeof document.id !== "string" || typeof document.content !== "string") return [];
  return [{
    region: "adr-document",
    id: document.id,
    title: fallbackText(document.title, "Untitled decision"),
    status: fallbackText(document.status, "unknown"),
    source_path: fallbackText(document.source_path, "source unavailable"),
    content: document.content,
  }];
}

// ── input strip ────────────────────────────────────────────────────────────

function inputRow(shape: ConsoleRawShape): ConsoleRow[] {
  const input = shape.console_input;
  return [{
    region: "input",
    text: input?.text ?? "",
    cursor: input?.cursor ?? 0,
    focused: input?.focused ?? false,
    action: input?.action === "answer" ? "answer" : input?.action === "queue" ? "queue" : "send",
    interrupt_available: input?.interrupt_available === true,
  }];
}

function collectionRows(value: unknown, keys: readonly string[]): readonly unknown[] {
  if (!record(value)) return [];
  for (const key of keys) if (Array.isArray(value[key])) return value[key];
  return [];
}

function pendingInterviewCount(value: unknown): number {
  return collectionRows(value, ["requests", "records", "items"]).filter((candidate) => {
    if (!record(candidate)) return true;
    if (candidate.answer !== undefined && candidate.answer !== null) return false;
    return !["answered", "resolved", "closed"].includes(fallbackText(candidate.status, "pending").toLowerCase());
  }).length;
}

function pendingApprovalCount(value: unknown): number {
  return collectionRows(value, ["records", "items"]).filter((candidate) => {
    if (!record(candidate)) return true;
    return !["approved", "rejected", "expired", "closed"].includes(fallbackText(candidate.status, "pending").toLowerCase());
  }).length;
}

/** Supplied-fact-only status signals flanking the exact UCT graph. */
function uctSignals(shape: ConsoleRawShape): readonly UctGovernanceSignal[] {
  const signals: UctGovernanceSignal[] = [];
  const governance = isGovernanceSnapshotShape(shape.governance) ? shape.governance : null;
  const distribution = governance?.decision_status_distribution;
  if (distribution !== undefined) {
    const proposed = typeof distribution.proposed === "number" ? distribution.proposed : 0;
    signals.push({ id: "adr", label: "ADR", value: proposed > 0 ? `${proposed} proposed` : `${typeof distribution.accepted === "number" ? distribution.accepted : 0} accepted`, tone: proposed > 0 ? "warning" : "success" });
  }
  const pendingInterviews = pendingInterviewCount(shape.operator_interviews);
  if (pendingInterviews > 0) signals.push({ id: "interviews", label: "ASK", value: String(pendingInterviews), tone: "warning" });
  const pendingApprovals = pendingApprovalCount(shape.approvals);
  if (pendingApprovals > 0) signals.push({ id: "approvals", label: "APPROVE", value: String(pendingApprovals), tone: "warning" });
  const firstFinding = governance?.policy_findings?.[0];
  if (firstFinding?.rule_id !== undefined) signals.push({ id: "policy", label: firstFinding.rule_id, value: firstFinding.severity ?? "reported", tone: firstFinding.severity === "error" ? "danger" : "warning" });
  const result = record(shape.result_review) ? shape.result_review : null;
  if (result?.status === "ready_for_review") signals.push({ id: "result", label: "RESULT", value: "verified", tone: "success" });
  return signals.slice(0, 8);
}

function uctNodes(shape: ConsoleRawShape): readonly UctHeaderNode[] {
  if (!isTreeShape(shape.tree)) return [];
  return (shape.tree.nodes ?? []).flatMap((value) => {
    if (!record(value) || typeof value.id !== "string" || typeof value.state !== "string") return [];
    return [{
      id: value.id,
      parent_id: typeof value.parent_id === "string" || value.parent_id === null ? value.parent_id : undefined,
      // Header glyph/tone/counts follow evidence, not the bare state string.
      state: evidencedNodeState(value, value.state),
      action_description: typeof value.action_description === "string" ? value.action_description : undefined,
      label: typeof value.label === "string" ? value.label : undefined,
      visit_count: typeof value.visit_count === "number" ? value.visit_count : undefined,
    }];
  });
}

/** Approvals and interviews awaiting the operator, each with the key that opens it. */
function pendingOperatorItems(shape: ConsoleRawShape): string[] {
  const items: string[] = [];
  const interviews = pendingInterviewCount(shape.operator_interviews);
  const approvals = pendingApprovalCount(shape.approvals);
  if (interviews > 0) items.push(`${interviews} interview${interviews === 1 ? "" : "s"} [i]`);
  if (approvals > 0) items.push(`${approvals} approval${approvals === 1 ? "" : "s"} [0]`);
  return items;
}

/** One calm, bounded queue for facts that currently require the operator. */
function attentionLabel(shape: ConsoleRawShape): string | null {
  const recovered = isTreeShape(shape.tree) && shape.tree.halted === true
    && shape.tree.halt_reason === "verified_result"
    && (shape.tree.nodes ?? []).some((node) => record(node) && node.state === "verified");
  const failedReason = !recovered && isTreeShape(shape.tree)
    ? [...(shape.tree.nodes ?? [])].reverse().find((candidate) => record(candidate)
      && candidate.state === "failed"
      && ((record(candidate.critic_verdict) && typeof candidate.critic_verdict.root_cause === "string" && candidate.critic_verdict.root_cause.trim().length > 0)
        || (record(candidate.outcome) && typeof candidate.outcome.message === "string" && candidate.outcome.message.trim().length > 0)
        || (typeof candidate.specialist_output === "string" && candidate.specialist_output.trim().length > 0)))
    : undefined;
  if (record(failedReason)) {
    const reason = record(failedReason.critic_verdict) && typeof failedReason.critic_verdict.root_cause === "string" && failedReason.critic_verdict.root_cause.trim().length > 0
      ? failedReason.critic_verdict.root_cause
      : record(failedReason.outcome) && typeof failedReason.outcome.message === "string" && failedReason.outcome.message.trim().length > 0
        ? failedReason.outcome.message : String(failedReason.specialist_output);
    // A failed node must not swallow the queue of things only the operator
    // can unblock: the pending approval/interview used to appear only as an
    // event row with no key. Keep the reason bounded so the keyed suffix is
    // not wrapped off the end of the (four-row) attention block.
    const pending = pendingOperatorItems(shape);
    const cleaned = reason.replace(/^FAILED:\s*/u, "");
    return pending.length === 0
      ? `BLOCKED · ${cleaned.slice(0, 800)}`
      : `BLOCKED · ${cleaned.length > 160 ? `${cleaned.slice(0, 159)}…` : cleaned} · also waiting on you: ${pending.join(" · ")}`;
  }
  const items: string[] = [];
  items.push(...pendingOperatorItems(shape));
  const result = record(shape.result_review) ? shape.result_review : null;
  if (result?.status === "ready_for_review") items.push("result ready [Shift+R]");
  const governance = isGovernanceSnapshotShape(shape.governance) ? shape.governance : null;
  const blockingFindings = (governance?.policy_findings ?? []).filter((finding) => finding.severity === "error").length;
  if (blockingFindings > 0) items.push(`${blockingFindings} governance blocker${blockingFindings === 1 ? "" : "s"} [g]`);
  return items.length === 0 ? null : `NEEDS YOU · ${items.join(" · ")}`;
}

/** Terse factual session chrome; the operator document remains its only grammar. */
function selectedSessionStatus(sessionAttach: unknown): { readonly session_id: string; readonly role: string | null; readonly state: string; readonly pending_steering: number } | null {
  if (!record(sessionAttach) || !record(sessionAttach.session)) return null;
  const sessionId = typeof sessionAttach.session.session_id === "string" && sessionAttach.session.session_id !== "" ? sessionAttach.session.session_id : null;
  if (sessionId === null) return null;
  return Object.freeze({
    session_id: sessionId,
    role: typeof sessionAttach.session.operation === "string" ? sessionAttach.session.operation : null,
    state: typeof sessionAttach.session.state === "string" ? sessionAttach.session.state : sessionAttach.live === true ? "live" : "unknown",
    pending_steering: typeof sessionAttach.pending_steering === "number" && Number.isSafeInteger(sessionAttach.pending_steering) ? sessionAttach.pending_steering : 0,
  });
}

function frontierRows(shape: ConsoleRawShape, width: number): ConsoleRow[] {
  const capturedAt = Date.parse(shape.captured_at);
  const nowMs = Number.isSafeInteger(capturedAt) ? capturedAt : 0;
  const operatorInput = consoleOperatorProjectionInput(shape, {
    viewport: { columns: Math.max(1, width), rows: 1 },
    now_ms: nowMs,
  });
  const operator = buildOperatorViewModel(operatorInput!);
  const status = selectedSessionStatus(shape.session_attach);
  const queuedAttention = attentionLabel(shape);
  const projectedAttention = operator.selected_attention;
  const clarification = selectConsoleClarification(shape.drafts);
  const planPreview = selectConsolePlanPreview(shape.drafts);
  const attention = clarification !== null ? `QUESTION · ${clarification.question}` : queuedAttention ?? (projectedAttention !== null
    ? `${projectedAttention.lifecycle === "failed" ? "RETRY" : "NOW"} · ${projectedAttention.summary}`
    : null);
  const sidebar = projectResponsiveSidebar({
    width,
    // Context is a deliberate inspection action; the task owns the default view.
    visibility: shape.sidebar_visibility ?? "auto",
    documents: shape.sidebar_documents,
    selected_document: shape.selected_document,
    scroll_offset: shape.sidebar_scroll_offset,
    document: record(shape.adr_document) && typeof shape.adr_document.content === "string"
      ? { title: fallbackText(shape.adr_document.title, "Document"), source_path: fallbackText(shape.adr_document.source_path, "Source unavailable"), content: shape.adr_document.content }
      : null,
    governance: shape.governance,
    project_registry: shape.project_registry,
    repository_tree: shape.repository_tree,
    devtools: shape.devtools,
    tab: shape.sidebar_tab ?? "project",
    focused: shape.sidebar_focused === true,
    agents: shape.agents,
    sessions: shape.sessions,
    campaign_tree: shape.tree,
    interview_unresolved_count: shape.operator_interviews === undefined ? undefined : pendingInterviewCount(shape.operator_interviews),
    inspect: shape.read_model_summary,
    inspect_action: shape.inspect_action,
    inspect_history: shape.inspect_history,
    inspect_prompt: shape.inspect_prompt,
    selected: {
      ...(typeof shape.selected_session_id === "string" ? { session_id: shape.selected_session_id } : {}),
      ...(typeof shape.selected_adr_id === "string" ? { adr_id: shape.selected_adr_id } : {}),
    },
  });
  return [
    ...(shape.shell_owns_uct === true ? [] : [{
      region: "uct" as const,
      nodes: uctNodes(shape),
      signals: uctSignals(shape),
      halted: isTreeShape(shape.tree) && shape.tree.halted === true,
      halt_reason: isTreeShape(shape.tree) && typeof shape.tree.halt_reason === "string" ? shape.tree.halt_reason : null,
    }]),
    ...(operator.objective === null ? [] : [{ region: "objective" as const, label: operator.objective.summary }]),
    ...(attention === null ? [] : [{ region: "attention" as const, label: attention }]),
    ...(record(shape.cancellation_pending) && typeof shape.cancellation_pending.task === "string"
      ? [{ region: "cancellation" as const, task: shape.cancellation_pending.task }]
      : []),
    ...(runControlState(shape) === null ? [] : [{ region: "run-control" as const, state: runControlState(shape)! }]),
    ...(status === null && operator.background.length === 0 ? [] : [{
      region: "agent-status" as const,
      label: [
        status === null ? null : `${status.role ?? "agent"} · ${status.state} · ${status.pending_steering} queued · ${status.session_id}`,
        operator.background.length === 0 ? null : `SUPERVISION · ${operator.background.map((work) => {
          const parent = work.parent_id ?? work.operation_id;
          const owner = work.owner === null ? "" : ` · ${work.owner}`;
          const steering = work.pending_steering > 0 ? ` · ${work.pending_steering} steer queued` : "";
          return `${work.source}:${work.id} · ${work.state}${owner}${parent === null ? "" : ` · ↳ ${parent}`}${steering}`;
        }).join("; ")}`,
      ].filter((value): value is string => value !== null).join(" · "),
    }]),
    ...operator.document.map((event): ConsoleRow => ({ region: "operator-event", event,
      review: event.source === "canonical_session" && record(shape.session_attach)
        && record(shape.session_attach.session) && shape.session_attach.session.operation === "review"
        && shape.session_attach.session.session_id === event.source_id,
    })),
    ...(planPreview === null ? [] : [{ region: "plan-preview" as const, preview: planPreview }]),
    ...(operator.inspector === null ? [] : [{ region: "operator-inspector" as const, inspector: operator.inspector }]),
    { region: "sidebar", projection: sidebar },
  ];
}

// ── project ──────────────────────────────────────────────────────────────────

/**
 * "No composite has been captured yet" and "a composite was captured and its
 * campaign list is empty" are different facts, and the Console was the one
 * screen in this pipeline that collapsed them (WA-59; `governance.ts`,
 * `jobs.ts`, `tasks.ts`, `config.ts`, `backlog.ts`, `communications.ts`,
 * `operations.ts`, `agents.ts`, `devtools.ts` and `kb.ts` all already draw the
 * distinction). `captured_at` is what `isConsoleRawShape` reads as the
 * readiness marker, so a shape carrying only screen-local input state is
 * "pending": the operator's keystrokes are real and must still echo, but this
 * surface has read nothing yet and must not answer questions about campaigns,
 * governance or cost as though it had.
 */
function emptyProjection(reason: "pending" | "empty", input?: ConsoleRow): ScreenProjection {
  return {
    screen: "console",
    rows: [input ?? { region: "input", text: "", cursor: 0, focused: false }],
    columns: [{ key: "region", title: "Region", width: 12 }],
    caption: reason === "pending"
      ? emptyCaption({ what: "Console has not captured a product surface yet — awaiting first projection", how: "wait for the runtime to finish starting" })
      : "revoy2 console — no campaigns yet",
    variant: reason === "pending" ? "pending" : "empty",
  };
}

function project(result: unknown, width: number): ScreenProjection {
  // A record without `captured_at` is screen-local input state published by
  // `syncConsoleInput` before the first composite landed. Echo the keystrokes,
  // but do not fall through to the main variant — every fact block there would
  // report an absent read as a confident zero.
  if (!isConsoleRawShape(result)) {
    return record(result)
      ? emptyProjection("pending", inputRow(result as unknown as ConsoleRawShape)[0])
      : emptyProjection("empty");
  }
  const reference = selectConsoleReferenceAnswer(result.drafts);
  if (reference !== null && !record(result.submission_pending)) return {
    screen: "console",
    rows: [{ region: "reference-answer", reference }, ...frontierRows(result, width).filter((row) => row.region === "sidebar"), ...inputRow(result)],
    columns: [{ key: "region", title: "Region", width: 12 }],
    caption: reference.status === "planning" ? "Reading reference - read-only" : "Reference answer - no campaign",
    variant: "reference-answer",
  };
  if (record(result.submission_pending) && typeof result.submission_pending.task === "string") {
    const sidebar = frontierRows(result, width).filter((row) => row.region === "sidebar");
    const cancellation = record(result.cancellation_pending) && typeof result.cancellation_pending.task === "string"
      ? [{ region: "cancellation" as const, task: result.cancellation_pending.task }]
      : [];
    return {
      screen: "console",
      rows: [{ region: "submission", task: result.submission_pending.task }, ...cancellation, ...sidebar, ...inputRow(result)],
      columns: [{ key: "region", title: "Region", width: 12 }],
      caption: "revoy2 console — submitting",
      variant: "planning",
    };
  }
  if (result.fresh_launch_empty === true) {
    const sidebar = frontierRows(result, width).filter((row) => row.region === "sidebar");
    return {
      screen: "console",
      // The fresh-launch foreground exists to avoid resurrecting prior
      // CAMPAIGN work (`tui.ts`'s `freshLaunchProjection`), which is why the
      // fleet and portfolio facts stay out of this variant. The operations
      // facets are a different kind of fact: doctor, migration, remote,
      // scheduler, notifications, verification and follow-up lineage describe
      // the INSTALLATION, not anything a previous session did. Dropping them
      // here meant a brand-new session could never see whether its own install
      // was healthy — the operator's first question on a fresh launch — so
      // they are foregrounded with the rest of the greenfield chrome.
      rows: [...sidebar, ...operationsRows(result), ...adrDocumentRows(result), ...inputRow(result)],
      columns: [{ key: "region", title: "Region", width: 12 }],
      caption: "revoy2 console",
      variant: "fresh",
    };
  }
  const hasPlanningDraft = record(result.drafts) && Array.isArray(result.drafts.items)
    && result.drafts.items.some((draft: unknown) => record(draft) && draft.status === "planning");
  if (result.fresh_launch_planning === true && hasPlanningDraft) {
    // During governed pre-campaign planning, show only the canonical draft
    // document. Persisted sessions and workspace facts belong to --resume;
    // suppressing the draft itself would turn an active frontier operation
    // into a blank screen.
    const planningRows = frontierRows(result, width).filter((row) => row.region === "operator-event" || row.region === "sidebar" || row.region === "plan-preview");
    const cancellation = record(result.cancellation_pending) && typeof result.cancellation_pending.task === "string"
      ? [{ region: "cancellation" as const, task: result.cancellation_pending.task }]
      : [];
    return {
      screen: "console",
      rows: [...cancellation, ...planningRows, ...adrDocumentRows(result), ...inputRow(result)],
      columns: [{ key: "region", title: "Region", width: 12 }],
      caption: "revoy2 console — planning",
      variant: "planning",
    };
  }
  const header = headerRow(result);
  const includeSidebarContext = result.sidebar_visibility === "shown";
  const rows: ConsoleRow[] = [
    ...frontierRows(result, width),
    ...header,
    // Fleet, portfolio, and operations are inspection context. They belong
    // in the explicitly opened sidebar rather than competing with the live
    // causal transcript on every refresh.
    ...(includeSidebarContext ? fleetRows(result) : []),
    ...(includeSidebarContext ? portfolioRows(result) : []),
    ...(includeSidebarContext ? operationsRows(result) : []),
    ...captureRows(result),
    ...adrDocumentRows(result),
    ...inputRow(result),
  ];
  // No row here carries a stable backend identity of its own (header and
  // governance entries are joined feed items, the
  // input row is screen-local UI state) — `tree` rows are the one exception,
  // but the tree pane here is a read-only search surface, not a
  // branch/prune target (that stays the dedicated Tree screen), so `row_ids`
  // is deliberately omitted, same as governance.ts's own aggregated rows.
  return {
    screen: "console",
    rows,
    columns: [{ key: "region", title: "Region", width: 12 }],
    caption: "revoy2 console",
    variant: rows.length > 1 ? "console" : "empty",
  };
}

// ── render ───────────────────────────────────────────────────────────────────

function emphasize(value: string, role: PaletteRole, color: boolean, theme?: RunTheme, colorMode: ColorMode = "truecolor"): string {
  if (!color) return value;
  const selected = theme ?? deriveTheme(undefined);
  return `${toForegroundSgr(selected.colors[role], colorMode)}${value}${ANSI.reset}`;
}

function renderHeader(rows: readonly Readonly<Record<string, unknown>>[], width: number, color = false, theme?: RunTheme, colorMode: ColorMode = "truecolor"): string {
  const header = bySection(rows, "header")[0];
  if (header === undefined) return clipLabelWithEllipsis("revoy2 console — no active campaign", width);
  const rightParts = [header.connector, header.cost === "unavailable" ? undefined : header.cost].filter((part): part is string => typeof part === "string" && part.length > 0);
  const rightPlain = [`STATUS · ${header.status} · nodes ${header.verified}/${header.total}`, ...rightParts].join(" · ");
  // Widths are measured on PLAIN text and the title yields first: the status
  // is what changes, so it must never be the part that is cut. Measuring the
  // emphasised strings charged escape bytes as cells and then a bare clip
  // took the tail off "Needs attention" (EC-062).
  const rightWidth = displayWidth(rightPlain);
  const titleBudget = Math.max(8, width - rightWidth - 1 - displayWidth("TASK · "));
  const title = clipLabelWithEllipsis(String(header.campaign), titleBudget);
  const left = `${emphasize("TASK", "accent", color, theme, colorMode)} · ${title}`;
  const leftWidth = displayWidth(`TASK · ${title}`);
  const right = rightPlain.replace(/^STATUS/u, emphasize("STATUS", "info", color, theme, colorMode));
  const gap = Math.max(1, width - leftWidth - rightWidth);
  if (leftWidth + gap + rightWidth > width) return clipAnsi(`${left} ${right}`, width);
  return `${left}${" ".repeat(gap)}${right}`;
}

function renderEmptyOperatorDocument(width: number): readonly string[] {
  return [clipDisplay("No canonical operator event is available in this refresh.", width)];
}

interface WrappedComposerRows {
  readonly rows: readonly string[];
  readonly cursor_row: number;
}

/**
 * Projects the canonical reducer buffer into bounded Console rows. The cursor
 * marker is inserted before projection, so its actual row remains visible
 * after a long paste grows beyond the bounded composer viewport. This is a
 * visual projection only: no native widget owns a second text buffer.
 */
function wrapComposerBuffer(text: string, cursor: number, width: number, focused: boolean): WrappedComposerRows {
  const marker = focused ? "▏" : "";
  const boundedCursor = Math.max(0, Math.min(cursor, text.length));
  const value = `${text.slice(0, boundedCursor)}${marker}${text.slice(boundedCursor)}`;
  const logicalRows = value.split("\n");
  const cursorRow = marker === "" ? 0 : Math.max(0, logicalRows.findIndex((line) => line.includes(marker)));
  // A long logical line scrolls horizontally around the cursor rather than
  // consuming the whole terminal vertically. Explicit newlines (including
  // pasted ones) are what make the composer grow.
  const rows = logicalRows.map((line) => {
    if (displayWidth(line) <= width) return line;
    if (marker !== "" && line.includes(marker)) return windowAroundCursor(line, width, marker);
    return clipDisplay(line, width);
  });
  return { rows, cursor_row: cursorRow };
}

function windowAroundCursor(value: string, columns: number, marker: string): string {
  if (columns <= 0) return "";
  const characters = [...value.normalize("NFC")];
  const markerIndex = Math.max(0, characters.indexOf(marker));
  let selected = marker;
  let used = displayWidth(marker);
  let right = markerIndex + 1;
  // Preserve roughly half the context after the cursor, then fill the left
  // side and any remaining room. The invariant is stronger than a suffix:
  // the cursor marker itself can never scroll off screen.
  const rightTarget = Math.floor(columns / 2);
  while (right < characters.length && used < rightTarget) {
    const character = characters[right]!;
    const characterWidth = displayWidth(character);
    if (used + characterWidth > columns) break;
    selected += character;
    used += characterWidth;
    right += 1;
  }
  let left = markerIndex - 1;
  while (left >= 0) {
    const character = characters[left]!;
    const characterWidth = displayWidth(character);
    if (used + characterWidth > columns) break;
    selected = character + selected;
    used += characterWidth;
    left -= 1;
  }
  while (right < characters.length) {
    const character = characters[right]!;
    const characterWidth = displayWidth(character);
    if (used + characterWidth > columns) break;
    selected += character;
    used += characterWidth;
    right += 1;
  }
  return selected;
}

function renderInputStrip(rows: readonly Readonly<Record<string, unknown>>[], width: number, maxContentRows: number, color = false, theme?: RunTheme, colorMode: ColorMode = "truecolor"): string[] {
  const input = bySection(rows, "input")[0] ?? { text: "", cursor: 0, focused: false, action: "send" as const, interrupt_available: false };
  const glyph = input.focused ? "─" : "╌";
  const top = clipDisplay(`┌${glyph.repeat(Math.max(0, width - 2))}┐`, width);
  const prefixWidth = displayWidth("│ ❯ ");
  const contentWidth = Math.max(1, width - 1 - prefixWidth);
  const wrapped = wrapComposerBuffer(input.text, input.cursor, contentWidth, input.focused);
  const cap = Math.max(1, maxContentRows);
  const start = Math.max(0, Math.min(wrapped.cursor_row - cap + 1, Math.max(0, wrapped.rows.length - cap)));
  const visible = wrapped.rows.slice(start, start + cap);
  const content = (visible.length === 0 ? [""] : visible).map((line, index) => {
    const prefix = index === 0 ? "│ ❯ " : "│   ";
    const label = line || (index === 0 && !input.focused ? "Enter to focus…" : "");
    return pad(clipDisplay(`${prefix}${label}`, width - 1), width - 1) + "│";
  });
  const action = input.action === "answer" ? "answer" : input.action === "queue" ? "queue" : "send";
  const interrupt = input.interrupt_available ? " · Ctrl+K interrupt" : "";
  // The full hint needs ~66 columns; below that fall back to a shorter form
  // that still names the two keys that matter, rather than cutting the long
  // one mid-word (EC-055d: "· Esc b│" at 60 columns).
  const fullHint = input.focused
    ? ` Shift+Enter newline · Enter ${action}${interrupt} · Ctrl+E editor · Esc blur `
    : " Enter focus · Ctrl+P palette ";
  const compactHint = input.focused ? ` Enter ${action} · Esc blur ` : " Enter focus ";
  const plainHint = displayWidth(fullHint) <= width - 2 ? fullHint : displayWidth(compactHint) <= width - 2 ? compactHint : clipLabelWithEllipsis(compactHint.trim(), Math.max(1, width - 2));
  const hint = color ? plainHint.replace(/Shift\+Enter|Ctrl\+K|Ctrl\+E|Ctrl\+P|Enter|Esc/gu, (key) => emphasize(key, key === "Esc" ? "warning" : "accent", true, theme, colorMode)) : plainHint;
  // Measure and clip what is VISIBLE. The hint carries SGR emphasis, and
  // counting those bytes as cells under-allocated the dashes and clipped the
  // hint to "Ctrl+E edito" with no ellipsis at 120 and 140 columns (EC-050).
  const runs = Math.max(0, width - 2 - displayWidth(stripAnsi(hint)));
  const leftRun = Math.floor(runs / 2);
  const rightRun = runs - leftRun;
  const bottom = clipAnsi(`└${glyph.repeat(leftRun)}${hint}${glyph.repeat(rightRun)}┘`, width);
  return [top, ...content.map((line) => clipDisplay(line, width)), bottom];
}

function renderSemanticTimeline(rows: readonly Readonly<Record<string, unknown>>[], width: number, height: number, color: boolean, offset?: number, theme?: RunTheme, colorMode: ColorMode = "truecolor", reviewExpanded = false): readonly string[] {
  const natural: string[] = [];
  const preview = bySection(rows, "plan-preview")[0]?.preview;
  if (preview !== undefined) {
    const document = consolePlanPreviewLines(preview, width).map((line) =>
      /^(?:PROPOSED PLAN|REVISING PLAN|WORK UNITS|ACCEPTANCE CHECKS)/u.test(line)
        ? emphasize(line, "accent", color, theme, colorMode)
        : line.startsWith("ASSUMPTIONS") ? emphasize(line, "warning", color, theme, colorMode) : line);
    const recent = preview.planning ? rows.filter((row) => row.region === "operator-event"
      && (row.event as EventView).source === "canonical_session"
      && (row.event as EventView).kind !== "final_answer").slice(-2)
      .flatMap((row) => renderOperatorEvent(row.event as EventView, width, color, { max_detail_lines: 2, compact: true, theme, color_mode: colorMode })) : [];
    const lines = recent.length > 0 ? [...recent, "", ...document] : document;
    const start = Math.min(Math.max(0, offset ?? 0), Math.max(0, lines.length - Math.max(1, height)));
    return lines.slice(start, start + Math.max(1, height));
  }
  // Intake is represented by the task title and phase in Console chrome. Its
  // durable `taskcomposer:*` identifiers are useful in the ledger, but not
  // useful primary prose once work has started.
  const allSemanticRows = rows.filter((row) => row.region === "operator-event" && (row.event as EventView).source !== "taskcomposer");
  const routine = (event: EventView): boolean => event.importance !== "attention"
    && event.lifecycle !== "failed" && event.lifecycle !== "interrupted"
    && (event.source === "devtools" && event.kind === "status"
      || event.source === "notification"
      || event.source === "job" && event.lifecycle === "completed"
      || event.source === "canonical_session" && event.event_kind === "lifecycle");
  const visibleRows = offset === undefined ? allSemanticRows.filter((row) => !routine(row.event as EventView)) : allSemanticRows;
  const hiddenCount = allSemanticRows.length - visibleRows.length;
  const semanticRows = offset === undefined ? visibleRows : visibleRows.slice(Math.max(0, offset));
  // Once a canonical final answer exists it becomes the center document.
  // Tool/lifecycle rows remain available in history and DevTools, but the
  // deliverable must not be compressed into the generic event renderer's
  // two-line silhouette. Preserve paragraph boundaries and make the whole
  // bounded answer vertically scrollable with the ordinary screen offset.
  const finalAnswer = [...allSemanticRows].reverse().find((row) => (row.event as EventView).kind === "final_answer");
  if (finalAnswer !== undefined) {
    const event = finalAnswer.event as EventView;
    const document = finalAnswer.review === true
      ? reviewDocument(event.summary, width, reviewExpanded || offset !== undefined).map((line) =>
        line.startsWith("REVIEW -") ? emphasize(line, "accent", color, theme, colorMode)
          : line.startsWith("FAIL:") ? emphasize(line, "warning", color, theme, colorMode) : line)
      : ["ANSWER", "", ...event.summary.split("\n").flatMap((line) => line.trim().length === 0 ? [""] : wrapDisplay(line, width))];
    const start = Math.min(Math.max(0, offset ?? 0), Math.max(0, document.length - Math.max(1, height)));
    return document.slice(start, start + Math.max(1, height));
  }
  if (semanticRows.length === 0 && hiddenCount === 0) return renderEmptyOperatorDocument(width);
  for (const row of semanticRows) {
    if (row.region === "operator-event") {
      natural.push(...renderOperatorEvent(row.event as EventView, width, color, { max_detail_lines: 3, compact: offset === undefined, theme, color_mode: colorMode }));
      continue;
    }
  }
  if (hiddenCount > 0) natural.push(clipLabelWithEllipsis(`${hiddenCount} routine update${hiddenCount === 1 ? "" : "s"} collapsed · scroll up for history`, width));
  return offset === undefined
    ? natural.slice(Math.max(0, natural.length - Math.max(1, height)))
    : natural.slice(0, Math.max(1, height));
}

/** Human task-intake acknowledgement for the short pre-campaign planning phase. */
function renderPlanningTimeline(rows: readonly Readonly<Record<string, unknown>>[], width: number, height: number): readonly string[] {
  const requestPreview = (task: string): readonly string[] => {
    const lines = wrapDisplay(`TASK · ${task}`, width);
    return lines.length <= 4 ? lines : [...lines.slice(0, 4), clipDisplay(`+${lines.length - 4} request lines retained in task history`, width)];
  };
  const cancellation = bySection(rows, "cancellation")[0];
  if (cancellation !== undefined) return wrapDisplay(`STOPPING · cancellation requested for ${cancellation.task}`, width).slice(0, Math.max(1, height));
  if (bySection(rows, "plan-preview").length > 0) return renderSemanticTimeline(rows, width, height, false);
  const submission = bySection(rows, "submission")[0];
  if (submission !== undefined) {
    return [
      ...requestPreview(submission.task),
      "ACCEPTED · handing the request to governed planning",
    ].slice(0, Math.max(1, height));
  }
  const taskEvents = rows
    .filter((row) => row.region === "operator-event")
    .map((row) => row.event as EventView)
    .filter((event) => event.source === "taskcomposer");
  const lines = taskEvents.flatMap((event) => {
    if (event.event_kind === "taskcomposer.intent") return requestPreview(event.summary);
    if (event.kind === "permission_gate") return wrapDisplay(`QUESTION · ${event.summary}${event.detail === null ? "" : ` · ${event.detail}`}`, width);
    const phase = event.lifecycle === "failed" ? "NEEDS ATTENTION" : event.lifecycle === "completed" ? "READY" : "PLANNING";
    return wrapDisplay(`${phase} · ${event.summary.replace(/^planning task$/u, "Building the plan")}${event.detail === null ? "" : ` · ${event.detail}`}`, width);
  });
  return lines.slice(0, Math.max(1, height));
}

function renderAdrDocument(rows: readonly Readonly<Record<string, unknown>>[], width: number, height: number): readonly string[] | null {
  const document = bySection(rows, "adr-document")[0];
  if (document === undefined) return null;
  const heading = [
    clipDisplay(`ADR · ${document.id} · ${document.status}`, width),
    clipDisplay(document.title, width),
    clipDisplay(document.source_path, width),
    "─".repeat(Math.max(1, width)),
  ];
  const content = document.content.split("\n").flatMap((line) => wrapDisplay(line, width));
  return [...heading, ...content].slice(0, Math.max(1, height));
}

/** Compose the persistent right inspector without turning it into a footer. */
function renderWithPersistentInspector(
  rows: readonly Readonly<Record<string, unknown>>[],
  left: readonly string[],
  width: number,
  height: number,
  color: boolean,
  theme?: RunTheme,
  colorMode: ColorMode = "truecolor",
): readonly string[] {
  const sidebar = bySection(rows, "sidebar")[0]?.projection;
  if (sidebar?.mode !== "docked") return left.slice(0, height);
  const sidebarWidth = Math.min(RESPONSIVE_SIDEBAR_WIDTH, Math.max(30, width - 42));
  const centerWidth = Math.max(1, width - sidebarWidth - 1);
  const document = renderAdrDocument(rows, centerWidth, height);
  const center = (document ?? left.flatMap((line) => wrapDisplay(line, centerWidth))).slice(0, height);
  // Reserve the fact strip's rows BEFORE the inspector claims the rail.
  // Laying the inspector out first and giving the facts "whatever is left"
  // meant a tall tree simply consumed the whole rail: at 100x30 the entire
  // OPERATOR install-health block (DOCTOR/MIGRATION/REMOTE/SCHEDULER/...)
  // vanished with no marker, while the same session at 140x44 showed it in
  // full. `operatorFactLines` degrades honestly to a `+N more · Ctrl+B` strip
  // when it is short of room, but only if it is given SOME room -- at a zero
  // budget it returns nothing at all, which is the silent cut this file's own
  // clipping convention forbids.
  const factCount = bySection(rows, "fleet").length + bySection(rows, "portfolio").length + bySection(rows, "operations").length;
  const factReserve = factCount === 0 ? 0 : Math.min(factCount + 1, Math.max(2, Math.floor(height * 0.3)));
  const inspector = renderResponsiveSidebar(sidebar, { width: sidebarWidth, height: Math.max(1, height - factReserve), color, theme, color_mode: colorMode });
  const factLines = operatorFactLines(rows, sidebarWidth, Math.max(0, height - inspector.length - 1));
  const inspectorColumn = [...inspector, ...(factLines.length === 0 ? [] : ["", ...factLines])];
  return stackHorizontal([
    { id: "document", lines: center, weight: centerWidth },
    { id: "inspector", lines: inspectorColumn, weight: sidebarWidth },
  ], { total_width: width, color }).slice(0, height);
}

function renderFrontierHeader(rows: readonly Readonly<Record<string, unknown>>[], width: number, height: number, color: boolean, theme?: RunTheme, colorMode: ColorMode = "truecolor"): readonly string[] {
  const uct = bySection(rows, "uct")[0];
  const objective = bySection(rows, "objective")[0]?.label;
  const runControl = bySection(rows, "run-control")[0]?.state;
  const identity = renderHeader(rows, width, color, theme, colorMode);
  if (uct === undefined || height <= 1) return [identity].slice(0, height);
  // A search tree is useful current-state context once it exists. Before that,
  // a graph, its legend, and a reserved billboard are all false affordances:
  // they say the harness has a frontier while the operator is still waiting for
  // task planning to create one.
  if (uct.nodes.length === 0) {
    const state = objective === undefined
      ? "FRONTIER · awaiting planned work"
      : `OBJECTIVE · ${objective} · awaiting planned work`;
    return [identity, clipDisplay(state, width)].slice(0, height);
  }
  // Branching earns rows too, not just node count. The sibling spine needs one
  // row per alternative; the graph is deliberately capped so the transcript
  // remains the dominant reading surface.
  const widestFan = (() => {
    const perParent = new Map<string, number>();
    for (const node of uct.nodes) {
      const parent = node.parent_id;
      if (typeof parent !== "string" || parent === "") continue;
      perParent.set(parent, (perParent.get(parent) ?? 0) + 1);
    }
    return Math.max(0, ...perParent.values());
  })();
  const graphHeight = Math.min(
    Math.max(1, height - 2),
    Math.max(3, Math.ceil(uct.nodes.length / 4) + 2, widestFan > 1 ? widestFan * 2 + 1 : 0),
  );
  const graph = projectUctHeader({ nodes: uct.nodes, governance: uct.signals }, { width, height: graphHeight, color });
  const scale = graph.metrics.encoding === "direct" ? "1:1" : `${graph.metrics.encoding} · ${graph.metrics.rendered_node_count}/${graph.metrics.node_count}`;
  const suffix = ` · tree ${scale}`;
  // Lay the header out INSIDE the room the suffix leaves, so the status is
  // never the part a trailing clip removes (EC-062).
  const headerWithinSuffix = renderHeader(rows, Math.max(8, width - displayWidth(suffix)), color, theme, colorMode);
  const first = `${headerWithinSuffix}${suffix}`;
  const states = new Map<string, number>();
  for (const node of uct.nodes) states.set(node.state, (states.get(node.state) ?? 0) + 1);
  const active = uct.halted || runControl !== undefined ? undefined : uct.nodes.find((node) => node.state === "expanding") ?? uct.nodes.find((node) => node.state === "claimed" && node.parent_id !== null);
  const now = runControl === "stopping"
    ? "OUTCOME · stopping at the operator's request"
    : runControl === "stopped"
      ? "OUTCOME · stopped by the operator · ready for another instruction"
      : uct.halted
    ? `OUTCOME · halted${uct.halt_reason === null ? "" : ` (${uct.halt_reason})`} · ${states.get("verified") ?? 0} verified · ${states.get("failed") ?? 0} failed`
    : active === undefined
      ? `${objective === undefined ? "FRONTIER" : `OBJECTIVE · ${objective}`} · ${states.get("pending") ?? 0} candidate · ${states.get("verified") ?? 0} verified · ${states.get("failed") ?? 0} failed`
      : `NOW · ${active.action_description ?? active.label ?? active.id}${objective === undefined ? "" : ` · objective ${objective}`} · frontier ${states.get("pending") ?? 0} · verified ${states.get("verified") ?? 0}`;
  // The graph's glyphs are self-contained state markers; a permanently
  // repeated legend only consumes transcript room. Detailed tree semantics
  // stay available in the dedicated Tree surface.
  // Marked when cut: "OBJECTIVE · … · 0 verifi│" at 60 columns (EC-055c).
  const stateTone = uct.halted ? ((states.get("failed") ?? 0) > 0 ? "danger" : "success") : "info";
  return [first, ...graph.lines, emphasize(clipLabelWithEllipsis(now, width), stateTone, color, theme, colorMode)].slice(0, height);
}

/**
 * Terse rendering of the absorbed fleet/portfolio facts.
 *
 * Wide layouts get one fact per line in the docked rail, where ADR-149
 * Decision 7 puts bounded contextual detail. Narrow layouts cannot afford a
 * rail, so the same facts collapse to a single ` · `-joined strip rather than
 * disappearing — the Dashboard and Projects screens they came from are gone,
 * so dropping them at narrow width would lose the information outright rather
 * than relocate it.
 *
 * Values are rendered as supplied. A fact whose value is "unavailable" or
 * "none" says so; this function never substitutes a zero.
 */
function operatorFactLines(rows: readonly Readonly<Record<string, unknown>>[], width: number, height: number): readonly string[] {
  const facts = [
    ...bySection(rows, "fleet").map((row) => row.fact),
    ...bySection(rows, "portfolio").map((row) => row.fact),
    ...bySection(rows, "operations").map((row) => row.fact),
  ];
  if (facts.length === 0 || height <= 0 || width <= 0) return [];
  // One fact per line whenever the budget allows it, headed so the block is
  // identifiable; otherwise WRAP the joined strip across the rows available
  // rather than clipping it. Clipping would silently drop the tail facts —
  // and since the Dashboard and Projects screens these came from are gone,
  // a dropped fact is gone from the product, not merely from this view.
  if (height >= facts.length + 1) {
    return ["OPERATOR", ...facts.map((fact) => clipLabelWithEllipsis(`${fact.label}  ${fact.value}`, width))];
  }
  // Compact mode cannot show every fact. ADR-149 Decision 7 permits hiding the
  // rail at narrow width but requires the layout be EXPLICITLY labelled, and
  // this file's own clipping convention (ADR-126 Decision 2) is that truncation
  // must be visible rather than a silent cut. So count what did not fit and say
  // so, instead of letting the tail vanish without a trace.
  // The header is not optional. ADR-149 Decision 7 (quoted above) requires the
  // compact layout to be EXPLICITLY labelled, and without it the strip renders
  // as bare "DOCTOR available · MIGRATION available · ..." with nothing saying
  // whose facts these are -- at 100x30 the block was unidentifiable while the
  // same session at 140x44 headed it "OPERATOR". OpenCode emits a group header
  // unconditionally (`dialog-select.tsx` groupBy + headers); no exemplar drops
  // a section label when compacting. EC-008.
  const parts = facts.map((fact) => `${fact.label} ${fact.value}`);
  // EC-057: the wrapped ` · ` strip is a wall — at 132x50 it took eighteen
  // rows to say what a list says in nineteen, and could not be scanned. When
  // there is room for a real list, list as many facts as fit, one per line,
  // and name the remainder; the wall is only for a rail too short to list.
  if (height >= 6) {
    const shown = facts.slice(0, height - 2);
    const marker = `+${facts.length - shown.length} more · Ctrl+B`;
    return ["OPERATOR", ...shown.map((fact) => clipLabelWithEllipsis(`${fact.label}  ${fact.value}`, width)), clipLabelWithEllipsis(marker, width)];
  }
  const wrapped = wrapDisplay(parts.join(" · "), Math.max(1, width));
  if (wrapped.length + 1 <= height) return ["OPERATOR", ...wrapped];
  const kept = ["OPERATOR", ...wrapped].slice(0, height);
  const shownText = kept.join(" ");
  const hidden = parts.filter((part) => !shownText.includes(part)).length;
  if (hidden === 0) return kept;
  const marker = `+${hidden} more · Ctrl+B`;
  const last = kept[kept.length - 1] ?? "";
  kept[kept.length - 1] = displayWidth(`${last} ${marker}`) <= width
    ? `${last} ${marker}`
    : clipLabelWithEllipsis(last, Math.max(0, width - displayWidth(marker) - 1)) + " " + marker;
  return kept;
}

/**
 * The manifest is intentionally adjacent to the composer: when a campaign
 * completes, the operator can read what happened, inspect its evidence, then
 * choose the next governed action without hunting through an old transcript.
 */
function completionManifestRows(rows: readonly Readonly<Record<string, unknown>>[], width: number): readonly string[] {
  const manifest = bySection(rows, "completion");
  if (manifest.length === 0) return [];
  return manifest.flatMap((entry, index) => wrapDisplay(
    `${index === 0 ? "COMPLETION · " : "             "}${entry.label} · ${entry.value}`,
    width,
  ));
}

function renderFrontierBody(rows: readonly Readonly<Record<string, unknown>>[], width: number, height: number, color: boolean, offset?: number, frameCount = 0, theme?: RunTheme, colorMode: ColorMode = "truecolor", reviewExpanded = false): readonly string[] {
  const sidebar = bySection(rows, "sidebar")[0]?.projection;
  const inspector = bySection(rows, "operator-inspector")[0]?.inspector;
  const status = bySection(rows, "agent-status")[0]?.label;
  const attention = bySection(rows, "attention")[0]?.label;
  const completionLines = completionManifestRows(rows, width);
  const uct = bySection(rows, "uct")[0];
  const runControl = bySection(rows, "run-control")[0]?.state;
  const cancellingTask = bySection(rows, "cancellation")[0]?.task;
  const active = runControl === undefined && (status !== undefined || uct?.nodes.some((node) => node.state === "expanding" || node.state === "claimed") === true);
  const activityText = runControl === "stopping" ? `Stopping · cancelling ${cancellingTask ?? "work in flight"}`
    : runControl === "stopped" ? "Stopped · ready for your next instruction"
    : status !== undefined && uct?.halted !== true
    ? "Thinking · waiting for the next streamed update"
    // A halt with nothing verified is a failure, not a completion: the
    // provider-backed pilot read "Complete · ready for review" two rows under
    // "0 verified · 1 failed" while Diff Review refused (EC-064).
    : uct?.halted === true ? ((uct.nodes.some((node) => node.state === "verified") ? "Complete · ready for review" : `Halted · nothing verified${uct.nodes.some((node) => node.state === "failed") ? " · see the BLOCKED reason above" : ""}`))
      : active ? "Working · waiting for the next streamed update" : "Idle · ready for your next instruction";
  const attentionLine = attention === undefined ? [] : wrapDisplay(`${attention.startsWith("BLOCKED ·") ? "!" : "?"} ${attention}`, width).slice(0, Math.max(1, Math.min(4, height - 1)));
  if (attention?.startsWith("BLOCKED ·") === true) {
    attentionLine.push(...wrapDisplay(/HTTP 402\b/u.test(attention)
      ? "Next: check provider access and billing before retrying. [t] inspect task"
      : "Next: inspect the failed task before retrying. [t] open Tree", width).slice(0, 2));
  }
  const showStatus = attention === undefined || runControl !== undefined;
  for (let index = 0; index < attentionLine.length; index++) {
    attentionLine[index] = emphasize(attentionLine[index]!, attentionLine[index]!.startsWith("Next:") ? "info" : attention?.startsWith("BLOCKED") ? "danger" : "warning", color, theme, colorMode);
  }
  const fixedRows = (showStatus ? 1 : 0) + attentionLine.length + completionLines.length;
  const available = Math.max(1, height - fixedRows);
  const working = (active && uct?.halted !== true) || runControl === "stopping";
  // Measure the prose, not the escape bytes: at 60 columns this read
  // "◌ Thinking · waiting for the next s" with 23 blank cells to its right
  // because the emphasised glyph's SGR was charged as width (EC-055b).
  const statusLine = showStatus ? [`${emphasize(working ? spinnerGlyph(frameCount) : "·", working ? "accent" : "muted", color, theme, colorMode)} ${clipLabelWithEllipsis(activityText, Math.max(1, width - 2))}`] : [];
  const inspectorLines = inspector === undefined ? [] : [
    // Keep the ordinary inspector to one row. It is permanently visible in
    // the bounded dock, so a second metadata-only row would evict the newest
    // chronology detail at common terminal heights.
    clipLabelWithEllipsis(
      `INSPECT · ${inspector.title} · ${inspector.lifecycle} · ${inspector.actor} · ${inspector.source}/${inspector.source_id}`,
      width,
    ),
    ...(inspector.failure === null ? [] : [clipDisplay(
      `${inspector.failure.level} failure · ${inspector.failure.classification}`
        + `${inspector.failure.stage === null ? "" : ` · ${inspector.failure.stage}`}`
        + `${inspector.failure.effect === null ? "" : ` · effect ${inspector.failure.effect}`}`
        + ` · retry safety ${inspector.failure.retry_safe === null ? "not reported" : inspector.failure.retry_safe ? "safe" : "unsafe"}`,
      width,
    )]),
  ];
  if (sidebar?.mode === "overlay") {
    // A deliberately opened narrow sidebar is an inspection mode. Give its
    // compact fact summary a bounded, labelled slice before the detailed
    // sidebar rather than quietly dropping it merely because it overlays.
    const factLines = operatorFactLines(rows, width, Math.min(4, available));
    const sidebarHeight = Math.max(1, available - inspectorLines.length - factLines.length);
    return [...attentionLine, ...statusLine, ...inspectorLines, ...factLines, ...renderResponsiveSidebar(sidebar, { width: Math.min(width, RESPONSIVE_SIDEBAR_WIDTH), height: sidebarHeight, color, theme, color_mode: colorMode }), ...completionLines].slice(0, height);
  }
  if (sidebar?.mode === "docked") {
    const sidebarWidth = Math.min(RESPONSIVE_SIDEBAR_WIDTH, Math.max(24, width - 36));
    const timelineWidth = Math.max(1, width - sidebarWidth - 1);
    const timeline = renderAdrDocument(rows, timelineWidth, available)
      ?? renderSemanticTimeline(rows, timelineWidth, available, color, offset, theme, colorMode, reviewExpanded);
    // Same reservation as `renderWithPersistentInspector`: the fact strip gets
    // its rows before the inspector body fills the rail, so a tall tree cannot
    // silently swallow the operator-fact block at small terminal heights.
    const dockedFactCount = bySection(rows, "fleet").length + bySection(rows, "portfolio").length + bySection(rows, "operations").length;
    const dockedFactReserve = dockedFactCount === 0 ? 0 : Math.min(dockedFactCount + 1, Math.max(2, Math.floor(available * 0.3)));
    const sidebarBody = renderResponsiveSidebar(sidebar, { width: sidebarWidth, height: Math.max(1, available - dockedFactReserve), color, theme, color_mode: colorMode });
    // Facts are included only for an explicitly opened sidebar (see
    // `project()`), never as a default Console dump.
    const factLines = operatorFactLines(rows, sidebarWidth, Math.max(0, available - sidebarBody.length - 1));
    const sidebarColumn = [...inspectorLines.map((line) => clipLabelWithEllipsis(line, sidebarWidth)), ...(inspectorLines.length === 0 ? [] : [""]), ...sidebarBody, ...(factLines.length === 0 ? [] : ["", ...factLines])];
    // Transcript and selected documents start at the top. `stackHorizontal`
    // pads the shorter column below its content; it must never push the first
    // useful sentence toward the composer merely because the inspector is
    // taller.
    const timelineColumn = timeline;
    // Region weights are the exact available widths here, preserving the
    // sidebar's 42-column contract while using the shared ANSI-safe composer.
    const body = stackHorizontal([
      { id: "timeline", lines: timelineColumn, weight: timelineWidth },
      { id: "sidebar", lines: sidebarColumn, weight: sidebarWidth },
    ], { total_width: width, color });
    return [...attentionLine, ...statusLine, ...body, ...completionLines].slice(0, height);
  }
  // Default Console: the document owns every remaining row. Context is a
  // deliberate drill-down, never an auto-expanded dashboard between the
  // operator and the work they just asked the harness to perform.
  const timeline = renderSemanticTimeline(rows, width, available, color, offset, theme, colorMode, reviewExpanded);
  return [...attentionLine, ...statusLine, ...timeline, ...completionLines].slice(0, height);
}

/** Shared diagnostic content for both standalone Console and the product rail. */
export function consoleInspectorDiagnostics(projection: ScreenProjection, width: number): readonly string[] {
  const inspected = bySection(projection.rows, "operator-inspector")[0]?.inspector;
  return [
    ...(inspected ? [clipLabelWithEllipsis(`INSPECT · ${inspected.title} · ${inspected.lifecycle}`, Math.max(1, width - 2)), ""] : []),
    ...operatorFactLines(projection.rows, Math.max(1, width - 2), Number.MAX_SAFE_INTEGER),
  ];
}

function render(projection: ScreenProjection, width: number, height: number, color: boolean, offset?: number, liveEdge?: FrontierLiveEdgeState, frameCount = 0, theme?: RunTheme, colorMode: ColorMode = "truecolor"): readonly string[] {
  const rows = projection.rows;
  const sidebar = bySection(rows, "sidebar")[0]?.projection;
  if (sidebar && sidebar.mode !== "hidden") {
    // The inspector is a sibling of the entire conversation, including the
    // header and composer, not a short box inside the transcript body.
    const sidebarWidth = Math.min(RESPONSIVE_SIDEBAR_WIDTH, width);
    const diagnostics = consoleInspectorDiagnostics(projection, sidebarWidth);
    const rail = renderResponsiveSidebar(sidebar, { width: sidebarWidth, height, color, theme, color_mode: colorMode, supplemental_lines: diagnostics });
    const primary = { ...projection, rows: rows.map((row) => row.region === "sidebar"
      ? { ...row, projection: { ...sidebar, mode: "hidden" as const } } : row) };
    if (sidebar.mode === "overlay") {
      const leftWidth = Math.max(0, width - sidebarWidth - 1);
      if (leftWidth === 0) return rail;
      const left = render(primary, width, height, color, offset, liveEdge, frameCount, theme, colorMode)
        .map((line) => clipDisplay(line, leftWidth));
      return stackHorizontal([{ id: "conversation", lines: left, weight: leftWidth }, { id: "inspector", lines: rail, weight: sidebarWidth }], { total_width: width, color }).slice(0, height);
    }
    const leftWidth = Math.max(1, width - sidebarWidth - 1);
    const left = render(primary, leftWidth, height, color, offset, liveEdge, frameCount, theme, colorMode);
    return stackHorizontal([{ id: "conversation", lines: left, weight: leftWidth }, { id: "inspector", lines: rail, weight: sidebarWidth }], { total_width: width, color }).slice(0, height);
  }
  // The composer grows with its multiline buffer but has a terminal-size
  // bound. It remains a bottom anchor in every renderer; sparse chronology
  // receives its blank space above it, never below it.
  const composerCap = height >= 32 ? 6 : height >= 20 ? 4 : height >= 10 ? 2 : 1;
  const input = renderInputStrip(rows, width, composerCap, color, theme, colorMode);
  const inputHeight = Math.min(height, input.length);
  const visibleInput = input.slice(Math.max(0, input.length - inputHeight));
  if (projection.variant === "fresh") {
    const bodyHeight = Math.max(0, height - visibleInput.length);
    // This column used to repeat `status-bar.ts`'s "Idle — describe what you
    // want changed" verbatim, so a 44-row greenfield screen showed the SAME
    // sentence twice, ~40 rows apart, while the whole centre column sat empty.
    // The status bar is persistent and already carries that prompt; what it
    // cannot carry is which repository this session is actually operating on.
    // The rail shows that path clipped into 40 columns, so state it here at
    // full width instead of echoing a line the operator is already reading.
    const sidebarProjection = bySection(rows, "sidebar")[0]?.projection;
    const repositoryRoot = sidebarProjection?.project?.repository_root;
    // An empty primary column is the one thing every frontier shell avoids on
    // a first run: the transcript has nothing in it yet, so the column carries
    // orientation instead of 40 blank rows. State what this session is
    // pointed at, that no campaign exists, and what a request looks like --
    // the composer's own placeholder can only say "describe what you want
    // changed", which does not tell a new operator the GRAIN of request this
    // accepts. Keys are deliberately not repeated here; the status bar and
    // composer footer already carry them.
    // Plain here; the bullet is emphasised AFTER layout. The heading is
    // wrapped by `wrapDisplay`, whose sanitiser strips every C0 control, so an
    // SGR sequence embedded here lost its ESC and rendered its parameters as
    // text: `[38;2;170;160;185m·[0m New session on …` on every greenfield
    // launch (EC-049). Both exemplars style spans after laying out plain text.
    const heading = typeof repositoryRoot === "string" && repositoryRoot.length > 0
      ? `· New session on ${repositoryRoot}`
      : "· New session";
    // Worked examples are onboarding for a blank composer. The moment the
    // operator has typed something they have demonstrably understood the
    // grain of request this takes, and leaving three sample prompts on screen
    // turns guidance into clutter competing with their own words -- so the
    // examples retire on first keystroke, the way a placeholder does.
    const composerText = bySection(rows, "input")[0]?.text;
    const composerHasText = typeof composerText === "string" && composerText.trim().length > 0;
    // Exemplar (EC-001, `artifacts/tui-pilot/2026-09-02-exemplar-checks.md`):
    // Claude Code renders ONE example at a time -- `Try "${G[...]}"` -- drawn
    // from a set whose entries are short, imperative, and several of them
    // parameterised with a real filename from the user's own project
    // (`refactor ${N}`, `write a test for ${N}`). A generic three-line list is
    // heavier and says nothing about THIS repository, so the sample is bound
    // to a file the operator can actually see in the rail beside it. The index
    // is derived from the repository path so it is stable for a session rather
    // than flickering on every repaint.
    const entries = sidebarProjection?.project?.repository_entries ?? [];
    // Prefer a SOURCE file for the sample: "refactor README.md" is a real path
    // but a poor suggestion, and docs/config/lock files are usually first
    // alphabetically, so taking the first entry reliably picked the worst one.
    const documentation = /\.(?:md|markdown|txt|json|jsonl|ya?ml|toml|lock|ini|cfg|mod|sum|properties)$/i;
    const files = entries.filter((entry) => entry.kind !== "directory");
    const sampleFile = (files.find((entry) => !documentation.test(entry.path) && !entry.path.startsWith("."))
      ?? files.find((entry) => !entry.path.startsWith("."))
      ?? files[0])?.path ?? null;
    const examples = sampleFile === null
      ? ["fix the failing tests", "add a health check endpoint and a test for it", "find and fix the flaky test in the suite"]
      : [`write a test for ${sampleFile}`, `refactor ${sampleFile}`, `explain how ${sampleFile} works`, "fix the failing tests"];
    const seed = [...(repositoryRoot ?? "")].reduce((total, character) => (total * 31 + character.charCodeAt(0)) % 100_000, 7);
    const example = examples[seed % examples.length] ?? examples[0]!;
    const orientation = composerHasText
      ? [heading, "", "No campaign yet. Enter sends this to planning."]
      : [
        heading,
        "",
        "No campaign yet. Describe a change below and revoy plans it into one.",
        "",
        `Try "${example}"`,
      ];
    const laidOut = renderWithPersistentInspector(rows, orientation, width, bodyHeight, color, theme, colorMode);
    const body = color && laidOut[0]?.startsWith("· ")
      ? [`${emphasize("·", "muted", color, theme, colorMode)}${laidOut[0].slice(1)}`, ...laidOut.slice(1)]
      : laidOut;
    return [...body, ...Array.from({ length: Math.max(0, bodyHeight - body.length) }, () => ""), ...visibleInput];
  }
  if (projection.variant === "reference-answer") {
    const bodyHeight = Math.max(0, height - visibleInput.length);
    const reference = bySection(rows, "reference-answer")[0]?.reference;
    const content = reference === undefined ? ["Reference answer unavailable"] : renderConsoleReferenceAnswer(reference, width, bodyHeight, offset);
    if (color && content.length > 0) content[0] = emphasize(content[0]!, reference?.status === "answered" ? "accent" : "warning", color, theme, colorMode);
    const body = renderWithPersistentInspector(rows, content, width, bodyHeight, color, theme, colorMode);
    return [...body, ...Array.from({ length: Math.max(0, bodyHeight - body.length) }, () => ""), ...visibleInput].slice(0, height);
  }
  if (projection.variant === "planning") {
    const bodyHeight = Math.max(0, height - visibleInput.length);
    const stopping = bySection(rows, "cancellation").length > 0;
    // Plain for layout, styled after (EC-049's sibling: the same wrap path
    // stripped the ESC here and rendered "[38;2;…m◌[0m Planning your").
    const glyph = spinnerGlyph(frameCount);
    const planning = [`${glyph} ${stopping ? "Stopping your request" : "Planning your request · Esc cancel"}`, ...renderPlanningTimeline(rows, width, bodyHeight)];
    const laidOut = renderWithPersistentInspector(rows, planning, width, bodyHeight, color, theme, colorMode);
    const body = color && laidOut[0]?.startsWith(`${glyph} `)
      ? [`${emphasize(glyph, "accent", color, theme, colorMode)}${laidOut[0].slice(glyph.length).replace(" · Esc cancel", ` · ${emphasize("Esc", "warning", color, theme, colorMode)} cancel`)}`, ...laidOut.slice(1)]
      : laidOut;
    return [...body, ...Array.from({ length: Math.max(0, bodyHeight - body.length) }, () => ""), ...visibleInput].slice(0, height);
  }
  const remaining = Math.max(0, height - inputHeight);
  const nodeCount = bySection(rows, "uct")[0]?.nodes.length ?? 0;
  // Current state should orient the reader, not become a dashboard. A missing
  // tree gets two compact lines; a real frontier earns at most five.
  const headerHeight = nodeCount === 0
    ? Math.min(2, remaining)
    : Math.min(7, Math.max(2, Math.floor(remaining * 0.22)));
  const header = renderFrontierHeader(rows, width, headerHeight, color, theme, colorMode);
  const bodyHeight = Math.max(0, remaining - header.length);
  const history = liveEdge?.mode === "scrollback"
    ? [clipDisplay(`↑ HISTORY · ${liveEdge.unseen_meaningful_events} new · End return to live`, width)]
    : [];
  const body = [...history, ...renderFrontierBody(rows, width, Math.max(0, bodyHeight - history.length), color, offset, frameCount, theme, colorMode, liveEdge?.mode === "scrollback")];
  // A console is read from the current task downward. Keep transcript rows
  // immediately below current state; only any genuinely spare terminal space
  // belongs below the document, before the anchored composer.
  const totalContent = header.length + body.length + visibleInput.length;
  const spacer = Array.from({ length: Math.max(0, height - totalContent) }, () => "");
  return [...header, ...body, ...spacer, ...visibleInput].slice(0, height);
}

// ── module ───────────────────────────────────────────────────────────────────

export const consoleScreen: ScreenModule = {
  id: "console" as ScreenId,
  title: "Console",
  required_capabilities: ["campaign.read"],
  surface: {
    commands: ["taskcomposer.submit", "harness.session.steer", "harness.session.interrupt"],
    queries: [...PRODUCT_SURFACE_QUERIES, "campaign.tree", "devtools.stream", "harness.session.attach", "output.list", "task.list"],
  },
  project: (result, context) => project(result, context.width),
  render: ({ projection, width, height, color, scroll_offset, live_edge, frame_count, theme, color_mode }) => render(projection, Math.max(1, width), Math.max(1, height), color === true, scroll_offset, live_edge, frame_count ?? 0, theme, color_mode),
};
