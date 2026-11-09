/**
 * The TUI's built-in keymap/palette catalog (ADR-020 / roadmap 4D.9, G-06).
 *
 * A default `InputCatalog` — one navigation action per screen, plus a help
 * action — so the cockpit is keyboard-navigable even with no config file
 * present (a missing config is normal, never an error). `applyKeymapOverrides`
 * layers a parsed `[tui.keymap]` grammar (see `keymap.ts` in `@arbor/config`)
 * on top by matching each override's description against an action's title,
 * so the palette/keymap grammar genuinely drives runtime bindings instead of
 * being decorative.
 */
import type { InputCatalog, KeyBinding, UiAction } from "./input-catalog.js";
import type { ScreenId } from "./screens/screen.js";
import { TUI_THEME_NAMES, THEME_TITLES, type TuiThemeName } from "./theme.js";

interface ScreenNavEntry {
  readonly screen: ScreenId;
  readonly title: string;
  readonly key: string | readonly string[];
}

/**
 * Short, truthful route hints for the cockpit's primary operational flow.
 * They are deliberately navigation guidance, not claims that a screen owns
 * backend authority (for example, creating a campaign remains an approved
 * plan-submission operation outside this read-only campaign list).
 */
const SCREEN_WORKFLOW_HINTS: Partial<Record<ScreenId, string>> = {
  "project-registry": "Review every registered project's discharge/staleness; Enter re-checks the selected entry, Ctrl+Shift+N reconciles all",
  campaigns: "Review campaigns; they appear after approved plan submission",
  tree: "Inspect the active campaign tree; select a non-root node before opening its thread",
  threads: "Read or acknowledge a selected non-root Tree node's direct parent/child messages in context of that node",
  approvals: "Review pending governed approvals and their independent deciders",
  recovery: "Review durable interrupted nodes before retrying or abandoning a selected target",
  output: "Review captured output evidence; select a capture before viewing its descriptor",
  "result-review": "Review captured changes, evidence, conflicts, comments, and selective adoption safety",
  audit: "Inspect the active campaign's durable evidence ledger",
  bus: "Inspect the active campaign's conversation-bus history in context of a correlation or selected node",
  a2a: "Inspect active campaign A2A source cards in context of their configured bridge and provenance",
  "command-history": "Scroll full commands, output, and exit codes a specialist/critic ran",
  devtools: "Inspect the raw bounded event stream in context beside the Console's semantic chronology; use it to diagnose a specific event, not as a second dashboard",
  diagnostics: "Inspect runtime faults, malformed projections, and event chronology in context of the active campaign",
  telemetry: "Inspect ledger-derived usage and event measures in context of the active campaign; it does not imply a cost estimate",
  surveillance: "Inspect monitored observations in context of the active campaign; routine health is not an incident",
  capabilities: "Inspect the granted capability catalogue and disabled reasons; this reference view does not create authority",
  "harness-connectors": "Inspect connector selection and readiness in context of the current execution path",
  "harness-readiness": "Inspect failed setup checks and their exact remediation in context of the selected connector",
  "harness-sessions": "Inspect bounded session state and redacted events; attach a selected session for its contextual tail",
  "harness-evaluations": "Inspect measured harness candidates and their evidence before any promotion or quarantine decision",
  communications: "Inspect selected-node communication in context of its parent, child, and campaign",
  siblings: "Inspect the selected node's sibling alternatives and their states in context of the Tree",
  overlays: "Inspect active governed folds, playbooks, harness revisions, and rollback availability in context of the campaign",
  kb: "Inspect capability-filtered learned knowledge in context of the current campaign and consumer tier",
};

/**
 * One mnemonic default key per registered operational screen (`install.ts`).
 * Every entry corresponds to an installed screen with a concrete projection
 * path.  Telemetry is injected through the audited TelemetrySourcePort, not
 * invented as a runtime-catalog query.
 */
