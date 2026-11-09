import { describe, it, expect, afterEach } from "vitest";
import { PassThrough } from "node:stream";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { haltedCampaignIdsFromEnvelopes, loadTuiCatalog, paneScrollIntent, pendingTaskComposerDraftId, resolveColorPolicy, routeKeystroke, runTui, selectionIntentFromPaneHit } from "../src/tui.js";
import { buildDefaultCatalog, clearRegisteredScreens, workflowPaletteActions } from "@arbor/tui";
import { ArborRuntime } from "../src/runtime.js";
import type { Action } from "@arbor/core";
import type { SessionEvent, SessionInspection } from "@arbor/harness";

let tempDir: string;

function makeTempDir(): string {
  tempDir = mkdtempSync(join(tmpdir(), "arbor-tui-test-"));
  return tempDir;
}

afterEach(() => {
  clearRegisteredScreens();
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
});

function capture(): { stream: PassThrough; text(): string } {
  const stream = new PassThrough();
  let data = "";
  stream.on("data", (chunk: Buffer) => { data += chunk.toString(); });
  return { stream, text: () => data };
}

function expectedDefaultCatalog() {
  const builtins = buildDefaultCatalog();
  return { actions: [...builtins.actions, ...workflowPaletteActions()] };
}

// OT-6 (P0): NO_COLOR + captured TerminalCapabilities drive the live
// render path's color policy, matching doctor.ts's NO_COLOR/TTY contract for
// the boolean gate and additionally degrading truecolor -> ansi256 -> mono
// against the renderer's captured capabilities.
describe("resolveColorPolicy (OT-6 — NO_COLOR + capability degrade matrix)", () => {
  it("NO_COLOR set forces mono regardless of TTY or capabilities", () => {
    expect(resolveColorPolicy({ NO_COLOR: "1" }, true, { rgb: true, ansi256: true })).toEqual({ color: false, color_mode: "truecolor" });
    expect(resolveColorPolicy({ NO_COLOR: "" }, true, { rgb: true, ansi256: true })).toEqual({ color: false, color_mode: "truecolor" });
  });

  it("non-TTY forces mono regardless of NO_COLOR or capabilities (matches doctor.ts's contract)", () => {
    expect(resolveColorPolicy({}, false, { rgb: true, ansi256: true })).toEqual({ color: false, color_mode: "truecolor" });
  });

  it("TTY + no NO_COLOR + rgb capability keeps truecolor (pre-OT-6 default)", () => {
    expect(resolveColorPolicy({}, true, { rgb: true, ansi256: true })).toEqual({ color: true, color_mode: "truecolor" });
  });

  it("TTY + no NO_COLOR + ansi256-only capability degrades to ansi256", () => {
    expect(resolveColorPolicy({}, true, { rgb: false, ansi256: true })).toEqual({ color: true, color_mode: "ansi256" });
  });

  it("TTY + no NO_COLOR + no color capability at all degrades to mono", () => {
    expect(resolveColorPolicy({}, true, { rgb: false, ansi256: false })).toEqual({ color: false, color_mode: "truecolor" });
  });

  it("TTY + no NO_COLOR + capabilities not yet observed (null) assumes truecolor (unchanged pre-OT-6 default)", () => {
    expect(resolveColorPolicy({}, true, null)).toEqual({ color: true, color_mode: "truecolor" });
  });
});

// OT-5: a real OpenTUI-native mouse-wheel scroll must move the active
// screen's scroll offset by the same amount as the raw-SGR wheel path
// (input-terminal.ts#mouseEventToIntent) -- this closes the wheel-scroll
// regression OT-2's removal of the raw stdin listener would otherwise have
// introduced under the opentui renderer.
describe("paneScrollIntent (OT-5 — native wheel scroll -> scroll_by intent)", () => {
  it("down scrolls forward, up scrolls backward, matching mouseEventToIntent's sign convention", () => {
    const down = paneScrollIntent({ pane_id: "main", direction: "down", delta: 1 });
    const up = paneScrollIntent({ pane_id: "main", direction: "up", delta: 1 });
    expect(down).toEqual({ type: "scroll_by", lines: expect.any(Number) });
    expect(up).toEqual({ type: "scroll_by", lines: expect.any(Number) });
    expect((down as { lines: number }).lines).toBeGreaterThan(0);
    expect((up as { lines: number }).lines).toBeLessThan(0);
  });

  it("left/right scroll has no defined target and yields null", () => {
    expect(paneScrollIntent({ pane_id: "main", direction: "left", delta: 1 })).toBeNull();
    expect(paneScrollIntent({ pane_id: "main", direction: "right", delta: 1 })).toBeNull();
  });
});

describe("loadTuiCatalog (G-06: config/keymap wiring)", () => {
  it("returns the real default catalog — not empty — when no config exists", () => {
    const dir = makeTempDir();
    const stderr = capture();
    const catalog = loadTuiCatalog(dir, stderr.stream);
    expect(catalog).toEqual(expectedDefaultCatalog());
    expect(catalog.actions.length).toBeGreaterThan(0);
    expect(stderr.text()).toBe("");
  });

  it("surfaces arbor.jsonc validation errors as a non-fatal startup warning", () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, "arbor.jsonc"), JSON.stringify({ tree_search: { max_seconds: -1 } }));
    const stderr = capture();
    const catalog = loadTuiCatalog(dir, stderr.stream);
    expect(stderr.text()).toContain("validation warnings");
    expect(stderr.text()).toContain("max_seconds");
    // Still returns a usable catalog — an invalid config never blocks the TUI.
    expect(catalog.actions.length).toBeGreaterThan(0);
  });

  it("applies an arbor.keymap override onto the default catalog", () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, "arbor.keymap"), '[tui.keymap]\nctrl-shift-c = "campaigns"');
    const stderr = capture();
    const catalog = loadTuiCatalog(dir, stderr.stream);
    const campaigns = catalog.actions.find((a) => a.id === "focus:campaigns")!;
    expect(campaigns.bindings[0].keys).toEqual(["ctrl+shift+c"]);
    expect(stderr.text()).toBe("");
  });

  it("reports an unmatched keymap binding without dropping the rest of the catalog", () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, "arbor.keymap"), '[tui.keymap]\nctrl-z = "not a real action"');
    const stderr = capture();
    const catalog = loadTuiCatalog(dir, stderr.stream);
    expect(stderr.text()).toContain("did not match a known action");
    expect(stderr.text()).toContain("not a real action");
    expect(catalog.actions.length).toBe(expectedDefaultCatalog().actions.length);
  });

  it("falls back to defaults and warns (never throws) on a malformed arbor.keymap", () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, "arbor.keymap"), "[tui.keymap]\ncapslock-a = \"bad modifier\"");
    const stderr = capture();
    const catalog = loadTuiCatalog(dir, stderr.stream);
    expect(stderr.text()).toContain("arbor.keymap ignored");
    expect(catalog).toEqual(expectedDefaultCatalog());
  });
});

const rootAction: Action = { description: "root", estimated_gain: 1, estimated_cost: 1, category: "root", delegate_to: "crown" };

