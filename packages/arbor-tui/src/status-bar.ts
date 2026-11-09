/**
 * Designed status-bar zone (ROADMAP 4F.4, execution-status follow-up).
 *
 * Replaces the scraped `connected────────` overlay that `renderTerminalFrame`
 * used to write: `${connection.status}` was stamped over part of a pane's
 * bottom-border row without clearing the rest of the row first, so leftover
 * `─` border fill bled through to the right of the text. This module renders
 * a real, full-width status-bar row instead: active campaign · activity
 * indicator · active node/attempt/phase/verified-progress · event counter ·
 * model · fidelity.
 *
 * Pure and deterministic: every zone is a function of `(AppModel,
 * frame_count)` — never `Date.now()`/random, matching the player-piano
 * contract (player-piano.ts). The same model state and frame clock always
 * produce the same row string, which is what lets `StdoutRenderer`'s row diff
 * (4F.3) skip repainting the row when nothing changed, and repaint only that
 * row when e.g. the spinner glyph advances.
 *
 * Applies the ADR-020 palette/legibility contract (theme.ts): colors come
 * from `footerTheme(deriveTheme(...))` — the RunFooterTheme ADR-020 names as
 * "the primary operator affordance" — converted to 24-bit SGR. No raw
 * hardcoded color bypasses the palette projection.
 *
 * Execution-status zones (active/attempt/phase/verified) are derived from
 * whichever fetched screen composite actually carries a campaign-fresh
 * `campaign.tree`-shaped result (ADR-123): `AppModel.screens.get("tree")` —
 * the dedicated Tree screen's own projection (screens/tree.ts) — first, and
 * when that is absent or stale, the currently active screen's own nested
 * `tree` field (today, only `console.ts` fetches one). Never fabricated.
 * `campaign.tree`'s real nodes (`CampaignManager
 * .getCampaignSnapshot`, arbor-mcp/src/manager.ts) carry a `state` field
 * (`"expanding"` is the same canonical "in progress" marker
 * `CampaignManager.getActiveExpandingNode` uses), a `visit_count` (the
 * UCB tree-search attempt counter, `arbor-core/src/types.ts`), and an
 * `action_description`. When the last-fetched tree result's own
 * `campaign_id` no longer matches the model's current campaign
 * (`telemetryCampaignId` — the same "current campaign" signal the
 * `campaign` zone itself already relies on), the projection is treated as
 * stale and rendered as unavailable rather than showing a previous
 * campaign's execution state under the new campaign's name.
 *
 * `budget` remains a computed zone (native-budget threshold warnings still
 * read it) but is no longer rendered as a default first-class row item — the
 * separate native-budget screen (screens/native-budget.ts) is the operator's
 * budget surface now. `epoch` is likewise no longer a default row item (it is
 * an internal model-version counter, not operator-facing execution status);
 * unlike `budget` nothing else reads it, so it is dropped from the row
 * without a replacement computed zone.
 */

import { spinnerGlyph, clipAnsi } from "./player-piano.js";
import { deriveTheme, footerTheme, toBackgroundSgr, toForegroundSgr, type ColorMode, type RunFooterTheme, type RunTheme } from "./theme.js";
import type { AppModel } from "./types.js";
import type { UsageCostRow } from "./telemetry-types.js";
import { formatCost } from "./telemetry-widgets.js";
import { campaignFidelityMeter } from "./fidelity-meter.js";
import { nativeBudgetWarning } from "./screens/native-budget.js";
import { clipDisplay, displayWidth } from "./widgets.js";
import { clipLabelWithEllipsis } from "./screens/region.js";
import { backgroundStatusLine, turnBoundaryLine, M7_THEME_TOKENS } from "./interaction-polish.js";

/** Rendered when a zone's underlying datum is not available on the model. */
export const STATUS_BAR_PLACEHOLDER = "—"; // em dash

export interface StatusBarZones {
  readonly campaign: string;
  /** Interrupt-confirmation hint when armed, otherwise the live activity spinner. */
  readonly activity: string;
  /** Observed pending Interviews/Recovery/Clarifications, encoded as I#/R#/C#; em dash when no attention surface has been fetched. */
  readonly attention: string;
  /** The node currently in the `"expanding"` state (canonical "in progress" marker); em dash when none. */
  readonly active: string;
  /** The active node's `visit_count` (UCB tree-search attempt counter); em dash when there is no active node. */
  readonly attempt: string;
  /** The active node's own `state`; em dash when there is no active node. */
  readonly phase: string;
  /** `"<verified count>/<total count>"` across the last-fetched tree; em dash when unavailable. */
  readonly verified: string;
  /** Count of failed, pruned, interrupted, or abandoned nodes. */
  readonly closed: string;
  /** Latest terminal node state and durable outcome reason, when present. */
  readonly last: string;
  readonly events: string;
  /** Computed but not rendered by default (native-budget threshold warnings still read it). */
  readonly budget: string;
  readonly epoch: string;
  readonly model: string;
  readonly fidelity: string;
}

