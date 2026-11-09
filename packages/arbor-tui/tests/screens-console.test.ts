import { describe, it, expect, afterEach } from "vitest";
import { registerScreen, clearRegisteredScreens, getScreen, availableScreens } from "../src/screens/screen.js";
import { consoleScreen } from "../src/screens/console.js";
import { displayWidth } from "../src/widgets.js";

afterEach(() => clearRegisteredScreens());

function render(result: unknown, width = 100, height = 30, color = false): readonly string[] {
  const projection = consoleScreen.project(result, { width, height });
  return consoleScreen.render({ projection, width, height, color });
}

it("renders a bounded return-to-live affordance while inspecting history", () => {
  const width = 100;
  const height = 30;
  const projection = consoleScreen.project(fixture, { width, height });
  const lines = consoleScreen.render({
    projection,
    width,
    height,
    color: false,
    scroll_offset: 0,
    live_edge: { mode: "scrollback", anchor_id: "canonical:session-1:1", unseen_meaningful_events: 2 },
  });
  expect(lines.join("\n")).toContain("HISTORY · 2 new · End return to live");
});

const fixture = {
  campaigns: {
    items: [
      { id: "camp-01", plan_path: "draft-01.json", active_node_state: "expanding", active_node_description: "Refactor terminal shell", active_node_role: "specialist", verified_nodes: 4, total_nodes: 9, halted: false },
    ],
  },
  drafts: { items: [{ campaign_id: "camp-01", task: "Give revoy2 an opencode-like console" }] },
  governance: {
    decision_status_distribution: { accepted: 12, proposed: 2 },
    policy_findings: [
      { rule_id: "POL-04", severity: "warning", detail: "Obligation missing a resolving proof", subject: { record_id: "ADR-108" } },
    ],
  },
  connector: { selection: { kind: "selected", connector_id: "revoy-native" } },
  usage_cost: [{ tags: { pricing: "priced", currency: "USD", minor_unit_exponent: 2 }, cost_minor_units: 431, input_tokens: 1000, output_tokens: 200, cache_read_tokens: 0 }],
  activity: [
    { timestamp: "2026-08-26T10:00:00.000Z", label: "Planning: Give revoy2 an opencode-like console", tone: "working", source: "task" },
    { timestamp: "2026-08-26T10:05:00.000Z", label: "expanding · specialist: Refactor terminal shell · 4/9 verified", tone: "working", source: "campaign" },
    { timestamp: "2026-08-26T10:10:00.000Z", label: "Approval needed: review requested", tone: "needs-operator", source: "approval" },
  ],
  tree: {
    campaign_id: "camp-01",
    nodes: [
      { id: "root", label: "Plan: Give revoy2 an opencode-like console", depth: 0, state: "claimed", has_children: true, action_delegate: "crown" },
      { id: "n1", parent_id: "root", label: "Expand: console.ts screen module", depth: 1, state: "expanding", has_children: false, action_delegate: "heartwood" },
    ],
  },
  agents: { live: [{ agent: "heartwood", task_id: "task-1", operation_id: "op-1", state: "running", kind: "specialist" }], active_agent_count: 1 },
  sessions: { sessions: [{ session_id: "session-1", campaign_id: "camp-01", node_id: "n1", terminal: null, state: "running", operation: "specialize" }] },
  selected_session_id: "session-1",
  session_attach: {
    session: { session_id: "session-1", campaign_id: "camp-01", node_id: "n1", operation: "specialize", connector_id: "native", state: "running", latest_sequence: 2 },
    live: true,
    pending_steering: 0,
    events: [{ sequence: 1, occurred_at: "2026-08-26T10:06:00.000Z", kind: "model_text", payload: { text: "Inspecting the renderer composition", phase: "commentary" } }],
  },
  devtools: { lines: [
    { seq: 1, ts: "2026-08-26T10:07:00.000Z", event_kind: "loop.tool_call", campaign_id: "camp-01", node_id: "n1", loop_event: { command: "rg render Console", stdout: "console.ts" } },
    { seq: 2, ts: "2026-08-26T10:08:00.000Z", event_kind: "loop.tool_call", campaign_id: "camp-01", node_id: "n1", loop_event: { command: "bun test" } },
  ] },
  operator_interviews: {
    campaign_id: "camp-01", node_id: "n1",
    records: [{ kind: "request_user_input", id: "question-1", timestamp: "2026-08-26T10:09:00.000Z", question: { question: "Choose the project greeting" }, answer: { custom_text: "Hello, governed world", answered_at: "2026-08-26T10:09:30.000Z", answered_by: "operator" } }],
  },
  console_input: { text: "check node n1", cursor: 5, focused: true },
  captured_at: "2026-08-26T10:10:00.000Z",
};

