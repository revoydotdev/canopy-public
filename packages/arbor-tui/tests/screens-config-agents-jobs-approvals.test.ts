import { describe, it, expect, afterEach } from "vitest";
import { configScreen } from "../src/screens/config.js";
import { agentsScreen } from "../src/screens/agents.js";
import { jobsScreen } from "../src/screens/jobs.js";
import { approvalsScreen } from "../src/screens/approvals.js";
import { registerScreen, clearRegisteredScreens, getScreen, availableScreens } from "../src/screens/screen.js";
import { displayWidth } from "../src/widgets.js";

afterEach(() => clearRegisteredScreens());

function r(screen: typeof configScreen, result: unknown, width = 80, height = 20): readonly string[] {
  const projection = screen.project(result, { width, height });
  return screen.render({ projection, width, height });
}

describe("config screen (item 21)", () => {
  it("projects leaves with source provenance", () => {
    registerScreen(configScreen);
    const projection = configScreen.project({ leaves: [{ path: "tree_search.max_seconds", source: "injected", value: 900, redacted: false }] }, { width: 80, height: 10 });
    expect(projection.rows[0]).toMatchObject({ path: "tree_search.max_seconds", source: "injected" });
    expect(projection.columns.some((c) => c.key === "source")).toBe(true);
  });
  it("makes resolved native selection visible without projecting a credential", () => {
    const projection = configScreen.project({ leaves: [], native_selection: { kind: "native", adapter_id: "openai-compatible", provider_id: "fixture", base_url: "https://fixture.invalid", model: "native-model", revision: null, selected_by: "native" } }, { width: 80, height: 10 });
    expect(projection.caption).toContain("Native: direct (openai-compatible → fixture/native-model)");
    expect(JSON.stringify(projection)).not.toContain("API_KEY");
  });
  it("distinguishes a configured revision expectation from a response-observed pin", () => {
    const projection = configScreen.project({ leaves: [], native_selection: { kind: "native", adapter_id: "openai-compatible", provider_id: "fixture", base_url: "https://fixture.invalid", model: "native-model", revision: "fp-configured", selected_by: "native" } }, { width: 120, height: 10 });
    expect(projection.caption).toContain("revision configured fp-configured (unobserved)");
    expect(projection.caption).not.toContain("revision observed");
  });
  it("summarizes the resolved native session budget and configured price source without inventing remaining campaign budget", () => {
    const projection = configScreen.project({
      native_selection: { kind: "native", adapter_id: "openai-compatible", provider_id: "fixture", base_url: "https://fixture.invalid", model: "native-model", revision: null, selected_by: "native" },
      leaves: [
        { path: "native.usage_budget.max_session_input_tokens", value: 1000, source: "file", redacted: false },
        { path: "native.usage_budget.max_session_total_tokens", value: 1500, source: "file", redacted: false },
        { path: "native.pricing.price_source_id", value: "fixture-price-v1", source: "file", redacted: false },
      ],
    }, { width: 120, height: 10 });
    expect(projection.caption).toContain("input≤1000");
    expect(projection.caption).toContain("total≤1500");
    expect(projection.caption).toContain("pricing fixture-price-v1");
    expect(projection.caption).not.toContain("remaining");
  });
  it("requires config.read capability", () => {
    registerScreen(configScreen);
    expect(availableScreens(new Set(["campaign.read"])).some((s) => s.id === "config")).toBe(false);
    expect(availableScreens(new Set(["config.read"])).some((s) => s.id === "config")).toBe(true);
  });
  it("degrades gracefully on null/unknown and is width-clipped", () => {
    expect(() => r(configScreen, null)).not.toThrow();
    expect(() => r(configScreen, { odd: 1 })).not.toThrow();
    const out = r(configScreen, { leaves: [{ path: "x".repeat(100), source: "file", value: "v", redacted: false }] }, 30, 5);
    for (const line of out) expect(displayWidth(line)).toBeLessThanOrEqual(31);
  });
  it("carries row_ids keyed by dotted path — a leaf's own stable identity", () => {
    const projection = configScreen.project({ leaves: [{ path: "tree_search.max_seconds", source: "injected", value: 900, redacted: false }] }, { width: 80, height: 10 });
    expect(projection.row_ids).toEqual([{ id: "tree_search.max_seconds" }]);
  });
});

