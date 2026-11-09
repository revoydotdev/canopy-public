import { selectConsoleReferenceAnswer } from "./console-reference-answer.js";
import type { AppEvent, AppModel, Diagnostic, FocusZone, Notification, OperatorFormKind, OperatorFormOverlay, UpdateResult } from "./types.js";
import type { ScreenId } from "./screens/screen.js";
import { freezeTelemetrySnapshot } from "./telemetry-types.js";
import { deriveTransitions, isDevToolsStreamShape } from "./player-piano.js";
import { observeUctPlayback } from "./uct-playback.js";
import { fromReviewLines, type ReviewDiffLineLike, type ReviewFileLike } from "./diff-view.js";
import {
  latestInterview, oldestPendingApproval, selectedPendingApproval, selectScreenRow,
  selectScreenEndpoint, selectTreeRow, stepScreenSelection, stickyScreenSelection,
} from "./operator-selection.js";
import { applyUctEvents, emptyUctGraph, updateUctReader, type UctGraphModel } from "./uct-model.js";
import { backspace as bufferBackspace, deleteForward as bufferDeleteForward, fromText as bufferFromText, insertText as bufferInsertText, moveCursor as bufferMoveCursor } from "./text-buffer.js";
import { applyVimKey } from "./terminal-editor.js";
import { buildOperatorViewModel, consoleOperatorProjectionInput, type EventView } from "./operator-view-model.js";
import {
  createFrontierLiveEdgeState,
  reduceFrontierLiveEdge,
  type FrontierLiveEdgeState,
} from "./frontier-live-edge.js";

/** Mirrors `@arbor/audit`'s USER_INPUT_MAX_ANSWER_BYTES — arbor-tui does not import @arbor/audit. */
const MAX_ANSWER_BYTES = 8 * 1024;

/**
 * A fixed, disclosed default for an operator-triggered `tree.branch`
 * (wave1/tui-contracts). `tree.branch` requires a full `Action`
 * (`arbor-core/src/types.ts`) — description, estimated_gain/cost, category,
 * delegate_to — normally produced by the tree-search loop's own
 * Specialist/UCB analysis. A single keypress cannot legitimately manufacture
 * a real gain/cost estimate, so this is NOT presented as one: `category:
 * "operator"` and the description both mark it plainly as a manual,
 * conservative-default expansion the operator asked for, not an automated
 * proposal. `delegate_to: "seed"` mirrors the general-specialist role used
 * for exploratory work elsewhere in this codebase (see `demo.ts`).
 */
const OPERATOR_BRANCH_ACTION = Object.freeze({
  description: "Operator-requested expansion",
  estimated_gain: 5,
  estimated_cost: 5,
  category: "operator",
  delegate_to: "seed",
});

export function update(model: AppModel, event: AppEvent): UpdateResult {
  switch (event.type) {
    case "ui_intent":
      return updateIntent(model, event.intent, event.at);
    case "transport_connecting":
      return result(model, { connection: { status: "connecting", attempt: event.attempt } });
    case "transport_connected":
      return {
        model: { ...model, epoch: model.epoch + 1, connection: { status: "synchronizing", cursor: model.snapshot?.cursor ?? null } },
        effects: [{ type: "request_snapshot", afterCursor: model.snapshot?.cursor ?? null }],
      };
    case "snapshot_received":
      if (model.snapshot !== null && event.snapshot.version < model.snapshot.version) {
        return addError(model, {
          fingerprint: "snapshot:stale",
          message: `Ignored stale snapshot version ${event.snapshot.version}`,
          source: "synchronization",
          recoverable: true,
          code: "conflict",
        }, event.snapshot.receivedAt);
      }
      return result(model, {
        snapshot: event.snapshot,
        connection: { status: "connected", cursor: event.snapshot.cursor },
      });
    case "cursor_advanced":
      if (model.connection.status !== "connected") {
        return addError(model, {
          fingerprint: "cursor:not-connected",
          message: "Ignored cursor update while not connected",
          source: "synchronization",
          recoverable: true,
          code: "conflict",
        }, 0);
      }
      return result(model, { connection: { status: "connected", cursor: event.cursor } });
    case "transport_disconnected":
      return result(model, { connection: { status: "disconnected", reason: event.reason } });
    case "error_raised":
      return addError(model, event.error, event.at);
    case "external_editor_result":
      return applyExternalEditorResult(model, event.request_id, event.text, event.at);
    case "notification_added":
      // Notification ids are semantic identities. Re-emitting the same local
      // state replaces its prior footer row instead of crowding the band with
      // obsolete values (for example while cycling themes).
      return result(model, { notifications: appendBounded(model.notifications.filter((item) => item.id !== event.notification.id), event.notification, model.limits.notifications) });
    case "shutdown_complete":
      return result(model, {
        connection: { status: "disconnected", reason: "shutdown" },
        shutdownComplete: true,
      });
    case "telemetry_requested":
      return telemetryRequested(model, event.campaignId, event.at);
    case "telemetry_received":
      return telemetryReceived(model, event.snapshot);
    case "screen_changed":
      return result(model, { screen: event.screen });
    case "command_dispatched":
      return result(model, {});
    case "query_results":
      return queryResults(model, event.queryId, event.screen, event.value, event.observed_at_ms);
    case "grants_updated":
      return result(model, { grantedCapabilities: new Set(event.capabilities) });
    case "repeat_confirmation_elapsed":
      return model.repeatConfirmation?.token === event.token ? result(model, { repeatConfirmation: null }) : modelOnly(model);
    case "read_model_updated":
      return result(model, { readModel: event.model });
  }
}

/**
 * Screens whose row selection is kept sticky across a fresh fetch (jobs/
 * operations/tasks generalize the Tree screen's original wave1/tui-contracts
 * behavior — command-surface expansion for job.cancel/retry, operation.cancel,
 * task.retry). Any other screen's `selection` entry is left untouched by a
 * query result — most screens have no row-scoped command to key a selection
 * for at all.
 */
const STICKY_SELECTION_SCREENS: ReadonlySet<ScreenId> = new Set(["tree", "jobs", "operations", "tasks", "recovery", "output", "communications", "approvals", "interviews", "overlays", "threads", "harness-sessions", "harness-evaluations", "task-composer", "console", "project-registry", "live-session"]);

/** Screens whose selected row is a native harness session (ADR-107: `harness-sessions` is the durable inventory, `live-session` the interactive front door — both share the same attach/steer/interrupt round trip). */
const HARNESS_SESSION_SCREENS: ReadonlySet<ScreenId> = new Set(["harness-sessions", "live-session"]);
const FRONTIER_TRANSCRIPT_SCREENS: ReadonlySet<ScreenId> = new Set(["console", "live-session"]);

function frontierDocument(screen: ScreenId, value: unknown): readonly EventView[] {
  if (!FRONTIER_TRANSCRIPT_SCREENS.has(screen) || typeof value !== "object" || value === null || Array.isArray(value)) return [];
  const shape = value as Record<string, unknown>;
  const input = screen === "console"
    ? consoleOperatorProjectionInput(value, { viewport: { columns: 120, rows: 40 }, now_ms: 0 })
    : {
      session_attach: value,
      output_list: shape.output_list,
      viewport: { columns: 120, rows: 40 },
      now_ms: 0,
      limits: { max_rows: 200, max_detail_chars: 1_000, max_attention: 20 },
    };
  if (input === null) return [];
  const view = buildOperatorViewModel(input);
  return view.document;
}

function withFrontierLiveEdge(
  edges: ReadonlyMap<ScreenId, FrontierLiveEdgeState>,
  screen: ScreenId,
  next: FrontierLiveEdgeState,
): ReadonlyMap<ScreenId, FrontierLiveEdgeState> {
  const current = edges.get(screen);
  if (current?.mode === next.mode && current.anchor_id === next.anchor_id && current.unseen_meaningful_events === next.unseen_meaningful_events) return edges;
  const copy = new Map(edges);
  if (next.mode === "following") copy.delete(screen); else copy.set(screen, next);
  return copy;
}

function queryResults(model: AppModel, queryId: string, screen: ScreenId, value: unknown, observedAt?: number): UpdateResult {
  const stream = screen === "console" && typeof value === "object" && value !== null ? (value as { devtools?: unknown }).devtools : undefined;
  const uctPlayback = observeUctPlayback(model.uctPlayback, stream, model.telemetryCampaignId, observedAt ?? Number.NaN);
  // Fold the player-piano transition map forward when a devtools.stream result
  // arrives (the model/update cadence drives flash decay — never renderer state).
  // Diffed against this SCREEN's own previous result (`model.screens.get(screen)`),
  // never the global `latestQueryValue` — an unrelated screen's poll (e.g.
  // tui.ts's `refreshExecutionStatus`, which fetches `tree` independently of
  // focus) can land between two devtools.stream fetches and clobber that
  // global field, which would otherwise make every already-settled node look
  // brand new and re-raise a spurious full-strength flash.
  const previousDevtoolsValue = model.screens.get(screen);
  const transitions = isDevToolsStreamShape(value)
    ? deriveTransitions(
        model.devtoolsTransitions,
        isDevToolsStreamShape(previousDevtoolsValue) ? previousDevtoolsValue.lines : [],
        value.lines,
      )
    : model.devtoolsTransitions;
  const screens = new Map(model.screens);
  screens.set(screen, value);
  // Recompute the screen's sticky selection on every fresh fetch (wave1/
  // tui-contracts; generalized wave2/tui-input-model to the per-screen
  // `selection` map) — the same query result the screen itself projects,
  // read here for pure selection bookkeeping only.
  let selection = STICKY_SELECTION_SCREENS.has(screen)
    ? withSelection(model.selection, screen, stickyScreenSelection(screen, model.selection.get(screen) ?? null, value))
    : model.selection;
  let uctReader = model.uctReader;
  if (screen === "tree") {
    const graph = campaignTreeGraph(value);
    if (graph !== null) {
      const campaignId = typeof value === "object" && value !== null && typeof (value as { campaign_id?: unknown }).campaign_id === "string"
        ? (value as { campaign_id: string }).campaign_id
        : null;
      const selectedCampaignId = model.selection.get("tree")?.context?.campaign_id ?? null;
      const readerBase = campaignId !== null && selectedCampaignId !== null && campaignId !== selectedCampaignId
        ? { ...model.uctReader, selected_id: null }
        : model.uctReader;
      uctReader = updateUctReader(readerBase, graph, "snapshot");
      selection = selectionForReader(selection, value, uctReader.selected_id);
    }
  }
  let frontierLiveEdges = model.frontierLiveEdges;
  let scrollOffsets = model.scrollOffsets;
  const priorReference = referenceDocument(screen, previousDevtoolsValue);
  const nextReference = referenceDocument(screen, value);
  if (priorReference?.id !== nextReference?.id) {
    scrollOffsets = withScrollOffset(scrollOffsets, screen, 0);
    frontierLiveEdges = withFrontierLiveEdge(frontierLiveEdges, screen, createFrontierLiveEdgeState());
  }
  if (nextReference === null && FRONTIER_TRANSCRIPT_SCREENS.has(screen)) {
    const previous = frontierDocument(screen, previousDevtoolsValue);
    const next = frontierDocument(screen, value);
    const previousIds = new Set(previous.map((event) => event.id));
    let edge = frontierLiveEdges.get(screen) ?? createFrontierLiveEdgeState();
    for (const event of next) {
      if (!previousIds.has(event.id)) {
        edge = reduceFrontierLiveEdge(edge, {
          type: "arrival",
          meaningful: event.kind !== "diagnostic",
          terminal: event.kind === "terminal",
        });
      }
    }
    if (edge.mode === "scrollback") {
      const anchorIndex = next.findIndex((event) => event.id === edge.anchor_id);
      if (anchorIndex >= 0) {
        scrollOffsets = withScrollOffset(scrollOffsets, screen, anchorIndex);
      } else if (next[0] !== undefined) {
        edge = reduceFrontierLiveEdge(edge, { type: "inspect", anchor_id: next[0].id });
        scrollOffsets = withScrollOffset(scrollOffsets, screen, 0);
      }
    }
    frontierLiveEdges = withFrontierLiveEdge(frontierLiveEdges, screen, edge);
  }
  return result(model, { screens, latestQueryId: queryId, latestQueryValue: value, devtoolsTransitions: transitions, uctPlayback, selection, uctReader, frontierLiveEdges, scrollOffsets });
}

/** Build the retained reader's semantic model from the exact authoritative query result. */
function campaignTreeGraph(raw: unknown): UctGraphModel | null {
  if (typeof raw !== "object" || raw === null || !Array.isArray((raw as { nodes?: unknown }).nodes)) return null;
  const shape = raw as { nodes: readonly unknown[]; event_cursor?: { sequence?: unknown } };
  const nodes = shape.nodes.flatMap((item) => {
    if (typeof item !== "object" || item === null || typeof (item as { id?: unknown }).id !== "string") return [];
    const node = item as Record<string, unknown>;
    return [{
      id: node.id as string,
      parent_id: typeof node.parent_id === "string" ? node.parent_id : null,
      state: typeof node.state === "string" ? node.state : "unknown",
      label: typeof node.label === "string" ? node.label : typeof node.action_description === "string" ? node.action_description : undefined,
      ...(typeof node.visit_count === "number" ? { visit_count: node.visit_count } : {}),
    }];
  });
  const sequence = typeof shape.event_cursor?.sequence === "number" && Number.isSafeInteger(shape.event_cursor.sequence) ? shape.event_cursor.sequence : 0;
  return applyUctEvents(emptyUctGraph(), [{ sequence, kind: "snapshot", nodes }]);
}

