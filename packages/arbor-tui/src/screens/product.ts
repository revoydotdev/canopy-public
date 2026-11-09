/**
 * Shared product-surface vocabulary.
 *
 * This file used to hold three screens — Dashboard, Cockpit and Projects —
 * that rendered the same composite query set three different ways. ADR-149
 * Decision 7 folded them into Console, so what remains is the part that was
 * always shared: the snapshot shape they all received, the bounded readers
 * that interpret it, and the fleet/portfolio fact extractors Console now
 * calls. No execution authority lives here; the MCP composition root collects
 * these values through RuntimePort and every visible mutation still travels
 * through the canonical command catalog.
 */
import { clipDisplay, displayWidth } from "../widgets.js";
import type { RuntimeQueryKind } from "../runtime-port.js";
import { formatCost } from "../telemetry-widgets.js";
import type { UsageCostRow } from "../telemetry-types.js";
import type { NodeTransition } from "../player-piano.js";
import { PILOT_WORKFLOWS, type PilotWorkflowCategory } from "../pilot-workflows.js";

/**
 * The render context `resolveActiveScreen` (renderer.ts:469) actually
 * carries — `frame_count`/`color`/`transitions`/`selected_id`/`scroll_offset`
 * alongside `projection`/`width`/`height`. Prior to this fix `module()`'s
 * render wrapper destructured only the first three, silently dropping the
 * rest before they ever reached `dashboard`/`cockpit`/`projects` — the
 * mechanical reason those three screens were structurally incapable of
 * colour, animation, flash highlights, or selection (finding B).
 *
 * This fix closes the plumbing gap and wires `selected_id` end to end (a
 * campaign/draft row now carries a cursor when the operator has one
 * selected). `color`/`frame_count`/`transitions` are threaded through and
 * available to these screens but deliberately left unconsumed here: safely
 * emitting real ANSI colour requires clipping the final line with
 * `clipAnsi` (player-piano.ts) instead of the plain `clipDisplay` these
 * screens already end every render with — clipDisplay does not understand
 * embedded SGR sequences and would corrupt/truncate one mid-escape, exactly
 * the pitfall console.ts's own comments document. That is real, additional
 * per-screen work (Step 3/5 territory), not a wiring gap; making the field
 * reachable is this step's job, not fabricating a color feature this file
 * cannot yet emit safely.
 */
export interface ProductRenderContext {
  readonly frame_count?: number;
  readonly color?: boolean;
  readonly transitions?: ReadonlyMap<string, NodeTransition>;
  readonly selected_id?: string;
  readonly scroll_offset?: number;
}

