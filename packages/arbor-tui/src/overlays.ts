import { clipLabelWithEllipsis } from "./screens/region.js";
import { helpActions, type InputCatalog, type InputScope, type UiAction } from "./input-catalog.js";
import { workflowForAction } from "./pilot-workflows.js";
import type { PaneHit } from "./frame.js";
import type { AppModel, Notification, NotificationSeverity, UiIntent } from "./types.js";
import { deriveTheme, toBackgroundSgr, toForegroundSgr, type ColorMode, type RunTheme } from "./theme.js";
import { clipDisplay, displayWidth, selectedRowMarker } from "./widgets.js";

export interface PaletteItem {
  readonly action_id: string;
  readonly title: string;
  readonly description: string;
  readonly keys: readonly string[];
  readonly source?: string;
  /** What can authorize this action, or why it cannot run in the current context. */
  readonly authority_or_reason: string;
  /** A concise, truthful result of running the action. */
  readonly effect: string;
  /** False when current projected state proves the action cannot run. */
  readonly enabled: boolean;
  /**
   * True when an AUTHORED signal makes this action relevant now — the
   * current screen, a selection, the lifecycle's attention state — and
   * nothing proves it cannot run. The contextual palette hoists these
   * under a label, the way OpenCode hoists `suggested && !disabled`
   * (EC-003, the positive half that was still open).
   */
  readonly suggested: boolean;
}

/** State that ranks discovery only; it never grants authority or changes routing. */
export interface PaletteContext {
  readonly screen?: string;
  readonly has_selection?: boolean;
  readonly lifecycle?: "idle" | "active" | "attention";
  /** Known unavailable actions, keyed by their canonical catalog action id. */
  readonly disabled_reasons?: Readonly<Record<string, string>>;
  /**
   * Families whose backing collection is genuinely empty right now (no
   * campaigns, no live sessions, nothing awaiting an answer, ...). Ranking
   * DEMOTES these; it never hides them, and a typed query still searches the
   * whole catalogue. `disabled_reasons` stays the per-action escape hatch —
   * this is the coarse "there is nothing of this kind to act on" signal.
   */
  readonly empty_families?: readonly EmptyFamily[];
}

/**
 * Coarse applicability families, keyed by the action's canonical id NAMESPACE.
 *
 * Exemplar (EC-003, `artifacts/tui-pilot/2026-09-02-exemplar-checks.md`):
 * OpenCode's palette carries an explicit per-command `disabled` flag and
 * filters on it (`packages/app/src/context/command.tsx`) — applicability is a
 * property OF THE COMMAND, never inferred from how its title reads. Matching
 * prose was the wrong shape here for the same reason: it made "Interrupt
 * active work" a session command because the word "interrupt" appears in it,
 * while a command whose title happens to avoid the vocabulary escaped its own
 * family entirely. The catalogue is already namespaced (`cmd:recovery.*`,
 * `cmd:approval.*`, `cmd:harness.session.*`, `cmd:tree.*`), so the namespace
 * is the declarative key.
 */
export type EmptyFamily = "attention" | "session" | "campaign" | "recovery" | "result";

const EMPTY_FAMILY_NAMESPACES: Readonly<Record<EmptyFamily, readonly string[]>> = {
  attention: ["cmd:approval.", "cmd:userinput.", "cmd:taskcomposer.answer", "focus:approvals", "focus:interviews", "workflow:intervene.approval", "workflow:intervene.interview"],
  session: ["cmd:harness.session.", "cmd:harness.sessions.", "focus:harness-sessions", "focus:live-session"],
  campaign: ["cmd:tree.", "cmd:campaign.", "focus:tree", "focus:campaigns", "workflow:intervene."],
  recovery: ["cmd:recovery.", "focus:recovery", "workflow:recover.pending"],
  result: ["cmd:result.", "focus:result-review", "workflow:finish."],
};