function selectionForReader(selection: AppModel["selection"], raw: unknown, selectedId: string | null): AppModel["selection"] {
  if (typeof raw !== "object" || raw === null || typeof (raw as { campaign_id?: unknown }).campaign_id !== "string") return selection;
  const nodes = (raw as { nodes?: unknown }).nodes;
  if (!Array.isArray(nodes)) return selection;
  if (selectedId === null) return withSelection(selection, "tree", null);
  const index = nodes.findIndex((node) => typeof node === "object" && node !== null && (node as { id?: unknown }).id === selectedId);
  return withSelection(selection, "tree", selectTreeRow(raw, index));
}

/** Replace or clear one screen's entry in a selection map, returning a new map only when the value actually changes. */
function withSelection(
  selection: ReadonlyMap<import("./screens/screen.js").ScreenId, import("./operator-selection.js").ScreenSelection>,
  screen: import("./screens/screen.js").ScreenId,
  next: import("./operator-selection.js").ScreenSelection | null,
): ReadonlyMap<import("./screens/screen.js").ScreenId, import("./operator-selection.js").ScreenSelection> {
  if (next === (selection.get(screen) ?? null)) return selection;
  const copy = new Map(selection);
  if (next === null) copy.delete(screen); else copy.set(screen, next);
  return copy;
}

/** Replace or clear one screen's entry in a scroll-offset map, clamped to zero, returning a new map only when the value actually changes. */
function withScrollOffset(
  offsets: ReadonlyMap<import("./screens/screen.js").ScreenId, number>,
  screen: import("./screens/screen.js").ScreenId,
  next: number,
): ReadonlyMap<import("./screens/screen.js").ScreenId, number> {
  const clamped = Math.max(0, next);
  if (clamped === (offsets.get(screen) ?? 0)) return offsets;
  const copy = new Map(offsets);
  if (clamped === 0) copy.delete(screen); else copy.set(screen, clamped);
  return copy;
}

function referenceDocument(screen: ScreenId, value: unknown) {
  return screen === "console" && typeof value === "object" && value !== null
    ? selectConsoleReferenceAnswer((value as { drafts?: unknown }).drafts) : null;
}

function moveFrontierAnchor(model: AppModel, delta: number | "first" | "live"): UpdateResult | null {
  // Reference answers are top-down documents, not event-ID-anchored history.
  if (referenceDocument(model.screen, model.screens.get(model.screen)) !== null) return null;
  if (!FRONTIER_TRANSCRIPT_SCREENS.has(model.screen)) return null;
  const document = frontierDocument(model.screen, model.screens.get(model.screen));
  if (document.length === 0) return modelOnly(model);
  if (delta === "live") {
    return result(model, {
      frontierLiveEdges: withFrontierLiveEdge(model.frontierLiveEdges, model.screen, reduceFrontierLiveEdge(model.frontierLiveEdges.get(model.screen) ?? createFrontierLiveEdgeState(), { type: "return_to_live" })),
      scrollOffsets: withScrollOffset(model.scrollOffsets, model.screen, 0),
    });
  }
  const currentEdge = model.frontierLiveEdges.get(model.screen) ?? createFrontierLiveEdgeState();
  const currentIndex = currentEdge.mode === "scrollback"
    ? document.findIndex((event) => event.id === currentEdge.anchor_id)
    : document.length;
  const nextIndex = delta === "first"
    ? 0
    : Math.min(document.length - 1, Math.max(0, (currentIndex < 0 ? 0 : currentIndex) + delta));
  if (delta !== "first" && delta > 0 && nextIndex === document.length - 1) {
    return moveFrontierAnchor(model, "live");
  }
  const edge = reduceFrontierLiveEdge(currentEdge, { type: "inspect", anchor_id: document[nextIndex]!.id });
  return result(model, {
    frontierLiveEdges: withFrontierLiveEdge(model.frontierLiveEdges, model.screen, edge),
    scrollOffsets: withScrollOffset(model.scrollOffsets, model.screen, nextIndex),
  });
}

/** A sentinel offset meaning "as far down as possible" — see the `scroll_end` UiIntent doc in types.ts. Render-time clamping (`boundedOffset`-style, against the real row count and pane height together) resolves it to the true last page. */
const SCROLL_END_SENTINEL = Number.MAX_SAFE_INTEGER;
const REPEAT_CONFIRMATION_WINDOW_MS = 2_000;

function repeatConfirmation(model: AppModel, at: number, actionKey: string, hint: string, effect: UpdateResult["effects"][number]): UpdateResult {
  const current = model.repeatConfirmation;
  if (current?.action_key === actionKey && at <= current.expires_at) {
    if (current.fired) return modelOnly(model);
    return { model: { ...model, epoch: model.epoch + 1, repeatConfirmation: { ...current, fired: true } }, effects: [effect] };
  }
  const token = `${actionKey}:${at}`;
  const expiresAt = at + REPEAT_CONFIRMATION_WINDOW_MS;
  return {
    model: { ...model, epoch: model.epoch + 1, repeatConfirmation: { token, action_key: actionKey, hint, expires_at: expiresAt, fired: false } },
    effects: [{ type: "schedule_repeat_confirmation_clear", token, at: expiresAt }],
  };
}

function clampIndex(index: number, length: number): number {
  if (length <= 0) return 0;
  return Math.min(Math.max(0, index), length - 1);
}

/** The Diff Review screen's own already-fetched query result (`result.review.workspace`), or null off-screen / before it's an object — never a fabricated workspace. */
function resultReviewWorkspace(model: AppModel): Record<string, unknown> | null {
  if (model.screen !== "result-review") return null;
  const raw = model.screens.get("result-review");
  return typeof raw === "object" && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
}

const isReviewFileLike = (value: unknown): value is ReviewFileLike =>
  typeof value === "object" && value !== null
  && typeof (value as { path?: unknown }).path === "string"
  && typeof (value as { status?: unknown }).status === "string"
  && typeof (value as { additions?: unknown }).additions === "number"
  && typeof (value as { deletions?: unknown }).deletions === "number";

const isReviewDiffLineLike = (value: unknown): value is ReviewDiffLineLike =>
  typeof value === "object" && value !== null
  && typeof (value as { kind?: unknown }).kind === "string"
  && typeof (value as { text?: unknown }).text === "string";

/** The workspace's `files`/`unified` arrays parsed into diff-view's pure model, plus the clamped current file index (`review_file_index`, defaulting to 0). Bounds hunk/file navigation without guessing when the arrays are absent or malformed. */
function resultReviewFiles(workspace: Record<string, unknown>): { files: ReturnType<typeof fromReviewLines>["files"]; fileIndex: number } {
  const rawFiles = Array.isArray(workspace.files) ? workspace.files.filter(isReviewFileLike) : [];
  const rawLines = Array.isArray(workspace.unified) ? workspace.unified.filter(isReviewDiffLineLike) : [];
  const files = fromReviewLines(rawFiles, rawLines).files;
  const fileIndex = clampIndex(Number((workspace as { review_file_index?: unknown }).review_file_index ?? 0), files.length);
  return { files, fileIndex };
}