export type RecordValue = Readonly<Record<string, unknown>>;
export interface ProductSurfaceSnapshot {
  readonly campaigns: unknown;
  readonly governance: unknown;
  readonly backlog: unknown;
  readonly jobs: unknown;
  readonly approvals: unknown;
  readonly drafts: unknown;
  readonly sessions: unknown;
  readonly readiness: unknown;
  readonly project: unknown;
  readonly agents: unknown;
  readonly extensions: unknown;
  /** Which connector (native / opencode / Claude Code) is actually selected for dispatch — `harness.connector.inventory`'s projection, read-only. */
  readonly connector?: unknown;
  /** Task-composer drafts the operator locally cancelled (tui.ts's `cancelledTaskComposerDraftIds`) — the background call may still be running. */
  readonly cancelled_draft_ids?: unknown;
  /**
   * Pilot defect #3: "completion and cost appear unavailable at terminal
   * state." `usage_cost` is the active campaign's real ledger-derived
   * `TelemetrySnapshot.usage_cost` rows (ADR-017; `tui.ts`'s
   * `refreshProductSurface` fetches it via `runtime.manager.projectTelemetry`
   * the same way the status bar's own budget zone does), so the dashboard can
   * show real cost/token data instead of never querying it at all. Absent
   * (no active campaign, or the projection genuinely failed) renders as
   * "unavailable" — never a fabricated `$0`.
   */
  readonly usage_cost?: unknown;
  /**
   * Optional, canonical result-inspection projection for the selected or most
   * recently completed task. This screen deliberately consumes it read-only:
   * review is not adoption and rendering it must never imply a mutation.
   *
   * Expected shape: `{ status?, summary?, changed_files?: [{ path, status?,
   * additions?, deletions? }], patch_summary?, verification?, adoption? }`.
   * `adoption` may be a string state or `{ state, detail? }`.
   */
  readonly result_review?: unknown;
  /**
   * Canonical, read-only activity entries assembled by the composition root.
   * Every item is `{ timestamp, label, tone, source }`; `tone` is one of
   * `needs-operator`, `working`, `ready`, `neutral`, or `error`.
   */
  readonly activity?: unknown;
  /**
   * Bounded, read-only session inspection entries. Resume and fork availability
   * are explicit so the cockpit never implies controls the catalog lacks.
   */
  readonly session_history?: unknown;
  /** Bounded product operations projection supplied through RuntimePort only. */
  readonly product_operations?: unknown;
  /**
   * Console and Cockpit screens only (`tui.ts`'s `refreshProductSurface`,
   * "console"/"cockpit" arms): the active/newest campaign's `campaign.tree`
   * result, the same real shape `tree.ts`'s `isTreeShape`/`projectTree`
   * already consume — reused rather than reimplemented (console.ts). Absent
   * for dashboard/projects, which never fetch it. The cockpit does not yet
   * render this field (ADR-125's region primitive that will compose a tree
   * banner into the cockpit's layout is a separate, concurrent change) —
   * fetching it now closes finding C's "never asks for the data it would
   * need" gap ahead of that composition landing.
   */
  readonly tree?: unknown;
  /**
   * Cockpit screen only: a LIMITED `devtools.stream` read (`tui.ts`'s
   * `refreshProductSurface`, "cockpit" arm) — the same
   * `RuntimePortAdapter.devtoolsStream()` shape the dedicated DevTools
   * screen renders in full, capped to its most recent lines here rather than
   * the whole in-memory ring, since the cockpit is a summary surface, not a
   * raw log tail. Absent for dashboard/projects/console, which never fetch
   * it. Like `tree` above, this screen does not yet render it — captured so
   * the narration layer (plan Step 3) and the region composition above can
   * consume real, already-fetched data instead of finding it never
   * requested at all.
   */
  readonly devtools?: unknown;
  /**
   * Console screen only: the screen-local inline input-strip buffer state
   * (`tui.ts`'s own closure state, mirrors the `resultFileSelection` bounded
   * inline-text idiom already used for selective adoption). Never a query
   * result — merged in locally by `tui.ts` on every keystroke so the strip
   * repaints without a network round trip. Absent for every other screen.
   */
  readonly console_input?: { readonly text: string; readonly cursor: number; readonly focused: boolean };
  readonly captured_at: string;
}

export function record(value: unknown): value is RecordValue { return value !== null && typeof value === "object" && !Array.isArray(value); }
function array(value: unknown): readonly unknown[] { return Array.isArray(value) ? value : []; }
export function values(value: unknown, key: string): readonly RecordValue[] {
  if (Array.isArray(value)) return value.filter(record);
  return record(value) ? array(value[key]).filter(record) : [];
}
export function text(value: unknown, fallback = "—"): string { return typeof value === "string" && value.trim() ? value : fallback; }
export function number(value: unknown): number { return typeof value === "number" && Number.isFinite(value) ? value : 0; }
export function campaignRows(value: unknown): readonly RecordValue[] { return values(value, "items"); }
function draftRows(value: unknown): readonly RecordValue[] { return values(value, "items"); }
function sessionRows(value: unknown): readonly RecordValue[] { return values(value, "sessions"); }
function approvalRows(value: unknown): readonly RecordValue[] { return values(value, "records"); }
function jobRows(value: unknown): readonly RecordValue[] { return values(value, "jobs"); }
function backlogRows(value: unknown): readonly RecordValue[] {
  if (!record(value)) return [];
  for (const key of ["items", "backlog", "obligations"]) {
    const rows = array(value[key]).filter(record);
    if (rows.length) return rows;
  }
  return [];
}
/**
 * Root states from which a campaign never re-expands, i.e. not "active".
 *
 * Kept as literals rather than importing `@arbor/core`'s TERMINAL_NODE_STATES,
 * because screens read wire strings and stay leaf-isolated (the same argument
 * diagnostics.ts makes for duck-typing `RuntimeEvent`). Drift against the real
 * union is caught by tests/screens-node-state-exhaustiveness.test.ts, which
 * asserts this list equals the canonical set.
 *
 * It previously omitted `claimed` and `abandoned`, so a campaign whose root was
 * abandoned still counted as active on the dashboard.
 */
