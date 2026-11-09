/**
 * Finding 8/9/15 (TUI-vs-backend observability gap audit) — the KB, evidence
 * ledger, and governance backlog screens. Each closes a gap where the real
 * backend content was reachable only as an opaque id in the diagnostics
 * event log or (for backlog) CLI stdout text.
 */
import { describe, it, expect, afterEach } from "vitest";
import { kbScreen } from "../src/screens/kb.js";
import { auditScreen } from "../src/screens/audit.js";
import { backlogScreen } from "../src/screens/backlog.js";
import { registerScreen, clearRegisteredScreens, availableScreens } from "../src/screens/screen.js";
import { displayWidth } from "../src/widgets.js";

afterEach(() => clearRegisteredScreens());

function r(screen: typeof kbScreen, result: unknown, width = 80, height = 20): readonly string[] {
  const projection = screen.project(result, { width, height });
  return screen.render({ projection, width, height });
}

describe("kb screen (finding 8)", () => {
  const realistic = [
    {
      id: "memory_abc",
      absence: null,
      value: {
        type: "failure_mode",
        value: "refactor auth module: failed",
        tier: "specialist_visible",
        failure_mode: "refactor auth module",
        root_cause: "regression in login flow",
      },
    },
    {
      id: "memory_def",
      absence: "capability_required",
      value: null,
    },
  ];

  it("declares the kb.list round trip it refreshes on", () => {
    expect(kbScreen.surface.commands).toEqual([]);
    expect(kbScreen.surface.queries).toEqual(["kb.list"]);
  });

  it("requires kb.read and degrades gracefully", () => {
    registerScreen(kbScreen);
    expect(availableScreens(new Set(["campaign.read"])).some((s) => s.id === "kb")).toBe(false);
    expect(availableScreens(new Set(["kb.read"])).some((s) => s.id === "kb")).toBe(true);
    expect(() => r(kbScreen, null)).not.toThrow();
    expect(() => r(kbScreen, { odd: 1 })).not.toThrow();
  });

  it("projects real failure_mode/root_cause content, never just the opaque id", () => {
    const projection = kbScreen.project(realistic, { width: 100, height: 20 });
    const row = projection.rows.find((row) => row.id === "memory_abc");
    expect(row).toBeDefined();
    expect(row!.type).toBe("failure_mode");
    expect(String(row!.detail)).toContain("refactor auth module");
    expect(String(row!.detail)).toContain("regression in login flow");
  });

  it("renders a capability-redacted entry as a real 'redacted' row, never silently dropped or fabricated", () => {
    const projection = kbScreen.project(realistic, { width: 100, height: 20 });
    const redacted = projection.rows.find((row) => row.id === "memory_def");
    expect(redacted).toBeDefined();
    expect(String(redacted!.detail)).toContain("redacted");
    expect(String(redacted!.detail)).toContain("capability_required");
  });

  it("renders campaign_reopen records: operator, overridden halt and phase, never as an unhandled kind", () => {
    const reopen = (phase: string) => ({ id: `reopen-${phase}`, kind: "campaign_reopen", campaign_id: "c1", node_id: "n7", reopen: { phase, actor: "operator", authority: "operator", overridden_halt_reason: "no_nodes" } });
    const details = auditScreen.project([reopen("reopened"), reopen("reverted")], { width: 120, height: 20 }).rows.map((row) => String(row.detail));
    expect(details[0]).toBe("reopen reopened by operator: overrode no_nodes halt for n7");
    expect(details[1]).toBe("reopen reverted by operator: overrode no_nodes halt for n7");
    expect(details.join("\n")).not.toContain("unhandled record kind");
  });

  it("a genuinely empty list is a real, distinct result — not the null/never-fetched fallback", () => {
    const projection = kbScreen.project([], { width: 80, height: 10 });
    // EC-012: empty captions name their subject and what creates a record.
    expect(projection.caption).toContain("No knowledge entries yet");
    const neverFetched = kbScreen.project(null, { width: 80, height: 10 });
    expect(neverFetched.caption).not.toBe(projection.caption);
  });

  it("carries row_ids keyed by the real entry id", () => {
    const projection = kbScreen.project(realistic, { width: 100, height: 20 });
    expect(projection.row_ids).toEqual([{ id: "memory_abc" }, { id: "memory_def" }]);
  });

  it("width clips every rendered line", () => {
    const lines = r(kbScreen, realistic, 30, 10);
    for (const line of lines) expect(displayWidth(line)).toBeLessThanOrEqual(30);
  });
});

