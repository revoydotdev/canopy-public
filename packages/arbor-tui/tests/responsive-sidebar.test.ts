import { tabBar } from "../src/responsive-sidebar.js";
import { describe, expect, it } from "vitest";
import { displayWidth } from "../src/widgets.js";
import {
  RESPONSIVE_SIDEBAR_WIDTH,
  projectResponsiveSidebar,
  renderResponsiveSidebar,
} from "../src/responsive-sidebar.js";

const governance = {
  ok: true,
  value: {
    decision_status_distribution: { accepted: 140, proposed: 2, draft: 1, rejected: 0, superseded: 3 },
    repository_counts: { adr_total: 146 },
    records: [
      { id: "revoy2:ADR-146", record_number: 146, title: "Governed console", source_path: "decisions/ADR-146-governed-console.md", decision: "accepted" },
      { id: "revoy2:ADR-147", record_number: 147, title: "Live lifecycle narration", source_path: "decisions/ADR-147-live-lifecycle-narration.md", decision: "proposed" },
    ],
    policy_findings: [
      { rule_id: "POL-04", severity: "warning", subject: { record_id: "ADR-107" }, detail: "interactive session proof needs review" },
      { rule_id: "SUR-05", severity: "warning", subject: { kind: "doc", path: "ROADMAP.md" }, detail: "derived count drift" },
    ],
  },
};

const agents = {
  ok: true,
  value: {
    active_agent_count: 2,
    live: [
      { agent: "crown", task_id: "task-crown", operation_id: "op-crown", kind: "campaign-orchestrator", state: "running", owner_scope_id: "scope-1" },
      { agent: "seed", task_id: "task-seed", operation_id: "op-seed", kind: "specialist", state: "running", owner_scope_id: "scope-1" },
    ],
  },
};

const sessions = {
  ok: true,
  value: {
    sessions: [
      { session_id: "session-crown", campaign_id: "campaign-1", node_id: "node-crown", operation: "specialize", state: "running", terminal: null },
      // A terminal session must never be offered as an in-flight feed.
      { session_id: "session-complete", campaign_id: "campaign-1", node_id: "node-seed", operation: "specialize", state: "completed", terminal: { cause: "completed" } },
    ],
  },
};

const campaignTree = {
  ok: true,
  value: {
    campaign_id: "campaign-1",
    nodes: [
      { id: "node-crown", action_delegate: "crown" },
      { id: "node-seed", action_delegate: "seed" },
    ],
  },
};