const SCREEN_NAV: readonly ScreenNavEntry[] = [
  { screen: "project-registry", title: "Project Registry", key: "{" },
  { screen: "campaigns", title: "Campaigns", key: ["\\", "1"] },
  { screen: "tasks", title: "Tasks", key: ["\\", "2"] },
  { screen: "operations", title: "Operations", key: ["\\", "3"] },
  { screen: "recovery", title: "Recovery", key: "w" },
  { screen: "output", title: "Output", key: "4" },
  { screen: "result-review", title: "Diff Review", key: "shift+r" },
  { screen: "communications", title: "Communications", key: "5" },
  { screen: "diagnostics", title: "Diagnostics", key: "6" },
  { screen: "config", title: "Config", key: "7" },
  { screen: "native-budget", title: "Native Budget", key: "alt+b" },
  { screen: "agents", title: "Agents", key: "8" },
  { screen: "jobs", title: "Jobs", key: "9" },
  { screen: "approvals", title: "Approvals", key: "0" },
  { screen: "interviews", title: "Interviews", key: "i" },
  { screen: "devtools", title: "DevTools", key: "d" },
  // Every single lowercase letter is already bound (see the shift+j/shift+k/
  // shift+n/shift+p rationale a few entries below — the same alphabet scan
  // applies here). `shift+d` is free and mnemonically ties to `d` (DevTools):
  // this is the "detailed"/full-history view over the same devtools.stream
  // data, filtered to commands and rendered for reading instead of scanning.
  { screen: "command-history", title: "Command History", key: "shift+d" },
  { screen: "tree", title: "Tree", key: "t" },
  // The screen is fully built, data-wired (tui.ts issues governance.snapshot
  // on focus) and capability-granted (governance.snapshot is `supported:
  // true` in RUNTIME_CATALOG, so its capability is already in the grant set
  // every runTui session hands out) — it was simply missing from this table,
  // so no keypress and no `[tui.keymap]` override (applyKeymapOverrides only
  // rebinds an EXISTING action) could ever reach it.
  { screen: "governance", title: "Governance", key: "g" },
  // Finding 8/9/15 (TUI-vs-backend observability gap audit): three more
  // screens with a real, tested round trip (tui.ts issues kb.list/audit.list/
  // governance.backlog on focus; runtime-catalog.ts's kind is `supported:
  // true`) but, like governance above before this table gained an entry, no
  // keypress could ever reach them without a SCREEN_NAV row.
  { screen: "kb", title: "Knowledge Base", key: "m" },
  { screen: "audit", title: "Evidence Ledger", key: "v" },
  { screen: "backlog", title: "Backlog", key: "l" },
  { screen: "compaction", title: "Compaction", key: "[" },
  { screen: "siblings", title: "Siblings", key: "]" },
  { screen: "surveillance", title: "Surveillance", key: ";" },
  { screen: "capabilities", title: "Capabilities", key: "=" },
  { screen: "threads", title: "Parent/Child Threads", key: ":" },
  { screen: "bus", title: "Bus", key: "ctrl+d" },
  { screen: "a2a", title: "A2A Cards", key: "ctrl+shift+a" },
  { screen: "overlays", title: "Governed Context", key: "_" },
  { screen: "telemetry", title: "Telemetry", key: "," },
  { screen: "trust", title: "Remote Trust", key: "'" },
  { screen: "harness-connectors", title: "Harness Connectors", key: "ctrl+k" },
  { screen: "harness-readiness", title: "Native Setup Doctor", key: "ctrl+r" },
  { screen: "harness-sessions", title: "Harness Sessions", key: "." },
  { screen: "harness-evaluations", title: "Harness Evaluations", key: "ctrl+shift+v" },
  { screen: "task-composer", title: "Task Composer", key: "ctrl+t" },
  { screen: "live-session", title: "Live Session", key: "ctrl+s" },
  { screen: "control", title: "Flight Control", key: "ctrl+shift+x" },
  // Backtick: unclaimed by any prior binding (every letter, digit, and the
  // dense symbol set above are already single-purpose) and a familiar
  // "drop to a console" mnemonic from terminal-style consoles elsewhere.
  { screen: "console", title: "Console", key: "`" },
];

export const HELP_ACTION_ID = "help";
const FOCUS_PREFIX = "focus:";
/**
 * Command-palette theme switching (theme.ts's seven named botanical/material
 * palettes). Prefix-addressed like `FOCUS_PREFIX` above — `themeForAction`
 * recovers the target name the same way `screenForAction` recovers a screen
 * — never a bare keybinding (a whole-terminal palette swap has no natural
 * single-key mnemonic and would collide with the dense global keymap), so
 * these are reachable only through the command palette/help overlay search.
 */
const THEME_ACTION_PREFIX = "cmd:theme.set:";
export const themeActionId = (name: TuiThemeName): string => `${THEME_ACTION_PREFIX}${name}`;

/** Recover the theme name a palette action selects, or null for a non-theme action. */
export function themeForAction(actionId: string): TuiThemeName | null {
  if (!actionId.startsWith(THEME_ACTION_PREFIX)) return null;
  const name = actionId.slice(THEME_ACTION_PREFIX.length);
  return (TUI_THEME_NAMES as readonly string[]).includes(name) ? (name as TuiThemeName) : null;
}

/**
 * Operator command-surface actions (A-3 remediation, roadmap 4C "every
 * visible control has a tested canonical round trip"). Each routes through
 * the existing `issue_command`/`interrupt_active_campaign` intents to a real
 * runtime-catalog command — never a second authority. `context` documents
 * which screen the control acts on (enforced by `update.ts`, which no-ops
 * the intent on any other screen); it is informational here, surfaced in the
 * help/palette description so the operator knows what a key does.
 */
export const INTERRUPT_ACTION_ID = "cmd:tree.interrupt";
/** Exits the cockpit only after the existing shutdown path interrupts active work. */
export const STOP_AND_EXIT_ACTION_ID = "cmd:tui.stop_and_exit";
export const ANSWER_ACTION_ID = "cmd:userinput.answer";
export const APPROVE_ACTION_ID = "cmd:approval.approve";
export const APPROVE_SESSION_ACTION_ID = "cmd:approval.approve_session";
export const APPROVE_PERSISTENT_ACTION_ID = "cmd:approval.approve_persistent";
export const REJECT_ACTION_ID = "cmd:approval.reject";
/**
 * Tree-node selection + branch/prune controls (wave1/tui-contracts). All
 * three no-op off the Tree screen (enforced by `update.ts`), matching the
 * approve/reject/answer idiom above: the key is global, the effect is
 * screen-scoped.
 */