describe("live UCT topology refresh (real runTui event subscription)", () => {
  it("coalesces overlapping topology refreshes so a delayed old snapshot cannot erase a newer branch", async () => {
    const dir = makeTempDir();
    const runtime = new ArborRuntime();
    await runtime.start();
    runtime.manager.startCampaign("live-uct", "plan.md", { ...rootAction, description: "UCT root baseline" });
    const stdin = new PassThrough();
    const stdout = capture();
    const stderr = capture();
    let treeQueries = 0;
    let holdNextTreeResult = false;
    let releaseDelayedResult: () => void = () => {};
    let delayedResultCaptured: () => void = () => {};
    const delayedResultGate = new Promise<void>((resolve) => { releaseDelayedResult = resolve; });
    const delayedResultReady = new Promise<void>((resolve) => { delayedResultCaptured = resolve; });
    const donePromise = runTui({
      cwd: dir,
      stdin,
      stdout: stdout.stream,
      stderr: stderr.stream,
      runtime_factory: () => runtime,
      on_runtime_query: ({ kind, screen }) => {
        if (kind === "campaign.tree" && screen === "tree") treeQueries += 1;
      },
      on_runtime_query_result: async ({ kind, screen }) => {
        if (kind !== "campaign.tree" || screen !== "tree" || !holdNextTreeResult) return;
        holdNextTreeResult = false;
        delayedResultCaptured();
        await delayedResultGate;
      },
    });
    const waitUntil = async (predicate: () => boolean, message: string): Promise<void> => {
      const deadline = Date.now() + 10_000;
      while (!predicate()) {
        if (Date.now() > deadline) throw new Error(`${message}\n${stdout.text().slice(-1200)}`);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    };
    try {
      await waitUntil(() => stdout.text().includes("revoy2 console"), "Console did not render");
      // Release Console's initial text focus before sending its screen binding.
      stdin.write("\u001b");
      await new Promise((resolve) => setTimeout(resolve, 60));
      stdin.write("t");
      await waitUntil(() => treeQueries > 0 && stdout.text().includes("UCT root baseline"), "initial canonical Tree snapshot did not render");

      const firstRefreshBaseline = treeQueries;
      holdNextTreeResult = true;
      const [firstChildId] = runtime.manager.branch("live-uct", "root", [{
        description: "first child from canonical branch event",
        estimated_gain: 1,
        estimated_cost: 1,
        category: "refactor",
        delegate_to: "seed",
      }]);
      expect(firstChildId).toBeDefined();
      await waitUntil(() => treeQueries > firstRefreshBaseline, "unknown tree.node_changed did not trigger an authoritative campaign.tree requery");
      await delayedResultReady;

      const secondRefreshBaseline = treeQueries;
      const [secondChildId] = runtime.manager.branch("live-uct", "root", [{
        description: "second child from later canonical branch event",
        estimated_gain: 1,
        estimated_cost: 1,
        category: "refactor",
        delegate_to: "seed",
      }]);
      expect(secondChildId).toBeDefined();
      await waitUntil(() => treeQueries > secondRefreshBaseline, "later topology event did not request a trailing canonical tree refresh");
      // Give an uncoalesced implementation time to render the newer response
      // before releasing the older, now stale result.
      await new Promise((resolve) => setTimeout(resolve, 150));
      releaseDelayedResult();
      await waitUntil(() => stdout.text().includes("first child from canonical branch event")
        && stdout.text().includes("second child from later canonical branch event"), "latest canonical tree snapshot did not render both branches");
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(stdout.text()).toContain("second child from later canonical branch event");

      stdin.write("\"");
      await waitUntil(() => stdout.text().includes("editing filter"), "Tree filter input did not open from its key binding");
      stdin.write("root\r");
      await waitUntil(() => stdout.text().includes("filter root"), "Tree filter was not retained by the live reader");
      stdin.write("F");
      await waitUntil(() => stdout.text().includes("follow off"), "Tree follow control did not update the retained reader");
      expect(stdout.text()).toContain("filter root");
      expect(stdout.text()).toContain("follow off");
    } finally {
      releaseDelayedResult();
      if (!stdin.readableEnded) stdin.end();
      const exitCode = await Promise.race([
        donePromise,
        new Promise<number>((_resolve, reject) => setTimeout(() => reject(new Error("TUI did not exit after stdin closed")), 5_000)),
      ]);
      expect(exitCode, `${stderr.text()}\n${stdout.text().slice(-2000)}`).toBe(0);
    }
  }, 20_000);
});

// Pilot defects #1(b)/#2/#3: telemetry, the tree screen, the output screen,
// and the status bar's counters all only ever refreshed on a screen-focus
// transition, so a campaign that halted while the operator was looking at a
// different screen simply froze there. `haltedCampaignIdsFromEnvelopes` is
// the halt watcher's pure detection core (tui.ts) — this exercises it
// directly against real `campaign.changed` envelopes a live
// `CampaignManager`/`RuntimeEventStream` actually produces, not a
// hand-shaped fixture, so a drift in the real event shape would fail this
// test too.
describe("haltedCampaignIdsFromEnvelopes (pilot defects #1(b)/#2/#3: terminal-state refresh)", () => {
  it("reports a real campaign.changed 'halted' event exactly once, from the real runtime event stream", async () => {
    const runtime = new ArborRuntime();
    await runtime.start();
    runtime.manager.startCampaign("c1", "plan.md", rootAction);
    const subscription = runtime.eventStream.subscribe();

    runtime.manager.completeAutoHalt("c1", "manual");

    const seen = new Set<string>();
    const firstPoll = haltedCampaignIdsFromEnvelopes(subscription.poll(), seen);
    expect(firstPoll).toEqual(["c1"]);

    // A second halt event for the same campaign (completeAutoHalt is
    // idempotent once already halted, but any duplicate/replayed envelope
    // must not re-trigger a second forced refresh for the same transition).
    const secondPoll = haltedCampaignIdsFromEnvelopes(subscription.poll(), seen);
    expect(secondPoll).toEqual([]);

    await runtime.close();
  });

  it("ignores non-halt campaign.changed events (e.g. 'created') and events for other kinds", () => {
    const seen = new Set<string>();
    const envelopes = [
      { event: { kind: "campaign.changed", campaign_id: "c1", change: "created" } },
      { event: { kind: "tree.node_changed", campaign_id: "c1", node_id: "n1", state: "expanding" } },
      { event: { kind: "campaign.changed", campaign_id: "c2", change: "halted" } },
    ];
    expect(haltedCampaignIdsFromEnvelopes(envelopes, seen)).toEqual(["c2"]);
  });
});

describe("runTui (G-06: end-to-end)", () => {
  it("routes Inspect side questions and explicit promotion through the live adapter, then hydrates history after restart", async () => {
    const dir = makeTempDir();
    const runtime = new ArborRuntime();
    runtime.operations.accept({
      metadata: {
        operation_id: "inspect-live-action",
        idempotency_key: "inspect-live-action-key",
        correlation_id: "inspect-live-action-correlation",
        actor_id: "fixture-owner",
        requested_at: new Date().toISOString(),
      },
      capability: "operation.read",
      fingerprint: "inspect-live-action-fixture",
    });
    const stdin = new PassThrough();
    const stdout = capture();
    const stderr = capture();
    const donePromise = runTui({ cwd: dir, stdin, stdout: stdout.stream, stderr: stderr.stream, runtime_factory: () => runtime });
    const waitUntil = async (predicate: () => boolean, message: string, timeoutMs = 15_000): Promise<void> => {
      const deadline = Date.now() + timeoutMs;
      while (!predicate()) {
        if (Date.now() > deadline) throw new Error(message);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    };
    await waitUntil(() => stdout.text().includes("revoy2 console"), "Console did not render", 30_000);
    stdin.write("\u0002"); // Ctrl+B focuses the inspector rail.
    stdin.write("\t\t"); // Git -> Governance -> Inspect.
    await waitUntil(() => stdout.text().includes("INSPECT"), "Inspect rail did not render");
    stdin.write("?");
    await waitUntil(() => stdout.text().includes("Side question"), "Inspect side-question prompt did not open");
    for (const char of "who owns the action?") { stdin.write(char); await new Promise((resolve) => setTimeout(resolve, 2)); }
    stdin.write("\r");
    await waitUntil(() => stdout.text().includes("Owner: fixture-owner."), `side answer was not rendered from the canonical snapshot\n${stderr.text()}\n${stdout.text().slice(-1000)}`);
    stdin.write("p");
    await waitUntil(() => stdout.text().includes("Promotion reason"), "Inspect promotion-reason prompt did not open");
    for (const char of "Use this answer as the next task") { stdin.write(char); await new Promise((resolve) => setTimeout(resolve, 2)); }
    stdin.write("\r");
    await waitUntil(() => runtime.operations.list(true).some((operation) => operation.operation_id.startsWith("inspect:promote:") && operation.capability === "taskcomposer.write"), `explicit promotion did not register through taskcomposer.submit\n${stdout.text().slice(-1200)}`);
    const historyPath = join(dir, ".arbor", "tui", "inspect-history.jsonl");
    await waitUntil(() => {
      try { return readFileSync(historyPath, "utf8").includes('"answer":{"kind":"deterministic"'); }
      catch { return false; }
    }, "durable Inspect promotion history was not written");
    stdin.end();
    expect(await donePromise).toBe(0);

    const restartedStdin = new PassThrough();
    const restartedStdout = capture();
    const restarted = runTui({ cwd: dir, stdin: restartedStdin, stdout: restartedStdout.stream, stderr: capture().stream });
    await waitUntil(() => restartedStdout.text().includes("revoy2 console"), "restarted Console did not render", 30_000);
    restartedStdin.write("\u0002\t\t");
    await waitUntil(() => restartedStdout.text().includes("who owns the action?") && restartedStdout.text().includes("Owner: fixture-owner."), "durable Inspect history did not hydrate after restart");
    restartedStdin.end();
    expect(await restarted).toBe(0);
  }, 60_000);

  it("keeps durable supervisor work out of a fresh Console foreground", async () => {
    const dir = makeTempDir();
    const runtime = new ArborRuntime();
    runtime.supervisor.register({
      id: "task-background-1", operation_id: "operation-background-1", kind: "specialist.expand", owner_scope_id: "campaign-background",
    });
    runtime.supervisor.start("task-background-1");
    const stdin = new PassThrough();
    const stdout = capture();
    const stderr = capture();
    const donePromise = runTui({
      cwd: dir, stdin, stdout: stdout.stream, stderr: stderr.stream,
      runtime_factory: () => runtime,
    });
    const deadline = Date.now() + 30_000;
    while (!stdout.text().includes("revoy2 console")) {
      if (Date.now() > deadline) throw new Error("Console did not render");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    // The task was present before this invocation.  It remains durable and
    // inspectable via --resume, but must not impersonate fresh foreground
    // work or make an idle Console look busy.
    expect(stdout.text()).not.toContain("task-background-1");
    expect(stdout.text()).not.toContain("operation-background-1");
    stdin.end();
    expect(await donePromise).toBe(0);
  }, 35_000);

  it("attaches a fresh campaign session without an action-delegate tree join and retains its terminal completion transcript", async () => {
    const dir = makeTempDir();
    const runtime = new ArborRuntime();
    runtime.notificationInbox.publish({
      id: "stale-background-notification",
      fingerprint: "stale-background-notification",
      project_id: "old-campaign",
      severity: "info",
      title: "Stale background notification",
      body: "This unrelated historical row must not enter the new Console transcript.",
      delivery: { channels: ["tui"], quiet_hours: null },
      provenance: { tag: "generated", generator: "tui-test", input_hash: "sha256:0000000000000000000000000000000000000000000000000000000000000000" },
      idempotency_key: "stale-background-notification",
    });
    const stdin = new PassThrough();
    const stdout = capture();
    const stderr = capture();
    const donePromise = runTui({
      cwd: dir, stdin, stdout: stdout.stream, stderr: stderr.stream,
      runtime_factory: () => runtime,
    });
    const waitUntil = async (predicate: () => boolean, message: string, timeoutMs = 15_000): Promise<void> => {
      const deadline = Date.now() + timeoutMs;
      while (!predicate()) {
        if (Date.now() > deadline) throw new Error(message);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    };
    await waitUntil(() => stdout.text().includes("revoy2 console"), "Console did not render");

    // This root deliberately has no action_delegate.  The former Console
    // selector rejected the session until campaign.tree exposed a delegate,
    // creating a black hole between session start and tree publication.
    runtime.manager.startCampaign("fresh-stream", "plan.md", rootAction);
    const events: SessionEvent[] = [{
      protocol_version: "1", session_id: "fresh-stream-session", sequence: 1,
      occurred_at: "2026-08-31T00:00:00.000Z", kind: "model_text",
      payload: { text: "fresh attached narrative", phase: "commentary" },
    }];
    let terminal = false;
    const inspect = (): SessionInspection => ({
      session_id: "fresh-stream-session", state: terminal ? "completed" : "running", latest_sequence: events.length,
      terminal: terminal ? { state: "completed", cause: "completed", message: "completion manifest captured", result: "claimed", provenance: { tag: "claimed", claimant: "tui-test" } } : null,
      ephemeral: true,
      policy: { filesystem: "read_only", approvals: "never", tool_allow: [], tool_deny: [], workspace_roots: [dir], max_wall_clock_ms: 10_000, max_events: 32, network_allowed: false, ambient_plugins_allowed: false, user_configuration_allowed: false, inherited_credentials_allowed: false },
      capabilities: [], lineage: { kind: "new" },
    });
    runtime.nativeSessionRegistry.register({
      session_id: "fresh-stream-session", campaign_id: "fresh-stream", node_id: "root",
      operation: "specialize", connector_id: "revoy-native", execution_kind: "direct_native",
      profile_id: "testing", controller: new AbortController(), inspect,
      events: (after = 0) => events.filter((event) => event.sequence > after),
    });
    // Campaign creation is a canonical runtime event, so the Console must
    // select and attach this session without waiting for a tree delegate.
    await waitUntil(() => stdout.text().includes("fresh attached narrative"), "fresh session narrative was not attached to Console");
    expect(stdout.text()).not.toContain("Stale background notification");

    events.push({
      protocol_version: "1", session_id: "fresh-stream-session", sequence: 2,
      occurred_at: "2026-08-31T00:00:01.000Z", kind: "model_text",
      payload: { text: "terminal completion manifest", phase: "final" },
    });
    terminal = true;
    runtime.manager.completeAutoHalt("fresh-stream", "manual");
    // A terminal inspection must remain selected long enough for its final
    // answer/evidence to be projected; dropping terminal sessions erased the
    // only completion transcript on the previous refresh.
    await waitUntil(() => stdout.text().includes("terminal completion manifest"), "terminal session transcript disappeared from Console");
    stdin.end();
    expect(await donePromise).toBe(0);
  }, 40_000);

  it("boots with no config file, renders real help content from the live catalog on '?', and exits cleanly", async () => {
    const dir = makeTempDir();
    const stdin = new PassThrough();
    const stdout = capture();
    const stderr = capture();

    const donePromise = runTui({ cwd: dir, stdin, stdout: stdout.stream, stderr: stderr.stream });
    await new Promise((resolve) => setTimeout(resolve, 30));

    stdin.write("\u0010");
    await new Promise((resolve) => setTimeout(resolve, 30));

    stdin.end();
    const code = await donePromise;

    expect(code).toBe(0);
    // Real catalog content produced by the real renderHelp/paletteItems call —
    // not a hardcoded string, so this fails if the catalog goes back to empty.
    expect(stdout.text()).toContain("Console");
    expect(stdout.text()).toContain("Command palette · console · idle · contextual");
    // At the default 120 columns the Inspector rail now docks (ui-spec §2.1;
    // the old `> 120` cutoff was baseline defect D-02), so the palette gets an
    // 87-column pane and renders its compact disclosure.
    expect(stdout.text()).toMatch(/\d+\/\d+ · search\/all/);
    expect(stdout.text()).toContain("›[screen]");
  });

  // Regression (wave1/tui-contracts): AppModel.grantedCapabilities starts as
  // the empty set (model.ts's initialModel()) and only `grants_updated`
  // populates it. Only demo.ts's driver dispatched that event — runTui, the
  // real `arbor tui` entry point, never did, so `availableScreens()`
  // (renderer.ts's resolveActiveScreen) never found a match for ANY screen
  // and every pane silently rendered the generic "loading"/"ready" fallback
  // regardless of which screen was focused or how much live data it had.
  it("grants the router's real supported capabilities on boot, so the product dashboard renders instead of the generic fallback", async () => {
    const dir = makeTempDir();
    const stdin = new PassThrough();
    const stdout = capture();
    const stderr = capture();

    const donePromise = runTui({ cwd: dir, stdin, stdout: stdout.stream, stderr: stderr.stream });
    await new Promise((resolve) => setTimeout(resolve, 50));
    stdin.end();
    await donePromise;

    // The product dashboard must render immediately, even if its composite
    // governance read is still loading — the pre-fix symptom was generic
    // "ready" fallback text or an entirely blank terminal.
    // (renderer.ts's primaryPaneContent, used only when no screen module is
    // available) appearing instead, on every screen, always.
    expect(stdout.text()).toMatch(/revoy2 console|Initializing native runtime and governed workspace/);
    expect(stdout.text()).not.toContain("│ready");
  });

  // T1 (field-observed defect, remediated): Enter is now the sole explicit
  // way to focus Cockpit's compose form -- printable keys typed BEFORE Enter
  // (including this suite's own "2"/"1"/"3" navigation digits) must resolve
  // through the navigation catalog, never get silently captured as prompt
  // text. This test used to type "build this" with no Enter and rely on the
  // (buggy) implicit typeahead to open the form; it now presses Enter first,
  // matching the required "explicitly focused" contract.
  it("turns typing into the governed native task form once the compose affordance is opened (Ctrl+N)", async () => {
    const dir = makeTempDir();
    const stdin = new PassThrough();
    const stdout = capture();
    const stderr = capture();
    const donePromise = runTui({ cwd: dir, stdin, stdout: stdout.stream, stderr: stderr.stream });
    for (let attempt = 0; attempt < 100 && !stdout.text().includes("Loading governed workspace"); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    // Ctrl+N is the surviving route to the governed task form. Cockpit's
    // Enter-to-compose is gone with the screen; Console's Enter focuses its
    // own inline strip instead, which is a different affordance.
    stdin.write("\u000e");
    for (let attempt = 0; attempt < 100 && !stdout.text().includes("WHAT SHOULD REVOY CHANGE?"); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    stdin.write("build this");
    await new Promise((resolve) => setTimeout(resolve, 200));
    stdin.write("\u001b");
    stdin.end();
    expect(await donePromise).toBe(0);
    expect(stdout.text()).toContain("Ctrl+P palette");
    expect(stdout.text()).toContain("task: build this_");
    expect(stdout.text()).toContain("starts safe work by default");
  });

  // T2 (field-observed defect, remediated): "Esc cancel" (the compose
  // form's own footer) used to need two presses, and reopening the form
  // kept stale draft text from the prior session ("3" became "31"). The
  // root cause traced to tui.ts's now-removed cockpit typeahead fast path
  // (T1) queuing a form-open paired with seeded input text via
  // `dispatchTaskComposer`'s FIFO queue -- a still-in-flight queued pair
  // could resurrect the form with stale text right after a direct cancel.
  // Ordinary field edits (including Escape) always folded synchronously and
  // are unchanged here; this proves the compose form is single-Escape-clean
  // end to end, not just at the `routeKeystroke` routing-decision level.
  it("(T2) a single Escape cancels the compose form, and reopening it starts with an empty draft", async () => {
    const dir = makeTempDir();
    const stdin = new PassThrough();
    const stdout = capture();
    const stderr = capture();
    const donePromise = runTui({ cwd: dir, stdin, stdout: stdout.stream, stderr: stderr.stream });
    const waitUntil = async (predicate: () => boolean, message: string, timeoutMs = 10_000): Promise<void> => {
      const deadline = Date.now() + timeoutMs;
      while (!predicate()) {
        if (Date.now() > deadline) throw new Error(message);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    };
    // Coverage's four workers can delay native renderer bootstrap well beyond
    // ordinary interaction latency. Keep the real rendered-header readiness
    // signal, but give only this startup transition a realistic budget.
    await waitUntil(() => stdout.text().includes("revoy2 console"), "TUI did not render its unified Console", 30_000);
    // Open the governed task form through its surviving route.
    stdin.write("\u000e");
    await waitUntil(() => stdout.text().includes("WHAT SHOULD REVOY CHANGE?"), "task composer form did not open");
    stdin.write("3");
    await waitUntil(() => stdout.text().includes("task: 3_"), "task input did not render");

    // Only inspect what renders AFTER the cancel keystroke: the full
    // accumulated buffer still (correctly) contains "task: 3" from the
    // frame just asserted above, so a plain `not.toContain` against the
    // whole buffer would be meaningless here.
    const beforeCancel = stdout.text().length;
    stdin.write("\u001b");
    // One Escape is enough: the overlay is gone and Console's focused
    // composer footer is back, not the compose form's own footer.
    await waitUntil(() => stdout.text().slice(beforeCancel).includes("Esc blur"), "Escape did not return to Console");
    expect(stdout.text().slice(beforeCancel)).not.toContain("WHAT SHOULD REVOY CHANGE?");

    // Reopen: the field must start empty, not "3" or a concatenation like "31".
    const beforeReopen = stdout.text().length;
    stdin.write("\u000e");
    await waitUntil(() => stdout.text().slice(beforeReopen).includes("task: _"), "task composer form did not reopen");
    const afterReopen = stdout.text().slice(beforeReopen);
    expect(afterReopen).toContain("task: _");
    expect(afterReopen).not.toContain("task: 3");
    expect(afterReopen).not.toContain("task: 31");

    stdin.write("\u001b");
    stdin.end();
    expect(await donePromise).toBe(0);
  }, 35_000);

  it("cancels an in-flight Cockpit planner through the canonical taskcomposer route without late-result resurrection", async () => {
    const dir = makeTempDir();
    const persistence = join(dir, ".arbor");
    const stdin = new PassThrough();
    const stdout = capture();
    const stderr = capture();
    const originalFetch = globalThis.fetch;
    const previousKey = process.env.ARBOR_NATIVE_API_KEY;
    let observedSignal: AbortSignal | undefined;
    let providerRequested!: () => void;
    const providerRequest = new Promise<void>((resolve) => { providerRequested = resolve; });
    let settleProvider!: (response: Response) => void;
    let providerSettled = false;
    let tuiRun: Promise<number> | null = null;
    let markInputReady!: () => void;
    const inputReady = new Promise<void>((resolve) => { markInputReady = resolve; });
    const lateProposal = JSON.stringify({
      summary: "late planner proposal", assumptions: [], questions: [],
      root_action: { description: "late root", estimated_gain: 1, estimated_cost: 1, category: "delivery", delegate_to: "crown" },
      actions: [{ description: "late action", estimated_gain: 1, estimated_cost: 1, category: "delivery", delegate_to: "seed" }],
      acceptance_checks: ["tests pass"], acceptance_mapping: [{ criterion: "tests pass", action_descriptions: ["late action"] }], risk_notes: [],
    });
    const waitUntil = async (predicate: () => boolean, message: string): Promise<void> => {
      const deadline = Date.now() + 15_000;
      while (!predicate()) {
        if (Date.now() > deadline) throw new Error(message);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    };
    const lateResponse = (): Response => new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: lateProposal } }], usage: { prompt_tokens: 9, completion_tokens: 4 } })}\n\ndata: [DONE]\n\n`, { status: 200, headers: { "content-type": "text/event-stream" } });
    const releaseProvider = (): void => {
      if (!providerSettled && typeof settleProvider === "function") {
        providerSettled = true;
        settleProvider(lateResponse());
      }
    };
    const within = async <T>(promise: Promise<T>, milliseconds: number, message: string): Promise<T> => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          promise,
          new Promise<T>((_resolve, reject) => { timer = setTimeout(() => reject(new Error(message)), milliseconds); }),
        ]);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    };
    try {
      writeFileSync(join(dir, "arbor.jsonc"), JSON.stringify({
        native: {
          mode: "native", adapter_id: "openai-compatible", provider_id: "fixture-provider", base_url: "http://native-provider.invalid/v1", model: "fixture-model",
          usage_budget: { estimate_authority: "fixture-upper-bound", estimate_max_input_tokens: 20_000, estimate_max_output_tokens: 2_048, max_campaign_tokens: 300_000 },
        },
      }), "utf8");
      process.env.ARBOR_NATIVE_API_KEY = "tui-cancel-fixture-secret";
      globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
        observedSignal = init?.signal as AbortSignal | undefined;
        providerRequested();
        return new Promise<Response>((resolve) => { settleProvider = resolve; });
      }) as typeof fetch;

      tuiRun = runTui({ cwd: dir, persistence_dir: persistence, stdin, stdout: stdout.stream, stderr: stderr.stream, frame_interval_ms: 5, on_ready: markInputReady });
      await within(inputReady, 4_000, "TUI did not register its input handler");
      const task = "perform an irreversible migration of production state";
      stdin.write(task);
      await waitUntil(
        () => stdout.text().includes(task),
        "Console intake did not render the typed task",
      );
      stdin.write("\n");
      await waitUntil(
        () => {
          try {
            const store = JSON.parse(readFileSync(join(persistence, "task-composer", "drafts.json"), "utf8")) as { drafts?: unknown[] };
            return (store.drafts?.length ?? 0) > 0;
          } catch { return false; }
        },
        "task submission did not create a durable planning draft",
      );
      try {
        await within(providerRequest, 15_000, "planner provider request did not start");
      } catch {
        const diagnostic = readFileSync(join(persistence, "task-composer", "drafts.json"), "utf8");
        throw new Error(`planner provider request did not start; durable draft: ${diagnostic}`);
      }
      await waitUntil(
        () => stdout.text().includes(task) && stdout.text().includes("Building the plan") && stdout.text().includes("Esc cancel"),
        "accepted task and canonical planning lifecycle were not rendered while the provider was in flight",
      );

      stdin.write("\u001b");
      await waitUntil(() => observedSignal?.aborted === true, "Escape did not abort the planner signal");

      releaseProvider();
      await waitUntil(() => {
        try {
          const store = JSON.parse(readFileSync(join(persistence, "task-composer", "drafts.json"), "utf8")) as { drafts?: Array<{ status?: unknown; planner?: { kind?: unknown } }> };
          return store.drafts?.[0]?.status === "cancelled";
        } catch { return false; }
      }, "cancelled draft was not durably persisted");
      const store = JSON.parse(readFileSync(join(persistence, "task-composer", "drafts.json"), "utf8")) as { drafts: Array<{ status: string; proposal: unknown; planner: { kind: string } }> };
      expect(store.drafts).toMatchObject([{ status: "cancelled", proposal: null, planner: { kind: "cancelled" } }]);

      stdin.end();
      if (tuiRun === null) throw new Error("TUI did not launch");
      expect(await within(tuiRun, 4_000, "TUI did not exit after stdin closed")).toBe(0);
    } finally {
      releaseProvider();
      if (!stdin.readableEnded) stdin.end();
      if (tuiRun !== null) await Promise.race([tuiRun.catch(() => undefined), new Promise<void>((resolve) => setTimeout(resolve, 1_000))]);
      globalThis.fetch = originalFetch;
      if (previousKey === undefined) delete process.env.ARBOR_NATIVE_API_KEY;
      else process.env.ARBOR_NATIVE_API_KEY = previousKey;
    }
  }, 30_000);

  // T1: the header-advertised [1]/[2]/[3] navigation digits (and every other
  // printable key) must navigate from Cockpit exactly as they do from
  // Dashboard when no text input is focused -- the field-observed defect was
  // that ONLY Dashboard navigated and Cockpit swallowed every printable key,
  // including these very digits, into the hidden compose form.
  it("(T1) navigates via digit keys from Cockpit exactly as from Dashboard -- no overlay ever opens", async () => {
    const dir = makeTempDir();
    const stdin = new PassThrough();
    const stdout = capture();
    const stderr = capture();
    let markInputReady!: () => void;
    const inputReady = new Promise<void>((resolve) => { markInputReady = resolve; });
    const donePromise = runTui({ cwd: dir, stdin, stdout: stdout.stream, stderr: stderr.stream, on_ready: markInputReady });
    const waitUntil = async (predicate: () => boolean, message: string): Promise<void> => {
      const deadline = Date.now() + 4_000;
      while (!predicate()) {
        if (Date.now() > deadline) throw new Error(message);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    };
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("TUI did not register its input handler")), 4_000);
        void inputReady.then(() => { clearTimeout(timer); resolve(); });
      });
      // Dashboard/Cockpit/Projects retired with keys 1/2/3, so this proves the
      // same property -- an idle screen routes printable keys to navigation
      // rather than swallowing them as prompt text -- using bindings that exist.
      stdin.write("\u001b");
      stdin.write("t");
      await waitUntil(() => stdout.text().includes("No search tree yet"), "\"t\" did not navigate to Tree");
      // From Tree (no overlay open), "g" must navigate to Governance -- not
      // get captured as the start of a task description.
      stdin.write("g");
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(stdout.text()).not.toContain("WHAT SHOULD REVOY CHANGE?");
      expect(stdout.text()).not.toContain("task: g");
    } finally {
      if (!stdin.readableEnded) stdin.end();
      expect(await Promise.race([
        donePromise,
        new Promise<number>((_resolve, reject) => setTimeout(() => reject(new Error("TUI did not exit after stdin closed")), 4_000)),
      ])).toBe(0);
    }
  });

  // Regression: the cockpit's own footer advertises "! interrupt"
  // (product.ts's cockpit() screen) as a shortcut, but the whole-chunk fast
  // path and the per-character cockpit branch both used to treat ANY
  // printable first keystroke — including a lone "!" — as the start of a
  // task description, so the documented interrupt shortcut was captured as
  // literal prompt text and the operator form opened instead of the
  // shortcut firing.
  it("treats a lone '!' on an idle cockpit as the interrupt shortcut, not the start of a task description", async () => {
    const dir = makeTempDir();
    const stdin = new PassThrough();
    const stdout = capture();
    const stderr = capture();
    const donePromise = runTui({ cwd: dir, stdin, stdout: stdout.stream, stderr: stderr.stream });
    for (let attempt = 0; attempt < 100 && !stdout.text().includes("Loading governed workspace"); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    stdin.write("!");
    await new Promise((resolve) => setTimeout(resolve, 400));
    stdin.end();
    expect(await donePromise).toBe(0);
    expect(stdout.text()).toContain("Ctrl+P palette");
    // The operator form never opened: no "WHAT SHOULD REVOY CHANGE?" overlay and no
    // "task: !" field rendered — before the fix, this exact sequence produced
    // `> task: !_` (the "!" captured as the first character of a task
    // description instead of firing the interrupt shortcut).
    expect(stdout.text()).not.toContain("task: !");
    expect(stdout.text()).not.toContain("WHAT SHOULD REVOY CHANGE?");
  });

  it("filters and executes the command palette instead of rendering read-only help", async () => {
    const dir = makeTempDir();
    const stdin = new PassThrough();
    const stdout = capture();
    const stderr = capture();
    const donePromise = runTui({ cwd: dir, stdin, stdout: stdout.stream, stderr: stderr.stream });
    await new Promise((resolve) => setTimeout(resolve, 40));
    stdin.write("\u0010");
    await new Promise((resolve) => setTimeout(resolve, 20));
    for (const char of "projects") {
      stdin.write(char);
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    stdin.write("\n");
    await new Promise((resolve) => setTimeout(resolve, 40));
    stdin.end();
    expect(await donePromise).toBe(0);
    expect(stdout.text()).toContain("Enter run · search/all"); // compact footer: rail docks at 120 cols (D-02)
    expect(stdout.text()).toContain("Ctrl+P palette");
  });

  it("keeps unavailable Diff Review in the palette and never dispatches its failing query", async () => {
    const dir = makeTempDir();
    const stdin = new PassThrough();
    const stdout = capture();
    const stderr = capture();
    const donePromise = runTui({ cwd: dir, stdin, stdout: stdout.stream, stderr: stderr.stream });
    await new Promise((resolve) => setTimeout(resolve, 60));
    stdin.write("\u0010");
    await new Promise((resolve) => setTimeout(resolve, 20));
    for (const char of "Diff Review") stdin.write(char);
    await new Promise((resolve) => setTimeout(resolve, 30));
    stdin.write("\n");
    await new Promise((resolve) => setTimeout(resolve, 60));
    stdin.end();

    expect(await donePromise).toBe(0);
    expect(stdout.text()).toContain("Unavailable: no captured result is ready to review");
    expect(stdout.text()).toContain("Command palette");
    expect(stdout.text()).not.toContain("has no captured result to review");
    expect(stderr.text()).not.toContain("result.review.workspace");
  });

  // Regression: selecting a palette-only action (no keybinding — every theme
  // entry and every workflow action) via Ctrl+P + Enter used to silently
  // no-op. `tui.ts`'s Enter handler looked the visible match up with
  // `paletteItems(catalog, { scope: "global", ... })`, but `visible()`
  // (overlays.ts) requires a binding whose OWN `.scope === "global"` —
  // theme actions are deliberately `bindings: []` (palette-search-only), so
  // the lookup always came back empty and `set_theme` never dispatched, even
  // though the exact same match rendered as the selected row via
  // renderer.ts's unscoped `renderHelp` call. The status bar's background
  // SGR sequence is the real, renderer-owned proof the live theme actually
  // changed — not the model in isolation.
  it("Ctrl+P theme selection repaints the status bar with the selected theme's colors", async () => {
    // This test proves the color-capable branch. The ambient shell may set
    // NO_COLOR, in which case the production policy correctly suppresses SGR
    // and this assertion becomes environment-dependent instead of exercising
    // theme selection. Restore the exact prior state after this scoped run.
    const priorNoColor = process.env.NO_COLOR;
    delete process.env.NO_COLOR;
    try {
    const dir = makeTempDir();
    const stdin = new PassThrough();
    const stdout = capture();
    const stderr = capture();
    // The frame thunk (tui.ts) only turns on status-bar color when
    // `stdout.isTTY === true`; a plain PassThrough reports `isTTY: undefined`,
    // which would make this test pass even with no repaint at all (colorless
    // output never contains an SGR background either way). Force the TTY flag
    // so the assertion below can only pass if the real theme colors render.
    (stdout.stream as unknown as { isTTY: boolean }).isTTY = true;
    const donePromise = runTui({ cwd: dir, stdin, stdout: stdout.stream, stderr: stderr.stream });
    await new Promise((resolve) => setTimeout(resolve, 40));

    // Ctrl+P (byte 0x10) opens the command palette (default-catalog.ts's
    // HELP_ACTION_ID binding), same overlay as "?" but the operator gesture
    // named in the bug report.
    stdin.write("");
    await new Promise((resolve) => setTimeout(resolve, 20));
    // A broad query returns all themes. Move the real visible cursor from
    // alphabetic row 0 (Birchwood Frost) to row 5 (Sandstone Thicket)
    // with decoded terminal Down keys; Enter must execute that row, not an
    // invisible first match.
    for (const char of "Theme:") {
      stdin.write(char);
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    for (let index = 0; index < 5; index += 1) {
      stdin.write("\u001b[B");
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    stdin.write("\n");
    await new Promise((resolve) => setTimeout(resolve, 60));
    stdin.end();

    expect(await donePromise).toBe(0);
    // Console no longer owns a footer/background strip. Its active Project
    // tab repaints with sandstone-thicket's real accent rgb(140,82,20),
    // proving the selected palette reached the persistent workspace itself.
    expect(stdout.text()).toContain("[38;2;140;82;20m");
    } finally {
      if (priorNoColor === undefined) delete process.env.NO_COLOR;
      else process.env.NO_COLOR = priorNoColor;
    }
  });

  // ADR-124: the Console input strip's Enter, on a non-empty buffer, must
  // route the typed text through the same governed `taskcomposer.submit`
  // path Cockpit's own compose flow uses (`open_task_preset`), not a
  // parallel/silent mechanism. Driving the real keystroke path end-to-end
  // (not just the reducer) is what proves the text is not discarded.
  it("Console input strip: Enter on a non-empty buffer submits the real governed task-composer request", async () => {
    const dir = makeTempDir();
    const stdin = new PassThrough();
    const stdout = capture();
    const stderr = capture();
    const donePromise = runTui({ cwd: dir, stdin, stdout: stdout.stream, stderr: stderr.stream });
    const waitUntil = async (predicate: () => boolean, message: string, timeoutMs = 10_000): Promise<void> => {
      const deadline = Date.now() + timeoutMs;
      while (!predicate()) {
        if (Date.now() > deadline) throw new Error(message);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    };
    await waitUntil(() => stdout.text().includes("revoy2 console"), "Console screen did not render", 30_000);
    // Fresh Console launches focus the visible input strip immediately.
    for (const char of "wire up the console prompt") {
      stdin.write(char);
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    await waitUntil(() => stdout.text().includes("wire up the console prompt"), "typed text did not render in the input strip");
    stdin.write("\n");
    const draftsPath = join(dir, ".arbor", "task-composer", "drafts.json");
    await waitUntil(() => {
      try {
        const parsed = JSON.parse(readFileSync(draftsPath, "utf8")) as { drafts?: readonly { task?: string; source?: string }[] };
        return (parsed.drafts ?? []).some((d) => d.task === "wire up the console prompt" && d.source === "tui");
      } catch {
        return false;
      }
    }, "no real draft with the console-typed text was persisted to .arbor/task-composer/drafts.json", 30_000);
    stdin.write("\u001b");
    stdin.end();
    expect(await donePromise).toBe(0);
  }, 60_000);

  it("Console /command invokes the visible project descriptor through governed task admission", async () => {
    const dir = makeTempDir();
    const commandDir = join(dir, ".arbor", "commands");
    mkdirSync(commandDir, { recursive: true });
    writeFileSync(join(commandDir, "inspect.md"), [
      "---",
      "description: Inspect one project path",
      "allowed_tools: [file.read, git.status]",
      "execution_role: specialist-executor",
      "argument_hint: <path>",
      "skill_id: inspect-repository",
      "skill_version: 1.0.0",
      "---",
      "Inspect $1 with all arguments: $ARGUMENTS",
    ].join("\n"));
    const stdin = new PassThrough();
    const stdout = capture();
    const stderr = capture();
    const donePromise = runTui({ cwd: dir, stdin, stdout: stdout.stream, stderr: stderr.stream });
    const waitUntil = async (predicate: () => boolean, message: string, timeoutMs = 30_000): Promise<void> => {
      const deadline = Date.now() + timeoutMs;
      while (!predicate()) {
        // A dispatch failure is rendered into the frame as a notification, so it
        // reaches stdout; a bare message here would discard the only evidence.
        if (Date.now() > deadline) throw new Error(`${message}\n--- stdout ---\n${stdout.text().slice(-1200)}\n--- stderr ---\n${stderr.text().slice(-1200)}`);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    };
    await waitUntil(() => stdout.text().includes("revoy2 console"), "Console screen did not render");
    stdin.write("/inspect src/index.ts carefully");
    stdin.write("\n");
    const expectedTask = "Inspect src/index.ts with all arguments: src/index.ts carefully";
    const draftsPath = join(dir, ".arbor", "task-composer", "drafts.json");
    await waitUntil(() => {
      try {
        const parsed = JSON.parse(readFileSync(draftsPath, "utf8")) as { drafts?: readonly { task?: string; source?: string; command?: unknown }[] };
        return (parsed.drafts ?? []).some((draft) => draft.task === expectedTask && draft.source === "tui" && JSON.stringify(draft.command) === JSON.stringify({
          name: "inspect",
          execution_role: "specialist-executor",
          allowed_tools: ["file.read", "git.status"],
          skill_id: "inspect-repository",
          skill_version: "1.0.0",
        }));
      } catch { return false; }
    }, "custom command did not enter the governed task-composer store with its typed authority binding");
    stdin.end();
    expect(await donePromise).toBe(0);
  }, 60_000);

  // A generalist prompt must remain tierless so the canonical arbiter/planner
  // can turn layman intent into a bounded plan. The CLI's explicit greenfield
  // shortcut remains available, but forcing `direct` here rejects broad intent
  // before any planner can derive its mutation scope.
  it("Console input strip: a fresh broad submission is never forced to the direct tier", async () => {
    const dir = makeTempDir();
    const stdin = new PassThrough();
    const stdout = capture();
    const stderr = capture();
    const donePromise = runTui({ cwd: dir, stdin, stdout: stdout.stream, stderr: stderr.stream });
    const waitUntil = async (predicate: () => boolean, message: string, timeoutMs = 10_000): Promise<void> => {
      const deadline = Date.now() + timeoutMs;
      while (!predicate()) {
        if (Date.now() > deadline) throw new Error(message);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    };
    await waitUntil(() => stdout.text().includes("revoy2 console"), "Console screen did not render", 30_000);
    const task = "build an astro website with a homepage and an about page";
    for (const char of task) {
      stdin.write(char);
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    await waitUntil(() => stdout.text().includes(task), "typed text did not render in the input strip");
    stdin.write("\n");
    const draftsPath = join(dir, ".arbor", "task-composer", "drafts.json");
    await waitUntil(() => {
      try {
        const parsed = JSON.parse(readFileSync(draftsPath, "utf8")) as { drafts?: readonly { task?: string; source?: string }[] };
        return (parsed.drafts ?? []).some((d) => d.task === task && d.source === "tui");
      } catch {
        return false;
      }
    }, "the console-typed submission never settled to a terminal status", 30_000);
    const parsed = JSON.parse(readFileSync(draftsPath, "utf8")) as { drafts: { task: string; source: string; arbiter_decision: { tier: string; source: string } | null }[] };
    const draft = parsed.drafts.find((d) => d.task === task && d.source === "tui")!;
    expect(draft.arbiter_decision?.source).not.toBe("operator_forced");
    stdin.write("");
    stdin.end();
    expect(await donePromise).toBe(0);
  }, 60_000);

  // Contrast case for the fix above: Cockpit's own "New task" compose entry
  // (never the console-input-strip preset) must keep resolving through the
  // ordinary arbiter classifier -- forcing `direct` there too would make an
  // unrelated, already-scoped task submission fail the same zero-cost
  // admission refusal `arbor greenfield` intentionally applies to unscoped
  // greenfield asks.
  it("Cockpit's own compose entry (not the console input strip) still resolves through the ordinary arbiter classifier, never operator-forced", async () => {
    const dir = makeTempDir();
    const stdin = new PassThrough();
    const stdout = capture();
    const stderr = capture();
    const donePromise = runTui({ cwd: dir, stdin, stdout: stdout.stream, stderr: stderr.stream });
    for (let attempt = 0; attempt < 100 && !stdout.text().includes("Ctrl+P palette"); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    stdin.write("\u000e");
    for (let attempt = 0; attempt < 100 && !stdout.text().includes("WHAT SHOULD REVOY CHANGE?"); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const task = "build an astro website with a homepage and an about page";
    stdin.write(task);
    await new Promise((resolve) => setTimeout(resolve, 200));
    stdin.write("\n");
    const draftsPath = join(dir, ".arbor", "task-composer", "drafts.json");
    const waitUntil = async (predicate: () => boolean, message: string, timeoutMs = 10_000): Promise<void> => {
      const deadline = Date.now() + timeoutMs;
      while (!predicate()) {
        if (Date.now() > deadline) throw new Error(message);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    };
    await waitUntil(() => {
      try {
        const parsed = JSON.parse(readFileSync(draftsPath, "utf8")) as { drafts?: readonly { task?: string; source?: string; status?: string }[] };
        return (parsed.drafts ?? []).some((d) => d.task === task && d.source === "tui" && d.status !== "planning");
      } catch {
        return false;
      }
    }, "the cockpit-composed submission never settled to a terminal status", 30_000);
    const parsed = JSON.parse(readFileSync(draftsPath, "utf8")) as { drafts: { task: string; source: string; arbiter_decision: { tier: string; source: string } | null }[] };
    const draft = parsed.drafts.find((d) => d.task === task && d.source === "tui")!;
    expect(draft.arbiter_decision?.source).not.toBe("operator_forced");
    stdin.write("");
    stdin.end();
    expect(await donePromise).toBe(0);
  }, 60_000);

  it("Console input strip: Enter on an empty buffer only blurs (no form opens); Escape blurs without clearing typed text", async () => {
    const dir = makeTempDir();
    const stdin = new PassThrough();
    const stdout = capture();
    const stderr = capture();
    const donePromise = runTui({ cwd: dir, stdin, stdout: stdout.stream, stderr: stderr.stream });
    const waitUntil = async (predicate: () => boolean, message: string, timeoutMs = 10_000): Promise<void> => {
      const deadline = Date.now() + timeoutMs;
      while (!predicate()) {
        if (Date.now() > deadline) throw new Error(message);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    };
    await waitUntil(() => stdout.text().includes("revoy2 console"), "Console screen did not render", 30_000);
    // Enter on an empty focused buffer: blur only, never the compose form.
    const beforeEmptyEnter = stdout.text().length;
    stdin.write("\n");
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(stdout.text().slice(beforeEmptyEnter)).not.toContain("WHAT SHOULD REVOY CHANGE?");

    // Refocus, type text, then Escape: text must survive (blur without clear).
    stdin.write("\n");
    await new Promise((resolve) => setTimeout(resolve, 40));
    for (const char of "not lost") {
      stdin.write(char);
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    await waitUntil(() => stdout.text().includes("not lost"), "typed text did not render in the input strip");
    stdin.write("\u001b");
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(stdout.text()).toContain("not lost");
    stdin.end();
    expect(await donePromise).toBe(0);
  }, 60_000);

  // T1: blurred, every keystroke including digits falls through to the
  // navigation catalog unchanged, on Console exactly as on any other screen.
  it("Console input strip: navigation keys navigate away while the strip is blurred (T1)", async () => {
    const dir = makeTempDir();
    const stdin = new PassThrough();
    const stdout = capture();
    const stderr = capture();
    const donePromise = runTui({ cwd: dir, stdin, stdout: stdout.stream, stderr: stderr.stream });
    const waitUntil = async (predicate: () => boolean, message: string, timeoutMs = 10_000): Promise<void> => {
      const deadline = Date.now() + timeoutMs;
      while (!predicate()) {
        if (Date.now() > deadline) throw new Error(message);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    };
    await waitUntil(() => stdout.text().includes("revoy2 console"), "Console screen did not render", 30_000);
    // Fresh launch starts focused; Escape explicitly exposes navigation.
    stdin.write("\u001b");
    await new Promise((resolve) => setTimeout(resolve, 40));
    // Blurred (not focused) -- a printable navigation key must reach the input
    // router, not be typed into the strip. "t" (Tree) is used rather than a
    // digit because 1/2/3 were freed when Dashboard/Cockpit/Projects retired.
    const beforeKey = stdout.text().length;
    stdin.write("t");
    // The invariant is that the blurred strip does not capture the key: a
    // repaint follows, and the composer does not come back holding "t".
    await waitUntil(() => stdout.text().length > beforeKey, "no repaint followed the navigation key");
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(stdout.text().slice(beforeKey)).not.toContain("\u276f t");
    stdin.end();
    expect(await donePromise).toBe(0);
  }, 60_000);
});

describe("pendingTaskComposerDraftId (pilot defect #1: submission progress/cancel)", () => {
  it("finds the most recently updated backend-cancellable planning draft", () => {
    const drafts = {
      items: [
        { id: "d1", status: "proposed", updated_at: "2026-08-14T00:00:03.000Z" },
        { id: "d2", status: "planning", updated_at: "2026-08-14T00:00:01.000Z" },
        { id: "d3", status: "awaiting_clarification", updated_at: "2026-08-14T00:00:02.000Z" },
      ],
    };
    expect(pendingTaskComposerDraftId(drafts)).toBe("d2");
  });

  it("returns null when nothing is in flight or the shape is unexpected", () => {
    expect(pendingTaskComposerDraftId({ items: [{ id: "d1", status: "proposed" }] })).toBeNull();
    expect(pendingTaskComposerDraftId({ items: [{ id: "d1", status: "awaiting_clarification" }] })).toBeNull();
    expect(pendingTaskComposerDraftId({ items: [] })).toBeNull();
    expect(pendingTaskComposerDraftId(null)).toBeNull();
    expect(pendingTaskComposerDraftId({})).toBeNull();
    expect(pendingTaskComposerDraftId("not an object")).toBeNull();
  });
});

describe("selectionIntentFromPaneHit — native OpenTUI click bridge", () => {
  it("maps the rows OpenTUI actually reports to scroll-adjusted reducer selections without treating chrome as data", () => {
    // A bordered main pane reserves local row 0 for its border. Tree content
    // then has summary + legend, while tables have caption + header.
    const rows = [{ id: "row-5", context: { campaign_id: "c" } }];
    expect(selectionIntentFromPaneHit({ pane_id: "main", row_in_pane: 1, column_in_pane: 4 }, "tree", rows, 0)).toBeNull();
    expect(selectionIntentFromPaneHit({ pane_id: "main", row_in_pane: 2, column_in_pane: 4 }, "tree", rows, 0)).toBeNull();
    expect(selectionIntentFromPaneHit({ pane_id: "main", row_in_pane: 3, column_in_pane: 4 }, "tree", rows, 0))
      .toEqual({ type: "select_row_identity", screen: "tree", selection: rows[0] });
    expect(selectionIntentFromPaneHit({ pane_id: "main", row_in_pane: 2, column_in_pane: 4 }, "jobs", rows, 0)).toBeNull();
    expect(selectionIntentFromPaneHit({ pane_id: "main", row_in_pane: 3, column_in_pane: 4 }, "jobs", rows, 0))
      .toEqual({ type: "select_row_identity", screen: "jobs", selection: rows[0] });
  });

  it("never invents a selection for another pane or the render-only scroll-end sentinel", () => {
    expect(selectionIntentFromPaneHit({ pane_id: "notifications", row_in_pane: 0, column_in_pane: 0 }, "tree", [{ id: "row" }], 0)).toBeNull();
    expect(selectionIntentFromPaneHit({ pane_id: "main", row_in_pane: 3, column_in_pane: 0 }, "tree", [{ id: "row" }], Number.MAX_SAFE_INTEGER)).toBeNull();
    expect(selectionIntentFromPaneHit({ pane_id: "main", row_in_pane: 3, column_in_pane: 0 }, "tree", [null], 0)).toBeNull();
  });

  it("maps first and last scrolled Tree nodes and ignores rows after their identities", () => {
    const rows = [{ id: "root" }, { id: "child" }, { id: "recovery" }];
    const hit = (row_in_pane: number) => ({ pane_id: "main", row_in_pane, column_in_pane: 4 });
    expect(selectionIntentFromPaneHit(hit(3), "tree", rows, 1)?.selection).toEqual(rows[1]);
    expect(selectionIntentFromPaneHit(hit(4), "tree", rows, 1)?.selection).toEqual(rows[2]);
    expect(selectionIntentFromPaneHit(hit(5), "tree", rows, 1)).toBeNull();
  });
});


// T1/T2 (field-observed cockpit-typeahead defect): pure unit tests for the
// raw-stdin routing decision, independent of a live harness/runtime. See
// `routeKeystroke`'s own doc comment in tui.ts for the full defect history.
describe("routeKeystroke -- raw-stdin routing decision (T1/T2)", () => {
  const noOverlay = { overlay: null } as const;

  it("(a) a digit on an ordinary screen with no overlay open routes to navigation, not compose text", () => {
    expect(routeKeystroke({ screen: "tree", ...noOverlay }, "1", false)).toBe("navigation");
    expect(routeKeystroke({ screen: "tree", ...noOverlay }, "2", false)).toBe("navigation");
    expect(routeKeystroke({ screen: "tree", ...noOverlay }, "3", false)).toBe("navigation");
    // Every screen behaves the same way with no overlay open. Tree and
    // Governance stand in for "any screen" here; Dashboard and Cockpit, which
    // this proof used to name, were folded into Console (ADR-149 Decision 7).
    expect(routeKeystroke({ screen: "governance", ...noOverlay }, "1", false)).toBe("navigation");
  });

  it("(b) a digit while a text input IS focused (an overlay is open) types instead of navigating", () => {
    const operatorFormOpen = { overlay: { kind: "operator_form" } } as const;
    const composeOpen = { overlay: { kind: "compose" } } as const;
    const helpOpen = { overlay: { kind: "help" } } as const;
    const confirmOpen = { overlay: { kind: "confirm" } } as const;
    expect(routeKeystroke({ screen: "tree", ...operatorFormOpen }, "1", false)).toBe("operator_form");
    expect(routeKeystroke({ screen: "tree", ...composeOpen }, "1", false)).toBe("compose_overlay");
    expect(routeKeystroke({ screen: "tree", ...helpOpen }, "1", false)).toBe("help_overlay");
    expect(routeKeystroke({ screen: "tree", ...confirmOpen }, "1", false)).toBe("confirm_overlay");
    // An open overlay wins regardless of screen -- it is what "focused" means.
    expect(routeKeystroke({ screen: "governance", ...operatorFormOpen }, "x", false)).toBe("operator_form");
  });

  it("(c) Console owns Enter directly; only a busy-composer Escape resolves to a cancel route", () => {
    const console_ = { screen: "console" as const, overlay: null };
    // Enter is deliberately NOT routed. Console's raw loop focuses and submits
    // its own inline strip, so a route here would be a second compose
    // authority on the same key — and an unreachable one.
    expect(routeKeystroke(console_, "\r", false)).toBe("navigation");
    expect(routeKeystroke(console_, "\n", true)).toBe("navigation");
    // Escape only means "cancel the in-flight planner" while one is actually
    // busy; otherwise it stays ordinary navigation.
    expect(routeKeystroke(console_, "\u001b", true)).toBe("console_cancel_pending");
    expect(routeKeystroke(console_, "\u001b", false)).toBe("navigation");
  });

  it("non-Cockpit screens never open compose or cancel a pending submission on Enter/Escape", () => {
    expect(routeKeystroke({ screen: "governance", ...noOverlay }, "\n", false)).toBe("navigation");
    expect(routeKeystroke({ screen: "governance", ...noOverlay }, "\u001b", true)).toBe("navigation");
  });
});