describe("console screen", () => {
  it("is registered with a real campaign.read-gated capability and a real query surface", () => {
    registerScreen(consoleScreen);
    const mod = getScreen("console");
    expect(mod.title).toBe("Console");
    expect(mod.required_capabilities).toEqual(["campaign.read"]);
    expect(mod.surface.commands).toEqual(["taskcomposer.submit", "harness.session.steer", "harness.session.interrupt"]);
    expect(mod.surface.queries).toContain("campaign.tree");
    expect(mod.surface.queries).toContain("campaign.list");
    expect(mod.surface.queries).toContain("governance.snapshot");
  });

  it("is offered under the same campaign.read gate as the other product surfaces", () => {
    registerScreen(consoleScreen);
    expect(availableScreens(new Set([])).some((s) => s.id === "console")).toBe(false);
    expect(availableScreens(new Set(["campaign.read"])).some((s) => s.id === "console")).toBe(true);
  });

  it("renders a transcript-first frontier surface with compact live state and input", () => {
    const lines = render({ ...fixture, sidebar_visibility: "hidden" }, 140, 40);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.length).toBeLessThanOrEqual(40);
    for (const line of lines) expect(displayWidth(line)).toBeLessThanOrEqual(140);

    // Header: human task title + readable current status precede transcript.
    expect(lines[0]).toContain("TASK · Give revoy2 an opencode-like console");
    expect(lines[0]).toContain("STATUS · Working");
    expect(lines[0]).toContain("tree 1:1");
    expect(lines[0]).toContain("revoy-native");

    const joined = lines.join("\n");
    expect(joined).toContain("Inspecting the renderer composition");
    expect(joined).toContain("$ rg render Console");
    expect(joined).toContain("tests ran: bun test");
    expect(joined).toContain("Choose the project greeting");
    expect(joined).toContain("Hello, governed world");
    expect(joined).not.toContain("PROJECT GOVERNANCE");
    expect(joined).not.toContain("AGENTS IN FLIGHT");
    expect(joined).not.toContain("edge=decomposition");
    expect(joined).not.toContain("taskcomposer:");
    expect(joined).toContain("NOW · Expand: console.ts screen module");
    // A bounded frontier signal can still surface an actionable policy state;
    // the full governance inventory remains behind the explicit sidebar.
    expect(joined).toContain("POL-04 warning");
    // Input strip: bordered box with the real buffer/cursor rendered inline.
    expect(joined).toContain("❯");
    expect(joined).toContain("check");
  });

  it("places one truthful needs-operator queue above routine chronology", () => {
    const withAttention = {
      ...fixture,
      approvals: { records: [
        { id: "approval-open", status: "pending" },
        { id: "approval-closed", status: "approved" },
      ] },
      operator_interviews: { records: [
        { id: "question-open", question: "Choose a store" },
        { id: "question-closed", question: "Choose output", answer: { custom_text: "text" } },
      ] },
    };
    const joined = render(withAttention, 140, 40).join("\n");
    expect(joined).toContain("? NEEDS YOU · 1 interview [i] · 1 approval [0]");
    expect(joined).not.toContain("2 interviews");
    expect(joined).not.toContain("2 approvals");
  });

  it("promotes a halted node's critic root cause and stops the activity spinner", () => {
    const blocked = {
      ...fixture,
      campaigns: { items: [{ ...fixture.campaigns.items[0], active_node_state: "failed", halted: true, halt_reason: "no_nodes" }] },
      tree: {
        campaign_id: "camp-01", halted: true, halt_reason: "no_nodes",
        nodes: [
          { id: "root", state: "claimed", parent_id: null },
          { id: "n1", state: "failed", parent_id: "root", critic_verdict: { root_cause: "acceptance command was not run" } },
        ],
      },
      session_attach: { ...fixture.session_attach, live: false, session: { ...fixture.session_attach.session, state: "completed" } },
    };
    const joined = render(blocked, 140, 40).join("\n");
    expect(joined).toContain("! BLOCKED · acceptance command was not run");
    // EC-064: nothing was verified, so the activity line must not claim completion.
    expect(joined).toContain("0 verified");
    expect(joined).not.toContain("Complete · ready for review");
    expect(joined).not.toContain("Thinking · waiting for the next streamed update");
  });

  it("renders a terminal final answer as a scrollable document instead of a two-line event", () => {
    const answer = Array.from({ length: 18 }, (_, index) => `Answer paragraph ${index + 1}: concrete operator detail.`).join("\n\n");
    const terminal = {
      ...fixture,
      campaigns: { items: [{ ...fixture.campaigns.items[0], active_node_state: "verified", halted: true, halt_reason: "verified_result" }] },
      tree: { ...fixture.tree, halted: true, halt_reason: "verified_result" },
      session_attach: {
        session: { ...fixture.session_attach.session, state: "completed", latest_sequence: 3 },
        live: false,
        pending_steering: 0,
        events: [
          ...fixture.session_attach.events,
          { sequence: 2, occurred_at: "2026-08-26T10:11:00.000Z", kind: "model_text", payload: { text: answer, phase: "final" } },
          { sequence: 3, occurred_at: "2026-08-26T10:11:01.000Z", kind: "terminal", payload: { state: "completed" } },
        ],
      },
    };
    const projection = consoleScreen.project(terminal, { width: 100, height: 20 });
    const first = consoleScreen.render({ projection, width: 100, height: 20, color: false, scroll_offset: 0 }).join("\n");
    const later = consoleScreen.render({ projection, width: 100, height: 20, color: false, scroll_offset: 20 }).join("\n");
    expect(first).toContain("ANSWER");
    expect(first).toContain("Answer paragraph 1: concrete operator detail.");
    expect(first).not.toContain("final answer · assistant");
    expect(later).toContain("Answer paragraph 10: concrete operator detail.");
    expect(later).not.toContain("Answer paragraph 1: concrete operator detail.");
  });

  it("keeps independently ordered sources visibly labelled instead of claiming a fabricated shared chronology", () => {
    const lines = render(fixture, 100, 30);
    const assistantIndex = lines.findIndex((line) => line.trimStart().startsWith("· Inspecting the renderer"));
    const commandIndex = lines.findIndex((line) => line.trimStart().startsWith("│ $ rg render Console"));
    const interviewIndex = lines.findIndex((line) => line.trimStart().startsWith("? Choose the project greeting"));
    expect(assistantIndex).toBeGreaterThanOrEqual(0);
    expect(commandIndex).toBeGreaterThan(assistantIndex);
    // The canonical session journal, durable user-input ledger, and local
    // devtools tail have no shared durable sequence. The canonical grammar
    // therefore source-groups them and labels the source instead of sorting
    // coincident timestamps into a misleading global history.
    expect(interviewIndex).toBeGreaterThan(assistantIndex);
    expect(interviewIndex).toBeLessThan(commandIndex);
    expect(lines.join("\n")).toContain("canonical/userinput");
    expect(lines.join("\n")).toContain("supplemental/devtools");
  });

  it("renders distinct tool, test, and diff chronology beats without turning the console into a raw log", () => {
    const withChangeProgress = {
      ...fixture,
      devtools: { lines: [
        { seq: 1, ts: "2026-08-26T10:07:00.000Z", event_kind: "loop.tool_call", campaign_id: "camp-01", node_id: "n1", loop_event: { command: "rg render Console", tool: "shell" } },
        { seq: 2, ts: "2026-08-26T10:08:00.000Z", event_kind: "loop.tool_call", campaign_id: "camp-01", node_id: "n1", loop_event: { command: "bun run test:all", tool: "shell", ok: true, exit: 0 } },
        { seq: 3, ts: "2026-08-26T10:08:30.000Z", event_kind: "loop.diff", campaign_id: "camp-01", node_id: "n1", loop_event: { path: "console.ts", additions: 12, deletions: 3, diff: "raw patch stays in Diff Review" } },
      ] },
    };
    const joined = render(withChangeProgress, 140, 40).join("\n");
    expect(joined).toContain("$ rg render Console");
    expect(joined).toContain("tests passed: bun run test:all");
    expect(joined).toContain("diff captured: console.ts");
    expect(joined).toContain("+12 / -3");
    expect(joined).not.toContain("raw patch stays in Diff Review");
  });

  it("wraps dense critic and gate chronology and narrates a halted tree as an outcome, never NOW", () => {
    const halted = {
      ...fixture,
      tree: {
        ...fixture.tree,
        halted: true,
        halt_reason: "no_nodes",
        nodes: fixture.tree.nodes.map((node) => ({ ...node, state: node.id === "n1" ? "failed" : "claimed" })),
      },
      session_attach: {
        ...fixture.session_attach,
        events: [{
          sequence: 1,
          occurred_at: "2026-08-26T10:06:00.000Z",
          kind: "approval_requested",
          payload: { subject: "This intentionally long critic explanation must wrap onto a continuation row instead of becoming one horizontally dense clipped sentence in the primary journey" },
        }],
      },
    };
    const joined = render(halted, 80, 30).join("\n");
    expect(joined).toContain("OUTCOME · halted (no_nodes)");
    expect(joined).not.toContain("NOW · Expand: console.ts screen module");
    expect(joined).toContain("This intentionally long critic");
    expect(joined).toContain("explanation must wrap");
    expect(joined).toContain("continuation row");
  });

  it("wires the canonical operator projection into the real Console with source and lifecycle truth", () => {
    const projection = consoleScreen.project(fixture, { width: 140, height: 40 });
    const events = projection.rows
      .filter((row: Readonly<Record<string, unknown>>) => row.region === "operator-event")
      .map((row: Readonly<Record<string, unknown>>) => row.event as Readonly<Record<string, unknown>>);
    expect(events.length).toBeGreaterThan(0);
    expect(events.some((event) => event.kind === "agent_narrative" && event.truth === "canonical")).toBe(true);
    expect(events.some((event) => event.kind === "tool" && event.truth === "supplemental")).toBe(true);
    expect(events.every((event) => event.source_id !== undefined && event.lifecycle !== undefined)).toBe(true);
  });

  it("keeps durable input and governed task rows visible when no session transcript is selected", () => {
    const projection = consoleScreen.project({
      captured_at: "2026-08-26T10:00:00.000Z",
      operator_interviews: { records: [{ id: "input-1", question: { question: "Choose a release target" } }] },
      drafts: { items: [{ id: "draft-1", task: "Prepare the governed release", status: "planning" }] },
    }, { width: 100, height: 30 });
    const events = projection.rows
      .filter((row: Readonly<Record<string, unknown>>) => row.region === "operator-event")
      .map((row: Readonly<Record<string, unknown>>) => row.event as Readonly<Record<string, unknown>>);
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: "userinput", summary: "Choose a release target", lifecycle: "pending" }),
      expect.objectContaining({ source: "taskcomposer", summary: "Prepare the governed release", lifecycle: "observed" }),
      expect.objectContaining({ source: "taskcomposer", summary: "planning task", lifecycle: "pending" }),
    ]));
  });

  it("renders canonical parentage as a compact causal branch instead of flattening nested work", () => {
    const nested = {
      ...fixture,
      session_attach: {
        ...fixture.session_attach,
        events: [
          { sequence: 1, occurred_at: "2026-08-26T10:06:00.000Z", kind: "model_text", payload: { text: "Inspect authentication", operation_id: "task-1" } },
          { sequence: 2, occurred_at: "2026-08-26T10:06:01.000Z", kind: "tool_intent", payload: { tool: "shell", input_summary: "rg auth", parent_id: "task-1", operation_id: "tool-1" } },
          { sequence: 3, occurred_at: "2026-08-26T10:06:02.000Z", kind: "tool_result", payload: { tool: "shell", result_summary: "route found", parent_id: "tool-1", operation_id: "result-1" } },
        ],
      },
    };
    const joined = render(nested, 140, 40).join("\n");
    expect(joined).not.toContain("↳ task-1");
    const projected = consoleScreen.project(nested, { width: 140, height: 40 });
    const history = consoleScreen.render({ projection: projected, width: 140, height: 40, color: false, scroll_offset: 0 }).join("\n");
    expect(history).toContain("↳ task-1");
    expect(history).toContain("↳ tool-1");
    expect(joined).toContain("│ tool: shell");
    expect(joined).toContain("└ tool result: shell");
    expect(joined).toContain("route found");
  });

  it("hides the auto sidebar below the breakpoint without corrupting the timeline", () => {
    const wide = render(fixture, 100, 30);
    const narrow = render(fixture, 60, 30);
    expect(narrow.length).toBeGreaterThan(0);
    expect(narrow.length).toBeLessThanOrEqual(30);
    for (const line of narrow) expect(line.length).toBeLessThanOrEqual(60 * 4);
    const narrowJoined = narrow.join("\n");
    expect(narrowJoined).toContain("Inspecting the renderer");
    expect(narrowJoined).not.toContain("PROJECT GOVERNANCE");
    expect(wide.length).toBeGreaterThan(0);
  });

  it("renders a calm empty state with zero campaigns — never blank space or a crash", () => {
    const lines = render({ captured_at: "2026-08-26T10:00:00.000Z" }, 100, 30);
    expect(lines.length).toBeGreaterThan(0);
    const joined = lines.join("\n");
    expect(joined).not.toBe("");
    expect(joined.toLowerCase()).toContain("no active campaign");
  });

  it("renders a calm empty state when no raw result has arrived yet", () => {
    expect(() => render(null, 100, 30)).not.toThrow();
    expect(() => render(undefined, 100, 30)).not.toThrow();
    const lines = render(null, 100, 30);
    expect(lines.length).toBeGreaterThan(0);
  });

  it("renders the inline buffer and cursor when focused, and a blurred hint otherwise", () => {
    const focused = render({ ...fixture, console_input: { text: "hello", cursor: 5, focused: true } }, 100, 30);
    expect(focused.join("\n")).toContain("hello");
    expect(focused.join("\n")).toContain("▏");

    const blurred = render({ ...fixture, console_input: { text: "", cursor: 0, focused: false } }, 100, 30);
    expect(blurred.join("\n")).toContain("Enter to focus");
  });

  it("renders the focused intake field and persistent project inspector for a fresh launch", () => {
    const projection = consoleScreen.project({
      ...fixture,
      fresh_launch_empty: true,
      console_input: { text: "", cursor: 0, focused: true },
    }, { width: 100, height: 30 });
    expect(projection.rows.some((row) => row.region === "sidebar")).toBe(true);
    expect(projection.rows.at(-1)).toEqual({ region: "input", text: "", cursor: 0, focused: true, action: "send", interrupt_available: false });
    const joined = consoleScreen.render({ projection, width: 100, height: 30, color: false }).join("\n");
    expect(joined).toContain("▏");
    expect(joined).not.toContain("Refactor terminal shell");
    expect(joined).not.toContain("No canonical operator event");
  });

  it("acknowledges a submitted task before the durable draft query catches up", () => {
    const projection = consoleScreen.project({
      ...fixture,
      campaigns: { items: [] },
      drafts: { items: [] },
      fresh_launch_empty: true,
      submission_pending: { task: "Create a health-check CLI", submitted_at: "2026-08-31T21:00:00Z" },
      console_input: { text: "", cursor: 0, focused: false },
    }, { width: 100, height: 30 });
    const joined = consoleScreen.render({ projection, width: 100, height: 30, color: false }).join("\n");
    expect(projection.variant).toBe("planning");
    expect(joined).toContain("TASK · Create a health-check CLI");
    expect(joined).toContain("ACCEPTED · handing the request to governed planning");
  });

  it("replaces the cancel affordance with an immediate stopping acknowledgement", () => {
    const projection = consoleScreen.project({
      ...fixture,
      campaigns: { items: [] }, drafts: { items: [] }, fresh_launch_empty: true,
      submission_pending: { task: "Create a health-check CLI" },
      cancellation_pending: { task: "Create a health-check CLI", requested_at: "2026-08-31T21:00:01Z" },
      console_input: { text: "", cursor: 0, focused: false },
    }, { width: 100, height: 30 });
    const joined = consoleScreen.render({ projection, width: 100, height: 30, color: false }).join("\n");
    expect(joined).toContain("Stopping your request");
    expect(joined).toContain("STOPPING · cancellation requested for Create a");
    expect(joined).toContain("health-check CLI");
    expect(joined).not.toContain("Esc cancel");
  });

  it("lets a cancelled job override stale claimed tree and live-session projections", () => {
    const joined = render({
      ...fixture,
      jobs: { jobs: [{ id: "task-composer-run:draft-1", state: "interrupted" }] },
      console_input: { text: "", cursor: 0, focused: false },
    }, 140, 40).join("\n");
    expect(joined).toContain("STATUS · Stopped");
    expect(joined).toContain("OUTCOME · stopped by the operator · ready for another instruction");
    expect(joined).toContain("Stopped · ready for your next instruction");
    expect(joined).not.toContain("STATUS · Working");
    expect(joined).not.toContain("STATUS · Delegating");
    expect(joined).not.toContain("Working · waiting for the next streamed update");
  });

  it("reveals the accepted task and canonical planning lifecycle before a campaign exists", () => {
    const projection = consoleScreen.project({
      ...fixture,
      campaigns: { items: [] },
      drafts: { items: [{ id: "draft-new", task: "Build a governed release cockpit", status: "planning" }] },
      fresh_launch_empty: false,
      fresh_launch_planning: true,
      console_input: { text: "", cursor: 0, focused: true },
    }, { width: 100, height: 30 });
    const joined = consoleScreen.render({ projection, width: 100, height: 30, color: false }).join("\n");
    expect(joined).toContain("Build a governed release cockpit");
    expect(joined).toContain("PLANNING · Building the plan");
    expect(joined).toContain("Esc cancel");
    expect(joined).not.toContain("Refactor terminal shell");
    expect(joined).not.toContain("Inspecting the renderer composition");
    expect(joined).not.toContain("No canonical operator event");
  });

  // ADR-124 O1/O2: Enter on a non-empty focused buffer is wired to submit
  // (tui.ts routes it through dispatchTaskComposer's open_task_preset), not
  // to merely clear — the focused hint must say so, or the strip repeats
  // exactly the affordance-vs-behavior mismatch ADR-124 was written to
  // close, just at the label instead of the keystroke.
  it("labels the focused hint with what Enter actually does (send), not the stale 'clear' description", () => {
    const focused = render({ ...fixture, console_input: { text: "hello", cursor: 5, focused: true } }, 100, 30);
    const joined = focused.join("\n");
    expect(joined).toContain("Enter send");
    expect(joined).not.toContain("Enter clear");
  });

  it("never throws across a degenerate 1x1 render", () => {
    expect(() => render(fixture, 1, 1)).not.toThrow();
  });

  it("never renders the retired synthesized activity timeline when no canonical document row exists", () => {
    const onlyActivity = {
      captured_at: "2026-08-26T10:00:00.000Z",
      activity: [{ timestamp: "2026-08-26T10:00:00.000Z", label: "Synthetic campaign status", tone: "working", source: "campaign" }],
    };
    const projection = consoleScreen.project(onlyActivity, { width: 100, height: 30 });
    expect(projection.rows.some((row: Readonly<Record<string, unknown>>) => row.region === "transcript")).toBe(false);
    const joined = consoleScreen.render({ projection, width: 100, height: 30, color: false }).join("\n");
    expect(joined).toContain("No canonical operator event is available");
    expect(joined).not.toContain("Synthetic campaign status");
  });

  it("colors a needs-operator canonical row with theme.ts's palette when color is enabled, and stays byte-identical without it", () => {
    const withAttention = {
      ...fixture,
      session_attach: { session: fixture.session_attach.session, live: true, pending_steering: 0, events: [
        { sequence: 1, occurred_at: "2026-08-26T10:00:00.000Z", kind: "approval_requested", payload: { subject: "Approval needed: review requested" } },
      ] },
      devtools: { lines: [] }, operator_interviews: { records: [] },
    };
    const colored = render(withAttention, 100, 30, true);
    const plain = render(withAttention, 100, 30, false);
    const coloredLine = colored.find((line) => line.includes("Approval needed"));
    const plainLine = plain.find((line) => line.includes("Approval needed"));
    expect(coloredLine).toBeDefined();
    expect(plainLine).toBeDefined();
    // A real SGR escape byte is present when color is on.
    expect(coloredLine).toContain("[");
    // The plain-text render carries no escape byte at all.
    expect(plainLine).not.toContain("[");
    // Stripping ANSI from the colored line reproduces the plain line's text content.
    // eslint-disable-next-line no-control-regex
    const stripped = coloredLine!.replace(/\[[0-9;]*m/g, "");
    expect(stripped).toBe(plainLine);
  });

  it("closes a colored canonical row's SGR before end of line even when the label is clipped, so color never bleeds into the tree/governance column beside it", () => {
    const longAttention = {
      ...fixture,
      session_attach: { session: fixture.session_attach.session, live: true, pending_steering: 0, events: [
        { sequence: 1, occurred_at: "2026-08-26T10:00:00.000Z", kind: "approval_requested", payload: { subject: "Approval needed: a very long operator-facing summary line that will not fit inside the narrow timeline at a small terminal width" } },
      ] },
      devtools: { lines: [] }, operator_interviews: { records: [] },
    };
    // Narrow enough that the left timeline column must clip this label.
    const colored = render(longAttention, 80, 30, true);
    const coloredLine = colored.find((line) => line.includes("Approval needed"));
    expect(coloredLine).toBeDefined();
    // eslint-disable-next-line no-control-regex
    expect(coloredLine).toMatch(/\[0m/);
  });

  // ── Console chronology starts beneath current task state ─────────────────

  it("pins the composer to the bottom while keeping chronology directly below current state", () => {
    const lines = render(fixture, 120, 40);
    expect(lines).toHaveLength(40);
    expect(lines.at(-1)).toContain("Enter send");
    const transcript = lines.findIndex((line) => line.includes("Inspecting the renderer composition"));
    const firstBlank = lines.findIndex((line, index) => index > transcript && line.trim() === "");
    expect(transcript).toBeGreaterThan(0);
    expect(firstBlank).toBeGreaterThan(transcript);
  });

  it("keeps the same bottom anchor at 80x24 and grows only for explicit multiline rows", () => {
    const input = { text: "first\nsecond\nthird", cursor: 18, focused: true };
    const lines = render({ ...fixture, console_input: input }, 80, 24);
    expect(lines).toHaveLength(24);
    expect(lines.at(-1)).toContain("Enter send");
    expect(lines.join("\n")).toContain("first");
    expect(lines.join("\n")).toContain("second");
    expect(lines.join("\n")).toContain("third▏");
  });

  it("labels live-session steering as a queue and makes the interrupt affordance explicit", () => {
    const joined = render({ ...fixture, console_input: { text: "hold", cursor: 4, focused: true, action: "queue", interrupt_available: true } }, 120, 40).join("\n");
    expect(joined).toContain("Enter queue");
    expect(joined).toContain("Ctrl+K interrupt");
  });

  it("keeps the persistent project inspector docked at an ordinary terminal width", () => {
    const joined = render({ ...fixture, sidebar_visibility: "shown" }, 90, 30).join("\n");
    expect(joined).toContain("PROJECT REPO");
    expect(joined).toContain("Ctrl+B focus");
  });
});