/**
 * `PILOT_WORKFLOWS` entries already declare their own precondition in a
 * `requires` field ("active campaign", "selected non-root tree node"). That is
 * this repository's closest equivalent to the exemplar's per-command
 * applicability flag, and it is authored next to the workflow rather than
 * inferred, so it is preferred over any namespace guess for the workflows it
 * covers.
 */
function workflowRequirementUnmet(actionId: string, families: readonly EmptyFamily[]): boolean {
  const workflow = workflowForAction(actionId);
  if (workflow === null) return false;
  // A workflow's authored ROUTE is as much a declaration of what it acts on as
  // its `requires` text. `supervise.live-session` carries no `requires` but
  // routes to `screen: "live-session"`, so it survived while the `focus:`
  // action for the very same screen was demoted (EC-003b).
  if (workflow.route.kind === "screen") {
    const target = `focus:${workflow.route.screen}`;
    if (families.some((family) => EMPTY_FAMILY_NAMESPACES[family]?.includes(target) === true)) return true;
  }
  const requires = workflow.requires;
  if (requires === undefined) return false;
  if (/campaign|node|tree/i.test(requires)) return families.includes("campaign");
  if (/session/i.test(requires)) return families.includes("session");
  return false;
}

/** Row-scoped commands cannot act without a selected row. */
const ROW_SCOPED_PREFIXES: readonly string[] = ["cmd:row.", "cmd:clipboard.copy_focused_row"];

export interface PaletteView {
  /** Action rows only. Their indexes remain the canonical selection indexes. */
  readonly items: readonly PaletteItem[];
  /** Categories omitted from the initial view, never from search or the full catalog. */
  readonly collapsed_categories: readonly ReturnType<typeof paletteCategory>[];
  readonly complete_catalog_count: number;
  readonly contextual: boolean;
}

export interface PaletteRenderedRow {
  /** Null for a group label ("Suggested now" / "Everything else"), which is not selectable. */
  readonly action_id: string | null;
  readonly plain: string;
  readonly styled: string;
  readonly selected: boolean;
  readonly header?: boolean;
}

export const DEFAULT_CONTEXTUAL_PALETTE_LIMIT = 12;

function object(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Readonly<Record<string, unknown>> : null;
}

function rowsAt(value: unknown, keys: readonly string[]): readonly unknown[] {
  const shape = object(value);
  if (shape === null) return [];
  for (const key of keys) if (Array.isArray(shape[key])) return shape[key] as readonly unknown[];
  return [];
}

function unresolved(value: unknown, keys: readonly string[]): boolean {
  return rowsAt(value, keys).some((candidate) => {
    const row = object(candidate);
    if (row === null) return true;
    if (row.answer !== undefined && row.answer !== null) return false;
    const status = typeof row.status === "string" ? row.status.toLocaleLowerCase() : "pending";
    return !["answered", "approved", "rejected", "expired", "resolved", "closed"].includes(status);
  });
}

/**
 * Diff Review is a contextual inspector, not an empty peer destination. A
 * usable capture is projected either into one of the product composites or,
 * after the operator has already visited it, as a real review workspace.
 */
function hasResultReviewCapture(model: AppModel): boolean {
  // Product projections can be hydrated against the resumed foreground
  // screen (Task Composer) or the normal Console composite. Discovery is a
  // session-wide command surface, so availability must not depend on which
  // screen happened to own the latest refresh.
  for (const value of model.screens.values()) {
    const shape = object(value);
    const review = shape === null ? null : object(shape.result_review);
    if (review !== null && object(review.capture) !== null) return true;
  }
  const workspace = object(model.screens.get("result-review"));
  return workspace !== null
    && Array.isArray(workspace.files)
    && Array.isArray(workspace.unified)
    && typeof workspace.campaign_id === "string"
    && typeof workspace.node_id === "string";
}

/**
 * One model-derived context shared by painting, cursor movement and Enter.
 * This ranks discovery only; it neither grants capabilities nor changes the
 * canonical action id that the composition root executes.
 */