function updateIntent(model: AppModel, intent: Extract<AppEvent, { type: "ui_intent" }>["intent"], at: number): UpdateResult {
  switch (intent.type) {
    case "dismiss_notification":
      return result(model, { notifications: model.notifications.filter((item) => item.id !== intent.id) });
    case "interrupt_active_campaign":
      return repeatConfirmation(model, at, "interrupt:active-campaign", "press again to interrupt", { type: "interrupt_campaign" });
    case "focus_screen":
      return { model, effects: [{ type: "set_screen", screen: intent.screen }] };
    case "issue_query":
      return {
        model,
        effects: [intent.screen === undefined
          ? { type: "run_query", request: intent.request }
          : { type: "run_query", request: intent.request, screen: intent.screen }],
      };
    case "arm_answer": {
      if (model.screen !== "interviews" || model.overlay !== null) return modelOnly(model);
      const target = latestInterview(model.screens.get("interviews"), model.selection.get("interviews")?.id);
      if (!target) return modelOnly(model);
      return result(model, { overlay: { kind: "compose", record_id: target.record_id, question: target.question, ...(target.options === undefined ? {} : { options: target.options }), buffer: bufferFromText("").text, cursor: bufferFromText("").cursor } });
    }
    case "compose_input":
      if (model.overlay === null || model.overlay.kind !== "compose") return modelOnly(model);
      return result(model, { overlay: { ...model.overlay, buffer: intent.buffer, cursor: intent.buffer.length, error: undefined } });
    case "compose_insert": {
      if (model.overlay === null || model.overlay.kind !== "compose") return modelOnly(model);
      const composeOverlay = model.overlay;
      const state = bufferInsertText({ text: composeOverlay.buffer, cursor: composeOverlay.cursor ?? composeOverlay.buffer.length }, intent.text);
      const truncated = state.text.length > MAX_ANSWER_BYTES;
      const buffer = truncated ? state.text.slice(0, MAX_ANSWER_BYTES) : state.text;
      const cursor = Math.min(state.cursor, buffer.length);
      const overlay = { ...composeOverlay, buffer, cursor };
      // A truncation notice only fires for a genuine multi-character insert
      // (a paste) — a single typed keystroke reaching the 8 KiB ceiling is
      // never itself "truncated content", just a buffer at its limit.
      if (truncated && intent.text.length > 1) {
        return result(model, {
          overlay,
          notifications: appendBounded(model.notifications, {
            id: `compose:truncated:${at}`, severity: "warning",
            message: "Paste truncated to the 8 KiB answer limit.", createdAt: at,
          }, model.limits.notifications),
        });
      }
      return result(model, { overlay });
    }
    case "compose_backspace": {
      if (model.overlay === null || model.overlay.kind !== "compose") return modelOnly(model);
      const composeOverlay = model.overlay;
      const state = bufferBackspace({ text: composeOverlay.buffer, cursor: composeOverlay.cursor ?? composeOverlay.buffer.length });
      return result(model, { overlay: { ...composeOverlay, buffer: state.text, cursor: state.cursor } });
    }
    case "compose_delete": {
      if (model.overlay === null || model.overlay.kind !== "compose") return modelOnly(model);
      const composeOverlay = model.overlay;
      const state = bufferDeleteForward({ text: composeOverlay.buffer, cursor: composeOverlay.cursor ?? composeOverlay.buffer.length });
      return result(model, { overlay: { ...composeOverlay, buffer: state.text, cursor: state.cursor } });
    }
    case "compose_move": {
      if (model.overlay === null || model.overlay.kind !== "compose") return modelOnly(model);
      const composeOverlay = model.overlay;
      const state = bufferMoveCursor({ text: composeOverlay.buffer, cursor: composeOverlay.cursor ?? composeOverlay.buffer.length }, intent.movement);
      return result(model, { overlay: { ...composeOverlay, cursor: state.cursor } });
    }
    case "toggle_vim_mode": {
      if (model.overlay?.kind !== "compose" && model.overlay?.kind !== "operator_form") return modelOnly(model);
      const editor = model.overlay.editor?.mode === "normal" ? { mode: "insert" as const } : { mode: "normal" as const };
      return result(model, { overlay: { ...model.overlay, editor } });
    }
    case "vim_key": {
      if (model.overlay?.kind === "compose") {
        const compose = model.overlay;
        const next = applyVimKey(compose.buffer, compose.cursor ?? compose.buffer.length, compose.editor, intent.key);
        if (!next.handled) return modelOnly(model);
        return result(model, { overlay: { ...compose, buffer: next.text, cursor: next.cursor, editor: next.editor } });
      }
      if (model.overlay?.kind === "operator_form") {
        const form = model.overlay;
        const value = form.fields[form.active_field] ?? "";
        const next = applyVimKey(value, form.field_cursor ?? value.length, form.editor, intent.key, false);
        if (!next.handled) return modelOnly(model);
        return result(model, { overlay: { ...form, fields: { ...form.fields, [form.active_field]: next.text }, field_cursor: next.cursor, editor: next.editor, error: null } });
      }
      return modelOnly(model);
    }
    case "open_external_editor": {
      if (model.overlay?.kind !== "compose" || model.overlay.external_editor_request_id !== undefined) return modelOnly(model);
      const request_id = `tui:external-editor:${at}`;
      return {
        model: { ...model, overlay: { ...model.overlay, external_editor_request_id: request_id }, epoch: model.epoch + 1 },
        effects: [{ type: "open_external_editor", request_id, title: model.overlay.question, text: model.overlay.buffer, language: "markdown", max_chars: MAX_ANSWER_BYTES }],
      };
    }
    case "cancel_compose":
      if (model.overlay === null || model.overlay.kind !== "compose") return modelOnly(model);
      return result(model, { overlay: null });
    case "submit_answer": {
      if (model.overlay === null || model.overlay.kind !== "compose") return modelOnly(model);
      const compose = model.overlay;
      const text = compose.buffer.trim().slice(0, MAX_ANSWER_BYTES);
      if (!text) return modelOnly(model);
      const normalized = text.toLocaleLowerCase();
      const options = compose.options ?? [];
      const selectedOption = options.find((option) => {
        const id = option.id.toLocaleLowerCase();
        return normalized === id || normalized.startsWith(`${id},`) || normalized.startsWith(`${id}:`);
      });
      // A custom answer is valid only for a question that explicitly offers
      // an "other" choice. A leading option id (`yes, rationale`) retains
      // the operator's note while keeping the durable answer well-formed.
      if (options.length > 0 && selectedOption === undefined && !options.some((option) => option.is_other)) {
        return result(model, { overlay: { ...compose, error: `Enter an option id: ${options.map((option) => option.id).join(" or ")}` } });
      }
      const stamp = `tui:userinput.answer:${at}`;
      return {
        model: { ...model, overlay: null, epoch: model.epoch + 1 },
        effects: [{
          type: "dispatch_command",
          request: {
            kind: "userinput.answer",
            metadata: { operation_id: stamp, idempotency_key: stamp },
            params: {
              record_id: compose.record_id,
              answer: { option_id: selectedOption?.id ?? null, custom_text: text, answered_by: "tui-operator", answered_at: new Date(at).toISOString() },
            },
          },
        }],
      };
    }
    case "approve_selected":
    case "reject_selected": {
      if (model.screen !== "approvals") return modelOnly(model);
      const target = selectedPendingApproval(model.screens.get("approvals"), model.selection.get("approvals")?.id) ?? oldestPendingApproval(model.screens.get("approvals"));
      if (!target) return modelOnly(model);
      const kind = intent.type === "approve_selected" ? "approval.approve" : "approval.reject";
      const memoryScope = intent.type === "approve_selected" ? (intent.scope ?? "once") : "once";
      if (memoryScope === "persistent" && !/^sha256:[a-f0-9]{64}$/.test(target.action_fingerprint ?? "")) {
        return result(model, { notifications: appendBounded(model.notifications, { id: `approval-not-canonical:${target.request_id}:${at}`, severity: "warning", message: `Persistent approval is unavailable for ${target.action}: its action cannot be canonicalized.`, createdAt: at }, model.limits.notifications) });
      }
      const stamp = `tui:${kind}:${at}`;
      return {
        model,
        effects: [{
          type: "dispatch_command",
          request: {
            kind,
            metadata: { operation_id: stamp, idempotency_key: stamp },
            params: { request_id: target.request_id, actor: "tui-operator", ...(intent.type === "approve_selected" ? { memory_scope: memoryScope } : {}) },
          },
        }],
      };
    }
    case "select_tree_node": {
      if (model.screen !== "tree") return modelOnly(model);
      const raw = model.screens.get("tree");
      const graph = campaignTreeGraph(raw);
      if (graph === null) return modelOnly(model);
      const reader = updateUctReader(model.uctReader, graph, intent.direction === 1 ? "next" : "prev");
      if (reader.selected_id === model.uctReader.selected_id && !model.uctReader.follow_active) return modelOnly(model);
      return result(model, { uctReader: reader, selection: selectionForReader(model.selection, raw, reader.selected_id) });
    }
    case "uct_reader_action": {
      if (model.screen !== "tree") return modelOnly(model);
      const raw = model.screens.get("tree");
      const graph = campaignTreeGraph(raw);
      if (graph === null) return modelOnly(model);
      const reader = updateUctReader(model.uctReader, graph, intent.action);
      const selection = selectionForReader(model.selection, raw, reader.selected_id);
      if (reader === model.uctReader && selection === model.selection) return modelOnly(model);
      return result(model, { uctReader: reader, selection });
    }
    case "select_row": {
      // Generalized (command-surface expansion) to any screen with a
      // recognized row shape — operator-selection.ts's `screenRowIds` covers
      // tree/jobs/operations/tasks today. A screen with no recognized shape
      // yet is a no-op rather than a guessed selection.
      const next = selectScreenRow(intent.screen, model.screens.get(intent.screen), intent.row);
      if (next === null) return modelOnly(model);
      const selection = withSelection(model.selection, intent.screen, next);
      if (intent.screen !== "tree") return result(model, { selection });
      const graph = campaignTreeGraph(model.screens.get("tree"));
      const uctReader = graph === null ? model.uctReader : updateUctReader(model.uctReader, graph, { select: next.id });
      return result(model, { selection, uctReader });
    }
    case "select_row_identity": {
      if (model.overlay !== null || model.screen !== intent.screen || !intent.selection.id) return modelOnly(model);
      const selection = withSelection(model.selection, intent.screen, intent.selection);
      if (intent.screen !== "tree") return result(model, { selection });
      const graph = campaignTreeGraph(model.screens.get("tree"));
      const uctReader = graph === null ? model.uctReader : updateUctReader(model.uctReader, graph, { select: intent.selection.id });
      return result(model, { selection, uctReader });
    }
    case "select_row_relative": {
      // Tree keeps using select_tree_node (compound context.campaign_id key);
      // every other screen with a recognized row shape steps a bare row id.
      if (model.screen === "tree") return modelOnly(model);
      const current = model.selection.get(model.screen) ?? null;
      const next = stepScreenSelection(model.screen, current, model.screens.get(model.screen), intent.direction);
      if (next === current) return modelOnly(model);
      return result(model, { selection: withSelection(model.selection, model.screen, next) });
    }
    case "cancel_selected_row": {
      if (model.overlay !== null) return modelOnly(model);
      const selected = model.selection.get(model.screen);
      if (selected === undefined) return modelOnly(model);
      if (model.screen === "jobs") {
        const stamp = `tui:job.cancel:${at}`;
        return repeatConfirmation(model, at, `job.cancel:${selected.id}`, `press again to cancel job ${selected.id}`, { type: "dispatch_command", request: { kind: "job.cancel", metadata: { operation_id: stamp, idempotency_key: stamp }, params: { job_id: selected.id } } });
      }
      if (model.screen === "operations") {
        const stamp = `tui:operation.cancel:${at}`;
        return repeatConfirmation(model, at, `operation.cancel:${selected.id}`, `press again to cancel operation ${selected.id}`, { type: "dispatch_command", request: { kind: "operation.cancel", metadata: { operation_id: stamp, idempotency_key: stamp }, params: { target_operation_id: selected.id } } });
      }
      if (HARNESS_SESSION_SCREENS.has(model.screen)) {
        if (selected.context?.interruptible === "no") {
          return result(model, {
            notifications: appendBounded(model.notifications, {
              id: `harness-session-terminal:${selected.id}`,
              severity: "warning",
              message: `Harness session ${selected.id} is terminal; inspect its durable evidence instead of interrupting it.`,
              createdAt: at,
            }, model.limits.notifications),
          });
        }
        const stamp = `tui:harness.session.interrupt:${at}`;
        return repeatConfirmation(model, at, `harness.session.interrupt:${selected.id}`, `press again to interrupt session ${selected.id}`, { type: "dispatch_command", request: { kind: "harness.session.interrupt", metadata: { operation_id: stamp, idempotency_key: stamp }, params: { session_id: selected.id, reason: "operator-requested interruption from TUI" } } });
      }
      return modelOnly(model);
    }
    case "retry_selected_row": {
      // Non-destructive — dispatches immediately, no confirmation. Only
      // jobs/tasks declare a real retry command (job.retry / task.retry).
      const selected = model.selection.get(model.screen);
      if (selected === undefined) return modelOnly(model);
      if (model.screen === "jobs") {
        const stamp = `tui:job.retry:${at}`;
        return {
          model,
          effects: [{ type: "dispatch_command", request: { kind: "job.retry", metadata: { operation_id: stamp, idempotency_key: stamp }, params: { job_id: selected.id } } }],
        };
      }
      if (model.screen === "tasks") {
        const stamp = `tui:task.retry:${at}`;
        return {
          model,
          effects: [{ type: "dispatch_command", request: { kind: "task.retry", metadata: { operation_id: stamp, idempotency_key: stamp }, params: { task_id: selected.id } } }],
        };
      }
      if (model.screen === "recovery") {
        const context = selected.context;
        if (!context?.campaign_id || !context.prior_operation_id || !context.expected_version) return modelOnly(model);
        const stamp = `tui:recovery.retry:${at}`;
        return {
          model,
          effects: [{ type: "dispatch_command", request: {
            kind: "recovery.retry", metadata: { operation_id: stamp, idempotency_key: stamp, expected_version: context.expected_version },
            params: { campaign_id: context.campaign_id, node_id: selected.id, prior_operation_id: context.prior_operation_id, reason: "operator-requested retry" },
          } }],
        };
      }
      return modelOnly(model);
    }
    case "abandon_recovery_selected": {
      if (model.screen !== "recovery" || model.overlay !== null) return modelOnly(model);
      const selected = model.selection.get("recovery");
      const context = selected?.context;
      if (!selected || !context?.campaign_id || !context.prior_operation_id || !context.expected_version) return modelOnly(model);
      return result(model, {
        overlay: {
          kind: "confirm",
          title: "Abandon recovery",
          detail: `Abandon recovery for ${selected.id}? This permanently records the operator disposition.`,
          pendingAction: {
            kind: "recovery.abandon", expected_version: context.expected_version,
            params: {
              campaign_id: context.campaign_id, node_id: selected.id, prior_operation_id: context.prior_operation_id,
              reason: "operator-requested abandonment",
              authorization: { authority: "operator", authorized_by: "tui-operator", rationale: "operator-confirmed abandonment from TUI" },
            },
          },
        },
      });
    }
    case "view_selected_row_detail": {
      if (model.overlay !== null) return modelOnly(model);
      const selected = model.selection.get(model.screen);
      if (selected === undefined) return modelOnly(model);
      const queryId = `tui:detail:${model.screen}:${at}`;
      if (model.screen === "operations") {
        return { model, effects: [{ type: "run_query", request: { kind: "operation.get", query_id: queryId, params: { operation_id: selected.id } } }] };
      }
      if (model.screen === "output") {
        return { model, effects: [{ type: "run_query", request: { kind: "output.descriptor", query_id: queryId, params: { evidence_id: selected.id } } }] };
      }
      if (model.screen === "communications") {
        const context = selected.context;
        if (!context?.campaign_id || !context.node_id) return modelOnly(model);
        return { model, effects: [{ type: "run_query", request: { kind: "communication.history", query_id: queryId, params: { campaign_id: context.campaign_id, node_id: context.node_id, limit: 100 } } }] };
      }
      if (model.screen === "harness-sessions") {
        return { model, effects: [{ type: "run_query", request: { kind: "harness.session.inspect", query_id: queryId, params: { session_id: selected.id } } }] };
      }
      if (model.screen === "harness-evaluations") {
        return { model, effects: [{ type: "run_query", request: { kind: "harness.evaluation.detail", query_id: queryId, params: { run_id: selected.id } } }] };
      }
      if (model.screen === "trust") {
        return { model, effects: [{ type: "run_query", request: { kind: "trust.session.status", query_id: queryId, params: { session_id: selected.id } } }] };
      }
      if (model.screen === "task-composer") {
        return { model, effects: [{ type: "run_query", request: { kind: "taskcomposer.get", query_id: queryId, params: { draft_id: selected.id } } }] };
      }
      // Project Registry (ADR-076 / Roadmap 23 W6): "view detail" on a
      // selected entry IS "re-check this entry" — verifyRegistryEntry
      // recomputes discharge fresh on every call, so re-issuing
      // project.registry.list scoped to the selected project_id both
      // re-verifies and re-renders it, with no second evaluation path.
      if (model.screen === "project-registry") {
        return { model, effects: [{ type: "run_query", request: { kind: "project.registry.list", query_id: queryId, params: { project_id: selected.id } } }] };
      }
      return modelOnly(model);
    }
    case "view_selected_harness_session_events": {
      if (model.overlay !== null || !HARNESS_SESSION_SCREENS.has(model.screen)) return modelOnly(model);
      const selected = model.selection.get(model.screen);
      if (selected === undefined) return modelOnly(model);
      const queryId = `tui:events:${model.screen}:${at}`;
      return { model, effects: [{ type: "run_query", request: { kind: "harness.session.events", query_id: queryId, params: { session_id: selected.id, limit: 200 } } }] };
    }
    case "attach_selected_harness_session": {
      if (model.overlay !== null || !HARNESS_SESSION_SCREENS.has(model.screen)) return modelOnly(model);
      const selected = model.selection.get(model.screen);
      if (selected === undefined) return modelOnly(model);
      const queryId = `tui:attach:${model.screen}:${at}`;
      return { model, effects: [{ type: "run_query", request: { kind: "harness.session.attach", query_id: queryId, params: { session_id: selected.id, limit: 200 } } }] };
    }
    case "confirm_task_composer": {
      const target = taskComposerSelection(model);
      if (target === null || model.overlay !== null) return modelOnly(model);
      const stamp = `tui:taskcomposer.confirm:${at}`;
      return {
        model,
        effects: [{ type: "dispatch_command", request: {
          kind: "taskcomposer.confirm",
          metadata: { operation_id: stamp, idempotency_key: stamp, expected_version: String(target.expected_revision) },
          params: { draft_id: target.draft_id, expected_revision: target.expected_revision, idempotency_key: stamp },
        } }],
      };
    }
    case "retry_task_composer": {
      const target = taskComposerSelection(model);
      if (target === null || model.overlay !== null) return modelOnly(model);
      const stamp = `tui:taskcomposer.retry:${at}`;
      return {
        model,
        effects: [{ type: "dispatch_command", request: {
          kind: "taskcomposer.retry",
          metadata: { operation_id: stamp, idempotency_key: stamp, expected_version: String(target.expected_revision) },
          params: { draft_id: target.draft_id, expected_revision: target.expected_revision, idempotency_key: stamp },
        } }],
      };
    }
    case "cancel_task_composer": {
      if (!intent.draft_id.trim() || !Number.isSafeInteger(intent.expected_revision) || intent.expected_revision < 1 || !intent.reason.trim()) return modelOnly(model);
      const stamp = `tui:taskcomposer.cancel:${at}`;
      return {
        model,
        effects: [{ type: "dispatch_command", request: {
          kind: "taskcomposer.cancel",
          metadata: { operation_id: stamp, idempotency_key: stamp, expected_version: String(intent.expected_revision) },
          params: { draft_id: intent.draft_id, expected_revision: intent.expected_revision, reason: intent.reason.trim() },
        } }],
      };
    }
    case "open_operator_form": {
      if (model.overlay !== null) return modelOnly(model);
      if ((intent.command === "bus.thread.send" && !threadFormContext(model)) || (intent.command === "bus.thread.ack" && !threadAckFormContext(model))) return modelOnly(model);
      if (intent.command === "fold.rollback" && (model.screen !== "overlays" || model.selection.get("overlays") === undefined)) return modelOnly(model);
      if (intent.command === "subagent.execute") {
        const selected = model.selection.get("overlays"); const tree = model.selection.get("tree");
        if (model.screen !== "overlays" || selected?.context?.overlay_type !== "harness" || selected.context?.component !== "subagent_descriptor" || !tree?.context?.campaign_id) return modelOnly(model);
      }
      if (intent.command === "harness.evaluation.start") {
        const selected = model.selection.get("overlays");
        if (model.screen !== "overlays" || selected?.context?.overlay_type !== "harness" || selected.context.status !== "active" || selected.context.evaluation_outcome !== "not_yet_measured") return modelOnly(model);
      }
      if (intent.command === "harness.promote") {
        const selected = model.selection.get("harness-evaluations");
        if (model.screen !== "harness-evaluations" || !selected?.context?.revision_id || selected.context.state !== "measured" || selected.context.outcome !== "improved" || selected.context.regression_detected !== "false") return modelOnly(model);
      }
      if (intent.command === "harness.quarantine") {
        const selected = model.selection.get("harness-evaluations");
        if (model.screen !== "harness-evaluations" || !selected?.context?.revision_id || selected.context.state !== "measured" || !selected.context.evidence_ids_json) return modelOnly(model);
      }
      if (intent.command === "harness.session.steer" && harnessSessionSteerContext(model) === null) return modelOnly(model);
      if ((intent.command === "harness.session.resume" || intent.command === "harness.session.fork" || intent.command === "harness.session.respawn") && harnessSessionContinuationContext(model, intent.command.slice("harness.session.".length) as "resume" | "fork" | "respawn") === null) return modelOnly(model);
      if (intent.command === "taskcomposer.followup" && taskComposerSelection(model)?.campaign_id === undefined) return modelOnly(model);
      if (intent.command === "taskcomposer.answer" && taskComposerSelection(model)?.question_id === undefined) return modelOnly(model);
      if (intent.command === "taskcomposer.reject" && taskComposerSelection(model) === null) return modelOnly(model);
      if (intent.command.startsWith("result.review.") && (model.screen !== "result-review" || model.selection.get("result-review") === undefined)) return modelOnly(model);
      const fields = initialFormFields(intent.command, model);
      const detail = intent.command === "taskcomposer.answer" ? taskComposerQuestionPrompt(model) : null;
      const firstField = Object.keys(fields)[0] ?? "";
      return result(model, { overlay: { kind: "operator_form", command: intent.command, title: operatorFormTitle(intent.command), ...(detail === null ? {} : { detail }), fields, active_field: firstField, field_cursor: (fields[firstField] ?? "").length, error: null } });
    }
    case "open_task_preset": {
      if (model.overlay !== null || !intent.task.trim()) return modelOnly(model);
      const task = intent.task.trim();
      return result(model, { overlay: { kind: "operator_form", command: "taskcomposer.submit", title: intent.mode === "answer" ? "Ask about this reference" : "What should Revoy change?", ...(intent.mode === undefined ? {} : { task_mode: intent.mode }), fields: { task }, active_field: "task", field_cursor: bufferFromText(task).cursor, error: null, ...(intent.command === undefined ? {} : { task_command: intent.command }), ...(intent.reference_attachments === undefined ? {} : { reference_attachments: intent.reference_attachments.map((attachment) => ({ ...attachment })) }) } });
    }
    case "operator_form_input": {
      if (model.overlay?.kind !== "operator_form") return modelOnly(model);
      const fields = { ...model.overlay.fields, [model.overlay.active_field]: intent.value };
      return result(model, { overlay: { ...model.overlay, fields, field_cursor: intent.value.length, error: null } });
    }
    case "operator_form_insert": {
      if (model.overlay?.kind !== "operator_form") return modelOnly(model);
      const formOverlay = model.overlay;
      const current = formOverlay.fields[formOverlay.active_field] ?? "";
      const state = bufferInsertText({ text: current, cursor: formOverlay.field_cursor ?? current.length }, intent.text);
      const truncated = state.text.length > MAX_ANSWER_BYTES;
      const value = truncated ? state.text.slice(0, MAX_ANSWER_BYTES) : state.text;
      const cursor = Math.min(state.cursor, value.length);
      const fields = { ...formOverlay.fields, [formOverlay.active_field]: value };
      const overlay = { ...formOverlay, fields, field_cursor: cursor, error: null };
      if (truncated && intent.text.length > 1) {
        return result(model, {
          overlay,
          notifications: appendBounded(model.notifications, {
            id: `operator-form:truncated:${at}`, severity: "warning",
            message: "Paste truncated to the 8 KiB field limit.", createdAt: at,
          }, model.limits.notifications),
        });
      }
      return result(model, { overlay });
    }
    case "operator_form_backspace": {
      if (model.overlay?.kind !== "operator_form") return modelOnly(model);
      const formOverlay = model.overlay;
      const current = formOverlay.fields[formOverlay.active_field] ?? "";
      const state = bufferBackspace({ text: current, cursor: formOverlay.field_cursor ?? current.length });
      const fields = { ...formOverlay.fields, [formOverlay.active_field]: state.text };
      return result(model, { overlay: { ...formOverlay, fields, field_cursor: state.cursor, error: null } });
    }
    case "operator_form_delete": {
      if (model.overlay?.kind !== "operator_form") return modelOnly(model);
      const formOverlay = model.overlay;
      const current = formOverlay.fields[formOverlay.active_field] ?? "";
      const state = bufferDeleteForward({ text: current, cursor: formOverlay.field_cursor ?? current.length });
      const fields = { ...formOverlay.fields, [formOverlay.active_field]: state.text };
      return result(model, { overlay: { ...formOverlay, fields, field_cursor: state.cursor, error: null } });
    }
    case "operator_form_move": {
      if (model.overlay?.kind !== "operator_form") return modelOnly(model);
      const formOverlay = model.overlay;
      const current = formOverlay.fields[formOverlay.active_field] ?? "";
      const state = bufferMoveCursor({ text: current, cursor: formOverlay.field_cursor ?? current.length }, intent.movement);
      return result(model, { overlay: { ...formOverlay, field_cursor: state.cursor } });
    }
    case "operator_form_next_field": {
      if (model.overlay?.kind !== "operator_form") return modelOnly(model);
      const keys = Object.keys(model.overlay.fields); const index = keys.indexOf(model.overlay.active_field);
      if (keys.length === 0 || index < 0) return modelOnly(model);
      const nextField = keys[(index + intent.direction + keys.length) % keys.length]!;
      return result(model, { overlay: { ...model.overlay, active_field: nextField, field_cursor: (model.overlay.fields[nextField] ?? "").length } });
    }
    case "cancel_operator_form":
      return model.overlay?.kind === "operator_form" ? result(model, { overlay: null }) : modelOnly(model);
    case "submit_operator_form":
      return submitOperatorForm(model, at);
    case "toggle_job_queue": {
      // Queue-level dispatch throttle, not row-scoped: reads the jobs
      // screen's own already-fetched `job.list` result (JobQueueView's
      // `queue_paused`) and dispatches the complementary job.pause/
      // job.resume command. Off the jobs screen, or before job.list has ever
      // been fetched, this is a no-op — never guesses the queue's state.
      if (model.screen !== "jobs") return modelOnly(model);
      const raw = model.screens.get("jobs");
      const paused = typeof raw === "object" && raw !== null && (raw as { queue_paused?: unknown }).queue_paused === true;
      const kind = paused ? "job.resume" : "job.pause";
      const stamp = `tui:${kind}:${at}`;
      return {
        model,
        effects: [{ type: "dispatch_command", request: { kind, metadata: { operation_id: stamp, idempotency_key: stamp }, params: {} } }],
      };
    }
    case "toggle_result_review_mode": {
      if (model.screen !== "result-review") return modelOnly(model);
      const workspace = model.screens.get("result-review");
      if (typeof workspace !== "object" || workspace === null || Array.isArray(workspace)) return modelOnly(model);
      const current = (workspace as { view_mode?: unknown }).view_mode === "side-by-side" ? "side-by-side" : "unified";
      const screens = new Map(model.screens); screens.set("result-review", { ...workspace, view_mode: current === "unified" ? "side-by-side" : "unified" });
      return result(model, { screens });
    }
    case "result_review_move_hunk": {
      const workspace = resultReviewWorkspace(model);
      if (workspace === null) return modelOnly(model);
      const { files, fileIndex } = resultReviewFiles(workspace);
      const hunkCount = files[fileIndex]?.hunks.length ?? 0;
      if (hunkCount === 0) return modelOnly(model);
      const currentHunk = clampIndex(Number((workspace as { review_hunk_index?: unknown }).review_hunk_index ?? 0), hunkCount);
      const nextHunk = clampIndex(currentHunk + intent.direction, hunkCount);
      if (nextHunk === currentHunk) return modelOnly(model);
      const screens = new Map(model.screens); screens.set("result-review", { ...workspace, review_hunk_index: nextHunk });
      return result(model, { screens });
    }
    case "result_review_move_file": {
      const workspace = resultReviewWorkspace(model);
      if (workspace === null) return modelOnly(model);
      const { files, fileIndex } = resultReviewFiles(workspace);
      if (files.length === 0) return modelOnly(model);
      const nextFile = clampIndex(fileIndex + intent.direction, files.length);
      if (nextFile === fileIndex) return modelOnly(model);
      const screens = new Map(model.screens); screens.set("result-review", { ...workspace, review_file_index: nextFile, review_hunk_index: 0 });
      return result(model, { screens });
    }
    case "expire_selected": {
      // Same oldest-pending target approve_selected/reject_selected already
      // resolve — expire is a third disposition on the same record, not a
      // second selection authority.
      if (model.screen !== "approvals") return modelOnly(model);
      const target = selectedPendingApproval(model.screens.get("approvals"), model.selection.get("approvals")?.id) ?? oldestPendingApproval(model.screens.get("approvals"));
      if (!target) return modelOnly(model);
      const stamp = `tui:approval.expire:${at}`;
      return {
        model,
        effects: [{ type: "dispatch_command", request: { kind: "approval.expire", metadata: { operation_id: stamp, idempotency_key: stamp }, params: { request_id: target.request_id } } }],
      };
    }
    case "branch_selected_node": {
      if (model.screen !== "tree") return modelOnly(model);
      const selected = model.selection.get("tree");
      if (selected === undefined) return modelOnly(model);
      const campaign_id = selected.context?.campaign_id;
      if (campaign_id === undefined) return modelOnly(model);
      const node_id = selected.id;
      const stamp = `tui:tree.branch:${at}`;
      return {
        model,
        effects: [{
          type: "dispatch_command",
          request: {
            kind: "tree.branch",
            metadata: { operation_id: stamp, idempotency_key: stamp },
            params: { campaign_id, node_id, actions: [OPERATOR_BRANCH_ACTION] },
          },
        }],
      };
    }
    case "request_prune_selected_node": {
      if (model.screen !== "tree" || model.overlay !== null) return modelOnly(model);
      const selected = model.selection.get("tree");
      if (selected === undefined) return modelOnly(model);
      const campaign_id = selected.context?.campaign_id;
      if (campaign_id === undefined) return modelOnly(model);
      const node_id = selected.id;
      return result(model, {
        overlay: {
          kind: "confirm",
          title: "Prune node",
          detail: `Prune ${node_id}? This permanently removes the node and its subtree — this cannot be undone.`,
          pendingAction: { kind: "tree.prune", params: { campaign_id, node_id } },
        },
      });
    }
    case "confirm_pending_action": {
      if (model.overlay === null || model.overlay.kind !== "confirm") return modelOnly(model);
      const { pendingAction } = model.overlay;
      const stamp = `tui:${pendingAction.kind}:${at}`;
      return {
        model: { ...model, overlay: null, epoch: model.epoch + 1 },
        effects: [{
          type: "dispatch_command",
          request: { kind: pendingAction.kind, metadata: { operation_id: stamp, idempotency_key: stamp, ...(pendingAction.expected_version === undefined ? {} : { expected_version: pendingAction.expected_version }) }, params: pendingAction.params },
        }],
      };
    }
    case "cancel_pending_action":
      if (model.overlay === null || model.overlay.kind !== "confirm") return modelOnly(model);
      return result(model, { overlay: null });
    case "page_up": {
      if (model.overlay !== null || !Number.isSafeInteger(intent.amount) || intent.amount < 1) return modelOnly(model);
      const frontier = moveFrontierAnchor(model, -intent.amount);
      if (frontier !== null) return frontier;
      // Known limitation: if the current offset is still the unresolved
      // SCROLL_END_SENTINEL (a scroll_end whose true row count/height was
      // never reported back to the model — see the sentinel's doc comment),
      // subtracting `amount` from it still yields a huge number that
      // render-time clamping will show as "the last page" again, not "one
      // page above the last page". A one-way Elm model/update/render split
      // has no render-to-model feedback channel to resolve this without
      // threading viewport height into the model, which the governing
      // constraint (no rendering knowledge in update.ts) rules out.
      const current = model.scrollOffsets.get(model.screen) ?? 0;
      return result(model, { scrollOffsets: withScrollOffset(model.scrollOffsets, model.screen, current - intent.amount) });
    }
    case "page_down": {
      if (model.overlay !== null || !Number.isSafeInteger(intent.amount) || intent.amount < 1) return modelOnly(model);
      const frontier = moveFrontierAnchor(model, intent.amount);
      if (frontier !== null) return frontier;
      const current = model.scrollOffsets.get(model.screen) ?? 0;
      return result(model, { scrollOffsets: withScrollOffset(model.scrollOffsets, model.screen, current + intent.amount) });
    }
    case "scroll_home": {
      if (model.overlay !== null) return modelOnly(model);
      const frontier = moveFrontierAnchor(model, "first");
      if (frontier !== null) return frontier;
      const endpoint = selectScreenEndpoint(model.screen, model.screens.get(model.screen), "first");
      return result(model, {
        scrollOffsets: withScrollOffset(model.scrollOffsets, model.screen, 0),
        ...(endpoint === null ? {} : { selection: withSelection(model.selection, model.screen, endpoint) }),
      });
    }
    case "scroll_end": {
      if (model.overlay !== null) return modelOnly(model);
      const frontier = moveFrontierAnchor(model, "live");
      if (frontier !== null) return frontier;
      const endpoint = selectScreenEndpoint(model.screen, model.screens.get(model.screen), "last");
      return result(model, {
        scrollOffsets: withScrollOffset(model.scrollOffsets, model.screen, SCROLL_END_SENTINEL),
        ...(endpoint === null ? {} : { selection: withSelection(model.selection, model.screen, endpoint) }),
      });
    }
    case "scroll_by": {
      if (model.overlay !== null || !Number.isSafeInteger(intent.lines) || intent.lines === 0) return modelOnly(model);
      const frontier = moveFrontierAnchor(model, intent.lines);
      if (frontier !== null) return frontier;
      const current = model.scrollOffsets.get(model.screen) ?? 0;
      return result(model, { scrollOffsets: withScrollOffset(model.scrollOffsets, model.screen, current + intent.lines) });
    }
    case "set_theme":
      // Model-owned so the shell's per-draw frame options (tui.ts) read the
      // live theme off `AppModel.theme` — `result()`'s epoch bump is what
      // drives TuiShell.invalidate()'s next draw to a full-frame repaint
      // under the new palette, the same mechanism every other model change
      // already relies on.
      return result(model, { theme: intent.theme });
    case "toggle_help": {
      if (model.overlay !== null && model.overlay.kind !== "help") return modelOnly(model);
      return result(model, { overlay: model.overlay === null ? { kind: "help", query: "", selected_index: 0, expanded: false } : null });
    }
    case "help_query_input":
      if (model.overlay === null || model.overlay.kind !== "help") return modelOnly(model);
      return result(model, { overlay: { ...model.overlay, query: intent.buffer, selected_index: 0 } });
    case "help_select_index":
      if (model.overlay === null || model.overlay.kind !== "help" || !Number.isSafeInteger(intent.index) || intent.index < 0) return modelOnly(model);
      return result(model, { overlay: { ...model.overlay, selected_index: intent.index } });
    case "help_toggle_expanded":
      if (model.overlay === null || model.overlay.kind !== "help") return modelOnly(model);
      return result(model, { overlay: { ...model.overlay, expanded: !model.overlay.expanded, selected_index: 0 } });
    // Explicit focus zone cycling (ui-spec §3, M2.2, F6/Shift+F6): a
    // text-entry context (the composer) owns raw keys while it is focused —
    // an overlay already routes keys to itself first, so this only no-ops
    // when an overlay owns input, matching every other navigation intent's
    // "overlay owns the keyboard" convention in this reducer.
    case "focus_zone_cycle": {
      if (model.overlay !== null) return modelOnly(model);
      return result(model, { focus: { ...model.focus, zone: nextFocusZone(model.focus.zone, intent.direction) } });
    }
    case "focus_zone_set":
      if (model.overlay !== null) return modelOnly(model);
      return result(model, { focus: { ...model.focus, zone: intent.zone } });
    case "focus_rail_tab":
      return result(model, { focus: { ...model.focus, rail_tab: intent.tab } });
    case "request_shutdown":
      if (model.shuttingDown) return modelOnly(model);
      return {
        model: {
          ...model,
          epoch: model.epoch + 1,
          shuttingDown: true,
          notifications: appendBounded(model.notifications, {
            id: "lifecycle:shutdown",
            severity: "info",
            message: "Shutting down",
            createdAt: at,
          }, model.limits.notifications),
        },
        effects: [{ type: "interrupt_campaign" }, { type: "disconnect" }, { type: "close_client" }, { type: "restore_terminal" }],
      };
  }
}