describe("agents screen (item 15)", () => {
  const defs = [{ name: "crown", tier: "orchestrator", description: "Tree driver" }];
  it("projects definitions when no live instances", () => {
    registerScreen(agentsScreen);
    const projection = agentsScreen.project({ definitions: defs, live: [] }, { width: 80, height: 10 });
    expect(projection.rows[0]).toMatchObject({ name: "crown", tier: "orchestrator" });
  });
  it("projects live instances when present and never fabricates", () => {
    registerScreen(agentsScreen);
    const projection = agentsScreen.project({ definitions: defs, live: [{ agent: "crown", task_id: "t1", state: "started", owner_scope_id: "c1" }] }, { width: 80, height: 10 });
    expect(projection.columns.some((c) => c.key === "task_id")).toBe(true);
    expect(projection.rows[0]).toMatchObject({ agent: "crown", task_id: "t1", state: "started" });
  });
  it("requires agent.read and degrades gracefully", () => {
    registerScreen(agentsScreen);
    expect(availableScreens(new Set(["campaign.read"])).some((s) => s.id === "agents")).toBe(false);
    expect(() => r(agentsScreen, null)).not.toThrow();
  });
  it("carries row_ids: definitions key by name, live instances key by task_id", () => {
    const defsProjection = agentsScreen.project({ definitions: defs, live: [] }, { width: 80, height: 10 });
    expect(defsProjection.row_ids).toEqual([{ id: "crown" }]);
    const liveProjection = agentsScreen.project({ definitions: defs, live: [{ agent: "crown", task_id: "t1", state: "started", owner_scope_id: "c1" }] }, { width: 80, height: 10 });
    expect(liveProjection.row_ids).toEqual([{ id: "t1" }]);
  });
});

describe("jobs screen (item 16)", () => {
  it("projects a job queue and only surfaces supported controls", () => {
    registerScreen(jobsScreen);
    const projection = jobsScreen.project({ jobs: [{ id: "j1", kind: "specialist.expand", state: "started", owner_scope_id: "c1", progress: 0.5 }], queue_paused: false }, { width: 80, height: 10 });
    expect(projection.rows[0]).toMatchObject({ id: "j1", kind: "specialist.expand" });
    for (const command of jobsScreen.surface.commands) {
      expect(["job.submit", "job.cancel", "job.retry", "job.pause", "job.resume"]).toContain(command);
    }
  });
  it("requires job.read+job.write; degrades gracefully", () => {
    registerScreen(jobsScreen);
    expect(availableScreens(new Set(["job.read"])).some((s) => s.id === "jobs")).toBe(false);
    expect(availableScreens(new Set(["job.read", "job.write"])).some((s) => s.id === "jobs")).toBe(true);
    expect(() => r(jobsScreen, null)).not.toThrow();
  });
  it("is width-clipped", () => {
    const out = r(jobsScreen, { jobs: [{ id: "job-id-very-long-name-here", kind: "k", state: "started", owner_scope_id: "c", progress: 0.9 }] }, 30, 5);
    for (const line of out) expect(displayWidth(line)).toBeLessThanOrEqual(31);
  });
  it("surfaces queue_paused: the backend reporting the whole queue paused is now visible, not silently dropped", () => {
    const paused = jobsScreen.project({ jobs: [{ id: "j1", kind: "k", state: "queued", owner_scope_id: "c" }], queue_paused: true }, { width: 80, height: 10 });
    expect(paused.caption).toContain("PAUSED");
    const live = jobsScreen.project({ jobs: [{ id: "j1", kind: "k", state: "queued", owner_scope_id: "c" }], queue_paused: false }, { width: 80, height: 10 });
    expect(live.caption).not.toContain("PAUSED");
  });
  // T6 (cosmetic sweep): a raw JobState enum like "cancel_requested" or
  // "timed_out" read as a machine token, not English.
  it("humanizes underscored job states for display, keeping the icon keyed on the raw value", () => {
    const projection = jobsScreen.project({ jobs: [
      { id: "j1", kind: "k", state: "cancel_requested", owner_scope_id: "c" },
      { id: "j2", kind: "k", state: "timed_out", owner_scope_id: "c" },
    ] }, { width: 80, height: 10 });
    expect(projection.rows[0].state).toContain("cancel requested");
    expect(projection.rows[0].state).not.toContain("_");
    expect(projection.rows[1].state).toContain("timed out");
  });
  it("carries row_ids keyed by job id, the value job.cancel/job.retry need", () => {
    const projection = jobsScreen.project({ jobs: [{ id: "j1", kind: "k", state: "queued", owner_scope_id: "c" }] }, { width: 80, height: 10 });
    expect(projection.row_ids).toEqual([{ id: "j1" }]);
  });
});

