/**
 * liveness-consumers.ts — the declared consumers the attestation family probes.
 *
 * Each entry mirrors a request some part of the product actually issues on a
 * real run, built the way that consumer builds it. The mirroring is the point
 * and also the weakness, so both are stated plainly:
 *
 * WHY MIRROR AT ALL. The catalog prober asks "does this seam answer when called
 * correctly", and answers it with the *prober's* payload. That is a genuinely
 * different question from "does this consumer call it correctly", and the gap
 * between them is where the diagnostics defect lived for an entire release
 * cycle: `refreshScreenData` issued `event.resume` with `cursor: 0` where
 * `RuntimeCursor` is `{stream_id, sequence}`. The call site existed, was
 * reachable, and was covered by a passing screen-projection test — every static
 * gate in this repository was green while the screen rendered nothing on any
 * real run. A catalog probe would have reported `event.resume` perfectly
 * healthy, because the prober's own cursor was well-formed.
 *
 * WHAT THIS COSTS. A mirrored request can drift from the consumer it mirrors,
 * and then attests to something nobody runs. There is no way around that short
 * of executing the consumer itself, which for the TUI means driving a terminal.
 * Two things bound the damage: drift shows up as `indeterminate` or a changed
 * outcome rather than a false green, and `consumersCoverScreens` below fails
 * the build when a screen with a known dispatch has no declared consumer, so
 * the table cannot silently fall behind the thing it mirrors.
 *
 * The honest ceiling: this attests that the request shape a consumer sends is
 * one the runtime accepts. It does not attest that the consumer sends it, that
 * the response is rendered, or that a human would recognise the result. Those
 * are the screen tests' job, and they remain necessary.
 */

import type { DeclaredConsumer } from "./liveness.js";

/**
 * TUI screens whose `refreshScreenData` branch issues a query with no
 * contextual-selection requirement. Kept in the same order as `tui.ts`'s own
 * branch chain so a reader can diff the two by eye.
 */
export const TUI_SCREEN_CONSUMERS: readonly DeclaredConsumer[] = [
  { consumer: "tui:interviews", kind: "userinput.list", request: (ctx) => ({ campaign_id: ctx.campaign_id, limit: 50 }) },
  { consumer: "tui:approvals", kind: "approval.list", request: () => ({ status: "pending", limit: 50 }) },
  { consumer: "tui:campaigns", kind: "campaign.list", request: () => ({ limit: 50 }) },
  { consumer: "tui:tasks", kind: "task.list", request: () => ({ limit: 50 }) },
  { consumer: "tui:task-composer", kind: "taskcomposer.list", request: () => ({ limit: 100 }) },
  { consumer: "tui:result-review", kind: "result.review.workspace", request: (ctx) => ({ campaign_id: ctx.campaign_id, max_patch_bytes: 1_048_576 }) },
  { consumer: "tui:control", kind: "control.status", request: () => ({}) },
  { consumer: "tui:agents", kind: "agent.list", request: () => ({}) },
  { consumer: "tui:config", kind: "config.get", request: () => ({}) },
  { consumer: "tui:native-budget", kind: "native.budget.get", request: (ctx) => ({ campaign_id: ctx.campaign_id }) },
  { consumer: "tui:jobs", kind: "job.list", request: () => ({}) },
  {
    // The record of the defect this family exists for. `cursor` is a
    // `RuntimeCursor` record, never a bare number.
    consumer: "tui:diagnostics",
    kind: "event.resume",
    request: (ctx) => ({ cursor: { stream_id: ctx.stream_id, sequence: 0 } }),
  },
  { consumer: "tui:tree", kind: "campaign.tree", request: (ctx) => ({ campaign_id: ctx.campaign_id, limit: 200 }) },
  { consumer: "tui:operations", kind: "operation.list", request: () => ({ include_terminal: false }) },
  { consumer: "tui:recovery", kind: "recovery.pending", request: (ctx) => ({ campaign_id: ctx.campaign_id, limit: 200 }) },
  { consumer: "tui:output", kind: "output.list", request: () => ({}) },
  { consumer: "tui:governance", kind: "governance.snapshot", request: () => ({}) },
  // Finding 15 (TUI-vs-backend observability gap audit): the backlog screen's
  // dispatch, mirroring governance above — no contextual selection required.
  { consumer: "tui:backlog", kind: "governance.backlog", request: () => ({}) },
  // Finding 8/9: kb/audit are campaign-scoped, same shape as tasks/interviews.
  { consumer: "tui:kb", kind: "kb.list", request: (ctx) => ({ campaign_id: ctx.campaign_id, limit: 200 }) },
  { consumer: "tui:audit", kind: "audit.list", request: (ctx) => ({ campaign_id: ctx.campaign_id, limit: 200 }) },
  { consumer: "tui:compaction", kind: "compaction.list", request: (ctx) => ({ campaign_id: ctx.campaign_id, limit: 200 }) },
  { consumer: "tui:siblings", kind: "sibling.status", request: (ctx) => ({ campaign_id: ctx.campaign_id, node_id: ctx.node_id }) },
  { consumer: "tui:surveillance", kind: "surveillance.findings", request: (ctx) => ({ campaign_id: ctx.campaign_id, limit: 200 }) },
  { consumer: "tui:capabilities", kind: "capability.introspect", request: () => ({}) },
  { consumer: "tui:trust", kind: "trust.session.list", request: () => ({ limit: 100 }) },
  { consumer: "tui:harness-connectors", kind: "harness.connector.inventory", request: () => ({}) },
  { consumer: "tui:harness-readiness", kind: "harness.native.readiness", request: () => ({}) },
  { consumer: "tui:harness-sessions", kind: "harness.session.list", request: () => ({ limit: 200 }) },
  // ADR-107 3: the live-session screen reads the same governed session list
  // and projects only the attachable ones; it is a second consumer of one kind,
  // not a second authority.
  { consumer: "tui:live-session", kind: "harness.session.list", request: () => ({ limit: 200 }) },
  { consumer: "tui:threads", kind: "bus.thread.history", request: (ctx) => ({ campaign_id: ctx.campaign_id, parent_node_id: ctx.node_id, child_node_id: ctx.child_node_id, limit: 200 }) },
  { consumer: "tui:overlays", kind: "context.overlays", request: (ctx) => ({ campaign_id: ctx.campaign_id }) },
  { consumer: "tui:harness-evaluations", kind: "harness.evaluation.runs", request: (ctx) => ({ campaign_id: ctx.campaign_id }) },
  {
    consumer: "tui:communications",
    kind: "communication.selection",
    request: (ctx) => ({ campaign_id: ctx.campaign_id, node_id: ctx.node_id, limit: 50 }),
  },
  // The project-registry screen dispatches on focus, so it needs a declared
  // consumer like any other — a screen that issues a real request shape with
  // nothing attesting to it is exactly the drift this family bounds. Sent
  // unscoped: the screen's own default lists every enrolled project, and the
  // per-entry re-check narrows to a project_id only on operator selection.
  { consumer: "tui:project-registry", kind: "project.registry.list", request: () => ({}) },
  // The a2a plane's two read seams. Both are campaign-wide with no per-node
  // selection, the same idiom compaction.list uses, and both got dedicated
  // screen slots so their results never fight another query for the same
  // `model.screens` entry.
  { consumer: "tui:bus", kind: "bus.history", request: (ctx) => ({ campaign_id: ctx.campaign_id, limit: 200 }) },
  { consumer: "tui:a2a", kind: "a2a.cards", request: (ctx) => ({ campaign_id: ctx.campaign_id }) },
];