export const TERMINAL_ROOT_STATES: readonly string[] = ["verified", "claimed", "failed", "pruned", "abandoned"];

/**
 * `job.list` is the scheduler's view, whose durable discriminant is `state`
 * (not the older dashboard-shaped `status` field).  Do not derive liveness by
 * exclusion: an unrecognised state is not evidence that work is live.  The
 * explicit set mirrors `JobState` in arbor-mcp/job-scheduler and keeps a
 * future terminal state from silently inflating the operator's live count.
 */
const ACTIVE_JOB_STATES = new Set(["queued", "started", "running", "retrying", "cancel_requested"]);

function jobState(value: RecordValue): string {
  // `status` is retained only as a read-compatible fallback for old persisted
  // captures. The live runtime contract always supplies `state`.
  return text(value.state, text(value.status, ""));
}

function activeJobCount(value: unknown): number {
  return jobRows(value).filter((item) => ACTIVE_JOB_STATES.has(jobState(item))).length;
}

/** A terminal marker is authoritative even when a stale textual state remains. */
function isLiveNativeSession(value: RecordValue): boolean {
  if (value.terminal !== null && value.terminal !== undefined) return false;
  // A session journal only exposes a null terminal for work that has not
  // reached a durable terminal observation. Limit the positive state set so
  // malformed/stale historical records cannot masquerade as currently live.
  return ["starting", "started", "running", "active", "draining", "interrupt_requested"].includes(text(value.state, "").toLowerCase());
}

function liveNativeSessionCount(value: unknown): number {
  return sessionRows(value).filter(isLiveNativeSession).length;
}

/**
 * Pilot defect #3: completion appeared "unavailable" at terminal state. Once
 * halted, `halt_reason` alone is a diagnostic string ("gate_failed",
 * "budget_exhausted", …), not an honest completed/partial/failed verdict — an
 * operator glancing at the campaign list could not tell success from
 * failure. `terminal_outcome` (frozen contract, core-state sibling landing it
 * on `listCampaigns()`'s items) is the real verdict; consumed defensively via
 * optional chaining so this renders correctly today with the old
 * `halt_reason`-only fallback and lights up honestly the moment the sibling's
 * field is present, with no code change needed here.
 */
export function status(value: RecordValue): string {
  if (value.halted === true) {
    const outcome = typeof value.terminal_outcome === "string" ? value.terminal_outcome : null;
    if (outcome !== null && outcome !== "in_progress") return outcome;
    return text(value.halt_reason, "halted");
  }
  return text(value.active_node_state, text(value.root_node_state, text(value.status, "idle")));
}

function compactCount(value: number): string {
  if (!Number.isFinite(value)) return "unavailable";
  if (value < 1_000) return String(Math.round(value));
  const units = [[1_000_000_000, "B"], [1_000_000, "M"], [1_000, "K"]] as const;
  const [divisor, suffix] = units.find(([divisor]) => value >= divisor)!;
  const scaled = value / divisor;
  return `${scaled >= 100 ? scaled.toFixed(0) : scaled >= 10 ? scaled.toFixed(1) : scaled.toFixed(2)}${suffix}`;
}

/**
 * Pilot defect #3: cost appeared "unavailable" at terminal state even though
 * `usage_cost` (`ProductSurfaceSnapshot.usage_cost`, populated by `tui.ts`'s
 * `refreshProductSurface`) is real, already-queried ledger data — it was
 * simply never rendered anywhere in the product screens. Mirrors
 * `status-bar.ts`'s own `formatBudget`: sums only the *priced* rows (an
 * unpriced row has no amount to add, and counting it as $0 would fabricate a
 * number G-09 already ruled out), falling back to a real total-token count
 * when every row is unpriced — genuinely queried data, not a placeholder —
 * and only "unavailable" when there is truly nothing to report.
 */