describe("console screen — the input strip survives a short narrow terminal (geometry)", () => {
  // The composer owns its rows before header/body budgeting. A very short
  // terminal must therefore shrink chronology, never truncate the anchored
  // input strip from the bottom.
  it("always renders the prompt marker and the focused/blurred hint text, never just a dangling top border", () => {
    const lines = consoleScreen.render({ projection: consoleScreen.project(fixture, { width: 60, height: 5 }), width: 60, height: 5, color: false });
    const joined = lines.join("\n");
    expect(joined).toContain("❯");
    expect(joined).toMatch(/Enter (send|focus)/);
  });
});

describe("console screen — input strip with wide CJK glyphs stays column-exact", () => {
  it("never overflows the pane's real display-column width when the buffer holds wide CJK characters", () => {
    const lines = consoleScreen.render({
      projection: consoleScreen.project({ ...fixture, console_input: { text: "查询节点树状态", cursor: 3, focused: true } }, { width: 60, height: 30 }),
      width: 60, height: 30, color: false,
    });
    for (const line of lines) expect(displayWidth(line)).toBeLessThanOrEqual(60);
    // The right border of the bordered box is still present on every strip
    // row (it is not pushed off the pane by a wide-glyph miscount).
    const promptLine = lines.find((line) => line.includes("❯"));
    expect(promptLine).toBeDefined();
    expect(promptLine!.endsWith("│")).toBe(true);
  });
});