/** Every screen id above, for the drift check below. */
const DECLARED_CONSUMER_SCREENS: readonly string[] = TUI_SCREEN_CONSUMERS.map((c) => c.consumer);

/**
 * Screens whose `refreshScreenData` branch issues a query, read from `tui.ts`.
 *
 * Extracted textually rather than imported because `runTui` builds its `issue`
 * closure inside the function body — there is no exported table to read. A
 * textual scan is weaker than a real import and is treated as such: it reports
 * what it found and lets the caller decide, rather than asserting completeness
 * it cannot establish.
 */
export function screensWithDispatch(tuiSource: string): string[] {
  const found = new Set<string>();
  // `[a-z0-9-]+`, not `[a-z-]+`: the "a2a" screen dispatches a real query and
  // was invisible to this scan because its id contains a digit. A screen the
  // extractor cannot see is a screen this family silently stops bounding,
  // which is the precise failure the textual-scan caveat below warns about.
  const branch = /screen === "([a-z0-9-]+)"/g;
  let match: RegExpExecArray | null;
  const segments: { screen: string; index: number }[] = [];
  while ((match = branch.exec(tuiSource))) segments.push({ screen: match[1], index: match.index });

  for (let i = 0; i < segments.length; i++) {
    const start = segments[i].index;
    const end = i + 1 < segments.length ? segments[i + 1].index : tuiSource.length;
    if (/\bissue\(/.test(tuiSource.slice(start, end))) found.add(segments[i].screen);
  }
  return [...found].sort();
}

/**
 * Screens that dispatch but have no declared consumer — i.e. real request
 * shapes nothing attests to. Empty is the healthy state.
 */
export function consumersCoverScreens(tuiSource: string): string[] {
  const declared = new Set(DECLARED_CONSUMER_SCREENS.map((id) => id.replace(/^tui:/, "")));
  // Both screens use RuntimePortAdapter's permanent `devtools.stream`
  // exception rather than a runtime-catalog query, so this catalog-consumer
  // family cannot probe them. Their real-stdin screen tests exercise the
  // adapter dispatch and rendered result instead.
  const exempt = new Set(["devtools", "command-history"]);
  return screensWithDispatch(tuiSource).filter((screen) => !declared.has(screen) && !exempt.has(screen));
}