/** One truthful, operator-readable statement for Console's bottom line. */
export interface ConsoleActivityNarrative {
  /** The state the harness can currently substantiate from its canonical projections. */
  readonly text: string;
  /** Whether a frame-driven glyph represents real in-flight work. */
  readonly active: boolean;
}

const ACTIVE_WORK_STATES = new Set(["accepted", "queued", "awaiting_clarification", "proposed", "pending", "blocked", "started", "running", "active", "retrying", "planning", "cancel_requested", "expanding", "awaiting_review"]);

/** Motion is evidence of live work, never a decorative heartbeat. */
function hasActiveOperatorWork(app: AppModel): boolean {
  const consoleValue = app.screens.get("console");
  const console = typeof consoleValue === "object" && consoleValue !== null ? consoleValue as Record<string, unknown> : null;
  if (console !== null) {
    const attach = typeof console.session_attach === "object" && console.session_attach !== null ? console.session_attach as Record<string, unknown> : null;
    if (attach?.live === true) return true;
    for (const [field, keys] of [["drafts", ["items"]], ["tasks", ["items", "tasks"]], ["jobs", ["items", "jobs"]], ["sessions", ["items", "sessions"]]] as const) {
      const projection = typeof console[field] === "object" && console[field] !== null ? console[field] as Record<string, unknown> : null;
      if (projection === null) continue;
      const rows = keys.flatMap((key) => Array.isArray(projection[key]) ? projection[key] as readonly unknown[] : []);
      if (rows.some((row) => typeof row === "object" && row !== null
        && (row as { interrupted?: unknown }).interrupted !== true
        && ACTIVE_WORK_STATES.has(String((row as { state?: unknown; status?: unknown }).state ?? (row as { status?: unknown }).status ?? "")))) return true;
    }
  }
  const execution = deriveExecutionStatus(app);
  return execution.phase === "expanding" || execution.phase === "awaiting_review";
}