describe("console screen — the input strip scrolls to keep the cursor visible on a long buffer", () => {
  // `renderInputStrip` used to build `buffer` (text + cursor marker) and
  // hand it straight to `clipDisplay`, which always keeps the PREFIX of a
  // string that's too wide. Typing (or pasting) past the strip's visible
  // width therefore pinned the cursor marker — and everything just typed —
  // off the right edge: the strip looked frozen, indistinguishable from
  // keystrokes silently not registering. This is exactly the class of
  // defect the operator's brief calls out ("any input that silently
  // no-ops") and is very likely to trigger live: any task description
  // longer than ~50 columns overflows a typical console-pane width.
  it("keeps the cursor marker visible once the typed buffer exceeds the strip's visible width", () => {
    const longText = "a".repeat(120);
    const lines = consoleScreen.render({
      projection: consoleScreen.project({ ...fixture, console_input: { text: longText, cursor: 120, focused: true } }, { width: 60, height: 30 }),
      width: 60, height: 30, color: false,
    });
    const promptLine = lines.find((l) => l.includes("❯"));
    expect(promptLine).toBeDefined();
    expect(promptLine).toContain("▏");
  });

  it("keeps the cursor marker visible when it sits in the middle of an overflowing buffer, not just at the end", () => {
    const longText = "a".repeat(60) + "b".repeat(60);
    const lines = consoleScreen.render({
      projection: consoleScreen.project({ ...fixture, console_input: { text: longText, cursor: 60, focused: true } }, { width: 60, height: 30 }),
      width: 60, height: 30, color: false,
    });
    const promptLine = lines.find((l) => l.includes("❯"));
    expect(promptLine).toBeDefined();
    expect(promptLine).toContain("▏");
  });

  it("still fits every input-strip line within the pane's own width once scrolled", () => {
    const longText = "a".repeat(200);
    const lines = consoleScreen.render({
      projection: consoleScreen.project({ ...fixture, console_input: { text: longText, cursor: 200, focused: true } }, { width: 60, height: 30 }),
      width: 60, height: 30, color: false,
    });
    for (const line of lines) expect(displayWidth(line)).toBeLessThanOrEqual(60);
  });
});