export const TREE_SELECT_NEXT_ACTION_ID = "cmd:tree.select_next";
export const TREE_SELECT_PREV_ACTION_ID = "cmd:tree.select_prev";
export const TREE_FOLLOW_ACTION_ID = "cmd:tree.follow";
export const TREE_FILTER_ACTION_ID = "cmd:tree.filter";
export const TREE_BRANCH_ACTION_ID = "cmd:tree.branch";
export const TREE_PRUNE_ACTION_ID = "cmd:tree.prune";
/**
 * Per-screen scroll controls (wave2/tui-input-model). Unlike the tree-only
 * controls above, these apply on every screen — `update.ts` targets
 * whichever screen is currently focused, not a fixed one. PageUp/PageDown/
 * Home/End were unclaimed by any existing binding (every prior key here is a
 * single character; these are multi-key-name tokens from a terminal escape
 * sequence — see `input-terminal.ts`'s `decodeTerminalInput`, which is what
 * must turn the raw bytes into a `NormalizedKeyEvent{key:"pageup"}` etc. for
 * this binding to ever match).
 */
export const PAGE_UP_ACTION_ID = "cmd:scroll.page_up";
export const PAGE_DOWN_ACTION_ID = "cmd:scroll.page_down";
export const SCROLL_HOME_ACTION_ID = "cmd:scroll.home";
export const SCROLL_END_ACTION_ID = "cmd:scroll.end";
/**
 * Command-surface expansion: job.cancel/retry, operation.cancel, task.retry,
 * job.pause/resume, approval.expire. `j`/`k` (TREE_SELECT_NEXT/PREV above)
 * are reused rather than duplicated — `tui.ts`'s keyboardAction dispatches
 * select_tree_node on the Tree screen and the generalized
 * select_row_relative everywhere else, the same "one key, screen-scoped
 * effect" idiom approve/reject already use.
 */
export const CANCEL_ROW_ACTION_ID = "cmd:row.cancel";
export const RETRY_ROW_ACTION_ID = "cmd:row.retry";
export const TOGGLE_JOB_QUEUE_ACTION_ID = "cmd:jobs.toggle_queue";
export const APPROVAL_EXPIRE_ACTION_ID = "cmd:approval.expire";
export const RECOVERY_ABANDON_ACTION_ID = "cmd:recovery.abandon";
export const VIEW_ROW_DETAIL_ACTION_ID = "cmd:row.view_detail";
export const TOGGLE_RESULT_REVIEW_MODE_ACTION_ID = "cmd:result.review.toggle_mode";
/**
 * Diff Review hunk/file navigation (T2.3a). Every single lowercase letter is
 * already bound (see the alphabet scan this action set was chosen against),
 * so these use free `shift+<letter>` combos: `shift+j`/`shift+k` mirror the
 * existing `j`/`k` row-navigation idiom one level down (hunk instead of
 * row); `shift+n`/`shift+p` are free (lowercase `n`/`p` are REJECT_ACTION_ID
 * and TOGGLE_JOB_QUEUE_ACTION_ID). `]`/`[`/`{` are taken (Compaction/
 * Siblings/Project Registry navigation).
 */
export const RESULT_REVIEW_NEXT_HUNK_ACTION_ID = "cmd:result.review.next_hunk";
export const RESULT_REVIEW_PREV_HUNK_ACTION_ID = "cmd:result.review.prev_hunk";
export const RESULT_REVIEW_NEXT_FILE_ACTION_ID = "cmd:result.review.next_file";
export const RESULT_REVIEW_PREV_FILE_ACTION_ID = "cmd:result.review.prev_file";
export const VIEW_HARNESS_SESSION_EVENTS_ACTION_ID = "cmd:harness.session.events";
export const ATTACH_HARNESS_SESSION_ACTION_ID = "cmd:harness.session.attach";
export const STEER_HARNESS_SESSION_ACTION_ID = "cmd:harness.session.steer";
export const RESUME_HARNESS_SESSION_ACTION_ID = "cmd:harness.session.resume";
export const FORK_HARNESS_SESSION_ACTION_ID = "cmd:harness.session.fork";
export const RESPAWN_HARNESS_SESSION_ACTION_ID = "cmd:harness.session.respawn";
export const COPY_FOCUSED_ROW_ACTION_ID = "cmd:clipboard.copy_focused_row";
/** Operator-authored commands use the typed form overlay, never implicit values. */
export const CAMPAIGN_HALT_ACTION_ID = "cmd:campaign.halt";
export const JOB_SUBMIT_ACTION_ID = "cmd:job.submit";
export const APPROVAL_REQUEST_ACTION_ID = "cmd:approval.request";
export const USERINPUT_ASK_ACTION_ID = "cmd:userinput.ask";
export const COMMUNICATION_RECORD_ACTION_ID = "cmd:communication.record";
export const OUTPUT_CAPTURE_ACTION_ID = "cmd:output.capture";
export const OUTPUT_RAW_ACTION_ID = "cmd:output.raw";
export const CONTEXT_ARTIFACT_CAPTURE_ACTION_ID = "cmd:context.artifact.capture";
export const THREAD_SEND_ACTION_ID = "cmd:bus.thread.send";
export const THREAD_ACK_ACTION_ID = "cmd:bus.thread.ack";
/**
 * A2A subsystem operator surface (gated same day as this wiring — see the
 * hazard-coverage fix in the evidence store). `bus.record` is the same
 * broadcast-conversation idiom `communication.record` already uses, scoped
 * to a conversation_id; `compaction.record` and the A2A commands mirror the
 * same "enter and submit a typed form" idiom every other operator command
 * above uses, never a second authority.
 */