export function costLabel(value: unknown): string {
  const rows = Array.isArray(value) ? (value as readonly UsageCostRow[]) : [];
  if (rows.length === 0) return "unavailable";
  const priced = rows.filter((row): row is Extract<UsageCostRow, { readonly cost_minor_units: number }> => row.tags.pricing === "priced");
  if (priced.length > 0) {
    const [first] = priced;
    const sameUnit = priced.every((row) => row.tags.currency === first.tags.currency && row.tags.minor_unit_exponent === first.tags.minor_unit_exponent);
    if (sameUnit) {
      const total = priced.reduce((sum, row) => sum + row.cost_minor_units, 0);
      return formatCost(total, Number(first.tags.minor_unit_exponent), first.tags.currency);
    }
    return formatCost(first.cost_minor_units, Number(first.tags.minor_unit_exponent), first.tags.currency);
  }
  const totalTokens = rows.reduce((sum, row) => sum + row.input_tokens + row.output_tokens, 0);
  const cachedTokens = rows.reduce((sum, row) => sum + row.cache_read_tokens, 0);
  return totalTokens > 0
    ? `price unavailable · ${compactCount(totalTokens)} provider tokens${cachedTokens > 0 ? ` · ${compactCount(cachedTokens)} cached` : ""}`
    : "unavailable";
}
/** Truncate to `max` display columns with a trailing ellipsis, never mid-surrogate. */
function truncateWithEllipsis(value: string, max: number): string {
  if (displayWidth(value) <= max) return value;
  return `${clipDisplay(value, Math.max(0, max - 1))}…`;
}

/**
 * T4a (TUI dashboard truthfulness sweep): a campaign row was labeled by its
 * raw durable store filename (`plan_path`'s basename, e.g.
 * `draft-<uuid>.json`) instead of the task the operator actually asked for.
 * `listCampaigns()` (arbor-mcp/src/manager.ts) has no task-text field of its
 * own to add one — the only task text reaching this package is each
 * task-composer draft's own `.task`, correlated here by the `campaign_id` a
 * draft records once admitted (`data.drafts`, already fetched alongside
 * `data.campaigns` by `tui.ts`'s `refreshProductSurface`). A campaign with no
 * matching draft (e.g. one admitted before this correlation existed, or one
 * whose draft fell off `taskcomposer.list`'s window) falls back to the prior
 * filename-basename behavior — never fabricated text.
 */
export function draftTaskByCampaignId(drafts: readonly RecordValue[]): ReadonlyMap<string, string> {
  const map = new Map<string, string>();
  for (const item of drafts) {
    const campaignId = typeof item.campaign_id === "string" ? item.campaign_id : null;
    const task = typeof item.task === "string" ? item.task.trim() : "";
    if (campaignId && task) map.set(campaignId, task);
  }
  return map;
}
export function campaignName(value: RecordValue, taskByCampaignId: ReadonlyMap<string, string>): string {
  const id = typeof value.id === "string" ? value.id : "";
  const task = id ? taskByCampaignId.get(id) : undefined;
  if (task) return truncateWithEllipsis(task, 60);
  const path = text(value.plan_path, text(value.name, text(value.id, "unnamed")));
  return path.split("/").at(-1) ?? path;
}
/**
 * `harness.connector.inventory`'s `selection` field, narrowed to just what
 * the readiness projection needs: is a connector actually selected, and is
 * it the native one. `"revoy-native"` is `NATIVE_HARNESS_CONNECTOR_ID`
 * (arbor-mcp/src/harness-control-plane.ts) — mirrored as a literal here
 * rather than imported, since @arbor/tui screens never import @arbor/mcp.
 */
export function selectedConnector(value: unknown): { readonly connectorId: string; readonly isNative: boolean } | null {
  if (!record(value) || !record(value.selection)) return null;
  const selection = value.selection;
  if (selection.kind !== "selected" || typeof selection.connector_id !== "string") return null;
  return { connectorId: selection.connector_id, isNative: selection.connector_id === "revoy-native" };
}

