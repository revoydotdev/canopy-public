import type { TelemetrySnapshot } from "./telemetry-types.js";
import type { RuntimeCommandKind, RuntimeCommandRequest, RuntimeQueryRequest } from "./runtime-port.js";
import type { ScreenId } from "./screens/screen.js";
import type { NodeTransition } from "./player-piano.js";
import type { ScreenSelection } from "./operator-selection.js";
import type { RunTheme } from "./theme.js";
import type { FrontierLiveEdgeState } from "./frontier-live-edge.js";
import type { CursorMovement } from "./text-buffer.js";
import type { VimEditorState } from "./terminal-editor.js";
import type { UctPlayback } from "./uct-playback.js";
import type { UctReaderAction, UctReaderState } from "./uct-model.js";
import type { ResponsiveInspectorTab } from "./responsive-sidebar.js";
import type { TuiReadModel } from "./read-model.js";

export type ConnectionState =
  | { readonly status: "disconnected"; readonly reason: string | null }
  | { readonly status: "connecting"; readonly attempt: number }
  | { readonly status: "synchronizing"; readonly cursor: string | null }
  | { readonly status: "connected"; readonly cursor: string }
  | { readonly status: "degraded"; readonly cursor: string | null; readonly reason: string };

export interface ProjectionSnapshot {
  readonly version: number;
  readonly cursor: string;
  readonly receivedAt: number;
  readonly summary: Readonly<Record<string, number>>;
}

export type NotificationSeverity = "info" | "warning" | "error";

/**
 * The TUI's single overlay slot (wave2/tui-input-model retrofit). Supersedes
 * three independently-plumbed `AppModel` fields (`compose`, `confirmation`,
 * `pendingAction`) plus the raw-loop-local `helpVisible` boolean, and
 * supersedes `navigation.ts`'s `Modal`/`modals` (a type with a correct
 * consumer — focus targeting — but zero producer anywhere in this codebase).
 * At most one overlay is active at a time — this was already true by
 * construction (the raw stdin loop's if/else-if ordering made compose and
 * confirmation mutually exclusive); this type makes it a real invariant
 * instead of an accidental one enforced only by call-site ordering.
 *
 * - `compose`: the interviews screen's `userinput.answer` free-text buffer.
 * - `confirm`: an armed destructive confirmation. `pendingAction` is
 *   command-agnostic (`RuntimeCommandKind`) — this is the seam every future
 *   destructive-command confirmation (job.cancel, campaign.halt, ...) reuses
 *   verbatim; only the arming intent that builds the value differs.
 * - `help`: the key-binding palette. `query` is a live substring filter
 *   threaded to `paletteView`/`renderPaletteRows` (overlays.ts) — printable
 *   keystrokes while this overlay is active edit `query`, not catalog
 *   bindings, mirroring how `compose`'s buffer already intercepts raw keys.
 * - `operator_form`: a schema-owned command form. Its field values are
 *   operator-entered text (or a real current selection), validated by the
 *   reducer before a canonical RuntimePort dispatch is possible.
 */
export type Overlay =
  | {
      readonly kind: "compose"; readonly record_id: string; readonly question: string;
      readonly options?: readonly { readonly id: string; readonly text: string; readonly is_other: boolean }[]; readonly buffer: string;
      /** Visible validation feedback; invalid option text never silently no-ops. */
      readonly error?: string;
      /**
       * UTF-16 offset into `buffer` (text-buffer.ts). Optional so every
       * existing call site that constructs a `compose` overlay by hand
       * (tests included) keeps compiling: omitted means "at the end of
       * `buffer`" — exactly the append-only behavior `compose_input` always
       * had before cursor-aware editing (T2.3b). Reducers/renderer read it
       * through `overlay.cursor ?? overlay.buffer.length`.
       */
      readonly cursor?: number;
      /** Optional Vim-style editing state; omitted retains normal insert mode. */
      readonly editor?: VimEditorState;
      /** Correlates a pending composition-root external-editor round trip. */
      readonly external_editor_request_id?: string;
    }
  | {
      readonly kind: "confirm";
      readonly title: string;
      readonly detail: string;
      readonly pendingAction: { readonly kind: RuntimeCommandKind; readonly params: Readonly<Record<string, unknown>>; readonly expected_version?: string };
    }
  | {
      readonly kind: "help";
      readonly query: string;
      /** Zero-based cursor into the currently filtered palette result set. */
      readonly selected_index: number;
      /** Explicit operator expansion of the otherwise bounded contextual view. */
      readonly expanded: boolean;
    }
  | OperatorFormOverlay;