describe("approvals screen (item 22)", () => {
  it("projects durable approval records", () => {
    registerScreen(approvalsScreen);
    const projection = approvalsScreen.project({ records: [{ request_id: "ap-1", action: "campaign.halt", subject: "halt", status: "pending", proposer: "alice", decided_by: null, expires_at: "2099-01-01T00:00:00.000Z" }] }, { width: 100, height: 10 });
    expect(projection.rows[0]).toMatchObject({ id: "ap-1", action: "HALT campaign · halt", proposer: "alice", memory: expect.stringContaining("persistent unavailable") });
    expect(projection.columns.some((c) => c.key === "decided_by")).toBe(true);
  });
  it("renders durability labels and only offers persistence for a canonical fingerprint", () => {
    const canonical = `sha256:${"a".repeat(64)}`;
    const projection = approvalsScreen.project({ records: [
      { request_id: "canonical", action: "output.raw", subject: "artifact", status: "pending", proposer: "p", action_fingerprint: canonical },
      { request_id: "fallback", action: "permission.grant", subject: "network", status: "pending", proposer: "p" },
    ] }, { width: 160, height: 10 });
    expect(projection.rows[0]).toMatchObject({ action: "DISCLOSE raw output · artifact", memory: expect.stringContaining("persistent (survives restart)") });
    expect(projection.rows[1]).toMatchObject({ action: "GRANT permission · network", memory: expect.stringContaining("persistent unavailable") });
  });
  it("requires approval capabilities and never offers self-approval controls", () => {
    registerScreen(approvalsScreen);
    expect(availableScreens(new Set(["approval.read"])).some((s) => s.id === "approvals")).toBe(false);
    expect(availableScreens(new Set(["approval.read", "approval.request", "approval.decide"])).some((s) => s.id === "approvals")).toBe(true);
    // screen only projects; decide controls are surfaced by the consumer against backend (self-approval structurally absent at service)
    for (const command of approvalsScreen.surface.commands) {
      expect(["approval.request", "approval.approve", "approval.reject", "approval.expire"]).toContain(command);
    }
  });
  it("degrades gracefully on null/unknown and bound-by-height", () => {
    expect(() => r(approvalsScreen, null)).not.toThrow();
    expect(() => r(approvalsScreen, { bad: 1 })).not.toThrow();
    const out = r(approvalsScreen, { records: Array.from({ length: 50 }, (_, i) => ({ request_id: `r${i}`, action: "a", status: "pending", proposer: "p" })) }, 100, 10);
    expect(out.length).toBeLessThanOrEqual(11);
  });
  it("keeps time-of-day on expires_at — two same-day expiries must render distinguishably", () => {
    const projection = approvalsScreen.project(
      {
        records: [
          { request_id: "r1", action: "a", status: "pending", proposer: "p", expires_at: "2026-08-07T09:15:00.000Z" },
          { request_id: "r2", action: "a", status: "pending", proposer: "p", expires_at: "2026-08-07T23:45:00.000Z" },
        ],
      },
      { width: 100, height: 10 },
    );
    expect(projection.rows[0].expires).not.toBe(projection.rows[1].expires);
    expect(projection.rows[0].expires).toContain("09:15");
    expect(projection.rows[1].expires).toContain("23:45");
  });
  it("carries row_ids keyed by request_id, the value approval.approve/reject/expire need", () => {
    const projection = approvalsScreen.project({ records: [{ request_id: "ap-1", action: "a", status: "pending", proposer: "p" }] }, { width: 100, height: 10 });
    expect(projection.row_ids).toEqual([{ id: "ap-1" }]);
  });
});

describe("install wiring includes the four new screens", () => {
  it("registers config/agents/jobs/approvals when their capabilities are granted", async () => {
    const { installScreens } = await import("../src/screens/install.js");
    clearRegisteredScreens();
    installScreens();
    for (const id of ["config", "agents", "jobs", "approvals"] as const) {
      expect(getScreen(id).id).toBe(id);
    }
    clearRegisteredScreens();
  });
});