function object(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function collection(value: unknown, keys: readonly string[]): readonly Record<string, unknown>[] {
  const source = object(value);
  if (source === null) return [];
  return keys.flatMap((key) => Array.isArray(source[key])
    ? source[key].flatMap((item) => object(item) === null ? [] : [object(item)!])
    : []);
}

function hasUnansweredQuestion(draft: Record<string, unknown>): boolean {
  const proposal = object(draft.proposal);
  if (proposal === null || !Array.isArray(proposal.questions)) return false;
  return proposal.questions.some((question) => {
    const value = object(question);
    return value !== null && value.answer === null && typeof value.question === "string" && value.question.trim().length > 0;
  });
}

/**
 * Console's activity statement is intentionally derived from durable task
 * state and canonical attached-session events.  It is not a synthesized
 * health claim: a spinner is shown only where this projection proves work is
 * in flight, and an answer is requested only where a real unanswered question
 * is present.
 */
export function deriveConsoleActivityNarrative(app: AppModel): ConsoleActivityNarrative {
  if (app.repeatConfirmation !== null && !app.repeatConfirmation.fired) {
    return { text: app.repeatConfirmation.hint, active: false };
  }
  const console = object(app.screens.get("console"));
  if (console === null) return { text: "Idle — describe what you want changed", active: false };

  const drafts = collection(console.drafts, ["items"]);
  const clarification = drafts.find((draft) => draft.status === "awaiting_clarification");
  if (clarification !== undefined) {
    return hasUnansweredQuestion(clarification)
      ? { text: "Waiting for your answer", active: false }
      : { text: "Reconciling clarification state", active: true };
  }
  if (drafts.some((draft) => draft.status === "planning")) {
    return { text: "Planning your request", active: true };
  }

  const attach = object(console.session_attach);
  if (attach !== null) {
    const events = Array.isArray(attach.events) ? attach.events.flatMap((event) => object(event) === null ? [] : [object(event)!]) : [];
    const latest = events.at(-1);
    if (attach.live === true) {
      if (latest?.kind === "model_text") return { text: "Thinking", active: true };
      if (latest?.kind === "tool" || latest?.kind === "tool_call") return { text: "Running a tool", active: true };
      if (latest?.kind === "tool_result") return { text: "Processing tool output", active: true };
      return { text: "Buffering live output", active: true };
    }
    if (object(attach.session)?.terminal !== null && object(attach.session)?.terminal !== undefined) {
      const terminal = object(object(attach.session)?.terminal);
      switch (terminal?.cause) {
        case "failed": return { text: "Session failed — review the error before retrying", active: false };
        case "interrupted": return { text: "Session interrupted — review before resuming", active: false };
        case "wall_clock_limit": return { text: "Session stopped — time limit reached", active: false };
        case "event_limit": return { text: "Session stopped — event limit reached", active: false };
        case "completed": break;
        default: return { text: "Session ended — outcome unavailable", active: false };
      }
      // Same rule as the Console's activity line (EC-064): a halted campaign
      // with nothing verified has no completion to review.
      const campaigns = collection(console.campaigns, ["items", "campaigns"]);
      const haltedUnverified = campaigns.some((campaign) => campaign.halted === true && Number(campaign.verified_nodes ?? 0) === 0);
      return haltedUnverified ? { text: "Halted — nothing verified", active: false } : { text: "Completion ready for review", active: false };
    }
  }

  const jobs = collection(console.jobs, ["jobs", "items"]);
  if (jobs.some((job) => job.state === "queued" || job.state === "accepted")) return { text: "Queued work is waiting to start", active: true };
  const tasks = collection(console.tasks, ["items", "tasks"]);
  // EC-053: a restored task with no process behind it is marked
  // `interrupted` by task.list; it must never read as work in flight.
  const live = tasks.filter((task) => task.interrupted !== true);
  if (live.some((task) => ACTIVE_WORK_STATES.has(String(task.state ?? task.status ?? "")))) return { text: "Working", active: true };
  if (hasActiveOperatorWork(app)) return { text: "Working", active: true };
  const interrupted = tasks.length - live.length;
  if (interrupted > 0) return { text: `Resumed — ${interrupted} task${interrupted === 1 ? "" : "s"} interrupted, see Recovery`, active: false };
  return { text: "Idle — describe what you want changed", active: false };
}

/** The shape `campaign.tree` query results project — mirrors `screens/tree.ts`'s own narrowing, kept local so this module never depends on a screen module. */
interface TreeStatusShape {
  readonly campaign_id?: string;
  readonly halted?: boolean;
  readonly halt_reason?: string | null;
  readonly nodes?: readonly Record<string, unknown>[];
}

function isTreeStatusShape(value: unknown): value is TreeStatusShape {
  return typeof value === "object" && value !== null && "nodes" in value && Array.isArray((value as TreeStatusShape).nodes);
}

const UNAVAILABLE_EXECUTION_STATUS = Object.freeze({
  active: STATUS_BAR_PLACEHOLDER,
  attempt: STATUS_BAR_PLACEHOLDER,
  phase: STATUS_BAR_PLACEHOLDER,
  verified: STATUS_BAR_PLACEHOLDER,
  closed: STATUS_BAR_PLACEHOLDER,
  last: STATUS_BAR_PLACEHOLDER,
});

interface ExecutionStatusZones {
  readonly active: string;
  readonly attempt: string;
  readonly phase: string;
  readonly verified: string;
  readonly closed: string;
  readonly last: string;
}

const TERMINAL_NODE_STATES = new Set(["failed", "pruned", "interrupted", "abandoned"]);

function terminalReason(node: Readonly<Record<string, unknown>>): string {
  const state = typeof node.state === "string" ? node.state : "closed";
  const outcome = node.outcome;
  if (typeof outcome === "object" && outcome !== null) {
    const record = outcome as Record<string, unknown>;
    if (typeof record.message === "string" && record.message.length > 0) return `${state}: ${record.message}`;
    const error = record.error;
    if (typeof error === "object" && error !== null && typeof (error as Record<string, unknown>).message === "string") {
      return `${state}: ${String((error as Record<string, unknown>).message)}`;
    }
  }
  if (typeof node.action_description === "string" && node.action_description.length > 0) return `${state}: ${node.action_description}`;
  return state;
}

function pendingClarifications(value: unknown): number | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  const drafts = Array.isArray(record.drafts) ? record.drafts : record.draft === undefined ? [] : [record.draft];
  return drafts.reduce((total, candidate) => {
    if (typeof candidate !== "object" || candidate === null) return total;
    const proposal = (candidate as Record<string, unknown>).proposal;
    if (typeof proposal !== "object" || proposal === null || !Array.isArray((proposal as Record<string, unknown>).questions)) return total;
    return total + ((proposal as Record<string, unknown>).questions as readonly unknown[]).filter((question) => (
      typeof question === "object" && question !== null && (question as Record<string, unknown>).answer === null
    )).length;
  }, 0);
}