function readinessLabel(readiness: unknown, connector?: unknown): string {
  // Pilot defect #2: the native readiness probe (native-harness-readiness.ts)
  // only ever inspects the direct-native credential path, so it reported a
  // false "credential absent" whenever a different connector (e.g. Claude
  // Code) was the one actually selected for dispatch. When the connector
  // inventory shows a non-native connector is selected, the native check is
  // simply not applicable to the running dispatch path — say so honestly
  // instead of repeating a check that does not describe what is operating.
  // TODO(connector-readiness): once native readiness (or a dedicated
  // harness.connector.readiness query) reports connector-scoped health
  // directly, branch on that here instead of only naming the selection —
  // this cannot fabricate the selected connector's own readiness from data
  // this screen does not have.
  const selected = selectedConnector(connector);
  if (selected !== null && !selected.isNative) {
    return `native check n/a — ${selected.connectorId} connector active`;
  }
  if (!record(readiness)) return "not checked";
  const execution = record(readiness.execution) ? readiness.execution : null;
  const state = text(execution?.kind, text(execution?.status, text(readiness.status, text(readiness.availability, "unknown"))));
  const reason = text(execution?.reason, "");
  return `${state}${reason ? ` · ${reason}` : ""}`.replaceAll("_", " ");
}
function governanceLabel(value: unknown): string {
  if (!record(value)) return "not projected";
  const findings = values(value, "policy_findings");
  const blocking = findings.filter((item) => item.severity === "error" || item.blocking === true).length;
  return blocking === 0 ? "policy clear" : `${blocking} blocking finding${blocking === 1 ? "" : "s"}`;
}
/**
 * `data.project` is a single enrolled-project overlay/manifest state
 * (`inspectProjectOverlay`, arbor-mcp/src/project-lifecycle.ts) — the one
 * real project-enrollment signal that exists. It is distinct from the
 * campaign count below; conflating the two was the pilot's defect #3.
 */
function projectEnrollmentLabel(value: unknown): string {
  return record(value) ? text(value.state, "not enrolled").replaceAll("_", " ") : "not inspected";
}






// WA-55: the three product screens' real data source is `tui.ts`'s
// `refreshProductSurface`, a bespoke composite fetch (not the generic
// per-kind `run_query`/`screenForQueryKind` path) that issues exactly these
// runtime-catalog query kinds on every refresh. Declaring `queries: []`
// understated the real surface and left `screenForQueryKind` unable to
// route a result back to whichever of these screens is focused if one of
// these kinds is ever dispatched through the generic path.
export const PRODUCT_SURFACE_QUERIES: readonly RuntimeQueryKind[] = [
  "campaign.list", "governance.snapshot", "governance.backlog", "job.list", "approval.list",
  "taskcomposer.list", "harness.session.list", "harness.native.readiness", "agent.list",
  "harness.connector.inventory", "userinput.awaiting", "doctor.get", "migration.inspect",
  "integration.list", "remote.inspect", "scheduler.inspect", "notification.list",
  "session.identity.search", "result.verification.list", "followup.list", "result.list",
  "result.inspect", "harness.session.availability", "harness.session.inspect", "harness.session.events",
];

/**
 * One terse operator fact: a label and an already-rendered value.
 *
 * `value` is a string, never a number, because several of these are
 * deliberately NOT counts — "unavailable", "none", and a connector-qualified
 * readiness label all have to survive as themselves. Rendering a genuine
 * absence as `0` is the exact defect the caveats below were written against.
 */
export interface OperatorFact {
  readonly label: string;
  readonly value: string;
}

/**
 * The bounded result-inspection payload is the authoritative source for the
 * operator's captured-result manifest.  It is deliberately a *capture*
 * manifest, not a synthetic campaign-completed verdict: result inspection can
 * exist for one verified node while the wider tree still has work to do.
 *
 * This is kept with ProductSurfaceSnapshot's wire vocabulary so Console can
 * render every disclosed result fact in its primary document without knowing
 * the mcp-side inspection schema.  No fallback prose is invented; absent
 * fields simply remain absent.
 */
export interface CompletionManifestLine {
  readonly label: "STATUS" | "RESULT" | "FILES" | "PATCH" | "VERIFICATION" | "EVIDENCE" | "ADOPTION" | "FOLLOW-UP" | "ACTIONS" | "FEEDBACK";
  readonly value: string;
}

function resultText(value: RecordValue, key: string): string | null {
  const candidate = value[key];
  return typeof candidate === "string" && candidate.trim() ? candidate.trim() : null;
}

/**
 * Projects every bounded result-review disclosure into labelled terminal
 * facts.  `changed_files` is structural data, therefore it is the one field
 * expanded here; all free-form strings were already bounded by the producer.
 */