describe("audit screen (finding 9)", () => {
  const realistic = [
    {
      id: "trace_1", kind: "trace", campaign_id: "c1", node_id: "n1",
      action_description: "refactor auth module", node_state_before: "expanding", node_state_after: "verified",
      score_before: 0, score_after: 10,
    },
    {
      id: "gate_1", kind: "gate_checkpoint", campaign_id: "c1", node_id: "n1",
      checkpoint: { transition: "node_expansion", gate: { gate: "isolation", result: "bypass", bypass_evidence_deficit: "no worktree check" } },
    },
    { id: "unknown_1", kind: "some_future_kind", campaign_id: "c1", node_id: "n1" },
  ];

  it("declares the audit.list round trip it refreshes on", () => {
    expect(auditScreen.surface.commands).toEqual([]);
    expect(auditScreen.surface.queries).toEqual(["audit.list"]);
  });

  it("requires audit.read and degrades gracefully", () => {
    registerScreen(auditScreen);
    expect(availableScreens(new Set(["campaign.read"])).some((s) => s.id === "audit")).toBe(false);
    expect(availableScreens(new Set(["audit.read"])).some((s) => s.id === "audit")).toBe(true);
    expect(() => r(auditScreen, null)).not.toThrow();
    expect(() => r(auditScreen, { odd: 1 })).not.toThrow();
  });

  it("projects the real trace packet content, never just the opaque id", () => {
    const projection = auditScreen.project(realistic, { width: 120, height: 20 });
    const row = projection.rows.find((row) => row.id === "trace_1");
    expect(row).toBeDefined();
    expect(String(row!.detail)).toContain("refactor auth module");
    expect(String(row!.detail)).toContain("expanding -> verified");
  });

  it("projects real gate checkpoint content including a bypass deficit", () => {
    const projection = auditScreen.project(realistic, { width: 120, height: 20 });
    const row = projection.rows.find((row) => row.id === "gate_1");
    expect(row).toBeDefined();
    expect(String(row!.detail)).toContain("isolation");
    expect(String(row!.detail)).toContain("bypass");
    expect(String(row!.detail)).toContain("no worktree check");
  });

  it("names an unrecognized record kind visibly, never collapses it into a legitimately blank row", () => {
    const projection = auditScreen.project(realistic, { width: 120, height: 20 });
    const row = projection.rows.find((row) => row.id === "unknown_1");
    expect(row).toBeDefined();
    expect(String(row!.detail)).toContain("unhandled record kind");
    expect(String(row!.detail)).toContain("some_future_kind");
  });

  it("projects every remaining durable audit record kind with its governed detail", () => {
    const records = [
      { id: "recovery", kind: "recovery_decision", campaign_id: "c1", decision: { decision: "retry", actor: "operator", outcome: "accepted" } },
      { id: "interrupt", kind: "interruption", campaign_id: "c1", interruption: { scope: "campaign", phase: "execution", reason: "stop" } },
      { id: "communication", kind: "node_communication", campaign_id: "c1", communication: { kind: "handoff", author_node_id: "n1", recipient_node_id: "n2" } },
      { id: "fact", kind: "memory_fact", campaign_id: "c1", fact: { type: "failure", content: "bad input" } },
      { id: "telemetry", kind: "telemetry_observation", campaign_id: "c1", observation: { type: "usage", phase: "run", outcome: "ok" } },
      { id: "phase", kind: "phase_message", campaign_id: "c1", message: { phase: "review", content: "ready" } },
      { id: "compact", kind: "compaction_lifecycle", campaign_id: "c1", lifecycle: { trigger: "budget", strategy: "summary", status: "done" } },
      { id: "question", kind: "request_user_input", campaign_id: "c1", status: "awaiting", question: { question: "Continue?" } },
      { id: "answer", kind: "user_input_answer", campaign_id: "c1", answer: { answered_by: "operator", custom_text: "yes" } },
    ];
    const details = auditScreen.project(records, { width: 120, height: 20 }).rows.map((row) => String(row.detail)).join("\n");
    for (const expected of ["retry by operator", "campaign execution", "handoff: n1 -> n2", "failure: bad input", "usage run", "review: ready", "budget summary", "awaiting: Continue?", "answered by operator"]) {
      expect(details).toContain(expected);
    }
  });

  it("a genuinely empty list is a real, distinct result — not the null/never-fetched fallback", () => {
    const projection = auditScreen.project([], { width: 80, height: 10 });
    expect(projection.caption).toContain("no evidence records");
    const neverFetched = auditScreen.project(null, { width: 80, height: 10 });
    expect(neverFetched.caption).not.toBe(projection.caption);
  });

  it("carries row_ids keyed by the real record id", () => {
    const projection = auditScreen.project(realistic, { width: 120, height: 20 });
    expect(projection.row_ids).toEqual([{ id: "trace_1" }, { id: "gate_1" }, { id: "unknown_1" }]);
  });

  it("width clips every rendered line", () => {
    const lines = r(auditScreen, realistic, 30, 10);
    for (const line of lines) expect(displayWidth(line)).toBeLessThanOrEqual(30);
  });
});

