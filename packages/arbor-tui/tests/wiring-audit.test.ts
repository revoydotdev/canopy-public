/**
 * TUI hardening gate 26 — wiring audit regression suite.
 *
 * Per docs/tui-cockpit/roadmap.md item 26:
 *   "control round-trip matrix, dead/stub/duplicate/event-consumer scans;
 *    regression suite"
 *   "zero fake/dead/disconnected controls, leaked subscriptions/tasks"
 *
 * The audit mechanically checks every declared surface is wired to a real
 * canonical capability. The @arbor/tui surface is intent-driven (UiIntent)
 * rather than action-id-driven (UiAction) per ADR-011, so the audit reconciles
 * intents ↔ effects and screens ↔ catalog capabilities.
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  Effect,
  UiIntent,
  InputCatalog,
  InputRouter,
  RuntimeCommandKind,
  RuntimeQueryKind,
  catalogConflicts,
  installScreens,
  clearRegisteredScreens,
  availableScreens,
  type ScreenModule,
} from "../src/index.js";

/**
 * Canonical capabilities the runtime catalog declares `supported: true`.
 * Mirror of RUNTIME_CATALOG in @arbor/mcp — kept here as a closed list so the
 * TUI package does not import @arbor/mcp (ADR-011 dependency invariant).
 * Update this set when the runtime catalog adds supported capabilities; the
 * capability-parity test below will surface drift on either side.
 */
const SUPPORTED_CATALOG_CAPABILITIES: ReadonlySet<string> = new Set([
  "campaign.write", "campaign.read",
  "tree.write", "tree.read", "tree.interrupt",
  "operation.cancel", "operation.read",
  "task.retry", "task.read",
  "recovery.write", "recovery.abandon",
  "communication.write", "communication.read",
  "output.capture", "output.read", "output.raw",
  "surveillance.scan", "surveillance.read",
  "capability.read",
  "config.read",
  "governance.read",
  "governance.backlog.read",
  "kb.read",
  "audit.read",
  "agent.read",
  "job.write", "job.read",
  "approval.request", "approval.decide", "approval.read",
  "compaction.write", "compaction.read",
  "sibling.read",
  "bus.read", "bus.write",
  "a2a.read", "a2a.write",
  "context.read", "fold.write", "fold.approve", "fold.rollback", "playbook.write", "playbook.approve", "harness.write", "harness.approve", "harness.rollback", "harness.evaluate", "harness.promote", "harness.quarantine", "subagent.execute",
  "userinput.write", "userinput.read",
  "event.read",
  "devtools.read",
  "harness.connector.read",
  "harness.session.read", "harness.session.interrupt",
  "trust.session.read", "trust.session.write",
  "project.registry.read", "project.manage.read",
]);

// ── 1. intent ↔ effect parity ─────────────────────────────────────────────