export const BUS_RECORD_ACTION_ID = "cmd:bus.record";
export const PEER_GRANT_ACTION_ID = "cmd:peer.grant";
export const COMPACTION_RECORD_ACTION_ID = "cmd:compaction.record";
export const A2A_SEND_ACTION_ID = "cmd:a2a.send";
export const A2A_RECEIVE_ACTION_ID = "cmd:a2a.receive";
export const FOLD_ROLLBACK_ACTION_ID = "cmd:fold.rollback";
export const FOLD_PROPOSE_ACTION_ID = "cmd:fold.propose";
export const FOLD_APPROVE_ACTION_ID = "cmd:fold.approve";
export const PLAYBOOK_PROPOSE_ACTION_ID = "cmd:playbook.propose";
export const PLAYBOOK_APPROVE_ACTION_ID = "cmd:playbook.approve";
export const HARNESS_PROPOSE_ACTION_ID = "cmd:harness.propose";
export const HARNESS_APPROVE_ACTION_ID = "cmd:harness.approve";
export const HARNESS_ROLLBACK_ACTION_ID = "cmd:harness.rollback";
export const HARNESS_EVALUATE_ACTION_ID = "cmd:harness.evaluate";
export const SUBAGENT_EXECUTE_ACTION_ID = "cmd:subagent.execute";
export const HARNESS_EVALUATION_START_ACTION_ID = "cmd:harness.evaluation.start";
export const HARNESS_PROMOTE_ACTION_ID = "cmd:harness.promote";
export const HARNESS_QUARANTINE_ACTION_ID = "cmd:harness.quarantine";
/**
 * Project Registry screen (ADR-076 / Roadmap 23 W6). "Re-check selected
 * entry" reuses VIEW_ROW_DETAIL_ACTION_ID (Enter) — see update.ts's
 * `view_selected_row_detail` case — since re-running discharge for the
 * selected entry and showing its current state IS the same action.
 * `PROJECT_MANAGE_ACTION_ID` is the one new control: it triggers the
 * per-project reconcile/gate-battery pass (`project.manage`) directly via
 * `issueQuery` (tui.ts's `executeAction`) — the same "issue a real catalog
 * query on an operator trigger" idiom `refreshScreenData` already uses for
 * every screen's focus-triggered fetch, just fired on demand instead.
 */
export const PROJECT_MANAGE_ACTION_ID = "cmd:project.manage";
export const TRUST_ENROLL_ACTION_ID = "cmd:trust.enroll";
export const TRUST_ROTATE_ACTION_ID = "cmd:trust.rotate";
export const TRUST_REVOKE_ACTION_ID = "cmd:trust.revoke";
/** Governed plain-language task intake; all commands still traverse RuntimePort. */
export const TASK_COMPOSER_NEW_ACTION_ID = "cmd:taskcomposer.new";
export const TASK_COMPOSER_FOLLOWUP_ACTION_ID = "cmd:taskcomposer.followup";
export const TASK_COMPOSER_ANSWER_ACTION_ID = "cmd:taskcomposer.answer";
export const TASK_COMPOSER_CONFIRM_ACTION_ID = "cmd:taskcomposer.confirm";
export const TASK_COMPOSER_RETRY_ACTION_ID = "cmd:taskcomposer.retry";
export const TASK_COMPOSER_REJECT_ACTION_ID = "cmd:taskcomposer.reject";
export const TASK_COMPOSER_ROADMAP_ACTION_ID = "cmd:taskcomposer.roadmap";
export const TASK_COMPOSER_MAINTENANCE_ACTION_ID = "cmd:taskcomposer.maintenance";
/**
 * Explicit focus model (ui-spec §3, M2.2). F6/Shift+F6 cycle the focus zone
 * (composer -> transcript -> rail -> graph); Shift+F10 opens a context menu
 * for the selection, reusing the existing contextual help/palette overlay
 * (`toggle_help`) rather than a second menu implementation — ui-spec §3
 * requires every menu item to be an existing catalog action id resolved
 * through this one registry, and the contextual palette view already is
 * exactly that. `input-terminal.ts`'s `decodeTerminalInput` decodes the
 * F6/Shift+F6/Shift+F10 CSI sequences these bindings need.
 */
export const FOCUS_ZONE_NEXT_ACTION_ID = "cmd:focus.zone_next";
export const FOCUS_ZONE_PREV_ACTION_ID = "cmd:focus.zone_prev";
export const CONTEXT_MENU_ACTION_ID = "cmd:ui.context_menu";
/**
 * ui-spec §4's "Project/docs/devtools content stays reachable through the
 * palette" residual: the M2 rail's default tabs are Git/Governance/Inspect,
 * so the pre-M2 Project and Docs rail content (the DevTools tab's own
 * content is also a full palette screen, `screen: "devtools"`) needs an
 * explicit route that is not simply "open the rail" any more. Nothing about
 * these is deleted; they are one palette entry away instead of one Tab-press
 * away.
 */
export const RAIL_TAB_PROJECT_ACTION_ID = "cmd:rail.tab_project";
export const RAIL_TAB_DOCS_ACTION_ID = "cmd:rail.tab_docs";

interface OperatorActionEntry {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  /** Omitted when a control is intentionally palette-only. */
  readonly key?: string;
  /** Additional single-key aliases bound to the same action (e.g. cursor keys beside j/k). */
  readonly aliases?: readonly string[];
}