export type OperatorFormKind = "campaign.halt" | "job.submit" | "approval.request" | "userinput.ask" | "communication.record" | "output.capture" | "output.raw" | "bus.thread.send" | "bus.thread.ack" | "bus.record" | "peer.grant" | "compaction.record" | "a2a.send" | "a2a.receive" | "context.artifact.capture" | "fold.propose" | "fold.approve" | "fold.rollback" | "playbook.propose" | "playbook.approve" | "harness.propose" | "harness.approve" | "harness.rollback" | "harness.evaluate" | "subagent.execute" | "harness.evaluation.start" | "harness.promote" | "harness.quarantine" | "harness.session.steer" | "harness.session.resume" | "harness.session.fork" | "harness.session.respawn" | "result.review.comment" | "result.review.request_revision" | "result.review.editor_handoff" | "migration.apply" | "migration.rollback" | "integration.install" | "integration.enable" | "integration.disable" | "integration.update" | "session.identity.mutate" | "notification.read" | "followup.create" | "trust.enroll" | "trust.rotate" | "trust.revoke" | "taskcomposer.submit" | "taskcomposer.followup" | "taskcomposer.answer" | "taskcomposer.reject";

/** Structural transport for a validated custom-command authority binding. */
export interface TaskComposerCommandBindingInput {
  readonly name: string;
  readonly execution_role: string;
  readonly allowed_tools: readonly string[];
  readonly skill_id: string | null;
}

/** Bounded reference bytes captured by the host, never instruction authority. */
export interface TaskComposerReferenceAttachment {
  readonly display_name: string;
  readonly content_base64: string;
}

/** Typed command authoring state. Values remain text until the reducer validates them. */
export interface OperatorFormOverlay {
  readonly kind: "operator_form";
  readonly command: OperatorFormKind;
  readonly title: string;
  /** Read-only context for an operator decision; never contributes to command params. */
  readonly detail?: string;
  readonly fields: Readonly<Record<string, string>>;
  readonly active_field: string;
  readonly error: string | null;
  /** Present only when a validated custom command opened this task form. */
  readonly task_command?: TaskComposerCommandBindingInput;
  readonly reference_attachments?: readonly TaskComposerReferenceAttachment[];
  readonly task_mode?: "execute" | "answer";
  /**
   * UTF-16 offset into `fields[active_field]` (text-buffer.ts). Optional for
   * the same backward-compatibility reason as `Overlay["compose"].cursor`:
   * omitted means "at the end of the active field's current value".
   * Operator-form fields stay single-line (never receive a `\n` insert), so
   * this is a plain offset, not a line/column pair.
   */
  readonly field_cursor?: number;
  /** Optional Vim-style editing state; omitted retains normal insert mode. */
  readonly editor?: VimEditorState;
}

export interface Notification {
  readonly id: string;
  readonly severity: NotificationSeverity;
  readonly message: string;
  readonly createdAt: number;
  /**
   * Optional display lifetime for ambient notification chrome. Expiry only
   * removes the item from the footer band; Diagnostics remains the durable
   * record for runtime failures and other operator evidence.
   */
  readonly expiresAt?: number;
}

export interface Diagnostic {
  readonly fingerprint: string;
  readonly message: string;
  readonly source: string;
  readonly count: number;
  readonly firstSeenAt: number;
  readonly lastSeenAt: number;
}

export interface AppError {
  readonly code: "validation" | "permission" | "conflict" | "unavailable" | "transport" | "timeout" | "cancellation" | "corrupt_data" | "internal";
  readonly message: string;
  readonly source: string;
  readonly recoverable: boolean;
  readonly fingerprint: string;
}

