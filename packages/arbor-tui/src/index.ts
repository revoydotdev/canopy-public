export { DEFAULT_LIMITS, initialModel } from "./model.js";
export { selectConsoleClarification, type ConsoleClarification } from "./console-clarification.js";
export { buildOperatorViewModel, DEFAULT_OPERATOR_PROJECTION_LIMITS, selectOperatorAttention } from "./operator-view-model.js";
export type {
  AttentionView, EventAction, EventCorrelation, EventView, EventVisualTreatment,
  FreshnessView, ObjectiveView, OperationView, OperatorEventKind, OperatorEventSource,
  OperatorImportance, OperatorLifecycle, OperatorProjectionInput, OperatorProjectionLimits,
  OperatorTruth, OperatorViewModel, OperatorVisualEmphasis, OperatorVisualFamily, ProjectionBounds,
  SupervisedWorkView,
} from "./operator-view-model.js";
export { FrontierInstrumentation } from "./frontier-instrumentation.js";
export type {
  AccessibilityCapabilityFacts, FrontierInstrumentationOptions, InstrumentationClock,
  LatencyObservation, LatencyOrigin, OperatorMetric, OperatorMetricObserver,
  OperatorMetricReceipt, QueueRetentionHighWater, QueueRetentionSnapshot,
  ReceiptState, RenderInvocation, ResourceSettlement, ResourceSettlementFacts,
} from "./frontier-instrumentation.js";
export {
  FOI_CORPUS_ID, FOI_EVIDENCE_SCHEMA_VERSION, FOI_V1_SCENARIOS,
  foiScenario, materializeFOIScenario, validateFOIScenarioEvidence,
} from "./foi-scenario-contract.js";
export { captureFOIScenarioArtifacts } from "./foi-capture.js";
export type { FOICapturedArtifacts } from "./foi-capture.js";
export { captureFOINativeScenarioArtifacts } from "./foi-native-capture.js";
export { captureFOIInteractionBenchmark } from "./foi-interaction-benchmark.js";
export type { FOIInteractionBenchmark } from "./foi-interaction-benchmark.js";
export type { FOINativeCapturedArtifacts } from "./foi-native-capture.js";
export type {
  FOIColorMode, FOICleanupReceipt, FOIEvidenceArtifacts, FOIEvidenceAssertion,
  FOIEvidenceMeasurements, FOIEvidenceStatus, FOIEvidenceValidation,
  FOIEvidenceVerdict, FOIMeasurementStatus, FOIMetricReceipt,
  FOIPresentationContract, FOIResizeTrace, FOIScenarioEvidence,
  FOIScenarioEvent, FOIScenarioFixture, FOIScenarioId, FOIScenarioManifest,
  FOIViewport,
} from "./foi-scenario-contract.js";
export { update, FOCUS_ZONE_ORDER, nextFocusZone } from "./update.js";
export { emptyUctGraph, applyUctEvents, initialUctReader, updateUctReader } from "./uct-model.js";
export type { UctModelNode, UctModelEdge, UctLifecycleEvent, UctGraphModel, UctReaderState } from "./uct-model.js";
export { HeadlessHarness } from "./headless.js";
export { applyVimKey, vimKeyIsOwned, vimModeLabel } from "./terminal-editor.js";
export type { EditorMode, VimEditorState, VimEditResult } from "./terminal-editor.js";
export { highlightSyntax, syntaxLanguageForPath } from "./syntax.js";
export type { SyntaxLanguage } from "./syntax.js";
export { activeWorkspace, createNavigation, layoutWorkspace, resizeTerminal } from "./navigation.js";
export { InputRouter, normalizeKey, catalogConflicts, helpActions } from "./input-catalog.js";
export {
  buildDefaultCatalog, applyKeymapOverrides, screenForAction, HELP_ACTION_ID,
  INTERRUPT_ACTION_ID, STOP_AND_EXIT_ACTION_ID, ANSWER_ACTION_ID, APPROVE_ACTION_ID, APPROVE_SESSION_ACTION_ID, APPROVE_PERSISTENT_ACTION_ID, REJECT_ACTION_ID,
  TREE_SELECT_NEXT_ACTION_ID, TREE_SELECT_PREV_ACTION_ID, TREE_FOLLOW_ACTION_ID, TREE_FILTER_ACTION_ID, PAGE_UP_ACTION_ID, PAGE_DOWN_ACTION_ID, SCROLL_HOME_ACTION_ID, SCROLL_END_ACTION_ID, TREE_BRANCH_ACTION_ID, TREE_PRUNE_ACTION_ID,
  TOGGLE_RESULT_REVIEW_MODE_ACTION_ID,
  RESULT_REVIEW_NEXT_HUNK_ACTION_ID, RESULT_REVIEW_PREV_HUNK_ACTION_ID, RESULT_REVIEW_NEXT_FILE_ACTION_ID, RESULT_REVIEW_PREV_FILE_ACTION_ID,
  CANCEL_ROW_ACTION_ID, RETRY_ROW_ACTION_ID, TOGGLE_JOB_QUEUE_ACTION_ID, APPROVAL_EXPIRE_ACTION_ID, RECOVERY_ABANDON_ACTION_ID, VIEW_ROW_DETAIL_ACTION_ID, VIEW_HARNESS_SESSION_EVENTS_ACTION_ID, ATTACH_HARNESS_SESSION_ACTION_ID, STEER_HARNESS_SESSION_ACTION_ID, RESUME_HARNESS_SESSION_ACTION_ID, FORK_HARNESS_SESSION_ACTION_ID, RESPAWN_HARNESS_SESSION_ACTION_ID, COPY_FOCUSED_ROW_ACTION_ID,
  CAMPAIGN_HALT_ACTION_ID, JOB_SUBMIT_ACTION_ID, APPROVAL_REQUEST_ACTION_ID, USERINPUT_ASK_ACTION_ID, COMMUNICATION_RECORD_ACTION_ID, OUTPUT_CAPTURE_ACTION_ID, OUTPUT_RAW_ACTION_ID, CONTEXT_ARTIFACT_CAPTURE_ACTION_ID,
  THREAD_SEND_ACTION_ID, THREAD_ACK_ACTION_ID,
  BUS_RECORD_ACTION_ID, PEER_GRANT_ACTION_ID, COMPACTION_RECORD_ACTION_ID, A2A_SEND_ACTION_ID, A2A_RECEIVE_ACTION_ID,
  FOLD_ROLLBACK_ACTION_ID, FOLD_PROPOSE_ACTION_ID, FOLD_APPROVE_ACTION_ID, PLAYBOOK_PROPOSE_ACTION_ID, PLAYBOOK_APPROVE_ACTION_ID,
  HARNESS_PROPOSE_ACTION_ID, HARNESS_APPROVE_ACTION_ID, HARNESS_ROLLBACK_ACTION_ID, HARNESS_EVALUATE_ACTION_ID,
  SUBAGENT_EXECUTE_ACTION_ID,
  HARNESS_EVALUATION_START_ACTION_ID, HARNESS_PROMOTE_ACTION_ID, HARNESS_QUARANTINE_ACTION_ID,
  PROJECT_MANAGE_ACTION_ID,
  TRUST_ENROLL_ACTION_ID, TRUST_ROTATE_ACTION_ID, TRUST_REVOKE_ACTION_ID,
  TASK_COMPOSER_NEW_ACTION_ID, TASK_COMPOSER_FOLLOWUP_ACTION_ID,
  TASK_COMPOSER_ANSWER_ACTION_ID, TASK_COMPOSER_CONFIRM_ACTION_ID, TASK_COMPOSER_RETRY_ACTION_ID,
  TASK_COMPOSER_REJECT_ACTION_ID,
  TASK_COMPOSER_ROADMAP_ACTION_ID, TASK_COMPOSER_MAINTENANCE_ACTION_ID,
  FOCUS_ZONE_NEXT_ACTION_ID, FOCUS_ZONE_PREV_ACTION_ID, CONTEXT_MENU_ACTION_ID,
  RAIL_TAB_PROJECT_ACTION_ID, RAIL_TAB_DOCS_ACTION_ID,
  themeActionId, themeForAction,
} from "./default-catalog.js";
export type { KeymapOverride, KeymapOverrideResult } from "./default-catalog.js";
export { compactionScreen } from "./screens/compaction.js";
export { siblingsScreen } from "./screens/siblings.js";
export { surveillanceScreen } from "./screens/surveillance.js";
export { capabilitiesScreen } from "./screens/capabilities.js";
export { threadsScreen } from "./screens/threads.js";
export { overlaysScreen } from "./screens/overlays.js";
export { telemetryScreen } from "./screens/telemetry.js";
export { trustScreen, TRUST_UNAVAILABLE } from "./screens/trust.js";
export { harnessConnectorsScreen } from "./screens/harness-connectors.js";
export { harnessReadinessScreen } from "./screens/harness-readiness.js";
export { harnessSessionsScreen } from "./screens/harness-sessions.js";
export { harnessEvaluationsScreen } from "./screens/harness-evaluations.js";
export { taskComposerScreen } from "./screens/task-composer.js";
export { liveSessionScreen } from "./screens/live-session.js";
// dashboard/cockpit/projects were retired (ADR-149 Decision 7): three composite
// views over the identical query set that Console now owns. Their fleet and
// portfolio facts live on in `operatorFleetFacts`/`operatorPortfolioFacts`.
export { operatorFleetFacts, operatorPortfolioFacts, type OperatorFact } from "./screens/product.js";
export type { ProductSurfaceSnapshot } from "./screens/product.js";
export { projectRegistryScreen } from "./screens/project-registry.js";
export { PILOT_WORKFLOWS, workflowForAction, workflowPaletteActions } from "./pilot-workflows.js";
export type { PilotWorkflow, PilotWorkflowCategory } from "./pilot-workflows.js";
export { nativeBudgetScreen } from "./screens/native-budget.js";
export { nativeBudgetWarning } from "./screens/native-budget.js";
export type { BudgetWarningProjection } from "./screens/native-budget.js";
export {
  latestInterview, oldestPendingApproval, selectedPendingApproval, stickyTreeSelection, stepTreeSelection,
  selectScreenRow, stepScreenSelection, stickyScreenSelection,
} from "./operator-selection.js";
// `TreeSelection` became `ScreenSelection` in wave 2: selection generalized
// from a tree-only pair to a per-screen `Map<ScreenId, ScreenSelection>`, so
// the operator commands that target a row (job.cancel, operation.cancel,
// task.retry) have a way to name one. See docs/tui-wave2-plan.md.
export type { InterviewTarget, ApprovalTarget, ScreenSelection } from "./operator-selection.js";
// `MemoryRenderer` and `renderTerminalFrame` were removed from this surface: both are
// test-only (VI findings vi:d527fa1dcc8f6d01 / vi:31e70181918a7bef) and now live in
// tests/support/render-harness.ts. They were never imported outside @arbor/tui.
export { StdoutRenderer, renderScene, paintScene } from "./renderer.js";
export { stripAnsi } from "./player-piano.js";
export {
  TerminalPainter, SsePainter, encodeFrameAsJson, paintTargetFromRenderFn,
} from "./painter.js";
export type { Frame, FramePainter, PaintTarget } from "./painter.js";
export { TuiShell, TUI_SHELL_RESOURCE_IDS, timerCadence, createProcessSignalPort, createProcessResizeSignalPort, defaultTerminalSize } from "./shell.js";
export { clipDisplay, displayCells, displayWidth, renderStreamViewport, renderTable, renderTree, SELECTED_ROW_MARKER, UNSELECTED_ROW_MARKER, selectedRowMarker } from "./widgets.js";
export {
  boundedNotifications, paletteCategory, paletteView, paletteContextForModel, paletteDisclosure, paletteFooterHint, renderPaletteRows,
  DEFAULT_NOTIFICATION_BAND_ROWS, notificationDismissIntent, renderNotificationBand, windowedNotifications,
} from "./overlays.js";
export type { NotificationBandLine } from "./overlays.js";
export { deriveEvaluationProof, formatCost, PHASE_DURATION_BUCKETS_MS, renderContextEconomy, renderEvaluationProof, renderTelemetryCounters, renderTelemetryEvidence, renderTelemetryPhaseHistogram, renderTelemetryUsageCost, renderTelemetryView, renderToolEconomy } from "./telemetry-widgets.js";
export type { EvaluationProofMetric, EvaluationProofProjection } from "./telemetry-widgets.js";
export { freezeTelemetrySnapshot } from "./telemetry-types.js";
export {
  deriveTheme, detectTerminalMode, checkLegibility, contrastRatio, luminance, footerTheme, toForegroundSgr, toBackgroundSgr,
  DEFAULT_DARK_PALETTE, DEFAULT_LIGHT_PALETTE,
  TUI_THEME_NAMES, THEME_CATALOG, THEME_TITLES, isTuiThemeName, getNamedTheme, resolveStartupTheme,
  SEMANTIC_GLYPHS, semanticGlyph, focusBorderGlyphs,
} from "./theme.js";
export type { RunTheme, RunFooterTheme, TerminalMode, PaletteRole, TuiThemeName, ColorMode, SemanticRole, SemanticGlyph } from "./theme.js";
export { computeShellLayout, focusZonesForShellLayout } from "./layout.js";
export type { ShellLayout, ShellLayoutRect, ShellLayoutClass, ShellRailRequest, ShellHeaderRequest, ShellLayoutInput } from "./layout.js";
export { deriveConsoleActivityNarrative, deriveStatusBarZones, renderStatusBar, STATUS_BAR_PLACEHOLDER } from "./status-bar.js";
export type { ConsoleActivityNarrative, StatusBarZones, StatusBarOptions } from "./status-bar.js";
export { fidelityMeter, campaignFidelityMeter } from "./fidelity-meter.js";
export type { FidelityBudgetInput, FidelityMeter } from "./fidelity-meter.js";
export type { KeyModifier, NormalizedKeyEvent, InputScope, KeyBinding, UiAction, InputCatalog, CatalogConflict, InputResult, CatalogSource } from "./input-catalog.js";
export type { Clock, HeadlessClient, HeadlessDependencies, HeadlessTerminal } from "./headless.js";
export type {
  AppError, AppEvent, AppLimits, AppModel, ConnectionState, Diagnostic, Effect,
  Notification, NotificationSeverity, OperatorFormKind, OperatorFormOverlay, ProjectionSnapshot, UiIntent, UpdateResult, Overlay, FocusZone,
} from "./types.js";
// `Modal`/`NavigationModel.modals` were deleted in wave 2 — a generic modal
// stack type with zero producers in production, superseded by the single
// `Overlay` union on AppModel that the three real overlays now share.
export type { FocusTarget, NavigationModel, Pane, PaneRect, TerminalSize, Workspace, WorkspaceLayout } from "./navigation.js";
export type { FrameOptions, RendererPort, RendererCommitObserver, RenderOutput, RenderProjection, RenderInput, RenderedFrame } from "./renderer.js";