const OPERATOR_ACTIONS: readonly OperatorActionEntry[] = [
  { id: STOP_AND_EXIT_ACTION_ID, title: "Stop active work and exit", description: "Interrupt the active expanding node, if any, then exit the TUI. This is not a detach.", key: "ctrl+c" },
  { id: INTERRUPT_ACTION_ID, title: "Interrupt", description: "Interrupt the active campaign's expanding node", key: "!" },
  { id: ANSWER_ACTION_ID, title: "Answer Interview", description: "Answer the most recent interview question (Interviews screen)", key: "a" },
  { id: APPROVE_ACTION_ID, title: "Approve once (this request only)", description: "Approve only the selected pending request", key: "y" },
  { id: APPROVE_SESSION_ACTION_ID, title: "Approve for session (until restart)", description: "Remember this canonical action in memory until revoy2 restarts", key: "shift+y" },
  { id: APPROVE_PERSISTENT_ACTION_ID, title: "Approve persistently (survives restart)", description: "Persist memory only when the selected action has a canonical fingerprint", key: "alt+y" },
  { id: REJECT_ACTION_ID, title: "Reject Request", description: "Reject the oldest pending request (Approvals screen)", key: "n" },
  // `down`/`up` aliases: the cursor keys decoded by input-terminal.ts's
  // CSI table. Before they were decoded at all, an arrow keypress reached the
  // router as ESC + "[" + letter and opened the Compaction screen (WA-25).
  { id: TREE_SELECT_NEXT_ACTION_ID, title: "Select Next Node", description: "Select the next row (Tree node, Jobs/Operations/Tasks, or Recovery row)", key: "j", aliases: ["down"] },
  { id: TREE_SELECT_PREV_ACTION_ID, title: "Select Previous Node", description: "Select the previous row (Tree node, Jobs/Operations/Tasks, or Recovery row)", key: "k", aliases: ["up"] },
  { id: TREE_FOLLOW_ACTION_ID, title: "Toggle Tree Follow", description: "Follow the newest active node in authoritative Tree snapshots", key: "shift+f" },
  { id: TREE_FILTER_ACTION_ID, title: "Filter Tree", description: "Filter Tree rows by node id, description, or state", key: "\"" },
  { id: TREE_BRANCH_ACTION_ID, title: "Branch Node", description: "Propose an operator expansion of the selected node (Tree screen)", key: "b" },
  { id: TREE_PRUNE_ACTION_ID, title: "Prune Node", description: "Prune the selected node — destructive, asks for confirmation (Tree screen)", key: "x" },
  { id: CANCEL_ROW_ACTION_ID, title: "Cancel / Interrupt Row", description: "Cancel the selected job/operation or interrupt the selected Harness Session (press twice)", key: "c" },
  { id: RETRY_ROW_ACTION_ID, title: "Retry Row", description: "Retry the selected row (Jobs/Tasks/Recovery screen)", key: "r" },
  { id: RECOVERY_ABANDON_ACTION_ID, title: "Abandon Recovery", description: "Abandon the selected recovery target — destructive, asks for confirmation (Recovery screen)", key: "z" },
  { id: VIEW_ROW_DETAIL_ACTION_ID, title: "View Row Detail", description: "Open the selected operation/output detail or selected node communication history", key: "enter" },
  { id: TOGGLE_RESULT_REVIEW_MODE_ACTION_ID, title: "Toggle Result Diff Mode", description: "Toggle unified and side-by-side diff rendering on the Diff Review screen", key: "ctrl+shift+u" },
  { id: RESULT_REVIEW_NEXT_HUNK_ACTION_ID, title: "Next Diff Hunk", description: "Move to the next hunk in the current file (Diff Review screen)", key: "shift+j" },
  { id: RESULT_REVIEW_PREV_HUNK_ACTION_ID, title: "Previous Diff Hunk", description: "Move to the previous hunk in the current file (Diff Review screen)", key: "shift+k" },
  { id: RESULT_REVIEW_NEXT_FILE_ACTION_ID, title: "Next Diff File", description: "Move to the next changed file (Diff Review screen)", key: "shift+n" },
  { id: RESULT_REVIEW_PREV_FILE_ACTION_ID, title: "Previous Diff File", description: "Move to the previous changed file (Diff Review screen)", key: "shift+p" },
  { id: VIEW_HARNESS_SESSION_EVENTS_ACTION_ID, title: "View Harness Session Events", description: "Open the selected Harness Session's redacted event stream", key: "ctrl+e" },
  // Raw terminal input can represent Ctrl letters but not a portable
  // Ctrl+Shift distinction. Keep these governed actions palette-only instead
  // of advertising shortcuts that the decoder cannot deliver.
  { id: ATTACH_HARNESS_SESSION_ACTION_ID, title: "Attach Harness Session Tail", description: "Open from the Help palette to read the selected session's bounded redacted tail and liveness" },
  { id: STEER_HARNESS_SESSION_ACTION_ID, title: "Steer Attached Harness Session", description: "Open from the Help palette to send a focused message only after the selected session is attached and live" },
  { id: RESUME_HARNESS_SESSION_ACTION_ID, title: "Resume Harness Session", description: "Open from the Help palette to resume only when the selected session explicitly advertises canonical recovery availability; requires typed RESUME confirmation" },
  { id: FORK_HARNESS_SESSION_ACTION_ID, title: "Fork Harness Session", description: "Open from the Help palette to fork only when the selected session explicitly advertises canonical recovery availability; requires typed FORK confirmation" },
  { id: RESPAWN_HARNESS_SESSION_ACTION_ID, title: "Respawn Harness Session", description: "Open from the Help palette to respawn only when the selected session explicitly advertises canonical recovery availability; requires typed RESPAWN confirmation" },
  { id: COPY_FOCUSED_ROW_ACTION_ID, title: "Copy Focused Row", description: "Copy the selected redacted row through OSC 52 when this terminal is clipboard-safe", key: "ctrl+shift+c" },
  { id: TOGGLE_JOB_QUEUE_ACTION_ID, title: "Toggle Job Queue", description: "Pause or resume new job dispatch (Jobs screen)", key: "p" },
  { id: APPROVAL_EXPIRE_ACTION_ID, title: "Expire Request", description: "Expire the oldest pending request (Approvals screen)", key: "e" },
  { id: PAGE_UP_ACTION_ID, title: "Page Up", description: "Scroll the active screen up one page", key: "pageup" },
  { id: PAGE_DOWN_ACTION_ID, title: "Page Down", description: "Scroll the active screen down one page", key: "pagedown" },
  { id: SCROLL_HOME_ACTION_ID, title: "Scroll to Top", description: "Jump to the top of the active screen", key: "home" },
  { id: SCROLL_END_ACTION_ID, title: "Scroll to Bottom", description: "Jump to the bottom of the active screen", key: "end" },
  { id: CAMPAIGN_HALT_ACTION_ID, title: "Halt Campaign", description: "Enter an independently authorized campaign halt (confirmation required)", key: "h" },
  { id: JOB_SUBMIT_ACTION_ID, title: "Submit Job", description: "Enter and submit a job through the canonical scheduler", key: "s" },
  { id: APPROVAL_REQUEST_ACTION_ID, title: "Request Approval", description: "Enter and request a governed approval", key: "q" },
  { id: USERINPUT_ASK_ACTION_ID, title: "Ask for Input", description: "Enter a user-input question and options", key: "u" },
  { id: COMMUNICATION_RECORD_ACTION_ID, title: "Record Communication", description: "Enter and record a node communication", key: "f" },
  { id: OUTPUT_CAPTURE_ACTION_ID, title: "Capture Output", description: "Enter and capture output evidence", key: "o" },
  { id: OUTPUT_RAW_ACTION_ID, title: "Review Raw Output", description: "Review selected output only with a matching approved disclosure", key: "~" },
  { id: CONTEXT_ARTIFACT_CAPTURE_ACTION_ID, title: "Capture Governed Context", description: "Capture bounded provenance-tagged context through the canonical governed-context ledger" },
  { id: THREAD_SEND_ACTION_ID, title: "Send Parent/Child Message", description: "Send/reply on the selected direct parent/child thread with its current CAS version", key: "@" },
  { id: THREAD_ACK_ACTION_ID, title: "Acknowledge Thread Message", description: "Acknowledge the selected ack-required direct-thread message as its recipient", key: "ctrl+;" },
  { id: BUS_RECORD_ACTION_ID, title: "Record Bus Message", description: "Enter and record a conversation-scoped bus message", key: "-" },
  { id: PEER_GRANT_ACTION_ID, title: "Grant Native Peer Relationship", description: "Submit a bounded peer relationship grant; the composed host must authenticate the selected campaign parent" },
  { id: COMPACTION_RECORD_ACTION_ID, title: "Record Compaction Lifecycle", description: "Enter and durably record a compaction lifecycle event (Compaction screen)", key: "/" },
  { id: A2A_SEND_ACTION_ID, title: "Send A2A Message", description: "Enter and send an outbound A2A message (requires a configured A2A bridge)", key: "(" },
  { id: A2A_RECEIVE_ACTION_ID, title: "Receive A2A Message", description: "Enter and durably record an inbound A2A message (requires a configured A2A bridge)", key: ")" },
  { id: FOLD_ROLLBACK_ACTION_ID, title: "Rollback Active Fold", description: "Rollback the selected active governed fold through the canonical ledger", key: "}" },
  { id: FOLD_PROPOSE_ACTION_ID, title: "Propose Governed Fold", description: "Submit a complete fold proposal JSON envelope through the canonical governed-context router" },
  { id: FOLD_APPROVE_ACTION_ID, title: "Approve Governed Fold", description: "Submit a selected fold id and measured fidelity ratio for independent approval" },
  { id: PLAYBOOK_PROPOSE_ACTION_ID, title: "Propose Playbook Delta", description: "Submit a complete campaign-local playbook delta JSON envelope" },
  { id: PLAYBOOK_APPROVE_ACTION_ID, title: "Approve Playbook Delta", description: "Submit a selected playbook delta id for independent approval" },
  { id: HARNESS_PROPOSE_ACTION_ID, title: "Propose Harness Revision", description: "Submit an allowlisted harness revision JSON envelope" },
  { id: HARNESS_APPROVE_ACTION_ID, title: "Approve Harness Revision", description: "Submit a selected harness revision id for independent activation" },
  { id: HARNESS_ROLLBACK_ACTION_ID, title: "Rollback Harness Revision", description: "Rollback a selected active harness revision through the canonical ledger" },
  { id: HARNESS_EVALUATE_ACTION_ID, title: "Record Harness Evaluation", description: "Submit measured harness evaluation evidence for a selected revision" },
  { id: SUBAGENT_EXECUTE_ACTION_ID, title: "Run Declarative Subagent", description: "Run the selected active descriptor as one isolated read-only native child", key: "ctrl+g" },
  { id: HARNESS_EVALUATION_START_ACTION_ID, title: "Evaluate Harness Revision", description: "Start the selected revision's controlled evaluation (provider only when configured)", key: "ctrl+v" },
  { id: HARNESS_PROMOTE_ACTION_ID, title: "Promote Harness Revision", description: "Record a named human promotion only after measured controlled-evaluation evidence", key: "ctrl+shift+p" },
  { id: HARNESS_QUARANTINE_ACTION_ID, title: "Quarantine Harness Revision", description: "Record an independent quarantine decision with measured evaluation evidence", key: "ctrl+q" },
  { id: PROJECT_MANAGE_ACTION_ID, title: "Reconcile Projects", description: "Run the multi-project reconcile/gate-battery pass over every registered project (Project Registry screen)", key: "ctrl+shift+n" },
  { id: TRUST_ENROLL_ACTION_ID, title: "Enroll Remote Trust", description: "Enroll a host-issued remote certificate/key binding through the signed local operator session", key: "ctrl+shift+e" },
  { id: TRUST_ROTATE_ACTION_ID, title: "Rotate Remote Trust Key", description: "Rotate the selected remote session to a host-issued replacement key/certificate binding", key: "ctrl+shift+k" },
  { id: TRUST_REVOKE_ACTION_ID, title: "Revoke Remote Trust", description: "Revoke the selected remote trust session through the signed local operator session", key: "ctrl+shift+r" },
  { id: TASK_COMPOSER_NEW_ACTION_ID, title: "New Task", description: "Describe an outcome; Revoy plans, checks, and starts safe work automatically unless clarification is needed", key: "ctrl+n" },
  { id: TASK_COMPOSER_FOLLOWUP_ACTION_ID, title: "New Follow-up", description: "Create a linked follow-up draft from the selected admitted campaign", key: "ctrl+shift+f" },
  { id: TASK_COMPOSER_ANSWER_ACTION_ID, title: "Answer Task Clarification", description: "Answer the selected task draft's pending clarification with its current revision", key: "ctrl+a" },
  { id: TASK_COMPOSER_CONFIRM_ACTION_ID, title: "Confirm Task Proposal", description: "Confirm the selected task proposal through the canonical governed runtime", key: "ctrl+y" },
  { id: TASK_COMPOSER_RETRY_ACTION_ID, title: "Retry Task Draft", description: "Retry the selected failed or cancelled planning draft with the same identity and lineage", key: "ctrl+shift+y" },
  { id: TASK_COMPOSER_REJECT_ACTION_ID, title: "Reject Task Proposal", description: "Reject the selected task proposal with a durable reason", key: "ctrl+u" },
  { id: TASK_COMPOSER_ROADMAP_ACTION_ID, title: "Dispatch Next Roadmap", description: "Review a native task proposal for the next governance-backed roadmap item", key: "ctrl+l" },
  { id: TASK_COMPOSER_MAINTENANCE_ACTION_ID, title: "Maintenance Pass", description: "Review a native task proposal for a comprehensive maintenance pass", key: "ctrl+w" },
  { id: FOCUS_ZONE_NEXT_ACTION_ID, title: "Focus Next Zone", description: "Cycle focus forward: composer, transcript, rail, graph", key: "f6" },
  { id: FOCUS_ZONE_PREV_ACTION_ID, title: "Focus Previous Zone", description: "Cycle focus backward: composer, transcript, rail, graph", key: "shift+f6" },
  { id: CONTEXT_MENU_ACTION_ID, title: "Context Menu", description: "Open the contextual command menu for the current selection", key: "shift+f10" },
  { id: RAIL_TAB_PROJECT_ACTION_ID, title: "Rail: Project Repo", description: "Open the rail's pre-M2 Project Repo tab (project registry, live checkout)" },
  { id: RAIL_TAB_DOCS_ACTION_ID, title: "Rail: Documents", description: "Open the rail's pre-M2 Documents tab (root and docs/ index)" },
];