export function paletteContextForModel(model: AppModel): PaletteContext {
  const consoleShape = object(model.screens.get("console"));
  const needsAttention = model.notifications.some((notification) => notification.severity === "error")
    || (consoleShape !== null && (
      unresolved(consoleShape.operator_interviews, ["requests", "records", "items"])
      || unresolved(consoleShape.approvals, ["records", "items"])
    ));
  const sessions = consoleShape === null ? [] : rowsAt(consoleShape.sessions, ["sessions", "items", "records"]);
  const treeShape = consoleShape === null ? null : object(consoleShape.tree);
  const treeNodes = treeShape === null || !Array.isArray(treeShape.nodes) ? [] : treeShape.nodes;
  const active = sessions.some((candidate) => {
    const row = object(candidate);
    return row !== null && ["running", "active", "starting"].includes(String(row.state ?? "").toLocaleLowerCase());
  }) || treeNodes.some((candidate) => {
    const row = object(candidate);
    return row !== null && ["expanding", "claimed", "running"].includes(String(row.state ?? "").toLocaleLowerCase());
  });
  // Emptiness is read from the same console projection the rest of this
  // context already uses, so a family is only ever called empty when its
  // backing collection really is.
  const campaigns = consoleShape === null ? [] : rowsAt(consoleShape.campaigns, ["items", "records"]);
  const hasCapture = hasResultReviewCapture(model);
  const emptyFamilies: EmptyFamily[] = [];
  if (!needsAttention) emptyFamilies.push("attention");
  if (sessions.length === 0) emptyFamilies.push("session");
  if (campaigns.length === 0 && treeNodes.length === 0) emptyFamilies.push("campaign");
  if (campaigns.length === 0) emptyFamilies.push("recovery");
  if (!hasCapture) emptyFamilies.push("result");
  return {
    screen: model.screen,
    has_selection: model.selection.has(model.screen),
    lifecycle: needsAttention ? "attention" : active ? "active" : "idle",
    ...(emptyFamilies.length === 0 ? {} : { empty_families: Object.freeze(emptyFamilies) }),
    ...(!hasCapture ? {
      disabled_reasons: { "focus:result-review": "no captured result is ready to review" },
    } : {}),
  };
}

/** Stable, compact category labels for a flat but scan-friendly palette. */
export function paletteCategory(item: PaletteItem): "screen" | "workflow" | "theme" | "custom" | "command" {
  if (item.action_id.startsWith("focus:")) return "screen";
  if (item.action_id.startsWith("workflow:")) return "workflow";
  if (item.action_id.startsWith("cmd:theme.set:")) return "theme";
  if (item.action_id.startsWith("user-command:")) return "custom";
  return "command";
}
/**
 * Substring match against an action's title/description/id AND its bound
 * keystrokes (e.g. typing the palette's own advertised "9" finds the action
 * bound to key "9", not just one whose title happens to contain a literal
 * "9"). Keys are matched as whole tokens, not raw substring, so an entry
 * bound to "ctrl+9" matches a query of "9" but a query of "9" never
 * accidentally substring-matches an unrelated multi-digit binding like "99"
 * (there are none today, but the token boundary keeps that a non-issue).
 */