// ── ADR-149 Decision 7: the retired peer screens' facts survive in Console ──

describe("absorbed Dashboard/Projects facts", () => {
  const load = (): typeof import("../src/screens/console.js") => require("../src/screens/console.js");
  void load;
  const withExplicitSidebar = <T extends object>(value: T): T & { sidebar_visibility: "shown" } => ({ ...value, sidebar_visibility: "shown" });

  it("projects fleet and portfolio facts only when the operator explicitly opens context", async () => {
    const { absorbedSurfaceFixture } = await import("./support/absorbed-fixture.js");
    const projection = consoleScreen.project(withExplicitSidebar(absorbedSurfaceFixture), { width: 120, height: 40 });
    const facts = projection.rows.filter((row) => row.region === "fleet" || row.region === "portfolio");
    const byLabel = new Map(facts.map((row) => [(row as { fact: { label: string; value: string } }).fact.label,
                                                (row as { fact: { label: string; value: string } }).fact.value]));
    // Counts, not placeholders: these are the exact numbers the Dashboard
    // computed from the same snapshot.
    expect(byLabel.get("CAMPAIGNS")).toBe("7");
    expect(byLabel.get("ACTIVE")).toBe("2");
    expect(byLabel.get("VERIFIED NODES")).toBe("6");
    expect(byLabel.get("APPROVALS")).toBe("2");
    expect(byLabel.get("ACTIVE JOBS")).toBe("2");
    // Scope-qualified on purpose: campaign.list carries only the ROOT state.
    expect(byLabel.get("REVIEWS PENDING (root)")).toBe("1");
    expect(byLabel.get("LIVE NATIVE SESSIONS")).toBe("0");
    // Projects' portfolio facts.
    expect(byLabel.get("ROADMAP")).toBe("2");
    expect(byLabel.get("SKILLS")).toBe("12");
    expect(byLabel.get("NEXT ROADMAP")).toBe("Close the gap register");
  });

  it("renders a genuine absence as itself, never as a fabricated zero", async () => {
    const { absorbedSurfaceFixture } = await import("./support/absorbed-fixture.js");
    const projection = consoleScreen.project(withExplicitSidebar(absorbedSurfaceFixture), { width: 120, height: 40 });
    const cost = projection.rows.find((row) => row.region === "fleet"
      && (row as { fact: { label: string } }).fact.label === "COST") as { fact: { value: string } } | undefined;
    // No usage_cost in the fixture: the Dashboard's own rule was that an absent
    // projection stays "unavailable" rather than becoming $0.
    expect(cost?.fact.value).toBe("unavailable");
  });

  it("shows every fact at a wide terminal", async () => {
    const { absorbedSurfaceFixture } = await import("./support/absorbed-fixture.js");
    const text = render({ ...withExplicitSidebar(absorbedSurfaceFixture), sidebar_tab: "devtools" }, 140, 44).join(" ");
    for (const label of ["CAMPAIGNS", "ACTIVE JOBS", "LIVE NATIVE SESSIONS", "COST", "SKILLS", "NEXT ROADMAP"]) {
      expect(text).toContain(label);
    }
  });

  it("EC-057: lists facts one per line with a named remainder instead of a wrapped wall", async () => {
    const { absorbedSurfaceFixture } = await import("./support/absorbed-fixture.js");
    const lines = render({ ...withExplicitSidebar(absorbedSurfaceFixture), sidebar_tab: "devtools" }, 132, 50).map((line) => line.slice(-42));
    const operator = lines.findIndex((line) => line.includes("OPERATOR"));
    expect(operator).toBeGreaterThan(-1);
    const block = lines.slice(operator, operator + 6).join("\n");
    // A list row carries one label and its value; the wall joined them with " · ".
    expect(block).not.toContain(" · ");
    expect(lines.some((line) => /\+\d+ more · Ctrl\+B/.test(line)) || lines.filter((line) => /^[│ ]*[A-Z][A-Z ]+ {2}\S/.test(line)).length >= 3).toBe(true);
  });

  it("announces the overflow at 80x24 instead of dropping facts silently", async () => {
    const { absorbedSurfaceFixture } = await import("./support/absorbed-fixture.js");
    const lines = render({ ...withExplicitSidebar(absorbedSurfaceFixture), sidebar_tab: "devtools" }, 80, 24);
    const text = lines.join(" ");
    expect(text).toContain("CAMPAIGNS");
    // Compact mode cannot show all of them; ADR-149 Decision 7 requires the
    // reduced layout be labelled, and ADR-126 Decision 2 requires truncation
    // be visible. A silent drop would satisfy neither.
    expect(lines.some((line) => /\+\d+ more/.test(line))).toBe(true);
  });
});