/** Build the default, always-available catalog: screen navigation, operator commands, and help. */
export function buildDefaultCatalog(): InputCatalog {
  const navActions: UiAction[] = SCREEN_NAV.map((entry) => {
    const description = SCREEN_WORKFLOW_HINTS[entry.screen] ?? `Focus the ${entry.title.toLowerCase()} screen`;
    return {
      id: `${FOCUS_PREFIX}${entry.screen}`,
      title: entry.title,
      description,
      source: "builtin",
      bindings: [{ scope: "global", keys: typeof entry.key === "string" ? [entry.key] : entry.key, description }],
    };
  });
  const operatorActions: UiAction[] = OPERATOR_ACTIONS.map((entry) => ({
    id: entry.id,
    title: entry.title,
    description: entry.description,
    source: "command",
    bindings: [
      ...(entry.key === undefined ? [] : [{ scope: "global" as const, keys: [entry.key], description: entry.description }]),
      ...(entry.aliases ?? []).map((alias) => ({ scope: "global" as const, keys: [alias], description: entry.description })),
    ],
  }));
  // Command-palette theme switching: no keybinding (see themeActionId's
  // doc), reachable only by palette search — the same no-binding idiom
  // pilot-workflows.ts's workflowPaletteActions already uses.
  const themeActions: UiAction[] = TUI_THEME_NAMES.map((name) => ({
    id: themeActionId(name),
    title: `Theme: ${THEME_TITLES[name]}`,
    description: `Switch the cockpit palette to ${THEME_TITLES[name]}`,
    source: "command",
    bindings: [],
  }));
  const productActions: UiAction[] = [
    ["cmd:migration.apply", "Apply reviewed migration", "Apply a migration with its preview path and SHA-256"],
    ["cmd:migration.rollback", "Rollback migration receipt", "Rollback a named durable migration receipt"],
    ["cmd:integration.install", "Install integration", "Install an admitted integration with explicit risk acknowledgement"],
    ["cmd:integration.enable", "Enable integration", "Enable an integration with explicit risk acknowledgement"],
    ["cmd:integration.disable", "Disable integration", "Disable an integration with explicit risk acknowledgement"],
    ["cmd:integration.update", "Update integration", "Update an integration to an exact SemVer version"],
    ["cmd:session.identity.mutate", "Name or tag session", "Set a durable session display name and tags"],
    ["cmd:notification.read", "Mark notification read", "Mark a durable notification read by id"],
    ["cmd:followup.create", "Create follow-up lineage", "Create typed campaign follow-up lineage from a result or node"],
    ["cmd:result.review.comment", "Comment on selected result line", "Add a CAS-bound inline comment to the selected captured file"],
    ["cmd:result.review.request_revision", "Request result revision", "Record a durable revision request for the selected capture"],
    ["cmd:result.review.editor_handoff", "Open selected result in editor", "Create a patch-bound editor handoff with a resume token"],
    ["cmd:product.refresh", "Refresh product operations", "Refresh doctor, migration, integrations, remote, scheduler, and durable product records"],
    ["cmd:control.status", "Flight control status", "Show coordinator, registration, bridge, and durable queue health"],
    ["cmd:control.discover", "Discover control hosts", "Show the bounded set of live coordinator hosts"],
    ["cmd:control.inbox", "Inspect control inbox", "Show redacted durable message metadata without payload bodies"],
    ["cmd:harness.sessions.previous", "Previous harness session page", "Load the prior stable page of durable harness sessions"],
    ["cmd:harness.sessions.next", "Next harness session page", "Load the next stable page of durable harness sessions when available"],
  ].map(([id, title, description]) => ({ id, title, description, source: "command" as const, bindings: [] }));
  const helpAction: UiAction = {
    id: HELP_ACTION_ID,
    title: "Help",
    description: "Show the key-binding palette",
    source: "builtin",
    bindings: [
      { scope: "global", keys: ["?"], description: "Show the key-binding palette" },
      { scope: "global", keys: ["ctrl+p"], description: "Show the command palette" },
    ],
  };
  // Keep the palette's own affordance visible in a height-bounded help
  // render even as the command surface grows. `renderPaletteRows` preserves catalog
  // order and intentionally clips to the terminal height, so putting Help
  // last made the one way to discover/filter the overflow disappear.
  return { actions: [helpAction, ...navActions, ...operatorActions, ...themeActions, ...productActions] };
}