/**
 * Explicit focus model (ui-spec §3, M2.2). `zone` cycles `composer` ->
 * `transcript` -> `rail` -> `graph` (F6/Shift+F6). `rail_tab` is the rail's
 * own sticky tab, reusing `ResponsiveInspectorTab` (`responsive-sidebar.ts`)
 * rather than a second, incompatible tab vocabulary. Overlay-stack semantics
 * (ui-spec: "topmost overlay owns input") are satisfied by the existing
 * `AppModel.overlay` single slot for M2: it already holds at most one
 * overlay, so "the top of the stack" and "the only overlay" coincide: a
 * genuine multi-level stack (e.g. a confirmation opened from within help) is
 * out of M2 scope. Row/document selection by stable id already lives in
 * `AppModel.selection` (`ScreenSelection`, keyed by screen) and is reused
 * rather than duplicated here.
 */
export type FocusZone = "composer" | "transcript" | "rail" | "graph";
export interface FocusModel {
  readonly zone: FocusZone;
  readonly rail_tab: ResponsiveInspectorTab;
}

export interface RepeatConfirmation {
  readonly token: string;
  readonly action_key: string;
  readonly hint: string;
  readonly expires_at: number;
  readonly fired: boolean;
}

export type UiIntent =
  | { readonly type: "dismiss_notification"; readonly id: string }
  | { readonly type: "request_shutdown" }
  | { readonly type: "interrupt_active_campaign" }
  | { readonly type: "focus_screen"; readonly screen: ScreenId }
  | { readonly type: "issue_query"; readonly queryId: string; readonly request: RuntimeQueryRequest; readonly screen?: ScreenId }
  // Operator command-surface controls (A-3 remediation): these read the
  // current screen's already-fetched query result out of `model.screens` and
  // turn a keypress into a real `dispatch_command` effect through the same
  // runtime-catalog command path `issue_command` already uses — no second
  // authority. Arm/compose/cancel/submit implement a minimal free-text
  // answer flow for the interviews screen's `userinput.answer` control.
  | { readonly type: "arm_answer" }
  | { readonly type: "compose_input"; readonly buffer: string }
  | { readonly type: "cancel_compose" }
  | { readonly type: "submit_answer" }
  // Cursor-aware compose editing (T2.3b, RV-TUI-14 / FP-19): insert/delete
  // apply at `overlay.cursor`, not the end of `buffer` — `compose_input`
  // above stays the coarse "replace the whole buffer" intent (still used by
  // a full re-seed), while these are the fine-grained per-keystroke/paste
  // edits. `compose_insert` carries a `\n` for Shift/Alt+Enter (multiline)
  // and for a pasted string with embedded newlines preserved.
  | { readonly type: "compose_insert"; readonly text: string }
  | { readonly type: "compose_backspace" }
  | { readonly type: "compose_delete" }
  | { readonly type: "compose_move"; readonly movement: CursorMovement }
  /** Toggles an editable overlay between ordinary insert and Vim normal mode. */
  | { readonly type: "toggle_vim_mode" }
  /** One raw terminal key that Vim normal mode owns. */
  | { readonly type: "vim_key"; readonly key: string }
  /** Ask the composition root to safely edit the compose buffer in $VISUAL/$EDITOR. */
  | { readonly type: "open_external_editor" }
  | { readonly type: "approve_selected"; readonly scope?: "once" | "session" | "persistent" }
  | { readonly type: "reject_selected" }
  // Tree-node selection + branch/prune controls (wave1/tui-contracts). Pure
  // selection/arm intents carry no effect; confirm/branch build a real
  // `dispatch_command` through the same runtime-catalog path issue_command
  // already uses — no second authority.
  | { readonly type: "select_tree_node"; readonly direction: 1 | -1 }
  | { readonly type: "uct_reader_action"; readonly action: Exclude<UctReaderAction, "snapshot"> }
  // Pointer-driven selection (wave 2). `row` is an index into the screen's own
  // ordered record list, already scroll-adjusted by the caller — deliberately
  // not a viewport row, so this intent means the same thing whether or not the
  // list is scrolled. Only screens that actually maintain a selection respond;
  // the rest are a safe no-op rather than a fabricated selection.
  | { readonly type: "select_row"; readonly screen: ScreenId; readonly row: number }
  | { readonly type: "select_row_identity"; readonly screen: ScreenId; readonly selection: ScreenSelection }
  | { readonly type: "branch_selected_node" }
  | { readonly type: "request_prune_selected_node" }
  | { readonly type: "confirm_pending_action" }
  | { readonly type: "cancel_pending_action" }
  // Command-surface expansion (job.cancel/retry, operation.cancel,
  // task.retry, job.pause/resume, approval.expire): the same
  // read-selected-row-then-dispatch-a-real-command idiom as the tree
  // controls above, generalized to any screen with a recognized row shape
  // (`operator-selection.ts`'s `screenRowIds`) instead of being tree-only.
  // `select_row_relative` is the keyboard (j/k) counterpart to the existing
  // pointer-driven `select_row`; the tree screen keeps using its own
  // `select_tree_node` (compound `context.campaign_id` key) instead of this.
  | { readonly type: "select_row_relative"; readonly direction: 1 | -1 }
  | { readonly type: "toggle_result_review_mode" }
  // Diff Review hunk/file navigation (T2.3a). Screen-scoped cursor state,
  // stored the same way toggle_result_review_mode already stores view_mode:
  // folded onto the screen's own already-fetched query result in
  // `model.screens`, never a bespoke AppModel field. `result_review_move_hunk`
  // steps within the current file's hunks; `result_review_move_file` steps
  // the file cursor and resets the hunk cursor to 0 (a fresh file's hunk 0).
  | { readonly type: "result_review_move_hunk"; readonly direction: 1 | -1 }
  | { readonly type: "result_review_move_file"; readonly direction: 1 | -1 }
  // Arms the SAME command-agnostic `confirm` overlay `request_prune_selected_node`
  // arms, for whichever screen's selected row supports a destructive cancel
  // (jobs -> job.cancel, operations -> operation.cancel) — never a second
  // confirmation authority.
  | { readonly type: "cancel_selected_row" }
  // Non-destructive: dispatches immediately, no confirmation (jobs ->
  // job.retry, tasks -> task.retry) — retrying a terminal job/task loses no
  // state a cancel would.
  | { readonly type: "retry_selected_row" }
  | { readonly type: "abandon_recovery_selected" }
  | { readonly type: "view_selected_row_detail" }
  | { readonly type: "view_selected_harness_session_events" }
  | { readonly type: "attach_selected_harness_session" }
  | { readonly type: "confirm_task_composer" }
  | { readonly type: "retry_task_composer" }
  | { readonly type: "cancel_task_composer"; readonly draft_id: string; readonly expected_revision: number; readonly reason: string }
  | { readonly type: "open_operator_form"; readonly command: OperatorFormKind }
  | { readonly type: "open_task_preset"; readonly task: string; readonly mode?: "execute" | "answer"; readonly command?: TaskComposerCommandBindingInput; readonly reference_attachments?: readonly TaskComposerReferenceAttachment[] }
  | { readonly type: "operator_form_input"; readonly value: string }
  // Cursor-aware operator-form field editing (T2.3b), the single-line
  // counterpart to `compose_insert`/`compose_backspace`/`compose_delete`/
  // `compose_move` above — same idiom, scoped to `overlay.fields[overlay.active_field]`
  // and `overlay.field_cursor` instead of the compose buffer. Never receives
  // a `\n`: fields stay single-line by construction of the caller.
  | { readonly type: "operator_form_insert"; readonly text: string }
  | { readonly type: "operator_form_backspace" }
  | { readonly type: "operator_form_delete" }
  | { readonly type: "operator_form_move"; readonly movement: CursorMovement }
  | { readonly type: "operator_form_next_field"; readonly direction: 1 | -1 }
  | { readonly type: "submit_operator_form" }
  | { readonly type: "cancel_operator_form" }
  // Queue-level (not row-scoped): toggles the jobs screen's dispatch
  // throttle by reading the current `queue_paused` flag off the jobs
  // screen's own already-fetched `job.list` result and dispatching the
  // complementary job.pause/job.resume command.
  | { readonly type: "toggle_job_queue" }
  // Approvals screen: expires the same oldest-pending target
  // approve_selected/reject_selected already resolve via `oldestPendingApproval`.
  | { readonly type: "expire_selected" }
  // Per-screen scroll (wave2/tui-input-model): all four target
  // `model.screen`'s entry in `AppModel.scrollOffsets`, no-op while an
  // overlay owns the keyboard. `amount` for page_up/page_down is supplied by
  // the dispatching caller (the composition root, which alone knows the real
  // pane height at dispatch time) rather than guessed here — update.ts has no
  // viewport size and must not fabricate one. scroll_by is the fine-grained
  // wheel-driven counterpart (see input-terminal.ts).
  | { readonly type: "page_up"; readonly amount: number }
  | { readonly type: "page_down"; readonly amount: number }
  | { readonly type: "scroll_home" }
  | { readonly type: "scroll_end" }
  | { readonly type: "scroll_by"; readonly lines: number }
  // Help overlay (wave2/tui-input-model): folds `helpVisible` (previously a
  // raw-loop-local boolean, invisible to update.ts) into real model state so
  // a live substring filter can redraw on every keystroke, the same way
  // `compose_input` already works.
  | { readonly type: "toggle_help" }
  | { readonly type: "help_query_input"; readonly buffer: string }
  | { readonly type: "help_select_index"; readonly index: number }
  | { readonly type: "help_toggle_expanded" }
  /**
   * Live command-palette theme switching. Carries the resolved `RunTheme`
   * value directly (not a bare name) — the same "reducer owns state, caller
   * resolves the real value" idiom `query_results` already uses — so
   * `update.ts` stays a pure function of already-derived data and never
   * re-imports theme.ts's named-catalog lookup itself.
   */
  | { readonly type: "set_theme"; readonly theme: RunTheme }
  // Explicit focus zone cycling (ui-spec §3, F6/Shift+F6): composer ->
  // transcript -> rail -> graph, wrapping. Pure model state; no effect.
  | { readonly type: "focus_zone_cycle"; readonly direction: 1 | -1 }
  | { readonly type: "focus_zone_set"; readonly zone: FocusZone }
  | { readonly type: "focus_rail_tab"; readonly tab: ResponsiveInspectorTab };