function deriveAttention(app: AppModel): string {
  const parts: string[] = [];
  let observed = false;
  const interviews = app.screens.get("interviews");
  if (typeof interviews === "object" && interviews !== null && Array.isArray((interviews as Record<string, unknown>).records)) {
    observed = true;
    const projection = interviews as Record<string, unknown>;
    const answered = new Set(Array.isArray(projection.answered_record_ids)
      ? projection.answered_record_ids.filter((id): id is string => typeof id === "string")
      : []);
    const count = (projection.records as readonly unknown[]).filter((candidate) => (
      typeof candidate === "object"
      && candidate !== null
      && typeof (candidate as Record<string, unknown>).id === "string"
      && !answered.has((candidate as Record<string, unknown>).id as string)
    )).length;
    if (count > 0) parts.push(`I${count}`);
  }
  const recovery = app.screens.get("recovery");
  if (typeof recovery === "object" && recovery !== null && Array.isArray((recovery as Record<string, unknown>).nodes)) {
    observed = true;
    const count = ((recovery as Record<string, unknown>).nodes as readonly unknown[]).length;
    if (count > 0) parts.push(`R${count}`);
  }
  const clarifications = pendingClarifications(app.screens.get("task-composer"));
  if (clarifications !== null) {
    observed = true;
    if (clarifications > 0) parts.push(`C${clarifications}`);
  }
  return parts.length > 0 ? parts.join("/") : observed ? "0" : STATUS_BAR_PLACEHOLDER;
}

function activeNodeLabel(node: Readonly<Record<string, unknown>>): string {
  if (typeof node.action_description === "string" && node.action_description.length > 0) return node.action_description;
  return typeof node.id === "string" && node.id.length > 0 ? node.id : STATUS_BAR_PLACEHOLDER;
}

function isCampaignFresh(app: AppModel, raw: TreeStatusShape): boolean {
  return app.telemetryCampaignId === null || typeof raw.campaign_id !== "string" || raw.campaign_id === app.telemetryCampaignId;
}

/**
 * Locates a campaign-fresh `campaign.tree`-shaped result reachable from the
 * model: the dedicated Tree screen's own top-level key first (unchanged
 * precedence), and only when that is absent or stale, the currently active
 * screen's own composite result's nested `tree` field (ADR-123) — the
 * pattern `console.ts` establishes today for its own tree-search pane. The
 * check is structural (`isTreeStatusShape` on the nested field), not a name
 * check for `"console"`, so any future screen that fetches `campaign.tree`
 * under its own composite key is picked up without a further change here.
 */
function findExecutionStatusSource(app: AppModel): TreeStatusShape | null {
  const topLevel = app.screens.get("tree");
  if (isTreeStatusShape(topLevel) && isCampaignFresh(app, topLevel)) return topLevel;
  const active = app.screens.get(app.screen);
  if (typeof active === "object" && active !== null && "tree" in active) {
    const nested = (active as { tree?: unknown }).tree;
    if (isTreeStatusShape(nested) && isCampaignFresh(app, nested)) return nested;
  }
  return null;
}

function deriveExecutionStatus(app: AppModel): ExecutionStatusZones {
  const raw = findExecutionStatusSource(app);
  if (raw === null) return UNAVAILABLE_EXECUTION_STATUS;
  const nodes = raw.nodes ?? [];
  const verifiedCount = nodes.filter((n) => n.state === "verified").length;
  const terminalNodes = nodes.filter((n) => typeof n.state === "string" && TERMINAL_NODE_STATES.has(n.state));
  const latestTerminal = terminalNodes.at(-1);
  if (raw.halted === true) {
    return {
      active: typeof raw.halt_reason === "string" && raw.halt_reason.length > 0 ? `halted (${raw.halt_reason})` : "halted",
      attempt: STATUS_BAR_PLACEHOLDER,
      phase: "halted",
      verified: `${verifiedCount}/${nodes.length}`,
      closed: String(terminalNodes.length),
      last: latestTerminal === undefined ? STATUS_BAR_PLACEHOLDER : terminalReason(latestTerminal),
    };
  }
  const activeNode = nodes.find((n) => n.state === "expanding");
  return {
    active: activeNode !== undefined ? activeNodeLabel(activeNode) : STATUS_BAR_PLACEHOLDER,
    attempt: activeNode !== undefined && typeof activeNode.visit_count === "number" ? String(activeNode.visit_count) : STATUS_BAR_PLACEHOLDER,
    phase: activeNode !== undefined && typeof activeNode.state === "string" ? activeNode.state : STATUS_BAR_PLACEHOLDER,
    verified: `${verifiedCount}/${nodes.length}`,
    closed: String(terminalNodes.length),
    last: latestTerminal === undefined ? STATUS_BAR_PLACEHOLDER : terminalReason(latestTerminal),
  };
}