function initialFormFields(command: OperatorFormKind, model: AppModel): Readonly<Record<string, string>> {
  const tree = model.selection.get("tree"); const context = { campaign_id: tree?.context?.campaign_id ?? "", node_id: tree?.id ?? "" };
  switch (command) {
    case "campaign.halt": return { campaign_id: context.campaign_id, approval_id: "" };
    case "job.submit": return { job_kind: "", owner_scope_id: context.campaign_id };
    // The proposer is the adapter-established cockpit identity, not a field
    // an operator can impersonate. A different identity must approve it.
    case "approval.request": return { action: "", subject: "", resource_id: "", rationale: "", expires_at: "" };
    case "userinput.ask": return { ...context, question: "", options_json: "", authority: "", blocking: "", requester_role: "" };
    case "communication.record": return { ...context, author_node_id: "", recipient_node_id: "", kind: "", capability_tier: "", content: "", provenance_json: "", trigger_turn: "" };
    case "output.capture": return { ...context, stream: "", media_type: "", provenance_json: "", content: "" };
    case "context.artifact.capture": return { campaign_id: context.campaign_id, media_type: "text/plain", producer: "tui-operator", visibility: "campaign", provenance_json: '{"tag":"claimed","claimant":"tui-operator"}', content: "" };
    case "output.raw": return { evidence_id: model.selection.get("output")?.id ?? "", approval_id: "" };
    case "bus.thread.send": {
      const context = threadFormContext(model);
      // `open_operator_form` refuses this command without a real direct
      // relation and a projection-derived cursor. These fields therefore
      // cannot silently become a root/self pseudo-thread.
      return {
        campaign_id: context?.campaign_id ?? "",
        parent_node_id: context?.parent_node_id ?? "",
        child_node_id: context?.child_node_id ?? "",
        from_node_id: context?.child_node_id ?? "",
        expected_thread_version: context?.expected_thread_version ?? "",
        message_kind: "reply",
        content: "",
        evidence_refs_json: "[]",
        provenance_json: '{"tag":"claimed","claimant":"tui-operator"}',
        capability_tier: "orchestrator",
        trigger_turn: "false",
        parent_communication_id: "",
        acknowledges_communication_id: "",
        retracts_communication_id: "",
      };
    }
    case "bus.thread.ack": {
      const context = threadAckFormContext(model);
      return { campaign_id: context?.campaign_id ?? "", parent_node_id: context?.parent_node_id ?? "", child_node_id: context?.child_node_id ?? "", from_node_id: context?.from_node_id ?? "", expected_thread_version: context?.expected_thread_version ?? "", message_id: context?.message_id ?? "", provenance_json: '{"tag":"claimed","claimant":"tui-operator"}', capability_tier: "orchestrator" };
    }
    // Same broadcast-conversation shape communication.record already uses,
    // scoped to a conversation_id (bus-contracts.ts's BusCommand).
    case "bus.record": return { ...context, conversation_id: "", author_node_id: "", recipient_node_id: "", kind: "", capability_tier: "", content: "", provenance_json: '{"tag":"claimed","claimant":"tui-operator"}', trigger_turn: "" };
    case "peer.grant": return { grant_id: "", campaign_id: context.campaign_id, parent_node_id: "", left_node_id: "", right_node_id: "", capabilities_json: '["query"]', capability_tier: "specialist", max_disclosure_bytes: "1024", expires_at: "", provenance_json: '{"tag":"claimed","claimant":"tui-operator"}' };
    // CompactionLifecycle (compaction-contracts.ts): the operator asserts a
    // manual lifecycle entry, never an automated compaction pass — the
    // record itself is what makes an out-of-band compaction observable.
    case "compaction.record": return { ...context, operation_id: "", trigger: "manual", strategy: "", status: "", pre_evidence_id: "", post_evidence_id: "", anchor_summary_id: "", reason: "", partial_evidence_ids_json: "[]" };
    // a2a.send records the same NodeCommunication shape communication.record
    // does; the catalog projects it to the A2A wire format for delivery.
    case "a2a.send": return { ...context, author_node_id: "", recipient_node_id: "", kind: "", capability_tier: "", content: "", provenance_json: '{"tag":"claimed","claimant":"tui-operator"}', trigger_turn: "" };
    // a2a.receive durably records an inbound A2AMessage (a2a-contracts.ts).
    case "a2a.receive": return { ...context, message_id: "", task_id: "", author_node_ref: "", recipient_node_refs_json: "[]", parts_json: "[]" };
    case "fold.rollback": {
      const selected = model.selection.get("overlays");
      // The row projection supplies the durable overlay type; it is not a
      // coordinate guess. Playbook deltas have no rollback command and the
      // form remains invalid instead of manufacturing one.
      return { overlay_id: selected?.id ?? "", overlay_type: selected?.context?.overlay_type ?? "" };
    }
    // These JSON fields intentionally preserve the catalog's complete typed
    // objects (artifact refs, message ranges, provenance and evidence) rather
    // than letting a cockpit shorthand invent authority-bearing defaults.
    case "fold.propose": return { proposal_json: "" };
    case "fold.approve": return { fold_id: model.selection.get("overlays")?.id ?? "", fidelity_ratio: "" };
    case "playbook.propose": return { delta_json: "" };
    case "playbook.approve": return { delta_id: "" };
    case "harness.propose": return { revision_json: "" };
    case "harness.approve": return { revision_id: model.selection.get("overlays")?.id ?? "" };
    case "harness.rollback": return { revision_id: model.selection.get("overlays")?.id ?? "" };
    case "harness.evaluate": return { revision_id: model.selection.get("overlays")?.id ?? "", evaluation_json: "" };
    case "subagent.execute": {
      const selected = model.selection.get("overlays"); const tree = model.selection.get("tree");
      return { campaign_id: tree?.context?.campaign_id ?? selected?.context?.campaign_id ?? "", parent_node_id: tree?.id ?? "", revision_id: selected?.id ?? "" };
    }
    case "harness.evaluation.start": return { revision_id: model.selection.get("overlays")?.id ?? "" };
    case "harness.promote": return { revision_id: model.selection.get("harness-evaluations")?.context?.revision_id ?? "" };
    case "harness.quarantine": return { revision_id: model.selection.get("harness-evaluations")?.context?.revision_id ?? "", reason: "", evidence_ids_json: model.selection.get("harness-evaluations")?.context?.evidence_ids_json ?? "[]" };
    case "harness.session.steer": return { session_id: harnessSessionSteerContext(model)?.session_id ?? "", message: "" };
    case "harness.session.resume": return { session_id: harnessSessionContinuationContext(model, "resume")?.session_id ?? "", disposition: "", confirmation: "" };
    case "harness.session.fork": return { session_id: harnessSessionContinuationContext(model, "fork")?.session_id ?? "", disposition: "", confirmation: "" };
    case "harness.session.respawn": return { session_id: harnessSessionContinuationContext(model, "respawn")?.session_id ?? "", disposition: "", confirmation: "" };
    case "result.review.comment": { const selected = model.selection.get("result-review"); return { campaign_id: selected?.context?.campaign_id ?? "", node_id: selected?.context?.node_id ?? "", expected_patch_sha256: selected?.context?.expected_patch_sha256 ?? "", expected_revision: selected?.context?.expected_revision ?? "", file_path: selected?.id ?? "", line: "1", side: "new", body: "", author_id: "tui-operator" }; }
    case "result.review.request_revision": { const selected = model.selection.get("result-review"); return { campaign_id: selected?.context?.campaign_id ?? "", node_id: selected?.context?.node_id ?? "", expected_patch_sha256: selected?.context?.expected_patch_sha256 ?? "", expected_revision: selected?.context?.expected_revision ?? "", reason: "", author_id: "tui-operator" }; }
    case "result.review.editor_handoff": { const selected = model.selection.get("result-review"); return { campaign_id: selected?.context?.campaign_id ?? "", node_id: selected?.context?.node_id ?? "", expected_patch_sha256: selected?.context?.expected_patch_sha256 ?? "", expected_revision: selected?.context?.expected_revision ?? "", file_path: selected?.id ?? "", line: "1", editor: "vscode" }; }
    case "migration.apply": return { source_path: "", expected_source_sha256: "", overwrite: "false" };
    case "migration.rollback": return { receipt_id: "" };
    case "integration.install":
    case "integration.enable":
    case "integration.disable": return { integration_id: "", acknowledge_risk: "true" };
    case "integration.update": return { integration_id: "", version: "", acknowledge_risk: "true" };
    case "session.identity.mutate": return { session_id: "", display_name: "", tags_json: "[]" };
    case "notification.read": return { notification_id: "" };
    case "followup.create": return { parent_campaign_id: "", source_campaign_id: "", source_node_id: "" };
    case "taskcomposer.submit": return { task: "", attachment_paths: "" };
    case "taskcomposer.followup": return { task: "", evidence_ids_json: model.selection.get("task-composer")?.context?.evidence_ids_json ?? "[]" };
    case "taskcomposer.answer": return { answer: "" };
    case "taskcomposer.reject": return { reason: "" };
    case "trust.enroll": return { registration_json: "" };
    case "trust.rotate": return { session_id: model.selection.get("trust")?.id ?? "", key_id: "", public_key_pem: "", certificate_id: "" };
    case "trust.revoke": return { session_id: model.selection.get("trust")?.id ?? "" };
  }
}
/**
 * The heading an operator reads above a command form.
 *
 * `default: return command` used to hand 42 of the 49 forms their raw
 * identifier -- an operator opening the job form saw "job.submit", and the
 * trust form said "trust.enroll". The seven curated titles below showed what
 * was missing ("Add inline review comment" against `result.review.comment`).
 * Both exemplars name every surface: OpenCode gives each command a prose
 * `title` ("Compact session", "Close diff viewer"), and Claude Code maps ids
 * through `displayName`/`userFacingName()` to labels like "Edit file".
 *
 * There is deliberately NO default branch: `OperatorFormKind` is a closed
 * union, so a new form kind fails typecheck here until it is given a name,
 * rather than silently falling back to its identifier again.
 */