// The structured scene (wave 2, ADR-037). `RendererPort.render` used to take a
// flattened `string`, which discarded every pane and cell boundary before the
// renderer saw it — so a renderer could not hit-test a click or drive a native
// scroll region no matter how capable it was. `SceneFrame` carries the pane
// rects that `layoutWorkspace` already computed and `TerminalPainter` used to
// throw away.
export { hitTestFrame } from "./frame.js";
export type { SceneFrame, FramePane, PaneHit } from "./frame.js";
export type { CadencePort, SignalPort, TuiShellOptions } from "./shell.js";
export type { TableColumn, TreeRow } from "./widgets.js";
export type { PaletteContext, PaletteItem, PaletteRenderedRow, PaletteView } from "./overlays.js";
export {
  aggregateBackgroundStatus, backgroundStatusesFromModel, backgroundStatusLine, turnBoundaryLine, summarizeTurnBoundary, preserveReadingAnchor, restoreReaderFocus, contextMenuItems,
  M7_THEME_TOKENS,
} from "./interaction-polish.js";
export type {
  BackgroundStatus, BackgroundStatusKind, BackgroundStatusSummary, TurnOutcome, TurnBoundaryInput,
  ReadingAnchor, ReadingAnchorResult, ReaderFocusSnapshot, ContextMenuItem,
} from "./interaction-polish.js";