/**
 * Derive the status-bar zones from the model. Pure: the same `(app,
 * frame_count)` always yields the same zones.
 *
 * - campaign: `telemetryCampaignId` (set when an operator is viewing a
 *   campaign), falling back to the last-fetched telemetry snapshot's own
 *   `campaign_id`; em dash when neither is available.
 * - activity: an armed, unfired interrupt-confirmation hint takes priority;
 *   otherwise motion appears only when canonical work is active. Idle state
 *   is labelled `idle`; a rotating glyph is never used as decorative chrome.
 * - active/attempt/phase/verified: see `deriveExecutionStatus` above.
 * - events: `telemetrySnapshot.source_record_count` (the ledger-derived
 *   record count backing the projection, ADR-017); em dash when telemetry
 *   has not been fetched.
 * - budget: the sum of the *priced* rows in `telemetrySnapshot.usage_cost`
 *   formatted via the existing `formatCost` helper; em dash when telemetry,
 *   usage-cost rows, or any priced row are unavailable (an all-unpriced
 *   snapshot is a genuine absence of budget data, never a fabricated "$0").
 *   Computed for the native-budget threshold warning, not rendered by default.
 * - epoch: `AppModel.epoch`, the model's own monotonic version counter
 *   (4F.2). Always available (defaults to 0), so never a placeholder.
 * - model: the usage-cost rows' `model_family` tag(s); em dash when
 *   unavailable.
 */
export function deriveStatusBarZones(app: AppModel, frame_count: number): StatusBarZones {
  const telemetry = app.telemetrySnapshot;
  const budgetWarning = (() => { const raw = app.screens.get("native-budget"); return typeof raw === "object" && raw !== null ? nativeBudgetWarning(raw as Record<string, unknown>) : null; })();
  const execution = deriveExecutionStatus(app);
  return {
    campaign: app.telemetryCampaignId ?? telemetry?.campaign_id ?? STATUS_BAR_PLACEHOLDER,
    activity: app.repeatConfirmation !== null && !app.repeatConfirmation.fired
      ? app.repeatConfirmation.hint
      : hasActiveOperatorWork(app) ? spinnerGlyph(frame_count) : "idle",
    attention: deriveAttention(app),
    active: execution.active,
    attempt: execution.attempt,
    phase: execution.phase,
    verified: execution.verified,
    closed: execution.closed,
    last: execution.last,
    events: telemetry !== null ? String(telemetry.source_record_count) : STATUS_BAR_PLACEHOLDER,
    budget: budgetWarning?.message ?? (telemetry !== null ? formatBudget(telemetry.usage_cost) : STATUS_BAR_PLACEHOLDER),
    epoch: String(app.epoch),
    model: telemetry !== null ? formatModel(telemetry.usage_cost) : STATUS_BAR_PLACEHOLDER,
    fidelity: campaignFidelityMeter(app).bar,
  };
}

/**
 * Sums only priced rows — an unpriced row (G-09: no price schedule reached
 * this call) has no amount to add, and must never be counted as a real zero.
 * When every row is unpriced, the budget is genuinely unavailable, not "$0".
 */
function formatBudget(rows: readonly UsageCostRow[]): string {
  const priced = rows.filter((row): row is Extract<UsageCostRow, { tags: { pricing: "priced" } }> => row.tags.pricing === "priced");
  if (priced.length === 0) return STATUS_BAR_PLACEHOLDER;
  const [first] = priced;
  const sameUnit = priced.every(
    (row) => row.tags.currency === first.tags.currency && row.tags.minor_unit_exponent === first.tags.minor_unit_exponent,
  );
  const exponent = Number(first.tags.minor_unit_exponent);
  if (!sameUnit) return formatCost(first.cost_minor_units, exponent, first.tags.currency);
  const total = priced.reduce((sum, row) => sum + row.cost_minor_units, 0);
  return formatCost(total, exponent, first.tags.currency);
}

function formatModel(rows: readonly UsageCostRow[]): string {
  if (rows.length === 0) return STATUS_BAR_PLACEHOLDER;
  const families = [...new Set(rows.map((row) => row.tags.model_family))];
  return families.join("+");
}

const LABELS = Object.freeze({
  campaign: "campaign",
  activity: "activity",
  attention: "attention",
  active: "active",
  attempt: "attempt",
  phase: "phase",
  verified: "verified",
  closed: "closed",
  last: "last",
  events: "events",
  model: "model",
  fidelity: "fidelity",
});

/**
 * Max display width of the `active` zone's value. Bounded so a long action
 * description can never crowd the higher-priority phase/attempt/verified
 * zones (or the row's own end-clip) out of a narrow row — unlike epoch/budget,
 * `active` is operator-priority-critical and stays in the default row, so it
 * must be self-limiting rather than relying on end-clipping alone.
 */
const ACTIVE_LABEL_MAX_WIDTH = 24;

/**
 * Columns above which the wide, labeled, descriptive row (full campaign id,
 * `label value` pairs) renders. At or below this width the row switches to
 * the compact layout: an 80-column terminal (a common operator default)
 * needs to fit campaign identity, activity, active label, phase, attempt,
 * and verified progress without depending on end-clipping to hide the
 * lower-priority zones — end-clipping alone can still cut phase/attempt/
 * verified when a full composer UUID (36 chars, plus its "campaign " label)
 * alone eats half of 80 columns.
 */