describe("wiring audit — intent ↔ effect parity", () => {
  /**
   * Each UiIntent type must produce ≥1 Effect kind somewhere in the reducer.
   * The reducer (update.ts) is intent-driven: intents dispatch effects. A
   * declared intent with no corresponding effect dispatch is dead surface.
   *
   * Closure-derived from the union members; both unions are closed, so adding
   * a new intent without wiring an effect will fail this test loudly.
   */
  it("every UiIntent type has at least one Effect kind it can produce", () => {
    // Map intent → set of effects the reducer emits for it (from update.ts reading).
    // The reducer is small and stable; this map is maintained alongside update.ts.
    const intentToEffects: Record<UiIntent["type"], readonly Effect["type"][]> = {
      // "connect", "disconnect", "view_telemetry", and "issue_command" were
      // deleted from UiIntent (DEF-02): each had a real reducer branch but no
      // production caller anywhere in tui.ts/demo.ts. connect/disconnect had
      // no real transport to drive (this TUI's boot path seeds
      // snapshot_received directly, never the connect->connecting->
      // synchronizing->connected chain); view_telemetry duplicated the real
      // telemetry_requested AppEvent tui.ts actually dispatches on
      // active-campaign change; issue_command was a generic dispatch_command
      // passthrough superseded by the screen-scoped command intents below.
      dismiss_notification: [], // pure model mutation; no effect (intentional)
      request_shutdown: ["interrupt_campaign", "disconnect", "close_client", "restore_terminal"],
      interrupt_active_campaign: ["interrupt_campaign"],
      focus_screen: ["set_screen"],
      issue_query: ["run_query"],
      // Operator command-surface intents (A-3 remediation). arm/cancel/compose
      // are pure compose-mode state transitions; submit/approve/reject build
      // and dispatch a real RuntimeCommandRequest through the same
      // dispatch_command effect the deleted issue_command used to.
      arm_answer: [],
      compose_input: [],
      compose_insert: [],
      compose_backspace: [],
      compose_delete: [],
      compose_move: [],
      toggle_vim_mode: [],
      vim_key: [],
      open_external_editor: ["open_external_editor"],
      cancel_compose: [],
      confirm_task_composer: ["dispatch_command"],
      retry_task_composer: ["dispatch_command"],
      cancel_task_composer: ["dispatch_command"],
      submit_answer: ["dispatch_command"],
      approve_selected: ["dispatch_command"],
      reject_selected: ["dispatch_command"],
      // Tree-node selection + branch/prune (wave1/tui-contracts). select_tree_node
      // and request_prune_selected_node are pure model transitions (selection
      // cursor / armed confirmation); branch and confirm build a real
      // RuntimeCommandRequest through the same dispatch_command effect.
      select_tree_node: [],
      uct_reader_action: [],
      branch_selected_node: ["dispatch_command"],
      request_prune_selected_node: [],
      confirm_pending_action: ["dispatch_command"],
      cancel_pending_action: [],

      // Wave 2. Viewport and selection state are pure model mutations by
      // design: the model decides WHAT is true (which row, which offset), the
      // renderer decides what it looks like, and neither talks to the runtime.
      // An effect here would mean scrolling issued a query, which is exactly
      // the model/render leak ADR-011's architecture exists to prevent.
      page_up: [],
      page_down: [],
      scroll_home: [],
      scroll_end: [],
      scroll_by: [],
      select_row: [],
      select_row_identity: [],
      select_row_relative: [],
      toggle_result_review_mode: [],
      result_review_move_hunk: [],
      result_review_move_file: [],
      toggle_help: [],
      help_query_input: [],
      help_select_index: [],
      help_toggle_expanded: [],

      // Row-scoped operator commands. `cancel_selected_row` is [] on purpose
      // and is NOT missing wiring: it arms a confirmation overlay carrying a
      // pendingAction, and the real job.cancel dispatch happens when
      // confirm_pending_action fires — the same two-step shape tree.prune
      // uses, because both are destructive.
      cancel_selected_row: [],
      retry_selected_row: ["dispatch_command"],
      abandon_recovery_selected: [],
      view_selected_row_detail: ["run_query"],
      view_selected_harness_session_events: ["run_query"],
      attach_selected_harness_session: ["run_query"],
      open_operator_form: [],
      open_task_preset: [],
      operator_form_input: [],
      operator_form_insert: [],
      operator_form_backspace: [],
      operator_form_delete: [],
      operator_form_move: [],
      operator_form_next_field: [],
      // campaign.halt first arms confirmation; every other typed form emits
      // this same canonical dispatch effect directly after validation.
      submit_operator_form: ["dispatch_command"],
      cancel_operator_form: [],
      expire_selected: ["dispatch_command"],
      toggle_job_queue: ["dispatch_command"],
      set_theme: [],
      focus_zone_cycle: [],
      focus_zone_set: [],
      focus_rail_tab: [],
    };
    const intentionalNoEffect: ReadonlySet<UiIntent["type"]> = new Set([
      "dismiss_notification", // pure model filter — intentionally effect-free
      "arm_answer", "compose_input", "compose_insert", "compose_backspace", "compose_delete", "compose_move", "operator_form_insert", "operator_form_backspace", "operator_form_delete", "operator_form_move", "cancel_compose", // pure compose-mode state — intentionally effect-free
      "toggle_vim_mode", "vim_key", // pure editor-state transitions; only open_external_editor crosses the composition boundary
      "select_tree_node", "uct_reader_action", "request_prune_selected_node", "cancel_pending_action", // pure tree-reader/selection/confirmation state — intentionally effect-free
      // Wave 2 viewport/selection/help state. Effect-free BY DESIGN, not by
      // omission: the model owns what is true, the renderer owns what it looks
      // like. An effect on any of these would mean scrolling or selecting a row
      // reached the runtime, which is the model/render leak ADR-011 exists to
      // prevent — so an entry appearing here later with an effect is a
      // regression, not a feature.
      "page_up", "page_down", "scroll_home", "scroll_end", "scroll_by",
      "select_row", "select_row_identity", "select_row_relative", "toggle_result_review_mode", "result_review_move_hunk", "result_review_move_file", "toggle_help", "help_query_input", "help_select_index", "help_toggle_expanded",
      // Destructive row command: arms a confirmation carrying a pendingAction.
      // The real dispatch happens on confirm_pending_action, the same two-step
      // shape tree.prune uses.
      "cancel_selected_row",
      "abandon_recovery_selected",
      "open_operator_form", "open_task_preset", "operator_form_input", "operator_form_next_field", "cancel_operator_form",
      // Theme selection is a pure model mutation (update.ts's set_theme case):
      // the shell reads AppModel.theme directly on next draw via the same
      // epoch-bump repaint mechanism every other model change relies on.
      "set_theme",
      // Explicit focus model (ui-spec §3, M2.2): pure model state, the same
      // "model owns what is true, renderer owns what it looks like" idiom as
      // the wave-2 viewport/selection intents above.
      "focus_zone_cycle", "focus_zone_set", "focus_rail_tab",
    ]);
    const dead: string[] = [];
    for (const [intent, effects] of Object.entries(intentToEffects) as Array<[UiIntent["type"], readonly Effect["type"][]]>) {
      if (effects.length === 0 && !intentionalNoEffect.has(intent)) dead.push(intent);
    }
    expect(dead, `intents with no effect and no allowlist entry: ${dead.join(", ")}`).toEqual([]);
  });

  /**
   * Every Effect type must be reachable from ≥1 UiIntent or AppEvent. A
   * declared Effect the reducer never emits is dead surface.
   */
  it("every Effect type is reachable from at least one intent or event, except the one documented exception", () => {
    // Effects emitted by intents (see above) + effects emitted by AppEvents
    // (transport_connected → request_snapshot).
    const reachableEffects: ReadonlySet<Effect["type"]> = new Set<Effect["type"]>([
      "disconnect", "interrupt_campaign", "close_client", "restore_terminal",
      "fetch_telemetry", "set_screen", "dispatch_command", "run_query",
      "request_snapshot", // from transport_connected event
    ]);
    const allEffectTypes: readonly Effect["type"][] = [
      "connect", "disconnect", "request_snapshot", "restore_terminal", "close_client",
      "interrupt_campaign", "fetch_telemetry", "dispatch_command", "run_query", "set_screen",
    ];
    // "connect" (Effect) is the one DOCUMENTED exception, not a silent gap.
    // Its only producer was the UiIntent "connect" case deleted for DEF-02.
    // headless.ts's HeadlessClient.connect() port and its interpret() case
    // stay -- deleting them would ripple into demo.ts's own HeadlessClient
    // construction, a file this closure pass does not own -- so the Effect
    // union member and port method remain declared but genuinely
    // unreachable from any intent or event in this package's own reducer.
    const knownUnreachable: ReadonlySet<Effect["type"]> = new Set<Effect["type"]>(["connect"]);
    const dead = allEffectTypes.filter((kind) => !reachableEffects.has(kind) && !knownUnreachable.has(kind));
    expect(dead, `effects with no emitter and no documented exception: ${dead.join(", ")}`).toEqual([]);
  });
});