// Terminal escape-sequence decoding (wave 2). Consumed by arbor-mcp's
// `runTui` stdin handler, which must recognize multi-byte sequences (PageUp
// `ESC [ 5 ~`, SGR mouse `ESC [ < Cb;Cx;Cy M`) before its per-character loop
// shreds them.
export { decodeTerminalInput, navigationKeyFromChar, TerminalInputDecoder, parseMouseEvent, mouseEventToIntent , classifyHeldBurst, HELD_BURST_INTRODUCERS } from "./input-terminal.js";
export type { MouseButton, MouseAction, MouseEvent, DecodedTerminalInput } from "./input-terminal.js";
export type {
  ContextEconomyRow, MetricCounterRow, MetricEvidencePointer, PhaseHistogramRow, ToolEconomyRow,
  TelemetrySnapshot, TelemetrySourcePort, UsageCostRow,
} from "./telemetry-types.js";
export type { TelemetryRenderOptions } from "./telemetry-widgets.js";
export {
  InspectService, DurableInspectRecordStore, MemoryInspectRecordStore, createInspectService, redactInspectValue,
} from "./inspect.js";
export type {
  InspectActionResult, InspectActionState, InspectClock, InspectDraft, InspectModel,
  InspectModelInput, InspectOptions, InspectRecordPersistence, InspectRecordStore, InspectSnapshot,
  InspectDependencyView, InspectEvidenceView,
  SideQueryAnswer, SideQueryRecord, SideQueryStatus,
} from "./inspect.js";
export {
  RUNTIME_PORT_LIMITS,
} from "./runtime-port.js";
export type {
  RuntimeCommandAcknowledgement, RuntimeCommandKind, RuntimeCommandMeta,
  RuntimeCommandRequest, RuntimeError, RuntimeGateRefusal, RuntimeGateRefusalV1,
  RuntimeGateRefusalV2, RuntimeEventSource, RuntimePort,
  RuntimePortLimits, RuntimePortWithEvents, RuntimeQueryKind, RuntimeQueryRequest, RuntimeResult,
} from "./runtime-port.js";
export {
  TUI_READ_MODEL_VERSION, TUI_READ_MODEL_BOUNDS,
  emptyReadModel, applySnapshot, applyEnvelopes, summarizeForInspect,
} from "./read-model.js";
export type {
  ApplyOutcome, GateResultView, OperationOutcomeView, ReadModelStatus,
  TreeNodeView, TuiReadModel, TuiReadModelVersion,
  InspectSummary, InspectTaskSummary, InspectGateSummary, InspectScope,
} from "./read-model.js";
export {
  availableScreens, clearRegisteredScreens, getScreen, registerScreen,
} from "./screens/screen.js";
export type {
  RowIdentity, ScreenId, ScreenModule, ScreenProjection, ScreenSurface,
} from "./screens/screen.js";
export { installScreens } from "./screens/install.js";
export { consoleScreen } from "./screens/console.js";
export type { ConsoleInputState } from "./screens/console.js";
export { fromText, insertText, backspace, deleteForward, moveCursor, cursorLineInfo } from "./text-buffer.js";
export type { TextBufferState, CursorMovement, CursorLineInfo } from "./text-buffer.js";
export { campaignsScreen } from "./screens/campaigns.js";
export { treeScreen } from "./screens/tree.js";
export { diagnosticsScreen } from "./screens/diagnostics.js";
export { tasksScreen } from "./screens/tasks.js";
export { operationsScreen } from "./screens/operations.js";
export { outputScreen } from "./screens/output.js";
export { resultReviewScreen } from "./screens/result-review.js";
export { communicationsScreen, type CommunicationsScreenOptions } from "./screens/communications.js";
export { configScreen } from "./screens/config.js";
export { agentsScreen } from "./screens/agents.js";
export { jobsScreen } from "./screens/jobs.js";
export { approvalsScreen } from "./screens/approvals.js";
export { interviewsScreen } from "./screens/interviews.js";
export { devtoolsScreen } from "./screens/devtools.js";
export { commandHistoryScreen } from "./screens/command-history.js";
export { governanceScreen } from "./screens/governance.js";
export { backlogScreen } from "./screens/backlog.js";
export { kbScreen } from "./screens/kb.js";
export { auditScreen } from "./screens/audit.js";
export { recoveryScreen } from "./screens/recovery.js";
export { controlScreen, CONTROL_DISABLED_GUIDANCE } from "./screens/control.js";
export type {
  GovernanceLegacyClassificationShape, GovernanceObligationCoverageShape,
  GovernancePolicyFindingShape, GovernanceRepositoryCountsShape, GovernanceSnapshotShape,
} from "./screens/governance.js";
export {
  ANSI,
  buildAnsiPalette,
  clipAnsi,
  colorize,
  deriveTransitions,
  eventClassColor,
  eventKindClass,
  flashStyle,
  isDevToolsStreamShape,
  nodeStateColor,
  spinnerGlyph,
} from "./player-piano.js";
export type {
  DevToolsEventClass,
  DevToolsStreamLine,
  DevToolsStreamShape,
  NodeTransition,
  TransitionOptions,
} from "./player-piano.js";
export { createKeyboardHandler, attachKeyboardInput } from "./keyboard.js";
export type { KeyboardHandlerOptions } from "./keyboard.js";
export { ansiToStyledText } from "./ansi-styled-text.js";
export { OpenTuiRenderer } from "./opentui-renderer.js";
export type { OpenTuiRendererOptions, TerminalProfileObservation, TerminalNotificationObservation, TerminalFocusState, NotificationMechanism, NotificationCondition, PaneScroll } from "./opentui-renderer.js";
export { projectCrash, renderCrashScreen, crashActionForKey } from "./crash-boundary.js";
export type { CrashProjection, CrashBoundaryAction } from "./crash-boundary.js";
export { sidebarTabAtColumn, projectResponsiveSidebar, sidebarAdrRows, sidebarDocumentRows, resolveRailRenderOptions, orderDecisionRecordsForDisplay, RESPONSIVE_SIDEBAR_WIDTH, RESPONSIVE_SIDEBAR_WIDE_BREAKPOINT, RAIL_TABS, ALL_INSPECTOR_TABS } from "./responsive-sidebar.js";
export type { ResponsiveSidebarProjection, ResponsiveSidebarInput, ResponsiveSidebarSelection, DecisionRecordDisplayOrderInput, ResponsiveInspectorTab } from "./responsive-sidebar.js";