/** Recover the screen a default navigation action focuses, or null for non-navigation actions. */
export function screenForAction(actionId: string): ScreenId | null {
  if (!actionId.startsWith(FOCUS_PREFIX)) return null;
  const screen = actionId.slice(FOCUS_PREFIX.length);
  return SCREEN_NAV.some((entry) => entry.screen === screen) ? (screen as ScreenId) : null;
}

export interface KeymapOverride {
  /** Matched case-insensitively against an action's title (the keymap grammar's binding description). */
  readonly description: string;
  /** Already-normalized per-keystroke tokens, e.g. ["ctrl+x", "ctrl+s"]. */
  readonly keys: readonly string[];
}

export interface KeymapOverrideResult {
  readonly catalog: InputCatalog;
  /** Override descriptions that matched no action title — reported, never silently dropped or fatal. */
  readonly unmatched: readonly string[];
}

/**
 * Layer parsed keymap-as-config overrides onto a base catalog. An override
 * whose description matches an action's title (case-insensitively) replaces
 * that action's global binding with the configured keys. Unmatched overrides
 * do not throw — a stale or misspelled keymap line is a reportable diagnostic,
 * not a fatal startup error.
 */
export function applyKeymapOverrides(catalog: InputCatalog, overrides: readonly KeymapOverride[]): KeymapOverrideResult {
  const byTitle = new Map(catalog.actions.map((action) => [action.title.toLocaleLowerCase(), action] as const));
  const replacements = new Map<string, KeyBinding>();
  const unmatched: string[] = [];
  for (const override of overrides) {
    const key = override.description.trim().toLocaleLowerCase();
    const action = byTitle.get(key);
    if (!action) { unmatched.push(override.description); continue; }
    replacements.set(action.id, { scope: "global", keys: [...override.keys], description: override.description });
  }
  const actions = catalog.actions.map((action) => {
    const replacement = replacements.get(action.id);
    return replacement ? { ...action, bindings: [replacement] } : action;
  });
  return { catalog: { actions }, unmatched };
}