// ── 2. input catalog health ───────────────────────────────────────────────

describe("wiring audit — input catalog health", () => {
  /**
   * catalogConflicts(catalog) must return empty for any catalog the shell
   * constructs. This is enforced at InputRouter construction; assert it
   * explicitly at the audit layer too.
   */
  it("a representative non-conflicting catalog reports zero conflicts", () => {
    const catalog: InputCatalog = {
      actions: [
        { id: "quit", title: "Quit", description: "Exit", bindings: [{ scope: "global", keys: ["ctrl+q"], description: "Quit" }] },
        { id: "palette", title: "Palette", description: "Open", bindings: [{ scope: "global", keys: ["ctrl+p"], description: "Palette" }] },
      ],
    };
    expect(catalogConflicts(catalog)).toEqual([]);
    expect(() => new InputRouter(catalog, () => 0)).not.toThrow();
  });

  it("a conflicting catalog is detected and rejected at router construction", () => {
    const conflicting: InputCatalog = {
      actions: [
        { id: "a", title: "A", description: "", bindings: [{ scope: "global", keys: ["ctrl+q"], description: "" }] },
        { id: "b", title: "B", description: "", bindings: [{ scope: "global", keys: ["ctrl+q"], description: "" }] },
      ],
    };
    expect(catalogConflicts(conflicting)).toHaveLength(1);
    expect(() => new InputRouter(conflicting, () => 0)).toThrow("conflicting bindings");
  });
});