function matchesQuery(action: UiAction, query: string): boolean {
  if (!query) return true;
  const text = `${action.title} ${action.description} ${action.id}`.toLocaleLowerCase();
  if (text.includes(query) || fuzzyMatch(text, query)) return true;
  return action.bindings.some((binding) => binding.keys.some((key) => key.toLocaleLowerCase() === query));
}
/**
 * Subsequence match anchored to WORD BOUNDARIES — the rule every palette of
 * this shape uses (fzf, VS Code, Zed) to make a short query feel precise.
 *
 * The original form accepted any ordered scattering of the query's letters
 * across `title + description + id`, so "gov" returned 66 of 170 commands and
 * trailed off into "Page Up" (pa*g*e / scr*o*ll / acti*v*e), "Bus" and
 * "Record Bus Message". Bounding the SPAN of that scatter was not enough —
 * those incidental letters sit close together — because the problem is not
 * distance, it is that the letters are not where a reader would look for them.
 *
 * So each matched character must either begin a word or continue the previous
 * match: "gov" reaches "**Gov**ernance" and "Approve **Gov**erned Fold" but
 * never pa*g*e-scr*o*ll-acti*v*e. `matchesQuery` tests a literal substring
 * first and that path is unaffected, so an exact hit can never be lost here.
 *
 * Exemplar check (OpenCode, read on disk): its TUI picker
 * (`packages/tui/src/ui/dialog-select.tsx`) uses the `fuzzysort` library with
 * title weighted twice category -- a SCORED subsequence matcher that strongly
 * favours word-boundary and camel hits. Anchoring here is aligned with that,
 * not a divergence from it. (An earlier note in this file cited OpenCode's
 * model-picker helper, which is substring-only, and wrongly generalised that
 * to the whole product; see EC-002 CORRECTION in
 * `artifacts/tui-pilot/2026-09-02-exemplar-checks.md`.) The remaining gap is
 * that fuzzysort RANKS by match quality where this returns a boolean match
 * plus a coarse `queryRank`.
 */
function fuzzyMatch(text: string, query: string): boolean {
  const compact = query.replace(/\s+/gu, "");
  if (compact.length === 0) return false;
  let cursor = 0;
  let previousEnd = -1;
  for (const character of compact) {
    let found = -1;
    for (let index = cursor; index < text.length; index += 1) {
      if (text[index] !== character) continue;
      const startsWord = index === 0 || !/[\p{L}\p{N}]/u.test(text[index - 1] ?? "");
      if (startsWord || index === previousEnd) { found = index; break; }
    }
    if (found < 0) return false;
    previousEnd = found + 1;
    cursor = found + 1;
  }
  return true;
}
function queryRank(action: UiAction, query: string): number { if (!query) return 0; const text = `${action.title} ${action.description} ${action.id}`.toLocaleLowerCase(); const exact = text.indexOf(query); if (exact >= 0) return exact; let cursor = 0; let gaps = 0; for (const character of query.replace(/\s+/gu, "")) { const next = text.indexOf(character, cursor); if (next < 0) return Number.MAX_SAFE_INTEGER; gaps += next - cursor; cursor = next + 1; } return 10_000 + gaps; }

type PaletteInput = {
  query?: string;
  scope?: InputScope;
  limit?: number;
  source?: string;
  context?: PaletteContext;
  /** Empty searches normally show a bounded contextual set. Queries always search every action. */
  contextual?: boolean;
  /** Explicit operator expansion; a query also expands automatically. */
  expanded?: boolean;
  /**
   * How many rows the caller can actually paint. The contextual view used a
   * fixed 12 regardless of terminal size, so a 44-row palette listed 12 of 170
   * commands above ~28 blank rows. A renderer that knows its list height
   * passes it here and the bounded set grows to fill it; callers that do not
   * know keep the conservative default.
   */
  contextual_limit?: number;
};

function effectFor(action: UiAction): string {
  if (action.discovery?.effect !== undefined) return action.discovery.effect;
  if (action.id.startsWith("focus:")) return "Focuses this screen";
  if (action.id === "help") return "Opens command discovery";
  return "Runs the registered action";
}

function authorityFor(action: UiAction, context: PaletteContext | undefined): string {
  const disabled = context?.disabled_reasons?.[action.id];
  if (disabled !== undefined && disabled.trim() !== "") return `Unavailable: ${disabled.trim()}`;
  if (action.discovery?.authority !== undefined) return action.discovery.authority;
  if (action.id.startsWith("focus:")) return "Navigation";
  if (action.bindings.length === 0) return "Palette-only";
  return "Registered command";
}