export type AppEvent =
  | { readonly type: "ui_intent"; readonly intent: UiIntent; readonly at: number }
  | { readonly type: "transport_connecting"; readonly attempt: number }
  | { readonly type: "transport_connected" }
  | { readonly type: "snapshot_received"; readonly snapshot: ProjectionSnapshot }
  | { readonly type: "cursor_advanced"; readonly cursor: string }
  | { readonly type: "transport_disconnected"; readonly reason: string }
  | { readonly type: "error_raised"; readonly error: AppError; readonly at: number }
  /** Return path for a composition-root external editor; null means cancelled. */
  | { readonly type: "external_editor_result"; readonly request_id: string; readonly text: string | null; readonly at: number }
  | { readonly type: "notification_added"; readonly notification: Notification }
  | { readonly type: "shutdown_complete" }
  | { readonly type: "telemetry_requested"; readonly campaignId: string; readonly at: number }
  | { readonly type: "telemetry_received"; readonly snapshot: TelemetrySnapshot }
  | { readonly type: "command_dispatched"; readonly request: RuntimeCommandRequest; readonly at: number }
  | { readonly type: "query_results"; readonly queryId: string; readonly screen: ScreenId; readonly value: unknown; readonly observed_at_ms?: number }
  | { readonly type: "screen_changed"; readonly screen: ScreenId }
  | { readonly type: "grants_updated"; readonly capabilities: readonly string[] }
  | { readonly type: "repeat_confirmation_elapsed"; readonly token: string }
  /**
   * The ADR-161 read model, folded by the composition root's own poll loop
   * (`tui.ts`'s `pollHaltTransitions`/`reseedReadModelFromResume`) and
   * dispatched into reducer state — never mutated onto the model from a
   * render callback. `renderCockpitScene` reads `AppModel.readModel`
   * directly for the Inspect rail tab (ui-spec §4).
   */
  | { readonly type: "read_model_updated"; readonly model: TuiReadModel };