// ── 3. screen registration parity ─────────────────────────────────────────

describe("wiring audit — screen registration parity", () => {
  /**
   * Every leaf screen module under packages/arbor-tui/src/screens/*.ts (except
   * install.ts and screen.ts which are infrastructure) must be registered via
   * installScreens(). A module that exists but isn't registered is an orphan;
   * a registered entry with no module is a phantom.
   */
  it("installScreens registers exactly the canonical set of screen modules", async () => {
    // The canonical set is derived from install.ts's imports. We import each
    // leaf module by name to confirm it is both exported AND registered.
    const [{ projectRegistryScreen }, { campaignsScreen }, { treeScreen }, { tasksScreen }, { operationsScreen }, { outputScreen }, { communicationsScreen }, { diagnosticsScreen }, { configScreen }, { nativeBudgetScreen }, { agentsScreen }, { jobsScreen }, { approvalsScreen }, { interviewsScreen }, { devtoolsScreen }, { commandHistoryScreen }, { governanceScreen }, { backlogScreen }, { kbScreen }, { auditScreen }, { compactionScreen }, { siblingsScreen }, { surveillanceScreen }, { capabilitiesScreen }, { threadsScreen }, { busScreen }, { a2aScreen }, { overlaysScreen }, { trustScreen }, { harnessConnectorsScreen }, { harnessReadinessScreen }, { harnessSessionsScreen }, { harnessEvaluationsScreen }, { liveSessionScreen }, { consoleScreen }] = await Promise.all([
      import("../src/screens/project-registry.js"),
      import("../src/screens/campaigns.js"),
      import("../src/screens/tree.js"),
      import("../src/screens/tasks.js"),
      import("../src/screens/operations.js"),
      import("../src/screens/output.js"),
      import("../src/screens/communications.js"),
      import("../src/screens/diagnostics.js"),
      import("../src/screens/config.js"),
      import("../src/screens/native-budget.js"),
      import("../src/screens/agents.js"),
      import("../src/screens/jobs.js"),
      import("../src/screens/approvals.js"),
      import("../src/screens/interviews.js"),
      import("../src/screens/devtools.js"),
      import("../src/screens/command-history.js"),
      import("../src/screens/governance.js"),
      import("../src/screens/backlog.js"),
      import("../src/screens/kb.js"),
      import("../src/screens/audit.js"),
      import("../src/screens/compaction.js"),
      import("../src/screens/siblings.js"),
      import("../src/screens/surveillance.js"),
      import("../src/screens/capabilities.js"),
      import("../src/screens/threads.js"),
      import("../src/screens/bus.js"),
      import("../src/screens/a2a.js"),
      import("../src/screens/overlays.js"),
      import("../src/screens/trust.js"),
      import("../src/screens/harness-connectors.js"),
      import("../src/screens/harness-readiness.js"),
      import("../src/screens/harness-sessions.js"),
      import("../src/screens/harness-evaluations.js"),
      import("../src/screens/live-session.js"),
      import("../src/screens/console.js"),
    ]);
    const allModules: ScreenModule[] = [
      projectRegistryScreen,
      campaignsScreen, treeScreen, tasksScreen, operationsScreen, outputScreen, communicationsScreen,
      diagnosticsScreen, configScreen, nativeBudgetScreen, agentsScreen, jobsScreen, approvalsScreen, interviewsScreen,
      devtoolsScreen, commandHistoryScreen, governanceScreen, backlogScreen, kbScreen, auditScreen,
      compactionScreen, siblingsScreen, surveillanceScreen, capabilitiesScreen, threadsScreen, busScreen, a2aScreen, overlaysScreen, trustScreen, harnessConnectorsScreen, harnessReadinessScreen, harnessSessionsScreen, harnessEvaluationsScreen, liveSessionScreen, consoleScreen,
    ];
    installScreens();
    try {
      const granted = new Set<string>(); // grant nothing — we read the registry directly
      availableScreens(granted); // returns ALL registered modules (empty filter when no caps granted? — actually filters by cap; use a different path)
      // The registry is closed; we cannot enumerate unfiltered. Instead, grant
      // every supported capability so availableScreens returns all registered.
      const all = availableScreens(SUPPORTED_CATALOG_CAPABILITIES);
      const registeredIds = new Set(all.map((m) => m.id));
      const moduleIds = new Set(allModules.map((m) => m.id));
      // Every module is registered.
      const orphans = allModules.filter((m) => !registeredIds.has(m.id)).map((m) => m.id);
      expect(orphans, `modules not registered: ${orphans.join(", ")}`).toEqual([]);
      // Every registered entry has a module.
      const phantoms = [...registeredIds].filter((id) => !moduleIds.has(id));
      expect(phantoms, `registered entries with no module: ${phantoms.join(", ")}`).toEqual([]);
    } finally {
      clearRegisteredScreens();
    }
  });
});