describe("responsive sidebar", () => {
  it("matches the OpenCode-style breakpoint and preserves an explicit operator override", () => {
    expect(projectResponsiveSidebar({ width: 121, visibility: "auto" }).mode).toBe("docked");
    expect(projectResponsiveSidebar({ width: 120, visibility: "auto" }).mode).toBe("hidden");
    expect(projectResponsiveSidebar({ width: 119, visibility: "auto" }).mode).toBe("hidden");
    expect(projectResponsiveSidebar({ width: 60, visibility: "shown" }).mode).toBe("overlay");
    expect(projectResponsiveSidebar({ width: 180, visibility: "hidden" }).mode).toBe("hidden");
  });

  it("projects only real ADR counts and bounded policy findings", () => {
    const projection = projectResponsiveSidebar({ width: 160, visibility: "auto", tab: "adrs", governance, agents });
    expect(projection.adr).toMatchObject({ state: "ready", total: 146 });
    expect(projection.adr.decisions).toContainEqual({ status: "accepted", count: 140 });
    expect(projection.adr.records[0]).toEqual({
      id: "revoy2:ADR-147",
      title: "Live lifecycle narration",
      status: "proposed",
      source_path: "decisions/ADR-147-live-lifecycle-narration.md",
      tone: "warning",
      selected: false,
    });
    expect(projection.adr.findings).toEqual([
      { rule_id: "POL-04", severity: "warning", subject: "ADR-107", detail: "interactive session proof needs review" },
      { rule_id: "SUR-05", severity: "warning", subject: "doc:ROADMAP.md", detail: "derived count drift" },
    ]);
  });

  it("projects greenfield ADR absence as ready zero with an actionable next event", () => {
    const projection = projectResponsiveSidebar({
      width: 160,
      visibility: "auto",
      tab: "adrs",
      governance: {
        governance_absence: true,
        message: "No canonical ADRs yet — the first governed decision will create the project decision store.",
      },
      agents,
    });
    const rendered = renderResponsiveSidebar(projection, { height: 20 }).join("\n");
    expect(projection.adr).toMatchObject({ state: "ready", total: 0 });
    expect(rendered).toContain("0 ADRs");
    expect(rendered).toContain("governed decision");
    expect(rendered).not.toContain("awaiting projection");
  });

  it("preserves canonical agent identities and selected state without parsing display labels", () => {
    const projection = projectResponsiveSidebar({
      width: 160,
      visibility: "auto",
      tab: "adrs",
      governance,
      agents,
      agent_updates: [{ task_id: "task-seed", session_id: "session-seed", summary: "issued 3 commands · validating diff" }],
      selected: { task_id: "task-seed" },
    });
    expect(projection.agents.rows).toEqual([
      expect.objectContaining({ id: "task-crown", source: "agent", agent: "crown", task_id: "task-crown", operation_id: "op-crown", selected: false, switchable: false, work: "running · campaign-orchestrator" }),
      expect.objectContaining({ id: "task-seed", source: "agent", agent: "seed", task_id: "task-seed", operation_id: "op-seed", selected: true, switchable: false, work: "issued 3 commands · validating diff" }),
    ]);
  });

  it("prefers a session-backed feed only after an exact campaign/tree delegation join", () => {
    const projection = projectResponsiveSidebar({
      width: 160,
      visibility: "auto",
      tab: "adrs",
      governance,
      agents,
      sessions,
      campaign_tree: campaignTree,
      agent_updates: [{ session_id: "session-crown", summary: "issued 3 commands · critic pending" }],
      selected: { session_id: "session-crown" },
    });
    expect(projection.agents.rows).toEqual([
      expect.objectContaining({
        id: "session-crown", source: "session", agent: "crown", session_id: "session-crown",
        campaign_id: "campaign-1", node_id: "node-crown", switchable: true, selected: true,
        work: "issued 3 commands · critic pending",
      }),
    ]);
  });

  it("does not invent a session-agent join when the campaign tree is stale or absent", () => {
    const projection = projectResponsiveSidebar({
      width: 160,
      visibility: "auto",
      governance,
      agents,
      sessions,
      campaign_tree: { ...campaignTree, value: { ...campaignTree.value, campaign_id: "other-campaign" } },
    });
    expect(projection.agents.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: "agent", id: "task-crown", switchable: false }),
    ]));
    expect(projection.agents.rows.some((row) => row.source === "session")).toBe(false);
  });

  it("never manufactures zero counts or agent rows from partial/unrecognised projections", () => {
    const projection = projectResponsiveSidebar({
      width: 160,
      visibility: "auto",
      governance: { repository_counts: { adr_total: "146" } },
      agents: { live: [{ agent: "seed", task_id: "task" }] },
    });
    expect(projection.adr.state).toBe("ready");
    expect(projection.adr.total).toBeUndefined();
    expect(projection.adr.decisions).toEqual([]);
    expect(projection.agents.rows).toEqual([]);
  });

  it("renders a bounded docked ADR inspector with full record navigation semantics", () => {
    const projection = projectResponsiveSidebar({
      width: 160,
      visibility: "auto",
      tab: "adrs",
      governance,
      agents,
      agent_updates: [{ operation_id: "op-crown", summary: "issued 3 commands · awaiting critic" }],
    });
    const lines = renderResponsiveSidebar(projection, { height: 30 });
    expect(lines.join("\n")).toContain("146 ADRs");
    expect(lines.join("\n")).toContain("POL-04");
    expect(lines.join("\n")).toContain("ADR-147 · proposed");
    expect(lines.join("\n")).toContain("Live lifecycle narration");
    expect(lines.join("\n")).toContain("[ADRS]");
    expect(lines.join("\n")).toContain("ENTER · OPEN DETAIL");
    expect(lines.length).toBeLessThanOrEqual(30);
    for (const row of lines) expect(displayWidth(row)).toBeLessThanOrEqual(RESPONSIVE_SIDEBAR_WIDTH);
  });

  it("reports pending and failed runtime projections explicitly rather than as fake empty data", () => {
    const pending = renderResponsiveSidebar(projectResponsiveSidebar({ width: 160, visibility: "auto", tab: "adrs" }), { height: 20 }).join("\n");
    const failed = renderResponsiveSidebar(projectResponsiveSidebar({
      width: 160,
      visibility: "auto",
      tab: "adrs",
      governance: { ok: false, error: { message: "decisions directory unavailable" } },
      agents: { ok: false, error: { message: "agent registry unavailable" } },
    }), { height: 20 }).join("\n");
    expect(pending).toContain("awaiting projection");
    expect(failed).toContain("decisions directory");
    expect(failed).toContain("unavailable");
  });

  it("defaults to the live project repo and governed-project state", () => {
    const projection = projectResponsiveSidebar({
      width: 160,
      visibility: "shown",
      project_registry: {
        present: true, entry_count: 1, ok: true,
        entries: [{ project_id: "revoy2", path: "/work/revoy2", verified_at_revision: "abcdef1234567890", expires: "2026-09-01T00:00:00.000Z", ok: true, failures: [] }],
      },
      agents,
    });
    const rendered = renderResponsiveSidebar(projection, { height: 20 }).join("\n");
    expect(projection.tab).toBe("project");
    expect(rendered).toContain("[PROJECT]");
    expect(rendered).toContain("PROJECT REPO");
    expect(rendered).toContain("revoy2 · ✓ discharged");
    expect(rendered).toContain("Repository clean");
  });

  it("renders DevTools only as labelled supplemental diagnostics", () => {
    const projection = projectResponsiveSidebar({
      width: 160,
      visibility: "shown",
      tab: "devtools",
      devtools: { campaign_id: "c1", lines: [{ seq: 9, ts: "2026-08-31T00:00:00Z", event_kind: "loop.tool_call", campaign_id: "c1", node_id: "n1", node_state: "expanding", synthetic: false }] },
    });
    const rendered = renderResponsiveSidebar(projection, { height: 20 }).join("\n");
    expect(rendered).toContain("[DEVTOOLS]");
    expect(rendered).toContain("SUPPLEMENTAL DIAGNOSTICS");
    expect(rendered).toContain("9 loop.tool_call · n1 · expanding");
  });

  it("retains exact ADR selection identity and semantic status tones for composition-owned navigation", () => {
    const projection = projectResponsiveSidebar({ width: 160, visibility: "shown", tab: "adrs", governance, selected: { adr_id: "revoy2:ADR-147" } });
    expect(projection.adr.records.find((record) => record.id === "revoy2:ADR-147")).toMatchObject({ selected: true, tone: "warning" });
    expect(projection.adr.records.find((record) => record.id === "revoy2:ADR-146")).toMatchObject({ selected: false, tone: "success" });
  });
});