export function completionManifestLines(value: unknown): readonly CompletionManifestLine[] {
  if (!record(value)) return [];
  const lines: CompletionManifestLine[] = [];
  const push = (label: CompletionManifestLine["label"], key: string): void => {
    const item = resultText(value, key);
    if (item !== null) lines.push({ label, value: item });
  };
  // `status` is a result-review disposition (`ready_for_review`,
  // `scope_authorization_required`, …), not a campaign terminal result. Keep
  // it as a separate, visibly qualified field so the renderer never upgrades
  // a captured node into an overall completion claim.
  const status = resultText(value, "status");
  if (status !== null) lines.push({ label: "STATUS", value: status.replaceAll("_", " ") });
  // FEEDBACK answers the operator's last keystroke (A/S/R), so it sits at the
  // top: as the last of ~10 lines it was the first thing a 30-row terminal
  // clipped, and pressing A there appeared to do nothing.
  push("FEEDBACK", "feedback");
  push("RESULT", "summary");
  const files = Array.isArray(value.changed_files) ? value.changed_files : [];
  const listedFiles = files.flatMap((item) => {
    if (!record(item)) return [];
    const path = resultText(item, "path");
    if (path === null) return [];
    const state = resultText(item, "status");
    return [`${path}${state === null ? "" : ` · ${state}`}`];
  });
  if (listedFiles.length > 0) lines.push({ label: "FILES", value: listedFiles.join(" · ") });
  push("PATCH", "patch_summary");
  push("VERIFICATION", "verification");
  // `metrics` contains only producer-supplied capture facts (including the
  // bounded patch hash and provenance); call it evidence rather than claiming
  // it proves a campaign-level completion.
  push("EVIDENCE", "metrics");
  push("ADOPTION", "adoption");
  push("FOLLOW-UP", "follow_up");
  push("ACTIONS", "controls");
  return Object.freeze(lines.map((line) => Object.freeze(line)));
}

/**
 * The fleet + portfolio facts the Dashboard and Projects screens used to own.
 *
 * Extracted here rather than reimplemented in Console (ADR-149 Decision 7
 * folds those peer screens into the conversational shell). The arithmetic and
 * every truthfulness caveat move verbatim, because each was written against a
 * real observed defect:
 *
 * - `REVIEWS PENDING (root)` counts only ROOT nodes in `awaiting_review`.
 *   `campaign.list` returns each campaign's root node state and nothing
 *   deeper, so a stalled non-root candidate is invisible here. The label says
 *   "(root)" so the number is honest about its own reach rather than implying
 *   a full-tree tally this surface never fetched.
 * - `LIVE NATIVE SESSIONS` counts only nonterminal sessions in
 *   `harness.session.list`, which only ever holds sessions dispatched through
 *   the native harness authority. A session journal is a historical archive;
 *   presenting its complete history as live work was the same misleading
 *   aggregate shape as the old running-jobs count. Under a Claude Code or
 *   other connector this reads 0 while work is genuinely in flight — the
 *   label names "NATIVE" so the 0 is a scope statement, not a claim that
 *   nothing is running.
 * - `APPROVALS` counts governed `ApprovalRecord`s only. An `awaiting_review`
 *   node is a different concept, counted separately above; folding them would
 *   misrepresent both.
 * - `COST` renders the real ledger-derived `usage_cost`, and an absent
 *   projection stays "unavailable" rather than becoming a fabricated `$0`.
 */