function contextRank(action: UiAction, context: PaletteContext | undefined): number {
  if (context === undefined) return 0;
  let score = action.id === "help" ? 4 : 0;
  if (context.screen !== undefined) {
    if (action.id === `focus:${context.screen}`) score += 18;
    if (action.description.toLocaleLowerCase().includes(`(${context.screen} screen)`)) score += 12;
  }
  if (context.has_selection === true && /selected|focused|row|node/i.test(`${action.title} ${action.description}`)) score += 10;
  if (context.lifecycle === "attention" && /approval|answer|interview|recovery|clarif/i.test(`${action.title} ${action.description}`)) score += 14;
  if (context.lifecycle === "active" && /interrupt|stop|output|session/i.test(`${action.title} ${action.description}`)) score += 12;
  // An action whose entire subject does not exist yet is the LEAST useful
  // thing to put in front of an operator, yet without this it tied at zero
  // with everything else and won on alphabetical order — which is how a fresh
  // greenfield Console opened its palette on "Abandon Recovery", "Answer
  // Interview" and "Apply reviewed migration" while calling itself contextual.
  // Demote, never hide: the row stays reachable by query or expansion.
  const families = context.empty_families ?? [];
  for (const family of families) {
    if (EMPTY_FAMILY_NAMESPACES[family]?.some((prefix) => action.id.startsWith(prefix)) === true) score -= 20;
  }
  if (workflowRequirementUnmet(action.id, families)) score -= 20;
  // A workflow whose AUTHORED category is the lifecycle phase the operator is
  // in right now is the most useful thing to suggest: intervene when work
  // needs them, supervise while it runs, project/plan on an empty project.
  // The category is the workflow's own declaration (pilot-workflows.ts), not
  // a regex over its title — the authored signal EC-003 asked for.
  const workflow = workflowForAction(action.id);
  if (workflow !== null && !workflowRequirementUnmet(action.id, families)) {
    const phase = context.lifecycle === "attention" ? "intervene" : context.lifecycle === "active" ? "supervise" : families.includes("campaign") ? "project" : "plan";
    if (workflow.category === phase || (phase === "project" && workflow.category === "plan")) score += 8;
  }
  // `has_selection` was only ever used to BOOST selection-scoped actions; when
  // nothing is selected these commands cannot act at all, so say so in the
  // ranking rather than leaving them level with everything else (EC-003b).
  if (context.has_selection !== true && ROW_SCOPED_PREFIXES.some((prefix) => action.id.startsWith(prefix))) score -= 20;
  return score;
}

function sortedActions(catalog: InputCatalog, input: PaletteInput, query: string): UiAction[] {
  return helpActions(catalog, input.scope)
    .filter((action) => visible(action, input.scope) && (input.source === undefined || action.source === input.source) && matchesQuery(action, query))
    .sort((left, right) => queryRank(left, query) - queryRank(right, query)
      || contextRank(right, input.context) - contextRank(left, input.context)
      || left.title.localeCompare(right.title)
      || left.id.localeCompare(right.id));
}

function toPaletteItem(action: UiAction, input: PaletteInput): PaletteItem {
  const disabled = input.context?.disabled_reasons?.[action.id];
  const enabled = disabled === undefined || disabled.trim() === "";
  return {
    suggested: enabled && contextRank(action, input.context) > 0,
    action_id: action.id,
    title: action.title,
    description: action.description,
    keys: action.bindings.filter((binding) => input.scope === undefined || binding.scope === input.scope).map((binding) => binding.keys.join(" ")),
    authority_or_reason: authorityFor(action, input.context),
    effect: effectFor(action),
    enabled,
    ...(action.source !== undefined ? { source: action.source } : {}),
  };
}

/**
 * Contextual discovery model. The initial empty-query view is bounded; a
 * typed query or `expanded` view always evaluates the complete catalog.
 * Ties are resolved by title/id, keeping keyboard selection deterministic.
 */