describe("backlog screen (finding 15)", () => {
  const realistic = {
    backlog: {
      decisions_dir: "/repo/decisions",
      total_records_scanned: 28,
      items: [
        {
          record_id: "revoy2:ADR-901", record_number: 901, title: "a buildable record",
          file_path: "decisions/ADR-901.md", decision_status: "accepted", classification: "author_obligations",
          reason: null, has_test_implications_section: false, rank_tier: 1,
          evidence: { finding_rule_id: "POL-04", finding_detail: "accepted with zero obligations declared" },
          decision_text: "...",
        },
        {
          record_id: "revoy2:ADR-902", record_number: 902, title: "a non-goal record",
          file_path: "decisions/ADR-902.md", decision_status: "accepted", classification: "not_applicable",
          reason: "does not introduce a mechanism", has_test_implications_section: false, rank_tier: 2,
          evidence: { finding_rule_id: "POL-04", finding_detail: "accepted with zero obligations declared" },
          decision_text: "...",
        },
      ],
    },
    selected: {
      record_id: "revoy2:ADR-901", record_number: 901, title: "a buildable record",
      file_path: "decisions/ADR-901.md", decision_status: "accepted", classification: "author_obligations",
      reason: null, has_test_implications_section: false, rank_tier: 1,
      evidence: { finding_rule_id: "POL-04", finding_detail: "accepted with zero obligations declared" },
      decision_text: "...",
    },
  };

  it("declares the governance.backlog round trip it refreshes on", () => {
    expect(backlogScreen.surface.commands).toEqual([]);
    expect(backlogScreen.surface.queries).toEqual(["governance.backlog"]);
  });

  it("renders a missing ADR store as a normal greenfield absence, not an ENOENT fault", () => {
    const absence = {
      governance_absence: true,
      decisions_dir: "/new-project/decisions",
      message: "No canonical ADRs yet — the first governed decision will create the project decision store.",
    };
    const projection = backlogScreen.project(absence, { width: 100, height: 20 });
    const body = r(backlogScreen as typeof kbScreen, absence, 100, 20).join("\n");
    expect(projection.rows).toEqual([]);
    expect(body).toContain("No canonical ADRs yet");
    expect(body).not.toContain("ENOENT");
    expect(body).not.toContain("unrecognised");
  });

  it("requires governance.backlog.read and degrades gracefully", () => {
    registerScreen(backlogScreen);
    expect(availableScreens(new Set(["campaign.read"])).some((s) => s.id === "backlog")).toBe(false);
    expect(availableScreens(new Set(["governance.backlog.read"])).some((s) => s.id === "backlog")).toBe(true);
    expect(() => r(backlogScreen, null)).not.toThrow();
    expect(() => r(backlogScreen, { odd: 1 })).not.toThrow();
  });

  it("projects real backlog items, marking the selected next item", () => {
    const projection = backlogScreen.project(realistic, { width: 120, height: 20 });
    expect(projection.rows).toHaveLength(2);
    const selectedRow = projection.rows.find((row) => row.record_id === "revoy2:ADR-901");
    expect(selectedRow!.next).toBe("-> next");
    const otherRow = projection.rows.find((row) => row.record_id === "revoy2:ADR-902");
    expect(otherRow!.next).toBe("");
    expect(otherRow!.classification).toBe("not_applicable");
  });

  it("caption names the selected next item", () => {
    const projection = backlogScreen.project(realistic, { width: 120, height: 20 });
    expect(projection.caption).toContain("revoy2:ADR-901");
  });

  it("a genuinely empty backlog (the real corpus's current, fully-covered state) is a real, distinct result", () => {
    const empty = { backlog: { decisions_dir: "/repo/decisions", total_records_scanned: 28, items: [] }, selected: null };
    const projection = backlogScreen.project(empty, { width: 80, height: 10 });
    expect(projection.rows).toHaveLength(0);
    expect(projection.caption).toContain("empty");
    const neverFetched = backlogScreen.project(null, { width: 80, height: 10 });
    expect(neverFetched.caption).not.toBe(projection.caption);
  });

  it("carries row_ids keyed by the real record id", () => {
    const projection = backlogScreen.project(realistic, { width: 120, height: 20 });
    expect(projection.row_ids).toEqual([{ id: "revoy2:ADR-901" }, { id: "revoy2:ADR-902" }]);
  });

  it("width clips every rendered line", () => {
    const lines = r(backlogScreen, realistic, 30, 10);
    for (const line of lines) expect(displayWidth(line)).toBeLessThanOrEqual(30);
  });
});