function operatorFormTitle(command: OperatorFormKind): string {
  switch (command) {
    case "taskcomposer.submit": return "What should Revoy change?";
    case "taskcomposer.followup": return "New linked follow-up";
    case "taskcomposer.answer": return "Answer task clarification";
    case "taskcomposer.reject": return "Reject task proposal";
    case "result.review.comment": return "Add inline review comment";
    case "result.review.request_revision": return "Request result revision";
    case "result.review.editor_handoff": return "Open result in editor";
    case "campaign.halt": return "Halt campaign";
    case "job.submit": return "Submit job";
    case "approval.request": return "Request approval";
    case "userinput.ask": return "Ask the operator a question";
    case "communication.record": return "Record communication";
    case "output.capture": return "Capture output";
    case "output.raw": return "Disclose raw output";
    case "bus.thread.send": return "Send thread message";
    case "bus.thread.ack": return "Acknowledge thread message";
    case "bus.record": return "Broadcast on the bus";
    case "peer.grant": return "Grant peer access";
    case "compaction.record": return "Record context compaction";
    case "a2a.send": return "Send agent-to-agent message";
    case "a2a.receive": return "Receive agent-to-agent message";
    case "context.artifact.capture": return "Capture context artifact";
    case "fold.propose": return "Propose context fold";
    case "fold.approve": return "Approve context fold";
    case "fold.rollback": return "Roll back context fold";
    case "playbook.propose": return "Propose playbook change";
    case "playbook.approve": return "Approve playbook change";
    case "harness.propose": return "Propose harness revision";
    case "harness.approve": return "Approve harness revision";
    case "harness.rollback": return "Roll back harness revision";
    case "harness.evaluate": return "Evaluate harness revision";
    case "harness.evaluation.start": return "Start harness evaluation";
    case "harness.promote": return "Promote harness revision";
    case "harness.quarantine": return "Quarantine harness revision";
    case "harness.session.steer": return "Steer harness session";
    case "harness.session.resume": return "Resume harness session";
    case "harness.session.fork": return "Fork harness session";
    case "harness.session.respawn": return "Respawn harness session";
    case "subagent.execute": return "Execute subagent";
    case "migration.apply": return "Apply migration";
    case "migration.rollback": return "Roll back migration";
    case "integration.install": return "Install integration";
    case "integration.enable": return "Enable integration";
    case "integration.disable": return "Disable integration";
    case "integration.update": return "Update integration";
    case "session.identity.mutate": return "Change session identity";
    case "notification.read": return "Mark notification read";
    case "followup.create": return "Create follow-up";
    case "trust.enroll": return "Enroll remote trust";
    case "trust.rotate": return "Rotate remote trust key";
    case "trust.revoke": return "Revoke remote trust";
  }
}
function formError(model: AppModel, form: OperatorFormOverlay, error: string): UpdateResult { return result(model, { overlay: { ...form, error } }); }
const OPTIONAL_FORM_FIELDS = new Set(["evidence_refs_json", "evidence_ids_json", "attachment_paths", "trigger_turn", "parent_communication_id", "acknowledges_communication_id", "retracts_communication_id", "post_evidence_id", "anchor_summary_id"]);
function missing(fields: Readonly<Record<string, string>>): string | null { const keys = Object.keys(fields).filter((key) => !OPTIONAL_FORM_FIELDS.has(key) && !fields[key]?.trim()); return keys.length ? `Required: ${keys.join(", ")}` : null; }
function json(text: string): unknown | null { try { return JSON.parse(text); } catch { return null; } }
/** Read the server-projected CAS cursor only after it is scoped to the selected direct tree edge. */
function threadFormContext(model: AppModel): { campaign_id: string; parent_node_id: string; child_node_id: string; expected_thread_version: string } | null {
  if (model.screen !== "threads") return null;
  const selected = model.selection.get("tree");
  const campaign_id = selected?.context?.campaign_id;
  const parent_node_id = selected?.context?.parent_node_id;
  const thread = model.screens.get("threads");
  if (!selected || !campaign_id || !parent_node_id || typeof thread !== "object" || thread === null) return null;
  const raw = thread as Record<string, unknown>;
  if (raw.parent_node_id !== parent_node_id || raw.child_node_id !== selected.id || typeof raw.version !== "string" || !raw.version.trim()) return null;
  return { campaign_id, parent_node_id, child_node_id: selected.id, expected_thread_version: raw.version };
}
/** An acknowledgement is always authored by the selected message's opposite endpoint. */
function threadAckFormContext(model: AppModel): { campaign_id: string; parent_node_id: string; child_node_id: string; expected_thread_version: string; message_id: string; from_node_id: string } | null {
  const thread = threadFormContext(model);
  const selected = model.selection.get("threads");
  const context = selected?.context;
  if (!thread || !selected || context?.ack_required !== "true" || typeof context.author_node_id !== "string" || !context.author_node_id) return null;
  return { ...thread, message_id: selected.id, from_node_id: context.author_node_id === thread.parent_node_id ? thread.child_node_id : thread.parent_node_id };
}