export function paletteView(catalog: InputCatalog, input: PaletteInput = {}): PaletteView {
  const limit = input.limit ?? 50;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new Error("palette limit must be from 1 to 200");
  const query = input.query?.trim().toLocaleLowerCase() ?? "";
  const all = sortedActions(catalog, input, query);
  const contextual = input.contextual === true && query.length === 0 && input.expanded !== true;
  const contextualBudget = Number.isSafeInteger(input.contextual_limit) && (input.contextual_limit ?? 0) > 0
    ? Math.max(DEFAULT_CONTEXTUAL_PALETTE_LIMIT, input.contextual_limit!)
    : DEFAULT_CONTEXTUAL_PALETTE_LIMIT;
  const visibleActions = contextual ? all.slice(0, Math.min(limit, contextualBudget)) : all.slice(0, limit);
  const categoryCounts = (actions: readonly UiAction[]): Map<ReturnType<typeof paletteCategory>, number> => {
    const counts = new Map<ReturnType<typeof paletteCategory>, number>();
    for (const action of actions) {
      const category = paletteCategory(toPaletteItem(action, input));
      counts.set(category, (counts.get(category) ?? 0) + 1);
    }
    return counts;
  };
  const allCategories = categoryCounts(all);
  const visibleCategories = categoryCounts(visibleActions);
  const collapsed = contextual
    ? [...allCategories.keys()].filter((category) => (visibleCategories.get(category) ?? 0) < (allCategories.get(category) ?? 0))
    : [];
  return { items: visibleActions.map((action) => toPaletteItem(action, input)), collapsed_categories: collapsed, complete_catalog_count: all.length, contextual };
}

/** Explicit disclosure that a contextual start is not a hidden catalog. */
export function paletteDisclosure(view: PaletteView, options: { compact?: boolean } = {}): string {
  if (!view.contextual) return `Showing all ${view.complete_catalog_count} commands`;
  const categories = view.collapsed_categories.length === 0 ? "more commands" : `${view.collapsed_categories.join(", ")} collapsed`;
  return options.compact === true
    ? `${view.items.length}/${view.complete_catalog_count} · search/all`
    : `Showing ${view.items.length} of ${view.complete_catalog_count} · ${categories} · type to search or expand all`;
}

/** Footer content is declarative; input ownership maps actual keys to these operations. */
export function paletteFooterHint(input: { pending_chord?: readonly string[]; focus?: string; compact?: boolean } = {}): string {
  const focus = input.focus?.trim() || "palette";
  const chord = input.pending_chord?.filter((key) => key.trim() !== "").join(" ");
  const prefix = chord === undefined || chord === "" ? `${focus} focus` : `${focus} focus · waiting for ${chord}`;
  return input.compact === true ? `${prefix} · ↑↓ select · Enter run · search/all` : `${prefix} · ↑/↓ select · Enter runs selected · type to search · expand all commands`;
}
/** Render the live help overlay from the same palette view used by movement and execution. */
export function renderPaletteRows(catalog: InputCatalog, options: PaletteInput & { width: number; selected_index?: number; color?: boolean; theme?: RunTheme; color_mode?: ColorMode; compact_rows?: boolean }): PaletteRenderedRow[] {
  const view = paletteView(catalog, options);
  const mode = options.color_mode ?? "truecolor";
  const theme = options.color === true ? (options.theme ?? deriveTheme(undefined)) : null;
  // Group labels only in the contextual (empty-query, unexpanded) view, and
  // only when both groups exist: a label over everything says nothing.
  const contextual = options.contextual === true && (options.query?.trim() ?? "") === "" && options.expanded !== true;
  const grouped = contextual && view.items.some((item) => item.suggested) && view.items.some((item) => !item.suggested);
  const header = (label: string): PaletteRenderedRow => {
    const plain = clipDisplay(label, options.width);
    return { action_id: null, plain, styled: theme === null ? plain : `${toForegroundSgr(theme.colors.muted, mode)}${plain}${PALETTE_SGR_RESET}`, selected: false, header: true };
  };
  const rows: PaletteRenderedRow[] = [];
  view.items.forEach((item, index) => {
    if (grouped && index === 0 && item.suggested) rows.push(header("Suggested now"));
    if (grouped && !item.suggested && (index === 0 || view.items[index - 1]!.suggested)) rows.push(header("Everything else · A–Z"));
    rows.push(renderPaletteRow(item, index, options, theme, mode));
  });
  return rows;
}