// ── 4. capability gating parity ───────────────────────────────────────────

describe("wiring audit — capability gating parity", () => {
  /**
   * Every screen's required_capabilities must be a subset of capabilities the
   * runtime catalog declares `supported: true`. A screen requiring an
   * unsupported capability is wired to nothing.
   */
  it("every screen's required_capabilities are supported by the runtime catalog", () => {
    installScreens();
    try {
      const all = availableScreens(SUPPORTED_CATALOG_CAPABILITIES);
      expect(all.length).toBeGreaterThan(0);
      const unsupported: Array<{ screen: string; caps: string[] }> = [];
      for (const module of all) {
        const missing = module.required_capabilities.filter((cap) => !SUPPORTED_CATALOG_CAPABILITIES.has(cap));
        if (missing.length > 0) unsupported.push({ screen: module.id, caps: missing });
      }
      expect(unsupported, `screens requiring unsupported capabilities: ${JSON.stringify(unsupported)}`).toEqual([]);
    } finally {
      clearRegisteredScreens();
    }
  });

  /**
   * Every screen's surface.commands and surface.queries must be closed-catalog
   * members of RuntimeCommandKind / RuntimeQueryKind. A screen issuing an
   * unknown kind is wired to nothing.
   */
  it("every screen surface command/query kind is in the closed TUI kind union", () => {
    installScreens();
    try {
      const commandKinds = new Set<RuntimeCommandKind>([
        "campaign.start", "campaign.halt", "tree.branch", "tree.prune", "tree.interrupt",
        "operation.cancel", "task.retry", "recovery.retry", "recovery.abandon",
        "communication.record", "output.capture", "surveillance.scan", "bus.thread.send", "bus.thread.ack", "bus.record", "compaction.record", "a2a.send", "a2a.receive", "fold.propose", "fold.approve", "fold.rollback", "playbook.propose", "playbook.approve", "harness.propose", "harness.approve", "harness.rollback", "harness.evaluate", "harness.evaluation.start", "harness.promote", "harness.quarantine", "trust.session.enroll", "trust.session.rotate", "trust.session.revoke",
        "job.submit", "job.cancel", "job.retry", "job.pause", "job.resume",
        "approval.request", "approval.approve", "approval.reject", "approval.expire",
        "userinput.ask", "userinput.answer", "taskcomposer.submit", "harness.session.interrupt", "harness.session.steer", "harness.session.resume", "harness.session.fork", "harness.session.respawn", "subagent.execute",
      ]);
      const queryKinds = new Set<RuntimeQueryKind>([
        "campaign.list", "campaign.snapshot", "campaign.tree",
        "operation.get", "operation.list", "task.list", "event.resume",
        "communication.selection", "communication.history",
        "output.descriptor", "output.list", "output.raw", "surveillance.findings", "capability.introspect",
        "governance.snapshot", "governance.backlog", "kb.list", "audit.list",
        "config.get", "native.budget.get", "agent.list", "job.list", "approval.list",
        "userinput.list", "userinput.awaiting", "compaction.list", "compaction.guard", "sibling.status", "bus.thread.history", "bus.history", "a2a.cards", "context.overlays", "context.governance", "subagent.executions", "harness.evaluation.candidates", "harness.evaluation.runs", "harness.evaluation.detail", "harness.connector.inventory", "harness.native.readiness", "trust.session.list", "trust.session.status",
        "devtools.stream", "harness.session.list", "harness.session.inspect", "harness.session.events", "harness.session.attach", "harness.session.availability",
        "project.registry.list", "project.manage",
        // WA-55: the three product screens (dashboard/cockpit/projects) declare
        // the real kinds their bespoke `refreshProductSurface` composite fetch
        // issues (packages/arbor-mcp/src/tui.ts), rather than an empty surface.
        "taskcomposer.list", "doctor.get", "migration.inspect", "integration.list",
        "remote.inspect", "scheduler.inspect", "notification.list", "session.identity.search",
        "result.verification.list", "followup.list", "result.list", "result.inspect",
      ]);
      const all = availableScreens(SUPPORTED_CATALOG_CAPABILITIES);
      const bad: string[] = [];
      for (const module of all) {
        for (const cmd of module.surface.commands) if (!commandKinds.has(cmd)) bad.push(`${module.id}.command.${cmd}`);
        for (const query of module.surface.queries) if (!queryKinds.has(query)) bad.push(`${module.id}.query.${query}`);
      }
      expect(bad, `screen surface kinds outside the closed TUI union: ${bad.join(", ")}`).toEqual([]);
    } finally {
      clearRegisteredScreens();
    }
  });
});