// ── the armed-confirmation prompt is never elided ───────────────────────────

describe("captured-result action prompt", () => {
  const withCapture = (feedback: string) => ({
    captured_at: "2026-08-29T00:00:00Z",
    campaigns: { total: 1, items: [{ id: "c1", halted: false, root_node_state: "expanding" }] },
    result_review: {
      summary: "Command-verified, scope-blocked captured result for campaign c1, node root.",
      controls: "A arm exact scope authorization; S choose files; R unavailable until this session adopts the patch",
      feedback,
    },
  });

  it("keeps the armed-confirmation prompt out of the elidable fact strip", () => {
    const raw = withCapture("Confirm authorization of exactly generated.txt with A");
    const projection = consoleScreen.project(raw, { width: 120, height: 40 });
    // It must not be one of the operator facts: that block is bounded and drops
    // its tail behind "+N more".
    const facts = projection.rows.filter((row) => row.region === "fleet" || row.region === "portfolio" || row.region === "operations");
    expect(facts.some((row) => JSON.stringify(row).includes("Confirm authorization"))).toBe(false);
    expect(projection.rows.some((row) => row.region === "completion")).toBe(true);
  });

  it("renders the prompt in full at 80x24, where the fact strip is already truncating", () => {
    const raw = withCapture("Confirm authorization of exactly generated.txt with A");
    const lines = render(raw, 80, 24);
    const text = lines.join(" ");
    // A destructive second keypress is armed; the operator must be told so even
    // on the narrow layout that elides campaign counts.
    expect(text).toContain("Confirm authorization of exactly generated.txt with A");
  });

  it("renders a labelled completion manifest immediately above the pinned composer", () => {
    const raw = {
      ...withCapture(""),
      result_review: {
        ...withCapture("").result_review,
        changed_files: [{ path: "packages/arbor-tui/src/screens/console.ts", status: "changed" }],
        verification: "Command and critic verification passed.",
        metrics: "files 1; checks 2; provenance verified capture",
        adoption: "not adopted; review required",
      },
    };
    const lines = render(raw, 120, 40);
    const completion = lines.findIndex((line) => line.includes("COMPLETION · RESULT"));
    const composer = lines.findIndex((line) => line.startsWith("┌"));
    expect(completion).toBeGreaterThanOrEqual(0);
    expect(composer).toBeGreaterThan(completion);
    const manifest = lines.slice(completion, composer).join("\n");
    for (const label of ["FILES", "VERIFICATION", "EVIDENCE", "ADOPTION", "ACTIONS"]) expect(manifest).toContain(label);
  });

  it("still shows the capture status and controls when nothing is armed, but no prompt", () => {
    const rows = consoleScreen.project(withCapture(""), { width: 120, height: 40 }).rows
      .filter((row) => row.region === "completion")
      .map((row) => (row as { label: string }).label);
    // RESULT + ACTIONS always; FEEDBACK is present only when armed.
    expect(rows).toHaveLength(2);
    expect(rows.some((label) => label.includes("Confirm"))).toBe(false);
  });

  it("keeps the controls hint out of the elidable fact strip", () => {
    const raw = withCapture("");
    const facts = consoleScreen.project(raw, { width: 120, height: 40 }).rows
      .filter((row) => row.region === "fleet" || row.region === "portfolio" || row.region === "operations");
    // A 258-frame recording showed `controls` elided behind "+N more" in every
    // frame at 140 columns, hiding the disabled reason ADR-149 Decision 5
    // requires be visible. It must never be a bounded statistic again.
    expect(facts.some((row) => JSON.stringify(row).includes("arm exact scope"))).toBe(false);
  });

  it("renders the controls hint in full at 80x24", () => {
    const text = render(withCapture(""), 80, 24).join(" ");
    expect(text).toContain("A arm exact scope authorization");
  });
});