function renderPaletteRow(item: PaletteItem, index: number, options: PaletteInput & { width: number; selected_index?: number; compact_rows?: boolean }, theme: RunTheme | null, mode: ColorMode): PaletteRenderedRow {
  {
    const selected = options.selected_index === index;
    const detail = `${item.description} · ${item.keys.join(", ") || "no shortcut"} · ${item.authority_or_reason} · ${item.effect}`;
    const plain = clipDisplay(options.compact_rows === true
      ? `${selectedRowMarker(selected)}[${paletteCategory(item)}] ${item.keys.join(", ") || "—"} · ${item.title}`
      : `${selectedRowMarker(selected)}[${paletteCategory(item)}] ${item.title} — ${detail}`, options.width);
    const styled = theme === null || !selected
      ? plain
      : `${toBackgroundSgr(theme.colors.accent, mode)}${toForegroundSgr(theme.colors.background, mode)}${plain}${PALETTE_SGR_RESET}`;
    return { action_id: item.action_id, plain, styled, selected };
  }
}

const PALETTE_ESC = String.fromCharCode(27);
const PALETTE_SGR_RESET = `${PALETTE_ESC}[0m`;
export function boundedNotifications(notifications: readonly Notification[], options: { limit: number; width: number }): string[] { if (!Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > 100) throw new Error("notification limit must be from 1 to 100"); return notifications.slice(-options.limit).map((notification) => clipLabelWithEllipsis(`[${notification.severity}] ${notification.message.replace(/[\u0000-\u0009\u000B-\u001F\u007F-\u009F]/gu, "")}`, options.width)); }

/**
 * Default height (content rows, border excluded — the band never has one)
 * of the persistent notification band `renderScene` reserves above the
 * status bar. `AppModel.notifications` is a real bounded ring (up to
 * `AppLimits.notifications`, default 100) that `interrupt`/`branch`/`prune`
 * all append to — the ring itself stays the durable record; this constant
 * bounds only the always-visible head of it. Kept deliberately small: an
 * ops cockpit's ambient feedback strip must stay legible without crowding
 * out the primary pane in a short, task-focused session.
 */
export const DEFAULT_NOTIFICATION_BAND_ROWS = 3;

/**
 * The exact notifications a rendered band actually shows, given the band's
 * row budget and however much vertical room the terminal genuinely has
 * above the status row. Single source of truth for that windowing:
 * `renderScene` uses it to build the band it paints, and a future
 * click-to-dismiss handler (`notificationDismissIntent` below) must resolve
 * a hit against the identical window — computing it twice, independently,
 * would let a click and the row it visually landed on drift apart on a
 * short terminal.
 */
export function windowedNotifications(notifications: readonly Notification[], options: { max_rows: number; available_rows: number; now_ms?: number }): readonly Notification[] {
  if (!Number.isSafeInteger(options.max_rows) || options.max_rows < 0) throw new Error("max_rows must be a non-negative safe integer");
  if (!Number.isSafeInteger(options.available_rows) || options.available_rows < 0) throw new Error("available_rows must be a non-negative safe integer");
  const rows = Math.min(options.max_rows, options.available_rows);
  if (rows <= 0) return [];
  // An omitted clock deliberately leaves the pure/snapshot path timeless.
  // TuiShell supplies one for the live cockpit; expired notices remain in the
  // model (and runtime errors remain in Diagnostics) rather than disappearing
  // from the record merely because they no longer deserve footer space.
  const now = options.now_ms;
  const visible = now === undefined
    ? notifications
    : notifications.filter((notification) => notification.expiresAt === undefined || notification.expiresAt > now);
  return visible.slice(-rows);
}

const SEVERITY_ROLE: Record<NotificationSeverity, "info" | "warning" | "danger"> = { info: "info", warning: "warning", error: "danger" };
/** ANSI reset, built at runtime (never a bare literal escape byte in source) — mirrors theme.ts/status-bar.ts's own convention. */
const NOTIFICATION_ESC = String.fromCharCode(27);
const NOTIFICATION_SGR_RESET = `${NOTIFICATION_ESC}[0m`;