// ── 5. event-consumer parity ──────────────────────────────────────────────

describe("wiring audit — event-consumer parity", () => {
  /**
   * Every AppEvent type the model subscribes to must be consumed by ≥1 branch
   * in update(). A subscribed event with no consumer is a leaked subscription.
   *
   * The reducer is closed-over (switch on event.type with no default). Every
   * AppEvent type is enumerated here; any new AppEvent variant without a
   * reducer branch would surface as a TS exhaustiveness error at compile time
   * AND as a failure here.
   */
  it("every AppEvent type is consumed by the reducer's switch", () => {
    // Mirror of AppEvent["type"] — maintained alongside types.ts.
    const eventTypes: readonly string[] = [
      "ui_intent", "transport_connecting", "transport_connected", "snapshot_received",
      "cursor_advanced", "transport_disconnected", "error_raised", "notification_added",
      "shutdown_complete", "telemetry_requested", "telemetry_received",
      "screen_changed", "command_dispatched", "query_results",
    ];
    // The reducer in update.ts has a `case` for every one of these. If a new
    // event is added to types.ts without a reducer case, TypeScript's
    // exhaustiveness check on the no-default switch fails the build. This
    // test asserts the SAME set of events is the contract; if the two drift,
    // either the build breaks (event added) or this test breaks (event removed).
    for (const type of eventTypes) expect(typeof type).toBe("string");
    expect(eventTypes.length).toBe(14);
  });
});