const WIDE_ROW_BREAKPOINT_COLUMNS = 96;

/**
 * Max display width of the compact row's campaign-identity token. Always the
 * *same leading slice* of the id (never chosen by how much of the rest of
 * the row happens to fit), so the identity an operator sees stays stable
 * frame to frame instead of shifting with end-clipping as other zones grow
 * or shrink.
 *
 * The slice is ELLIPSISED. `seed-campaign` rendered as `seed-cam`, which an
 * operator cannot tell from a campaign actually named `seed-cam` -- the same
 * ambiguity EC-023 fixed in the Audit id column. OpenCode marks every one of
 * its fourteen label truncations (`Locale.truncate`/`truncateLeft`/
 * `truncateMiddle`) and hard-slices no visible label anywhere.
 */
const COMPACT_CAMPAIGN_ID_MAX_WIDTH = 8;

/**
 * Tighter bound than `ACTIVE_LABEL_MAX_WIDTH`: the compact row has far less
 * horizontal budget, and phase/attempt/verified must still fit next to it.
 */
const COMPACT_ACTIVE_LABEL_MAX_WIDTH = 12;

/** ANSI Control Sequence Introducer, built at runtime (never a bare literal escape byte in source). */
const CSI = String.fromCharCode(27) + "[";
const SGR_RESET = CSI + "0m";

/**
 * True exactly when `deriveExecutionStatus` returned `UNAVAILABLE_EXECUTION_STATUS`
 * (ADR-123 Decision 2): `verified` is the only execution-status zone that is
 * never a bare placeholder when a source is available (it is always
 * `"<n>/<m>"`, even `"0/0"`), so it alone is a reliable group-level marker —
 * unlike `active`/`phase`/`attempt`, which legitimately render the
 * placeholder individually (available source, no currently-expanding node).
 */
function executionStatusUnavailable(zones: StatusBarZones): boolean {
  return zones.verified === STATUS_BAR_PLACEHOLDER;
}

function isNewSessionStatus(zones: StatusBarZones): boolean {
  return zones.campaign === STATUS_BAR_PLACEHOLDER
    && zones.activity === "idle"
    && zones.attention === STATUS_BAR_PLACEHOLDER
    && executionStatusUnavailable(zones)
    && zones.closed === STATUS_BAR_PLACEHOLDER
    && zones.events === STATUS_BAR_PLACEHOLDER
    && zones.model === STATUS_BAR_PLACEHOLDER;
}

function buildNewSessionRow(footer: RunFooterTheme | null, mode: ColorMode): { plain: string; styled: string } {
  const plain = " revoy2 · new session · Ctrl+P palette ";
  if (footer === null) return { plain, styled: plain };
  const accent = toForegroundSgr(footer.accent, mode);
  const text = toForegroundSgr(footer.text, mode);
  return { plain, styled: `${text} ${accent}revoy2${text} · new session · Ctrl+P palette ` };
}

function buildConsoleNarrativeRow(app: AppModel, frameCount: number, footer: RunFooterTheme | null, mode: ColorMode): { plain: string; styled: string } {
  const narrative = deriveConsoleActivityNarrative(app);
  const glyph = narrative.active ? spinnerGlyph(frameCount) : "·";
  const background = backgroundStatusLine(app, 64);
  const turn = turnBoundaryLine(app, 64);
  const suffix = background === null && turn === null ? "" : `  ${M7_THEME_TOKENS.active.glyph} ${background ?? turn}`;
  const plain = ` ${glyph} ${narrative.text}${suffix} `;
  if (footer === null) return { plain, styled: plain };
  const accent = toForegroundSgr(footer.accent, mode);
  const text = toForegroundSgr(footer.text, mode);
  const liveSuffix = background === null && turn === null ? "" : `  ${accent}${M7_THEME_TOKENS.active.glyph}${text} ${background ?? turn}`;
  return { plain, styled: `${text} ${accent}${glyph}${text} ${narrative.text}${liveSuffix} ` };
}

/**
 * Build the plain and styled row from the same structured segment list, so
 * the styled variant can never accidentally re-color a label-shaped
 * substring that happens to appear inside a zone *value* (e.g. a campaign id
 * containing the word "phase") — the label/value pairing is explicit, not
 * recovered by searching the text.
 *
 * Zones are ordered by operator priority so a narrow terminal's end-clipping
 * (`renderStatusBar` below) drops the least critical zones first: campaign
 * and the interrupt-confirmation hint (`activity`) come first, then the
 * execution-status projection this module exists to surface, and only then
 * the lower-priority events/epoch/model/fidelity zones — preserved in full
 * whenever the row is wide enough to fit them.
 */