export type Effect =
  | { readonly type: "connect"; readonly target: string }
  | { readonly type: "disconnect" }
  | { readonly type: "request_snapshot"; readonly afterCursor: string | null }
  | { readonly type: "restore_terminal" }
  | { readonly type: "close_client" }
  | { readonly type: "interrupt_campaign" }
  | { readonly type: "fetch_telemetry"; readonly campaignId: string }
  | { readonly type: "dispatch_command"; readonly request: RuntimeCommandRequest }
  /** Paths are resolved by an MCP-owned boundary; TUI state never contains attachment bytes. */
  | { readonly type: "submit_taskcomposer_attachments"; readonly request: RuntimeCommandRequest; readonly attachment_paths: readonly string[] }
  /**
   * TUI requests an editor but never launches it: the composition root owns
   * temp files, terminal suspend/resume, and the process boundary.
   */
  | { readonly type: "open_external_editor"; readonly request_id: string; readonly title: string; readonly text: string; readonly language: "markdown"; readonly max_chars: number }
  | { readonly type: "run_query"; readonly request: RuntimeQueryRequest; readonly screen?: ScreenId }
  | { readonly type: "set_screen"; readonly screen: ScreenId }
  | { readonly type: "schedule_repeat_confirmation_clear"; readonly token: string; readonly at: number };