export function operatorFleetFacts(data: ProductSurfaceSnapshot): readonly OperatorFact[] {
  const campaigns = campaignRows(data.campaigns);
  const campaignTotal = record(data.campaigns) && typeof data.campaigns.total === "number" ? data.campaigns.total : campaigns.length;
  const active = campaigns.filter((item) => item.halted !== true && !TERMINAL_ROOT_STATES.includes(text(item.root_node_state, ""))).length;
  const verified = campaigns.reduce((sum, item) => sum + number(item.verified_nodes), 0);
  const rootAwaitingReview = campaigns.filter((item) => item.root_node_state === "awaiting_review").length;
  const outcomeCounts = new Map<string, number>();
  for (const item of campaigns.filter((entry) => entry.halted === true)) {
    const outcome = typeof item.terminal_outcome === "string" && item.terminal_outcome !== "in_progress" ? item.terminal_outcome : "halted";
    outcomeCounts.set(outcome, (outcomeCounts.get(outcome) ?? 0) + 1);
  }
  return [
    { label: "CAMPAIGNS", value: String(campaignTotal) },
    { label: "ACTIVE", value: String(active) },
    { label: "VERIFIED NODES", value: String(verified) },
    { label: "APPROVALS", value: String(approvalRows(data.approvals).filter((item) => item.status === "pending").length) },
    { label: "ACTIVE JOBS", value: String(activeJobCount(data.jobs)) },
    { label: "REVIEWS PENDING (root)", value: String(rootAwaitingReview) },
    { label: "LIVE NATIVE SESSIONS", value: String(liveNativeSessionCount(data.sessions)) },
    { label: "ENROLLMENT", value: projectEnrollmentLabel(data.project) },
    { label: "GOVERNANCE", value: governanceLabel(data.governance) },
    { label: "EXECUTION", value: readinessLabel(data.readiness, data.connector) },
    { label: "TERMINAL OUTCOMES", value: outcomeCounts.size === 0 ? "none" : [...outcomeCounts.entries()].map(([outcome, count]) => `${count} ${outcome}`).join(" · ") },
    { label: "COST", value: costLabel(data.usage_cost) },
  ];
}

/**
 * The operations facets the Cockpit's PRODUCT OPERATIONS block used to own.
 *
 * `product_operations` is assembled by the composition root from nine real
 * inspect queries. Each facet reports what its query actually returned:
 * a record's own status/state/summary, a record COUNT for a list, and
 * "unavailable" when the query returned nothing. "unavailable" is a genuine
 * answer here — the query ran and produced no usable value — and must not be
 * rendered as a zero or a cheerful default.
 */
export function operatorOperationsFacts(data: ProductSurfaceSnapshot): readonly OperatorFact[] {
  const source = record(data.product_operations) ? data.product_operations : null;
  if (source === null) return [];
  const facet = (key: string): string => {
    const item = source[key];
    if (item === null || item === undefined) return "unavailable";
    if (Array.isArray(item)) return `${item.length} record(s)`;
    if (record(item)) return text(item.status, text(item.state, text(item.summary, "available"))).replaceAll("_", " ");
    return "unavailable";
  };
  return [
    { label: "DOCTOR", value: facet("doctor") },
    { label: "MIGRATION", value: facet("migration") },
    { label: "REMOTE", value: facet("remote") },
    { label: "SCHEDULER", value: facet("scheduler") },
    { label: "NOTIFICATIONS", value: facet("notifications") },
    { label: "VERIFICATION", value: facet("verification") },
    { label: "FOLLOW-UP LINEAGE", value: facet("lineage") },
  ];
}

/**
 * The portfolio facts the Projects screen used to own: roadmap/draft depth,
 * the extensibility inventory, and the pilot-workflow catalogue by category.
 *
 * `NEXT ROADMAP` is the first backlog item's own title/description/id, in that
 * order of preference — never a fabricated placeholder when the queue is
 * genuinely empty.
 */
export function operatorPortfolioFacts(data: ProductSurfaceSnapshot): readonly OperatorFact[] {
  const backlog = backlogRows(data.backlog);
  const extensions = record(data.extensions) ? data.extensions : {};
  const categoryOrder: readonly PilotWorkflowCategory[] = ["project", "plan", "supervise", "intervene", "recover", "delegate", "govern", "integrate", "finish"];
  const workflows = categoryOrder
    .map((category) => ({ category, count: PILOT_WORKFLOWS.filter((workflow) => workflow.category === category).length }))
    .filter((entry) => entry.count > 0)
    .map((entry) => `${entry.category.toUpperCase()} ${entry.count}`);
  return [
    { label: "ROADMAP", value: String(backlog.length) },
    { label: "DRAFTS", value: String(draftRows(data.drafts).length) },
    { label: "AGENTS", value: String(values(data.agents, "definitions").length) },
    { label: "PROJECT COMMANDS", value: String(number(extensions.commands)) },
    { label: "SKILLS", value: String(number(extensions.skills)) },
    { label: "PILOT WORKFLOWS", value: workflows.join(" · ") || "none" },
    { label: "NEXT ROADMAP", value: backlog.length ? text(backlog[0]?.title, text(backlog[0]?.description, text(backlog[0]?.id, "available"))) : "none queued" },
  ];
}