export interface NotificationBandLine {
  readonly id: string;
  readonly severity: NotificationSeverity;
  /** Plain text, clipped and padded to `width` — safe to embed verbatim in a `FramePane.content` row or assign into a flat canvas row with no bleed-through from whatever the row previously held. */
  readonly plain: string;
  /** Same content with severity-colored SGR when `options.color` is true (danger/warning/info roles, theme.ts); identical to `plain` otherwise. Pre-padded to `width` exactly like `plain`. */
  readonly styled: string;
}

/**
 * Composes the persistent notification band `renderScene` paints above the
 * status bar. Built on `boundedNotifications` (this file's own plain-text
 * `[severity] message` formatter) rather than duplicating its composition —
 * this function only adds per-line severity coloring, id-carrying (for
 * `notificationDismissIntent`), and full-width padding so a caller can
 * assign the result straight into a canvas row, mirroring the padding
 * contract `renderStatusBar` already established for exactly that reason
 * (status-bar.ts's own doc comment explains why: raw assignment, not
 * `put()`/`clipDisplay`, because those treat an embedded SGR escape as a
 * one-column character).
 *
 * `notifications` is expected to already be the rendered window
 * (`windowedNotifications`'s output), not the full ring — this function
 * does no slicing of its own beyond what `boundedNotifications` does
 * (a no-op here since the window is already sized).
 */
export function renderNotificationBand(notifications: readonly Notification[], options: { width: number; color?: boolean; theme?: RunTheme; color_mode?: ColorMode }): NotificationBandLine[] {
  if (notifications.length === 0) return [];
  const plainLines = boundedNotifications(notifications, { limit: notifications.length, width: options.width });
  const color = options.color === true;
  const mode = options.color_mode ?? "truecolor";
  const theme = color ? (options.theme ?? deriveTheme(undefined)) : null;
  return notifications.map((notification, index) => {
    const text = plainLines[index] ?? "";
    const pad = " ".repeat(Math.max(0, options.width - displayWidth(text)));
    const plain = text + pad;
    if (theme === null) return { id: notification.id, severity: notification.severity, plain, styled: plain };
    const role = SEVERITY_ROLE[notification.severity];
    const styled = `${toForegroundSgr(theme.colors[role], mode)}${text}${NOTIFICATION_SGR_RESET}${pad}`;
    return { id: notification.id, severity: notification.severity, plain, styled };
  });
}

/**
 * Translates a pane-hit inside the notification band into the real
 * `dismiss_notification` `UiIntent` it means. `hit.row_in_pane` is
 * pixel-accurate against `windowed` because `frame.ts`'s `hitTestFrame`
 * (unmodified) resolves it against the exact rect `renderScene` reserved
 * for the `"notifications"` pane, and `windowed` must be the identical
 * `windowedNotifications(...)` result that pane's content was built from —
 * the same single-source-of-truth reasoning `windowedNotifications` itself
 * documents. Returns `null` for a hit outside the notifications pane, or a
 * row past the last real line, rather than guessing — a missing target is
 * a real outcome, never a fabricated dismiss of the wrong notification.
 *
 * Pure translation only: this package has no dispatch authority (`update.ts`
 * already owns the real `dismiss_notification` case, wave2/tui-input-model).
 * The caller that owns turning an OpenTUI mouse event or a keybinding into a
 * dispatched intent (`packages/arbor-mcp/src/tui.ts`, outside this
 * package's ownership) is the one that must call this and dispatch the
 * result.
 */
export function notificationDismissIntent(hit: PaneHit, windowed: readonly Notification[]): Extract<UiIntent, { readonly type: "dismiss_notification" }> | null {
  if (hit.pane_id !== "notifications") return null;
  const target = windowed[hit.row_in_pane];
  return target ? { type: "dismiss_notification", id: target.id } : null;
}

function visible(action: UiAction, scope?: InputScope): boolean { return scope === undefined || action.bindings.some((binding) => binding.scope === scope); }