describe("EC-059: the active rail tab wins the width", () => {
  it("compresses the inactive labels to initials when the full strip does not fit", () => {
    expect(tabBar("devtools", null, "truecolor")).toBe("PROJECT | ADRS | DOCS | [DEVTOOLS]");
    expect(tabBar("devtools", null, "truecolor", 24)).toBe("P | A | D | [DEVTOOLS]");
    expect(tabBar("project", null, "truecolor", 24)).toBe("[PROJECT] | A | D | D");
    expect(tabBar("adrs", null, "truecolor", 27)).toBe("P | [ADRS] | D | D");
  });

  it("renders the M2 rail's own three-tab bar (git/governance/inspect), not the pre-M2 four", () => {
    expect(tabBar("git", null, "truecolor")).toBe("[GIT] | GOVERNANCE | INSPECT");
    expect(tabBar("inspect", null, "truecolor")).toBe("GIT | GOVERNANCE | [INSPECT]");
  });
});

describe("ui-spec §4 (M2): Git/Governance/Inspect rail tabs", () => {
  it("Git tab re-homes the porcelain file list and states an honest branch/HEAD absence", () => {
    const projection = projectResponsiveSidebar({
      width: 160, visibility: "shown", tab: "git",
      repository_tree: { root: "/work/revoy2", entries: [{ path: "src/index.ts", status: "M", kind: "file" }] },
    });
    const rendered = renderResponsiveSidebar(projection, { height: 20 }).join("\n");
    expect(rendered).toContain("[GIT]");
    expect(rendered).toContain("branch: unavailable");
    expect(rendered).toContain("index.ts · modified");
  });

  it("Governance tab re-homes the ADR rows and reports an explicit interview count, or 'unavailable' when none was supplied", () => {
    const withCount = projectResponsiveSidebar({ width: 160, visibility: "shown", tab: "governance", governance, interview_unresolved_count: 3 });
    expect(renderResponsiveSidebar(withCount, { height: 30 }).join("\n")).toContain("unresolved interviews: 3");

    const withoutCount = projectResponsiveSidebar({ width: 160, visibility: "shown", tab: "governance", governance });
    expect(renderResponsiveSidebar(withoutCount, { height: 30 }).join("\n")).toContain("unresolved interviews: unavailable");
  });

  it("Inspect tab shows the watermark and the resync state, never 'nothing running' while resync is required", () => {
    const resyncing = projectResponsiveSidebar({
      width: 160, visibility: "shown", tab: "inspect",
      inspect: { status: "resync_required", watermark_seq: 41, resync_note: "resync required — history before seq 41 not shown", task: null, gates: [] },
    });
    const resyncingRendered = renderResponsiveSidebar(resyncing, { height: 20 }).join("\n");
    expect(resyncingRendered).toContain("watermark seq 41");
    expect(resyncingRendered).toContain("resync required");
    expect(resyncingRendered).not.toContain("nothing running");

    const running = projectResponsiveSidebar({
      width: 160, visibility: "shown", tab: "inspect",
      inspect: {
        status: "ok", watermark_seq: 12, resync_note: null,
        task: { task_id: "t1", operation_id: "op-1", kind: "worker", owner_scope_id: "scope-1", retry_attempt: 0, state: "started", started_at: "2026-01-01T00:00:00Z", deadline_at: null },
        gates: [{ gate: "review", node_id: "n1", result: "pass" }],
      },
    });
    const runningRendered = renderResponsiveSidebar(running, { height: 20 }).join("\n");
    expect(runningRendered).toContain("watermark seq 12");
    expect(runningRendered).toContain("task t1 · operation op-1");
    expect(runningRendered).toContain("retry_attempt 0 · state started");
    expect(runningRendered).toContain("review · n1 · pass");
  });
});