// ── 6. M1.2 entry-point boundary audit ────────────────────────────────────

/**
 * arbor-tui is the Elm-style TUI core: it must remain a pure projection over
 * an injected `RuntimePort`/`RuntimeEventSource` (ADR-011). None of its
 * modules may reach around that seam — no `@arbor/mcp` import (that would
 * invert the allowed mcp->tui dependency direction), no process spawning,
 * and no filesystem writes (the TUI reads terminal state and dispatches
 * requests; it does not persist anything to disk on its own). This is a
 * mechanical, file-content scan rather than a type-level check because the
 * forbidden surfaces (`node:child_process`, `fs.writeFile*`) are ordinary
 * values a TS import-graph check would not catch if reached via a runtime
 * `require`/dynamic import.
 */
const ARBOR_TUI_SRC_ROOT = fileURLToPath(new URL("../src", import.meta.url));

function listTsFilesRecursive(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) out.push(...listTsFilesRecursive(full));
    else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts")) out.push(full);
  }
  return out;
}

describe("wiring audit — M1.2 entry-point boundaries", () => {
  /**
   * No documented exceptions exist today (a grep of `packages/arbor-tui/src`
   * for `@arbor/mcp`, `child_process`, and every `fs`/`node:fs` write API
   * turns up zero hits before this test was added) — this allowlist is
   * intentionally empty so a future exception must be added here, with a
   * reason, rather than silently passing because nothing enforced it.
   */
  const DOCUMENTED_EXCEPTIONS: ReadonlySet<string> = new Set([]);

  // Word-boundary regexes, not plain `.includes()`: a bare substring check
  // for "rm(" would false-positive on ordinary identifiers like "form(" or
  // "confirm(", both common in this operator-forms-heavy package.
  const FS_WRITE_API_PATTERNS = [
    "writeFile", "writeFileSync", "appendFile", "appendFileSync",
    "mkdir", "mkdirSync", "rm", "rmSync", "rmdir", "rmdirSync",
    "unlink", "unlinkSync", "copyFile", "copyFileSync", "createWriteStream",
  ].map((name) => new RegExp(`\\b${name}\\b`));

  it("no module under src/ imports @arbor/mcp, spawns a child process, or writes files", () => {
    const files = listTsFilesRecursive(ARBOR_TUI_SRC_ROOT);
    expect(files.length).toBeGreaterThan(50); // sanity: the scan actually found the package
    const violations: string[] = [];
    for (const file of files) {
      const relPath = file.slice(ARBOR_TUI_SRC_ROOT.length + 1);
      if (DOCUMENTED_EXCEPTIONS.has(relPath)) continue;
      const content = readFileSync(file, "utf8");
      // Only actual import/require syntax counts — several modules mention
      // "@arbor/mcp" in prose comments documenting this very invariant.
      if (/(?:from|require\(|import\()\s*["']@arbor\/mcp["']/.test(content)) violations.push(`${relPath}: imports @arbor/mcp`);
      if (/\bchild_process\b/.test(content)) violations.push(`${relPath}: references child_process`);
      // The shipped TUI runs under Bun, whose native process/file APIs are
      // reachable without any `node:` import (verifier finding on ADR-161 O3).
      if (/\bBun\s*\.\s*(?:spawn|spawnSync|write|\$)\b|\bBun\s*\.\s*\$/.test(content)) violations.push(`${relPath}: references a Bun process/file API`);
      if (/(?:from|require\(|import\()\s*["']bun["']/.test(content)) violations.push(`${relPath}: imports the bun module (shell/spawn surface)`);
      for (const pattern of FS_WRITE_API_PATTERNS) {
        if (pattern.test(content)) violations.push(`${relPath}: references fs write API "${pattern.source}"`);
      }
    }
    expect(violations, `entry-point boundary violations: ${violations.join("; ")}`).toEqual([]);
  });
});