export interface AppLimits {
  readonly notifications: number;
  readonly diagnostics: number;
}

export interface AppModel {
  readonly connection: ConnectionState;
  readonly snapshot: ProjectionSnapshot | null;
  readonly notifications: readonly Notification[];
  readonly diagnostics: readonly Diagnostic[];
  readonly limits: AppLimits;
  readonly shuttingDown: boolean;
  readonly shutdownComplete: boolean;
  readonly telemetrySnapshot: TelemetrySnapshot | null;
  readonly telemetryCampaignId: string | null;
  readonly screen: ScreenId;
  readonly grantedCapabilities: ReadonlySet<string>;
  readonly latestQueryValue: unknown;
  readonly latestQueryId: string | null;
  /** Per-screen latest query slots (4F.1): each screen projects its own query result instead of one global value. */
  readonly screens: ReadonlyMap<ScreenId, unknown>;
  /** Monotonic model version (4F.2): bumped on every model-changing update so consumers redraw event-driven, not on a poll. */
  readonly epoch: number;
  /** Model-folded state-change flash map (player-piano), driven by the update cadence. */
  readonly devtoolsTransitions: ReadonlyMap<string, NodeTransition>;
  readonly uctPlayback: UctPlayback;
  /** Retained Tree reader cursor and controls, reconciled from authoritative campaign.tree results. */
  readonly uctReader: UctReaderState;
  /**
   * The single active overlay (compose / confirm / help), or none. Supersedes
   * `compose`, `confirmation`, `pendingAction`, and the raw-loop-local
   * `helpVisible` boolean — see the `Overlay` type doc for the full
   * rationale. Non-null blocks other keyboard routing the same way the three
   * predecessor fields already did.
   */
  readonly overlay: Overlay | null;
  /** Visible, expiring double-press guard for interrupt/cancel only. */
  readonly repeatConfirmation: RepeatConfirmation | null;
  /**
   * Per-screen operator row selection (wave2/tui-input-model), generalizing
   * the Tree screen's previously tree-only `TreeSelection`. `context` carries
   * whatever compound key a screen's selection needs beyond a bare row id —
   * the Tree screen's entry stores `{campaign_id}` there, the same value
   * `TreeSelection.campaign_id` used to hold directly. Only "tree" is
   * populated today (the only screen with a live selection cursor); the
   * per-screen shape is what the rest of the operator command surface
   * (job.cancel, operation.cancel, task.retry, ...) will key into once wired.
   */
  readonly selection: ReadonlyMap<ScreenId, ScreenSelection>;
  /**
   * Per-screen scroll offset (wave2/tui-input-model). A row index, not a
   * pixel/cell coordinate. `scroll_end`'s effective offset is a sentinel
   * (see update.ts) resolved down to the true last page only once both row
   * count and viewport height are known together, at render time.
   */
  readonly scrollOffsets: ReadonlyMap<ScreenId, number>;
  /** Stable event-ID scrollback intent for transcript surfaces. */
  readonly frontierLiveEdges: ReadonlyMap<ScreenId, FrontierLiveEdgeState>;
  /**
   * The active render palette (theme.ts). Model-owned so a `set_theme`
   * intent can drive a live, full-frame repaint through the same
   * update-then-invalidate path every other model change already uses,
   * instead of a renderer-local mutable outside model control.
   */
  readonly theme: RunTheme;
  /** Explicit focus model (ui-spec §3, M2.2). See `FocusModel`'s own doc comment. */
  readonly focus: FocusModel;
  /** ADR-161 read model, updated only via the `read_model_updated` reducer event (never a render-time mutation). */
  readonly readModel: TuiReadModel;
}

export interface UpdateResult {
  readonly model: AppModel;
  readonly effects: readonly Effect[];
}