// ── the header sizes itself by branching, not only by node count ────────────

describe("Console header gives a fan the rows to be a fan", () => {
  const treeRaw = (nodes: readonly { id: string; parent_id: string | null; state: string }[]) => ({
    captured_at: "2026-08-30T00:00:00Z",
    campaigns: { total: 1, items: [{ id: "c1", halted: false, root_node_state: "expanding" }] },
    tree: { campaign_id: "c1", nodes: nodes.map((n) => ({ ...n, action_description: n.id })) },
  });

  it("draws the spine for a real branch, at the real Console surface", () => {
    // The projector could always draw a spine; the header asked for three rows
    // regardless of shape, leaving ONE content row, so siblings could never
    // occupy distinct rows and a branch rendered as a flat chain.
    const text = render(treeRaw([
      { id: "r", parent_id: null, state: "claimed" },
      { id: "a", parent_id: "r", state: "verified" },
      { id: "b", parent_id: "r", state: "pending" },
      { id: "c", parent_id: "r", state: "failed" },
    ]), 120, 44).join("\n");
    expect(text).toContain("┬");
    expect(text).toContain("├");
    expect(text).toContain("└");
  });

  it("claims no extra rows for an unbranched chain", () => {
    const lines = render(treeRaw([
      { id: "r", parent_id: null, state: "claimed" },
      { id: "a", parent_id: "r", state: "verified" },
      { id: "b", parent_id: "a", state: "expanding" },
    ]), 120, 44);
    const graphRows = lines.filter((line) => /[◉●◐○×]/u.test(line) && line.includes("│"));
    // One content row is all a chain needs; the rest belongs to the chronology.
    expect(graphRows.length).toBe(1);
    expect(lines.join("\n")).not.toContain("├");
  });

  it("still separates expanding from verified on the Console surface", () => {
    const text = render(treeRaw([
      { id: "r", parent_id: null, state: "claimed" },
      { id: "a", parent_id: "r", state: "expanding" },
    ]), 120, 44).join("\n");
    expect(text).toContain("◐");
  });
});