function buildRow(zones: StatusBarZones, footer: RunFooterTheme | null, mode: ColorMode): { plain: string; styled: string } {
  const pairs: ReadonlyArray<readonly [string, string]> = [
    [LABELS.campaign, zones.campaign],
    [LABELS.activity, zones.activity],
    ...(zones.attention === STATUS_BAR_PLACEHOLDER || zones.attention === "0" ? [] : [[LABELS.attention, zones.attention] as const]),
    ...(executionStatusUnavailable(zones) ? [] : [
      [LABELS.active, clipLabelWithEllipsis(zones.active, ACTIVE_LABEL_MAX_WIDTH)] as const,
      [LABELS.phase, zones.phase] as const,
      [LABELS.attempt, zones.attempt] as const,
      [LABELS.verified, zones.verified] as const,
    ]),
    ...(zones.closed === STATUS_BAR_PLACEHOLDER || zones.closed === "0" ? [] : [
      [LABELS.closed, zones.closed] as const,
      [LABELS.last, clipLabelWithEllipsis(zones.last, 32)] as const,
    ]),
    [LABELS.events, zones.events],
    [LABELS.model, zones.model],
    [LABELS.fidelity, zones.fidelity],
  ];
  const plain = ` ${pairs.map(([label, value]) => `${label} ${value}`).join("  ")} `;
  if (footer === null) return { plain, styled: plain };
  const accent = toForegroundSgr(footer.accent, mode);
  const text = toForegroundSgr(footer.text, mode);
  const styled = ` ${pairs.map(([label, value]) => `${accent}${label}${text} ${value}`).join("  ")} `;
  return { plain, styled: `${text}${styled}` };
}

/**
 * A leading slice of the campaign id, always the same width regardless of
 * what else fits on the row (unlike end-clipping) — the identity an operator
 * reads stays fixed frame to frame instead of growing or shrinking with the
 * rest of the row's content.
 */
function compactCampaignIdentity(value: string): string {
  if (value === STATUS_BAR_PLACEHOLDER) return value;
  const composerDraft = /^composer-draft-([0-9a-f]{8})(?:-|$)/i.exec(value);
  if (composerDraft?.[1]) return composerDraft[1];
  // A UUID's leading hex block is a COMPLETE short identity by convention --
  // the same form git uses for short SHAs -- so it takes no ellipsis. Marking
  // it would both cost a character of the identity and make it unfamiliar.
  // An arbitrary campaign NAME is different: `seed-campaign` cut to
  // `seed-cam` is indistinguishable from a campaign really called `seed-cam`,
  // so that cut is marked.
  const uuidPrefix = /^([0-9a-f]{8})-[0-9a-f]{4}-/i.exec(value);
  if (uuidPrefix?.[1]) return uuidPrefix[1];
  return clipLabelWithEllipsis(value, COMPACT_CAMPAIGN_ID_MAX_WIDTH);
}

/** `#3`/`✓1/3`-style compact token; a placeholder value renders bare (no dangling `#—`/`✓—`). */
function compactToken(prefix: string, value: string): string {
  return value === STATUS_BAR_PLACEHOLDER ? value : `${prefix}${value}`;
}

/**
 * Build the compact row for terminals at or below `WIDE_ROW_BREAKPOINT_COLUMNS`:
 * bare, unlabeled tokens instead of `label value` pairs, so an 80-column
 * terminal shows campaign identity, activity, the bounded active label,
 * phase, and compact attempt/verified progress without a full composer UUID
 * (plus its "campaign " label) alone consuming half the row. Same priority
 * order as `buildRow` — the interrupt-confirmation hint (via `activity`)
 * stays ahead of the execution-status projection, and the row's own
 * end-clip (`renderStatusBar` below) still drops the least-critical tokens
 * first on rows too narrow even for the compact set.
 */
function buildCompactRow(zones: StatusBarZones, footer: RunFooterTheme | null, mode: ColorMode): { plain: string; styled: string } {
  const campaign = compactCampaignIdentity(zones.campaign);
  const activity = zones.activity;
  const attention = zones.attention === STATUS_BAR_PLACEHOLDER || zones.attention === "0" ? [] : [`!${zones.attention}`];
  const closed = zones.closed === STATUS_BAR_PLACEHOLDER || zones.closed === "0" ? [] : [`×${zones.closed}`];
  const execution: readonly string[] = executionStatusUnavailable(zones) ? [] : [
    clipLabelWithEllipsis(zones.active, COMPACT_ACTIVE_LABEL_MAX_WIDTH),
    zones.phase,
    compactToken("#", zones.attempt),
    compactToken("✓", zones.verified),
  ];
  const rest: readonly string[] = [
    ...attention,
    ...execution,
    ...closed,
  ];
  const plain = ` ${[campaign, activity, ...rest].join(" · ")} `;
  if (footer === null) return { plain, styled: plain };
  const accent = toForegroundSgr(footer.accent, mode);
  const text = toForegroundSgr(footer.text, mode);
  const styled = ` ${accent}${campaign}${text} · ${accent}${activity}${text}${rest.length > 0 ? ` · ${rest.join(" · ")}` : ""} `;
  return { plain, styled: `${text}${styled}` };
}