/** Steering is enabled only from the authoritative attach projection, never inferred from a list row. */
function harnessSessionSteerContext(model: AppModel): { session_id: string } | null {
  if (!HARNESS_SESSION_SCREENS.has(model.screen)) return null;
  const selected = model.selection.get(model.screen);
  const raw = model.screens.get(model.screen);
  if (!selected || typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const attach = raw as { session?: unknown; live?: unknown };
  if (attach.live !== true || typeof attach.session !== "object" || attach.session === null || Array.isArray(attach.session)) return null;
  const session = attach.session as { session_id?: unknown; terminal?: unknown };
  return session.session_id === selected.id && session.terminal === null ? { session_id: selected.id } : null;
}
function harnessSessionContinuationContext(model: AppModel, kind: "resume" | "fork" | "respawn"): { session_id: string } | null {
  if (model.screen !== "harness-sessions") return null;
  const selected = model.selection.get("harness-sessions");
  const raw = model.screens.get("harness-sessions");
  if (!selected || typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  if (record.session_id !== selected.id) return null;
  const continuations = typeof record.continuations === "object" && record.continuations !== null && !Array.isArray(record.continuations)
    ? record.continuations as Record<string, unknown>
    : typeof record.continuation === "object" && record.continuation !== null && !Array.isArray(record.continuation)
      ? record.continuation as Record<string, unknown> : null;
  const value = continuations?.[kind] ?? record[`${kind}_availability`];
  const available = value === true || (typeof value === "object" && value !== null && !Array.isArray(value) && (((value as Record<string, unknown>).available === true) || ((value as Record<string, unknown>).availability === "available")));
  return available ? { session_id: selected.id } : null;
}

interface TaskComposerSelection {
  readonly draft_id: string;
  readonly expected_revision: number;
  readonly question_id?: string;
  readonly campaign_id?: string;
  readonly evidence_ids_json: string;
}

/** Only a projection-derived row identity may supply a draft/CAS target. */
function taskComposerSelection(model: AppModel): TaskComposerSelection | null {
  if (model.screen !== "task-composer" && model.screen !== "console") return null;
  const selected = model.selection.get(model.screen);
  const expected_revision = Number(selected?.context?.expected_revision);
  if (!selected?.id || !Number.isSafeInteger(expected_revision) || expected_revision < 1) return null;
  return {
    draft_id: selected.id,
    expected_revision,
    ...(selected.context?.question_id ? { question_id: selected.context.question_id } : {}),
    ...(selected.context?.campaign_id ? { campaign_id: selected.context.campaign_id } : {}),
    evidence_ids_json: selected.context?.evidence_ids_json ?? "[]",
  };
}

/** Resolve the displayed clarification from the same live draft projection that supplied its CAS identity. */
function taskComposerQuestionPrompt(model: AppModel): string | null {
  const selected = taskComposerSelection(model);
  if (selected?.question_id === undefined) return null;
  const raw = model.screens.get(model.screen);
  const root = typeof raw === "object" && raw !== null && !Array.isArray(raw) ? raw as Record<string, unknown> : null;
  const drafts = Array.isArray(root?.items) ? root.items
    : root?.draft !== undefined ? [root.draft]
      : typeof root?.drafts === "object" && root.drafts !== null && !Array.isArray(root.drafts) && Array.isArray((root.drafts as Record<string, unknown>).items)
        ? (root.drafts as Record<string, unknown>).items as readonly unknown[]
        : [];
  const draft = drafts.find((value) => typeof value === "object" && value !== null && (value as Record<string, unknown>).id === selected.draft_id);
  if (typeof draft !== "object" || draft === null) return null;
  const proposal = (draft as Record<string, unknown>).proposal;
  if (typeof proposal !== "object" || proposal === null) return null;
  const questions = (proposal as Record<string, unknown>).questions;
  if (!Array.isArray(questions)) return null;
  const question = questions.find((value: unknown) => typeof value === "object" && value !== null && (value as Record<string, unknown>).id === selected.question_id);
  const text = typeof question === "object" && question !== null ? (question as Record<string, unknown>).question : null;
  return typeof text === "string" && text.trim() ? text : null;
}

function composerEvidenceIds(text: string): readonly string[] | null {
  const parsed = json(text);
  if (!Array.isArray(parsed) || parsed.length > 32) return null;
  const values = parsed.filter((value): value is string => typeof value === "string" && !!value.trim());
  return values.length === parsed.length && values.every((value) => value.length <= 256) ? values : null;
}

/** Newlines preserve each explicit filesystem path without inventing a delimiter. */
function composerAttachmentPaths(text: string): readonly string[] | null {
  const paths = text.split(/\r?\n/).map((path) => path.trim()).filter(Boolean);
  return paths.length <= 4 && paths.every((path) => path.length <= 4_096) ? paths : null;
}

function submitOperatorForm(model: AppModel, at: number): UpdateResult {
  if (model.overlay?.kind !== "operator_form") return modelOnly(model);
  const form = model.overlay; const f = form.fields;
  const absent = missing(f); if (absent) return formError(model, form, absent);
  const stamp = `tui:${form.command}:${at}`; let kind: import("./runtime-port.js").RuntimeCommandKind; let params: Record<string, unknown>;
  switch (form.command) {
    case "campaign.halt": kind = "campaign.halt"; params = { campaign_id: f.campaign_id, reason: "manual", approval_id: f.approval_id }; break;
    case "job.submit": kind = "job.submit"; params = { id: stamp, operation_id: stamp, job_kind: f.job_kind, owner_scope_id: f.owner_scope_id, idempotency_key: stamp }; break;
    case "approval.request": kind = "approval.request"; params = { request_id: stamp, idempotency_key: stamp, action: f.action, subject: f.subject, resource_id: f.resource_id, proposer: "tui-operator", rationale: f.rationale, expires_at: f.expires_at }; break;
    case "userinput.ask": { const options = json(f.options_json); if (!Array.isArray(options)) return formError(model, form, "options_json must be a JSON array"); kind = "userinput.ask"; params = { campaign_id: f.campaign_id, node_id: f.node_id, question: { operation_id: stamp, question: f.question, options, authority: f.authority, blocking: f.blocking, requester_role: f.requester_role, idempotency_key: stamp, as_of: new Date(at).toISOString() } }; break; }
    case "communication.record": { const provenance = json(f.provenance_json); if (provenance === null) return formError(model, form, "provenance_json must be valid JSON"); if (f.trigger_turn !== "true" && f.trigger_turn !== "false") return formError(model, form, "trigger_turn must be true or false"); kind = "communication.record"; params = { campaign_id: f.campaign_id, node_id: f.node_id, communication: { author_node_id: f.author_node_id, recipient_node_id: f.recipient_node_id, other_recipient_node_ids: [], kind: f.kind, payload: { content: f.content, provenance }, capability_tier: f.capability_tier, trigger_turn: f.trigger_turn === "true", as_of: new Date(at).toISOString(), correlation_id: stamp, idempotency_key: stamp, acknowledges_communication_id: null, retracts_communication_id: null } }; break; }
    case "output.capture": { const provenance = json(f.provenance_json); if (provenance === null) return formError(model, form, "provenance_json must be valid JSON"); kind = "output.capture"; params = { artifact: { campaign_id: f.campaign_id, node_id: f.node_id, stream: f.stream, media_type: f.media_type, provenance }, content: f.content }; break; }
    case "context.artifact.capture": {
      const provenance = json(f.provenance_json);
      if (provenance === null || Array.isArray(provenance) || typeof provenance !== "object") return formError(model, form, "provenance_json must be a JSON object");
      if (!new Set(["campaign", "critic_only"]).has(f.visibility)) return formError(model, form, "visibility must be campaign or critic_only");
      kind = "context.artifact.capture"; params = { artifact: { campaign_id: f.campaign_id, media_type: f.media_type, producer: f.producer, visibility: f.visibility, provenance }, content: f.content }; break;
    }
    case "output.raw": {
      const queryId = `tui:output.raw:${at}`;
      return { model: { ...model, overlay: null, epoch: model.epoch + 1 }, effects: [{ type: "run_query", request: { kind: "output.raw", query_id: queryId, params: { evidence_id: f.evidence_id, approval_id: f.approval_id } } }] };
    }
    case "bus.thread.send": {
      const provenance = json(f.provenance_json);
      if (provenance === null || Array.isArray(provenance) || typeof provenance !== "object") return formError(model, form, "provenance_json must be a JSON object");
      const evidence_refs = json(f.evidence_refs_json);
      if (!Array.isArray(evidence_refs) || evidence_refs.some((ref) => typeof ref !== "string" || !ref.trim())) return formError(model, form, "evidence_refs_json must be a JSON array of non-empty references");
      if (f.trigger_turn && f.trigger_turn !== "true" && f.trigger_turn !== "false") return formError(model, form, "trigger_turn must be true or false");
      if (!new Set(["delegate", "report", "retract", "steer", "reply", "clarify", "promote"]).has(f.message_kind)) return formError(model, form, "message_kind is invalid");
      if (!new Set(["specialist", "critic", "auditor", "orchestrator"]).has(f.capability_tier)) return formError(model, form, "capability_tier is invalid");
      kind = "bus.thread.send";
      params = {
        campaign_id: f.campaign_id, parent_node_id: f.parent_node_id, child_node_id: f.child_node_id,
        from_node_id: f.from_node_id, expected_thread_version: f.expected_thread_version,
        message_kind: f.message_kind, content: f.content, evidence_refs, provenance,
        capability_tier: f.capability_tier,
        ...(f.trigger_turn ? { trigger_turn: f.trigger_turn === "true" } : {}),
        ...(f.parent_communication_id ? { parent_communication_id: f.parent_communication_id } : {}),
        ...(f.acknowledges_communication_id ? { acknowledges_communication_id: f.acknowledges_communication_id } : {}),
        ...(f.retracts_communication_id ? { retracts_communication_id: f.retracts_communication_id } : {}),
      };
      break;
    }
    case "bus.thread.ack": {
      const provenance = json(f.provenance_json);
      if (provenance === null || Array.isArray(provenance) || typeof provenance !== "object") return formError(model, form, "provenance_json must be a JSON object");
      if (!new Set(["specialist", "critic", "auditor", "orchestrator"]).has(f.capability_tier)) return formError(model, form, "capability_tier is invalid");
      kind = "bus.thread.ack";
      params = { campaign_id: f.campaign_id, parent_node_id: f.parent_node_id, child_node_id: f.child_node_id, from_node_id: f.from_node_id, expected_thread_version: f.expected_thread_version, message_id: f.message_id, provenance, capability_tier: f.capability_tier };
      break;
    }
    case "result.review.comment": kind = form.command; params = { campaign_id: f.campaign_id, node_id: f.node_id, expected_patch_sha256: f.expected_patch_sha256, expected_revision: Number(f.expected_revision), file_path: f.file_path, line: Number(f.line), side: f.side, body: f.body, author_id: f.author_id }; break;
    case "result.review.request_revision": kind = form.command; params = { campaign_id: f.campaign_id, node_id: f.node_id, expected_patch_sha256: f.expected_patch_sha256, expected_revision: Number(f.expected_revision), reason: f.reason, author_id: f.author_id }; break;
    case "result.review.editor_handoff": kind = form.command; params = { campaign_id: f.campaign_id, node_id: f.node_id, expected_patch_sha256: f.expected_patch_sha256, expected_revision: Number(f.expected_revision), file_path: f.file_path, line: Number(f.line), editor: f.editor }; break;
    case "bus.record": {
      const provenance = json(f.provenance_json);
      if (provenance === null || Array.isArray(provenance) || typeof provenance !== "object") return formError(model, form, "provenance_json must be a JSON object");
      if (f.trigger_turn && f.trigger_turn !== "true" && f.trigger_turn !== "false") return formError(model, form, "trigger_turn must be true or false");
      if (!new Set(["delegate", "report", "retract", "steer", "reply", "clarify", "promote"]).has(f.kind)) return formError(model, form, "kind is invalid");
      if (!new Set(["specialist", "critic", "auditor", "orchestrator"]).has(f.capability_tier)) return formError(model, form, "capability_tier is invalid");
      kind = "bus.record";
      params = {
        campaign_id: f.campaign_id, node_id: f.node_id,
        communication: {
          author_node_id: f.author_node_id, recipient_node_id: f.recipient_node_id, other_recipient_node_ids: [],
          kind: f.kind, payload: { content: f.content, provenance }, capability_tier: f.capability_tier,
          trigger_turn: f.trigger_turn === "true", as_of: new Date(at).toISOString(), correlation_id: stamp, idempotency_key: stamp,
          acknowledges_communication_id: null, retracts_communication_id: null, conversation_id: f.conversation_id,
        },
      };
      break;
    }
    case "peer.grant": {
      const capabilities = json(f.capabilities_json); const provenance = json(f.provenance_json); const max_disclosure_bytes = Number(f.max_disclosure_bytes);
      if (!Array.isArray(capabilities) || capabilities.length === 0 || capabilities.some((item) => item !== "query" && item !== "reply")) return formError(model, form, "capabilities_json must be a non-empty query/reply JSON array");
      if (!new Set(["specialist", "critic", "auditor", "orchestrator"]).has(f.capability_tier)) return formError(model, form, "capability_tier is invalid");
      if (!Number.isSafeInteger(max_disclosure_bytes) || max_disclosure_bytes < 1 || max_disclosure_bytes > 16_384) return formError(model, form, "max_disclosure_bytes must be an integer from 1 through 16384");
      if (!provenance || Array.isArray(provenance) || typeof provenance !== "object") return formError(model, form, "provenance_json must be a JSON object");
      kind = "peer.grant"; params = { grant_id: f.grant_id, campaign_id: f.campaign_id, parent_node_id: f.parent_node_id, left_node_id: f.left_node_id, right_node_id: f.right_node_id, capabilities, capability_tier: f.capability_tier, max_disclosure_bytes, expires_at: f.expires_at, provenance }; break;
    }
    case "compaction.record": {
      if (f.trigger !== "auto" && f.trigger !== "manual") return formError(model, form, "trigger must be auto or manual");
      if (!new Set(["local_model", "token_budget_fresh_window", "structural_folding"]).has(f.strategy)) return formError(model, form, "strategy is invalid");
      if (!new Set(["completed", "interrupted", "failed"]).has(f.status)) return formError(model, form, "status is invalid");
      const partial_evidence_ids = json(f.partial_evidence_ids_json);
      if (!Array.isArray(partial_evidence_ids) || partial_evidence_ids.some((id) => typeof id !== "string")) return formError(model, form, "partial_evidence_ids_json must be a JSON array of strings");
      kind = "compaction.record";
      params = {
        campaign_id: f.campaign_id, node_id: f.node_id,
        lifecycle: {
          operation_id: f.operation_id, trigger: f.trigger, strategy: f.strategy, status: f.status,
          pre_evidence_id: f.pre_evidence_id, post_evidence_id: f.post_evidence_id || null, anchor_summary_id: f.anchor_summary_id || null,
          reason: f.reason, partial_evidence_ids, idempotency_key: stamp, as_of: new Date(at).toISOString(),
        },
      };
      break;
    }
    case "a2a.send": {
      const provenance = json(f.provenance_json);
      if (provenance === null || Array.isArray(provenance) || typeof provenance !== "object") return formError(model, form, "provenance_json must be a JSON object");
      if (f.trigger_turn && f.trigger_turn !== "true" && f.trigger_turn !== "false") return formError(model, form, "trigger_turn must be true or false");
      if (!new Set(["delegate", "report", "retract", "steer", "reply", "clarify", "promote"]).has(f.kind)) return formError(model, form, "kind is invalid");
      if (!new Set(["specialist", "critic", "auditor", "orchestrator"]).has(f.capability_tier)) return formError(model, form, "capability_tier is invalid");
      kind = "a2a.send";
      params = {
        campaign_id: f.campaign_id, node_id: f.node_id,
        communication: {
          author_node_id: f.author_node_id, recipient_node_id: f.recipient_node_id, other_recipient_node_ids: [],
          kind: f.kind, payload: { content: f.content, provenance }, capability_tier: f.capability_tier,
          trigger_turn: f.trigger_turn === "true", as_of: new Date(at).toISOString(), correlation_id: stamp, idempotency_key: stamp,
          acknowledges_communication_id: null, retracts_communication_id: null,
        },
      };
      break;
    }
    case "a2a.receive": {
      const recipient_node_refs = json(f.recipient_node_refs_json);
      if (!Array.isArray(recipient_node_refs) || recipient_node_refs.some((ref) => typeof ref !== "string" || !ref.trim())) return formError(model, form, "recipient_node_refs_json must be a JSON array of non-empty node refs");
      const parts = json(f.parts_json);
      if (!Array.isArray(parts) || parts.length === 0) return formError(model, form, "parts_json must be a non-empty JSON array of A2A parts");
      kind = "a2a.receive";
      params = {
        campaign_id: f.campaign_id, node_id: f.node_id,
        message: { id: f.message_id, task_id: f.task_id, author_node_ref: f.author_node_ref, recipient_node_refs, parts, as_of: new Date(at).toISOString() },
      };
      break;
    }
    case "fold.rollback": {
      if (f.overlay_type === "fold") { kind = "fold.rollback"; params = { fold_id: f.overlay_id }; }
      else if (f.overlay_type === "harness") { kind = "harness.rollback"; params = { revision_id: f.overlay_id }; }
      else return formError(model, form, "Selected overlay is not rollback-addressable");
      break;
    }
    case "fold.propose": { const proposal = json(f.proposal_json); if (!proposal || Array.isArray(proposal) || typeof proposal !== "object") return formError(model, form, "proposal_json must be a JSON object"); kind = "fold.propose"; params = { proposal }; break; }
    case "fold.approve": { const fidelity_ratio = Number(f.fidelity_ratio); if (!Number.isFinite(fidelity_ratio) || fidelity_ratio < 0 || fidelity_ratio > 1) return formError(model, form, "fidelity_ratio must be a number from 0 through 1"); kind = "fold.approve"; params = { fold_id: f.fold_id, fidelity_ratio }; break; }
    case "playbook.propose": { const delta = json(f.delta_json); if (!delta || Array.isArray(delta) || typeof delta !== "object") return formError(model, form, "delta_json must be a JSON object"); kind = "playbook.propose"; params = { delta }; break; }
    case "playbook.approve": kind = "playbook.approve"; params = { delta_id: f.delta_id }; break;
    case "harness.propose": { const revision = json(f.revision_json); if (!revision || Array.isArray(revision) || typeof revision !== "object") return formError(model, form, "revision_json must be a JSON object"); kind = "harness.propose"; params = { revision }; break; }
    case "harness.approve": kind = "harness.approve"; params = { revision_id: f.revision_id }; break;
    case "harness.rollback": kind = "harness.rollback"; params = { revision_id: f.revision_id }; break;
    case "harness.evaluate": { const evaluation = json(f.evaluation_json); if (!evaluation || Array.isArray(evaluation) || typeof evaluation !== "object") return formError(model, form, "evaluation_json must be a JSON object"); kind = "harness.evaluate"; params = { revision_id: f.revision_id, evaluation }; break; }
    case "subagent.execute":
      kind = "subagent.execute"; params = { campaign_id: f.campaign_id, parent_node_id: f.parent_node_id, revision_id: f.revision_id }; break;
    case "harness.evaluation.start": kind = "harness.evaluation.start"; params = { revision_id: f.revision_id }; break;
    case "harness.promote": kind = "harness.promote"; params = { revision_id: f.revision_id }; break;
    case "harness.quarantine": { const evidence_ids = json(f.evidence_ids_json); if (!Array.isArray(evidence_ids) || evidence_ids.some((id) => typeof id !== "string" || !id.trim())) return formError(model, form, "evidence_ids_json must be a JSON array of non-empty ids"); kind = "harness.quarantine"; params = { revision_id: f.revision_id, reason: f.reason, evidence_ids }; break; }
    case "harness.session.steer": {
      const target = harnessSessionSteerContext(model);
      if (target === null || target.session_id !== f.session_id) return formError(model, form, "Attach a live, non-terminal harness session before steering");
      if (Buffer.byteLength(f.message, "utf8") > 8 * 1024) return formError(model, form, "message exceeds the 8 KiB steering limit");
      kind = "harness.session.steer"; params = { session_id: target.session_id, message: f.message, provenance: { tag: "claimed", claimant: "tui-operator" } }; break;
    }
    case "harness.session.resume":
    case "harness.session.fork":
    case "harness.session.respawn": {
      const operation = form.command.slice("harness.session.".length) as "resume" | "fork" | "respawn";
      const target = harnessSessionContinuationContext(model, operation);
      if (target === null || target.session_id !== f.session_id) return formError(model, form, `Selected session does not advertise ${operation} availability`);
      if (f.confirmation !== operation.toUpperCase()) return formError(model, form, `Type ${operation.toUpperCase()} exactly to confirm`);
      if (Buffer.byteLength(f.disposition, "utf8") > 8 * 1024) return formError(model, form, "disposition exceeds the 8 KiB input limit");
      kind = form.command; params = { session_id: target.session_id, reason: f.disposition, dispositions: [] }; break;
    }
    case "migration.apply": {
      if (!/^sha256:[a-f0-9]{64}$/.test(f.expected_source_sha256)) return formError(model, form, "expected_source_sha256 must come from migration preview");
      kind = form.command; params = { source_path: f.source_path, expected_source_sha256: f.expected_source_sha256, overwrite: f.overwrite === "true", provenance: { tag: "claimed", claimant: "tui-operator" } }; break;
    }
    case "migration.rollback": kind = form.command; params = { receipt_id: f.receipt_id, provenance: { tag: "claimed", claimant: "tui-operator" } }; break;
    case "integration.install":
    case "integration.enable":
    case "integration.disable":
    case "integration.update": {
      if (form.command === "integration.update" && !/^\d+\.\d+\.\d+$/.test(f.version)) return formError(model, form, "update requires an exact SemVer version");
      kind = form.command; params = { integration_id: f.integration_id, acknowledge_risk: f.acknowledge_risk === "true", provenance: { tag: "claimed", claimant: "tui-operator" }, ...(form.command === "integration.update" ? { version: f.version } : {}) }; break;
    }
    case "session.identity.mutate": { const tags = json(f.tags_json); if (!Array.isArray(tags) || tags.some((tag) => typeof tag !== "string")) return formError(model, form, "tags_json must be a JSON string array"); kind = form.command; params = { session_id: f.session_id, display_name: f.display_name || null, tags, provenance: { tag: "claimed", claimant: "tui-operator" } }; break; }
    case "notification.read": kind = form.command; params = { notification_id: f.notification_id }; break;
    case "followup.create": kind = form.command; params = { parent_campaign_id: f.parent_campaign_id, source_result: { campaign_id: f.source_campaign_id, node_id: f.source_node_id }, source_node: null, provenance: { tag: "claimed", claimant: "tui-operator" } }; break;
    case "taskcomposer.submit": {
      const evidence_ids = composerEvidenceIds(f.evidence_ids_json ?? "[]");
      if (evidence_ids === null) return formError(model, form, "evidence_ids_json must be a JSON array of at most 32 non-empty bounded ids");
      const attachment_paths = composerAttachmentPaths(f.attachment_paths ?? "");
      if (attachment_paths === null) return formError(model, form, "attachment_paths must contain at most four newline-separated paths");
      if (attachment_paths.length > 0 && (form.reference_attachments?.length ?? 0) > 0) return formError(model, form, "Submit captured references separately from additional attachment paths.");
      if (f.task.length > 16 * 1024) return formError(model, form, "task exceeds the 16 KiB composer input limit");
      // Captured reference text is not authority to execute a model's plan.
      // Until document answers have a separate read-only lifecycle, require
      // explicit plan confirmation rather than auto-admitting inferred edits.
      kind = "taskcomposer.submit"; params = { task: f.task, source: "tui", idempotency_key: stamp, evidence_ids, auto_confirm: form.task_mode !== "answer" && (form.reference_attachments?.length ?? 0) === 0, ...(form.task_mode === undefined ? {} : { mode: form.task_mode }), ...(form.task_command === undefined ? {} : { command: form.task_command }), ...(form.reference_attachments === undefined ? {} : { attachment_uploads: form.reference_attachments }) };
      if (attachment_paths.length > 0) return {
        model: { ...model, overlay: null, epoch: model.epoch + 1 },
        effects: [{ type: "submit_taskcomposer_attachments", request: { kind, metadata: { operation_id: stamp, idempotency_key: stamp }, params }, attachment_paths }],
      };
      break;
    }
    case "taskcomposer.followup": {
      const target = taskComposerSelection(model);
      if (target?.campaign_id === undefined) return formError(model, form, "Select an admitted task draft with a linked campaign before creating a follow-up");
      const evidence_ids = composerEvidenceIds(f.evidence_ids_json);
      if (evidence_ids === null) return formError(model, form, "evidence_ids_json must be a JSON array of at most 32 non-empty bounded ids");
      if (f.task.length > 16 * 1024) return formError(model, form, "task exceeds the 16 KiB composer input limit");
      kind = "taskcomposer.submit"; params = { task: f.task, source: "tui", idempotency_key: stamp, parent_campaign_id: target.campaign_id, evidence_ids, auto_confirm: true };
      break;
    }
    case "taskcomposer.answer": {
      const target = taskComposerSelection(model);
      if (target?.question_id === undefined) return formError(model, form, "Select a task draft with a pending clarification");
      if (f.answer.length > MAX_ANSWER_BYTES) return formError(model, form, "answer exceeds the 8 KiB input limit");
      kind = "taskcomposer.answer"; params = { draft_id: target.draft_id, expected_revision: target.expected_revision, question_id: target.question_id, answer: f.answer };
      break;
    }
    case "taskcomposer.reject": {
      const target = taskComposerSelection(model);
      if (target === null) return formError(model, form, "Select a task draft before rejecting its proposal");
      if (f.reason.length > 8 * 1024) return formError(model, form, "reason exceeds the 8 KiB input limit");
      kind = "taskcomposer.reject"; params = { draft_id: target.draft_id, expected_revision: target.expected_revision, reason: f.reason };
      break;
    }
    case "trust.enroll": { const registration = json(f.registration_json); if (!registration || Array.isArray(registration) || typeof registration !== "object") return formError(model, form, "registration_json must be a JSON object"); kind = "trust.session.enroll"; params = { registration }; break; }
    case "trust.rotate": kind = "trust.session.rotate"; params = { session_id: f.session_id, key_id: f.key_id, public_key_pem: f.public_key_pem, certificate_id: f.certificate_id }; break;
    case "trust.revoke": kind = "trust.session.revoke"; params = { session_id: f.session_id }; break;
  }
  if (form.command === "campaign.halt") {
    return result(model, {
      overlay: {
        kind: "confirm",
        title: "Halt campaign",
        detail: `Halt ${f.campaign_id} using durable approval ${f.approval_id}?`,
        pendingAction: { kind, params },
      },
    });
  }
  return { model: { ...model, overlay: null, epoch: model.epoch + 1 }, effects: [{ type: "dispatch_command", request: { kind, metadata: { operation_id: stamp, idempotency_key: stamp }, params } }] };
}

/** F6 traversal order (ui-spec §3). One copy, shared by the reducer and the composition root. */
export const FOCUS_ZONE_ORDER: readonly FocusZone[] = Object.freeze(["composer", "transcript", "rail", "graph"]);

export function nextFocusZone(zone: FocusZone, direction: 1 | -1, available: readonly FocusZone[] = FOCUS_ZONE_ORDER): FocusZone {
  if (available.length === 0) return zone;
  const index = available.indexOf(zone);
  // A resize can make the previously focused pane disappear. Treat its
  // position in the canonical order as the cursor, then advance to the first
  // painted target in that direction.
  const origin = index >= 0 ? index : FOCUS_ZONE_ORDER.indexOf(zone);
  for (let step = 1; step <= FOCUS_ZONE_ORDER.length; step += 1) {
    const candidate = FOCUS_ZONE_ORDER[(origin + direction * step + FOCUS_ZONE_ORDER.length * 2) % FOCUS_ZONE_ORDER.length]!;
    if (available.includes(candidate)) return candidate;
  }
  return available[0]!;
}

/** Fresh runtime failures need immediate attention, not permanent footer real estate. */
const ERROR_NOTIFICATION_FOOTER_TTL_MS = 15_000;

function addError(model: AppModel, error: Extract<AppEvent, { type: "error_raised" }>["error"], at: number): UpdateResult {
  const existing = model.diagnostics.find((item) => item.fingerprint === error.fingerprint);
  const diagnostic: Diagnostic = existing === undefined
    ? { fingerprint: error.fingerprint, message: error.message, source: error.source, count: 1, firstSeenAt: at, lastSeenAt: at }
    : { ...existing, message: error.message, source: error.source, count: existing.count + 1, lastSeenAt: at };
  const withoutExisting = model.diagnostics.filter((item) => item.fingerprint !== error.fingerprint);
  const notification: Notification = {
    id: `error:${error.fingerprint}`,
    severity: "error",
    message: error.message,
    createdAt: at,
    expiresAt: at + ERROR_NOTIFICATION_FOOTER_TTL_MS,
  };
  return result(model, {
    diagnostics: appendBounded(withoutExisting, diagnostic, model.limits.diagnostics),
    notifications: appendBounded(model.notifications.filter((item) => item.id !== notification.id), notification, model.limits.notifications),
  });
}

function appendBounded<T>(items: readonly T[], item: T, limit: number): readonly T[] {
  return limit <= 0 ? [] : [...items, item].slice(-limit);
}

function telemetryRequested(model: AppModel, campaignId: string, at: number): UpdateResult {
  if (model.shuttingDown) return modelOnly(model);
  return {
    model: {
      ...model,
      epoch: model.epoch + 1,
      telemetryCampaignId: campaignId,
      notifications: appendBounded(model.notifications.filter((item) => item.id !== "telemetry:fetch"), {
        id: `telemetry:fetch`,
        severity: "info",
        message: `Fetching telemetry for campaign ${campaignId}`,
        createdAt: at,
      }, model.limits.notifications),
    },
    effects: [{ type: "fetch_telemetry", campaignId }],
  };
}

function telemetryReceived(model: AppModel, snapshot: import("./telemetry-types.js").TelemetrySnapshot): UpdateResult {
  const frozen = freezeTelemetrySnapshot(snapshot);
  // Idempotent: same snapshot yields same model (deterministic reference check)
  if (
    model.telemetrySnapshot !== null &&
    model.telemetrySnapshot.campaign_id === frozen.campaign_id &&
    model.telemetrySnapshot.source_record_count === frozen.source_record_count
  ) {
    const notifications = model.notifications.filter((item) => item.id !== "telemetry:fetch");
    return notifications.length === model.notifications.length ? modelOnly(model) : result(model, { notifications });
  }
  const screens = new Map(model.screens);
  screens.set("telemetry", frozen);
  return result(model, { telemetrySnapshot: frozen, screens, notifications: model.notifications.filter((item) => item.id !== "telemetry:fetch") });
}

function modelOnly(model: AppModel): UpdateResult {
  return { model, effects: [] };
}

function result(model: AppModel, patch: Partial<AppModel>): UpdateResult {
  return { model: { ...model, ...patch, epoch: model.epoch + 1 }, effects: [] };
}

/** Applies a correlated external-editor result without granting the TUI process authority. */
function applyExternalEditorResult(model: AppModel, requestId: string, text: string | null, at: number): UpdateResult {
  const compose = model.overlay?.kind === "compose" ? model.overlay : null;
  if (compose === null || compose.external_editor_request_id !== requestId) return modelOnly(model);
  const { external_editor_request_id: _requestId, ...idleCompose } = compose;
  if (text === null) return result(model, { overlay: idleCompose });
  const bounded = text.slice(0, MAX_ANSWER_BYTES);
  const overlay = { ...idleCompose, buffer: bounded, cursor: bounded.length };
  if (bounded.length === text.length) return result(model, { overlay });
  return result(model, {
    overlay,
    notifications: appendBounded(model.notifications, {
      id: `external-editor:truncated:${at}`,
      severity: "warning",
      message: "External editor content was truncated to the 8 KiB answer limit.",
      createdAt: at,
    }, model.limits.notifications),
  });
}