describe("greenfield chrome under colour (EC-049 / EC-050)", () => {
  const ESC = String.fromCharCode(27);
  const sgrRe = new RegExp(`${ESC}\\[[0-9;]*m`, "gu");
  const plain = (line: string) => line.replace(sgrRe, "");
  const greenfield = {
    campaigns: { items: [] },
    drafts: { items: [] },
    sidebar_visibility: "shown",
    repository_tree: { root: "/tmp/pilot-project", entries: [{ path: "src/main.ts", status: "tracked", kind: "file" }] },
    console_input: { text: "", cursor: 0, focused: true },
    captured_at: "2026-09-03T10:00:00.000Z",
    fresh_launch_empty: true,
  };

  it("emphasises the header bullet without leaking SGR parameters as text", () => {
    const projection = consoleScreen.project(greenfield, { width: 120, height: 40 });
    expect(projection.variant).toBe("fresh");
    const lines = consoleScreen.render({ projection, width: 120, height: 40, color: true });
    const heading = lines.find((line) => plain(line).includes("New session on"));
    expect(heading).toBeDefined();
    // The bullet is styled (an ESC is present) and no bare parameter list survived.
    expect(heading).toContain(ESC);
    expect(plain(heading!)).toMatch(/^· New session on/u);
    expect(heading).not.toMatch(/\[38;2;\d+;\d+;\d+m·\[0m/u);
  });

  for (const [width, focused] of [[120, true], [140, true], [120, false]] as const) {
    it(`draws the composer footer to the full width with the whole hint at ${width} columns, focused=${focused}`, () => {
      const input = { text: focused ? "refactor" : "", cursor: focused ? 8 : 0, focused };
      const projection = consoleScreen.project({ ...greenfield, sidebar_visibility: "hidden", console_input: input }, { width, height: 40 });
      const lines = consoleScreen.render({ projection, width, height: 40, color: true });
      const top = lines.find((line) => plain(line).startsWith("┌"))!;
      const bottom = lines.find((line) => plain(line).startsWith("└"))!;
      expect(displayWidth(plain(bottom))).toBe(displayWidth(plain(top)));
      expect(plain(bottom).endsWith("┘")).toBe(true);
      expect(plain(bottom)).toContain(focused ? "Ctrl+E editor · Esc blur" : "Enter focus · Ctrl+P palette");
    });
  }
});

describe("inspector row in the narrow docked layout (EC-051)", () => {
  it("marks the inspector line when the sidebar column cannot hold it, and leaves it whole when it can", () => {
    const narrow = render({ ...fixture, sidebar_visibility: "shown", sidebar_tab: "devtools" }, 80, 24);
    const cut = narrow.find((line) => line.includes("INSPECT ·"));
    expect(cut).toBeDefined();
    // The row is stacked beside the timeline at 80 columns; the inspector
    // text is longer than its 40-column share, so the cut must be visible.
    expect(cut).toContain("…");
    expect(displayWidth(cut!)).toBeLessThanOrEqual(80);
    // The marker replaces the tail, never the head: what remains is a prefix of the full line.
    const shown = cut!.slice(cut!.indexOf("INSPECT ·"), cut!.indexOf("…"));
    expect("INSPECT · Hello, governed world · completed".startsWith(shown.trimEnd())).toBe(true);
    // A title that fits its column is left whole.
    const short = render({ ...fixture, sidebar_visibility: "shown", sidebar_tab: "devtools", operator_interviews: { ...fixture.operator_interviews, records: [{ ...fixture.operator_interviews.records[0], answer: { custom_text: "Yes", answered_at: "2026-08-26T10:09:30.000Z", answered_by: "operator" } }] } }, 200, 40);
    const inspectRows = short.filter((line) => line.includes("INSPECT ·"));
    expect(inspectRows.length).toBeGreaterThan(0);
  });
});

describe("planning chrome under colour (EC-049 sibling)", () => {
  it("styles the spinner and Esc without leaking SGR parameters as text", () => {
    const ESC = String.fromCharCode(27);
    const planning = { drafts: { items: [] }, campaigns: { items: [] }, sidebar_visibility: "hidden", repository_tree: { root: "/tmp/p", entries: [] }, submission_pending: { task: "Add a health check" }, fresh_launch_planning: true, console_input: { text: "", cursor: 0, focused: false }, captured_at: "2026-09-03T10:00:00.000Z" };
    const projection = consoleScreen.project(planning, { width: 120, height: 40 });
    expect(projection.variant).toBe("planning");
    const lines = consoleScreen.render({ projection, width: 120, height: 40, color: true, frame_count: 3 });
    const head = lines.find((line) => line.includes("Planning your request"));
    expect(head).toBeDefined();
    expect(head).toContain(ESC);
    // Every SGR parameter list is introduced by its ESC; none survives as bare text.
    expect(head!.replace(new RegExp(`${ESC}\\[[0-9;]*m`, "gu"), "")).not.toMatch(/\[\d+(?:;\d+)*m/u);
    expect(head!.replace(new RegExp(`${ESC}\\[[0-9;]*m`, "gu"), "")).toContain("Planning your request · Esc cancel");
  });
});

describe("60-column Console chrome (EC-055 b/c/d)", () => {
  const ESC = String.fromCharCode(27);
  const plain = (line: string) => line.replace(new RegExp(`${ESC}\\[[0-9;]*m`, "gu"), "");
  it("status line is measured on its prose, not its escape bytes, and marks its cut", () => {
    // At 60 the 47-character prose fits: the pre-fix render cut it at 35 cells
    // because the glyph's escape bytes were charged as width.
    const statusRow = (line: string) => /(?:Thinking|Working|Idle) · /u.test(line) && !line.includes("TASK ·");
    const at60 = render(fixture, 60, 20, true).map(plain).find(statusRow)!;
    expect(at60).toContain("waiting for the next streamed update");
    expect(displayWidth(at60)).toBeLessThanOrEqual(60);
    // At 40 it cannot fit, and the cut is marked.
    const at40 = render(fixture, 40, 20, true).map(plain).find(statusRow)!;
    expect(displayWidth(at40)).toBeLessThanOrEqual(40);
    expect(at40).toContain("…");
  });
  it("objective row marks its cut", () => {
    const lines = render(fixture, 60, 20, false);
    const objective = lines.find((line) => line.includes("OBJECTIVE ·") || line.includes("NOW ·"))!;
    expect(objective).toBeDefined();
    expect(displayWidth(objective)).toBeLessThanOrEqual(60);
    if (displayWidth(objective) === 60) expect(objective).toContain("…");
  });
  it("composer footer falls back to a compact hint that still names Enter and Esc", () => {
    const lines = render({ ...fixture, console_input: { text: "hi", cursor: 2, focused: true } }, 60, 20, false);
    const bottom = lines.find((line) => line.startsWith("└"))!;
    expect(bottom.endsWith("┘")).toBe(true);
    expect(bottom).toContain("Enter send · Esc blur");
    expect(bottom).not.toContain("Ctrl+E");
    const wide = render({ ...fixture, console_input: { text: "hi", cursor: 2, focused: true } }, 120, 40, false).find((line) => line.startsWith("└"))!;
    expect(wide).toContain("Ctrl+E editor · Esc blur");
  });
});

describe("header keeps its STATUS whole and elides the title first (EC-062)", () => {
  it("at 150 columns a long task title is marked and the status phrase survives", () => {
    const long = { ...fixture, drafts: { items: [{ campaign_id: "camp-01", task: "Add a greet(name) function to src/greeting.ts that returns a friendly message, and a test for it, then wire it into main" }] } };
    const lines = render(long, 150, 40, true);
    const ESC = String.fromCharCode(27);
    const header = lines.find((line) => line.includes("STATUS"))!.replace(new RegExp(`${ESC}\\[[0-9;]*m`, "gu"), "");
    expect(header).toContain("STATUS · ");
    expect(header).toMatch(/nodes \d+\/\d+/u);
    expect(displayWidth(header)).toBeLessThanOrEqual(150);
    expect(header).toContain("…");
  });
});

describe("a halt with nothing verified is not a completion (EC-064)", () => {
  const halted = (verified: boolean) => ({
    ...fixture,
    tree: { campaign_id: "camp-01", halted: true, halt_reason: "no_nodes", nodes: [
      { id: "root", label: "Plan", depth: 0, state: "claimed", has_children: true, action_delegate: "crown" },
      { id: "n1", parent_id: "root", label: "greet", depth: 1, state: verified ? "verified" : "failed", has_children: false, action_delegate: "seed" },
    ] },
  });
  it("says Halted · nothing verified when every node failed", () => {
    const lines = render(halted(false), 120, 40);
    expect(lines.some((line) => line.includes("Halted · nothing verified"))).toBe(true);
    expect(lines.some((line) => line.includes("Complete · ready for review"))).toBe(false);
  });
  it("keeps Complete · ready for review when a node verified", () => {
    const lines = render(halted(true), 120, 40);
    expect(lines.some((line) => line.includes("Complete · ready for review"))).toBe(true);
  });
});