export interface StatusBarOptions {
  readonly columns: number;
  /** Injected frame clock (matches `FrameOptions.frame_count`); drives the phase spinner. */
  readonly frame_count?: number;
  readonly color?: boolean;
  /** Palette source (ADR-020); defaults to the dark-mode fallback when omitted. */
  readonly theme?: RunTheme;
  /** Color-emission tier (OT-6); only consulted when `color` is true. Defaults to truecolor. */
  readonly color_mode?: ColorMode;
  readonly presentation?: "operator" | "diagnostic";
}

/** Fit whole operator-priority segments; never cut a trailing diagnostic label. */
function buildOperatorRow(app: AppModel, zones: StatusBarZones, options: StatusBarOptions, footer: RunFooterTheme | null, mode: ColorMode): { plain: string; styled: string } {
  const narrative = deriveConsoleActivityNarrative(app);
  const interrupted = app.repeatConfirmation !== null && !app.repeatConfirmation.fired;
  const activity = interrupted ? narrative.text : zones.phase === "halted" ? "Halted"
    : narrative.active ? `${spinnerGlyph(options.frame_count ?? 0)} ${narrative.text}` : zones.activity === "idle" ? "Idle" : narrative.text;
  const tokens = [clipLabelWithEllipsis(activity, Math.max(0, options.columns - 2))];
  const candidates = [
    ...(zones.attention === STATUS_BAR_PLACEHOLDER || zones.attention === "0" ? [] : [`Attention ${zones.attention}`]),
    ...(zones.campaign === STATUS_BAR_PLACEHOLDER ? [] : [clipLabelWithEllipsis(zones.campaign, 24)]),
    ...(zones.verified === STATUS_BAR_PLACEHOLDER ? [] : [`${zones.verified} verified`]),
    ...(zones.active === STATUS_BAR_PLACEHOLDER ? [] : [clipLabelWithEllipsis(zones.active, 32)]),
    "Ctrl+P commands",
  ];
  for (const candidate of candidates) {
    if (displayWidth(` ${[...tokens, candidate].join("  |  ")} `) <= options.columns) tokens.push(candidate);
  }
  const plain = ` ${tokens.join("  |  ")} `;
  if (footer === null) return { plain, styled: plain };
  const text = toForegroundSgr(footer.text, mode);
  const accent = toForegroundSgr(footer.accent, mode);
  return { plain, styled: ` ${accent}${tokens[0]}${text}${tokens.length > 1 ? `  |  ${tokens.slice(1).join("  |  ")}` : ""} ` };
}

/**
 * Render the designed status-bar row: a single line, exactly `options.columns`
 * display-width wide, ready to overwrite a canvas row in full (no stray
 * border bleed-through, unlike the strip it replaces).
 *
 * Throttling is inherited from `StdoutRenderer`'s row diff (4F.3) "for free":
 * this function is pure, so an unchanged `(app, frame_count)` yields
 * byte-identical output and the renderer will not repaint the row; a spinner
 * advance changes only this row's string, so only this row repaints.
 */
export function renderStatusBar(app: AppModel, options: StatusBarOptions): string {
  if (!Number.isSafeInteger(options.columns) || options.columns < 0) {
    throw new Error("columns must be a non-negative safe integer");
  }
  const zones = deriveStatusBarZones(app, options.frame_count ?? 0);
  const color = options.color === true;
  const mode = options.color_mode ?? "truecolor";
  const footer = color ? footerTheme(options.theme ?? deriveTheme(undefined)) : null;
  // Console is a conversation surface.  Its one persistent line names the
  // current evidenced activity; campaign ids, ledger counts, model names and
  // fidelity remain available in their respective drill-down views instead
  // of displacing the active narrative with dashboard telemetry.
  const { plain, styled } = app.screen === "console"
    ? buildConsoleNarrativeRow(app, options.frame_count ?? 0, footer, mode)
    : options.presentation === "operator"
      ? buildOperatorRow(app, zones, options, footer, mode)
    : isNewSessionStatus(zones)
      ? buildNewSessionRow(footer, mode)
      : options.columns > WIDE_ROW_BREAKPOINT_COLUMNS ? buildRow(zones, footer, mode) : buildCompactRow(zones, footer, mode);
  const clippedPlain = clipDisplay(plain, options.columns);
  const pad = " ".repeat(Math.max(0, options.columns - displayWidth(clippedPlain)));
  if (footer === null) return clippedPlain + pad;
  const clippedStyled = clipAnsi(styled, options.columns);
  return toBackgroundSgr(footer.background, mode) + clippedStyled + pad + SGR_RESET;
}
