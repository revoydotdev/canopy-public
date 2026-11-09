/**
 * Project Registry screen (ADR-076 / Roadmap 23 W2+W6) — the multi-project
 * registry view the `projects` screen never had: it only ever showed the
 * current checkout's own single enrollment overlay, never a list of every
 * registered project.
 */
import { describe, it, expect, afterEach } from "vitest";
import { projectRegistryScreen } from "../src/screens/project-registry.js";
import { registerScreen, clearRegisteredScreens, availableScreens } from "../src/screens/screen.js";
import { initialModel } from "../src/model.js";
import { update } from "../src/update.js";
import { displayWidth } from "../src/widgets.js";

afterEach(() => clearRegisteredScreens());

function r(result: unknown, width = 100, height = 20): readonly string[] {
  const projection = projectRegistryScreen.project(result, { width, height });
  return projectRegistryScreen.render({ projection, width, height });
}

function seeded(value: unknown) {
  const focused = update(initialModel(), { type: "screen_changed", screen: "project-registry" }).model;
  return update(focused, { type: "query_results", queryId: "list", screen: "project-registry", value }).model;
}

const registryListResult = {
  present: true,
  entry_count: 2,
  ok: false,
  entries: [
    {
      project_id: "revoy2", path: "/repo/revoy2",
      profile_hash: "abc123", verified_at_revision: "deadbeef1234567890", verified_at: "2026-08-01T00:00:00.000Z",
      expires: "2026-09-30",
      ok: true, failures: [],
    },
    {
      project_id: "revoy-spec", path: "/repo/revoy-spec",
      profile_hash: "def456", verified_at_revision: "cafebabe1234567890", verified_at: "2026-07-01T00:00:00.000Z",
      expires: "2026-08-01",
      ok: false, failures: [{ code: "expired", detail: "entry expired 2026-08-01" }],
    },
  ],
};

const manageResult = {
  ok: false,
  entry_count: 2,
  retargetable_gate_ids: ["project-conform", "tui-catalog-parity"],
  not_applicable_gates: [{ gate_id: "coverage", reason: "not retargetable" }],
  entries: [
    {
      project_id: "revoy2", path: "/repo/revoy2", discharge_ok: true, discharge_failures: [],
      gates: [
        { gate_id: "project-conform", status: "pass", detail: "PASS" },
        { gate_id: "tui-catalog-parity", status: "pass", detail: "PASS" },
      ],
      ok: true,
    },
    {
      project_id: "revoy-spec", path: "/repo/revoy-spec", discharge_ok: false,
      discharge_failures: [{ code: "expired", detail: "entry expired 2026-08-01" }],
      gates: [
        { gate_id: "project-conform", status: "not_run_discharge_failed", detail: "discharge failed" },
        { gate_id: "tui-catalog-parity", status: "not_run_discharge_failed", detail: "discharge failed" },
      ],
      ok: false,
    },
  ],
};

describe("project registry screen — declaration", () => {
  it("declares the project.registry.list/project.manage round trips, no direct commands", () => {
    expect(projectRegistryScreen.surface.commands).toEqual([]);
    expect(projectRegistryScreen.surface.queries).toEqual(["project.registry.list", "project.manage"]);
  });

  it("requires project.registry.read and project.manage.read and degrades gracefully", () => {
    registerScreen(projectRegistryScreen);
    expect(availableScreens(new Set(["campaign.read"])).some((s) => s.id === "project-registry")).toBe(false);
    expect(availableScreens(new Set(["project.registry.read"])).some((s) => s.id === "project-registry")).toBe(false);
    expect(availableScreens(new Set(["project.registry.read", "project.manage.read"])).some((s) => s.id === "project-registry")).toBe(true);
    expect(() => r(null)).not.toThrow();
    expect(() => r({ odd: 1 })).not.toThrow();
  });
});

describe("project registry screen — registry list variant", () => {
  it("projects every registered project's identity, path, revision, discharge and staleness — never fabricated", () => {
    const projection = projectRegistryScreen.project(registryListResult, { width: 120, height: 20 });
    expect(projection.rows).toHaveLength(2);
    const ok = projection.rows.find((row) => row.project_id === "revoy2")!;
    expect(ok.path).toBe("/repo/revoy2");
    expect(ok.revision).toBe("deadbeef1234");
    expect(ok.discharge).toBe("OK");
    const failing = projection.rows.find((row) => row.project_id === "revoy-spec")!;
    expect(failing.discharge).toContain("FAIL");
    expect(failing.discharge).toContain("expired");
  });

  it("carries row_ids keyed by the real project_id", () => {
    const projection = projectRegistryScreen.project(registryListResult, { width: 120, height: 20 });
    expect(projection.row_ids).toEqual([{ id: "revoy2" }, { id: "revoy-spec" }]);
  });

  it("makes a failing/stale entry visually obvious in the caption", () => {
    const projection = projectRegistryScreen.project(registryListResult, { width: 120, height: 20 });
    expect(projection.caption).toContain("FAILING DISCHARGE");
  });

  it("a fresh checkout with no registry file yet reads as 'no projects registered', never a crash or blank panel", () => {
    const neverRegistered = { present: false, entry_count: 0, ok: true, entries: [] };
    const projection = projectRegistryScreen.project(neverRegistered, { width: 100, height: 10 });
    expect(projection.rows).toHaveLength(0);
    expect(projection.caption).toContain("no projects registered yet");
    expect(() => r(neverRegistered)).not.toThrow();
    // At 80 columns the remedy is the part that fell off the row (EC-058); the
    // empty state is prose and wraps, so the whole sentence survives.
    const narrow = r(neverRegistered, 80, 10);
    expect(narrow.every((line) => displayWidth(line) <= 80)).toBe(true);
    expect(narrow.join(" ")).toContain("registers the current checkout");
  });

  it("a present registry with zero entries is distinct from 'never registered' — governing zero projects is valid, not a failure", () => {
    const zeroEntries = { present: true, entry_count: 0, ok: true, entries: [] };
    const projection = projectRegistryScreen.project(zeroEntries, { width: 100, height: 10 });
    expect(projection.caption).toContain("governing no projects");
    expect(projection.caption).not.toContain("no projects registered yet");
  });

  it("distinguishes a genuinely empty result from the never-fetched (null) loading state", () => {
    const loading = projectRegistryScreen.project(null, { width: 80, height: 10 });
    const empty = projectRegistryScreen.project({ present: true, entry_count: 0, ok: true, entries: [] }, { width: 80, height: 10 });
    expect(loading.caption).not.toBe(empty.caption);
  });

  it("width clips every rendered line", () => {
    const lines = r(registryListResult, 40, 12);
    for (const line of lines) expect(displayWidth(line)).toBeLessThanOrEqual(40);
  });

  it("renders every TTL state and preserves unknown registry fields as unknown", () => {
    const iso = (offsetDays: number) => new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);
    const projection = projectRegistryScreen.project({
      present: true,
      entries: [
        { project_id: "expired", expires: iso(-2), ok: false, failures: [{ detail: "missing code" }] },
        { project_id: "today", expires: iso(0), ok: true },
        { project_id: "fresh", expires: iso(3), ok: true },
        { project_id: "invalid", expires: "not-a-date", ok: true },
        { path: 42, verified_at_revision: 42, ok: false },
      ],
    }, { width: 120, height: 20 });
    expect(projection.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ project_id: "expired", discharge: "FAIL (?)", staleness: "expired 2d ago" }),
      expect.objectContaining({ project_id: "today", staleness: "expires today" }),
      expect.objectContaining({ project_id: "fresh", staleness: "3d left" }),
      expect.objectContaining({ project_id: "invalid", staleness: "?" }),
      expect.objectContaining({ project_id: "?", path: "?", revision: "?", discharge: "FAIL", staleness: "?" }),
    ]));
    expect(projection.row_ids?.at(-1)).toBeNull();
  });

  it("uses singular/all-discharged copy and marks the selected table row", () => {
    const value = { present: true, entries: [{ project_id: "only", path: "/only", verified_at_revision: "abcdef", ok: true, failures: [] }] };
    const projection = projectRegistryScreen.project(value, { width: 100, height: 10 });
    expect(projection.caption).toBe("Project registry — 1 entry, all discharged");
    const lines = projectRegistryScreen.render({ projection, width: 100, height: 10, selected_id: "only" });
    expect(lines.join("\n")).toContain("› only");
    const broken = { ...projection, columns: undefined } as never;
    expect(projectRegistryScreen.render({ projection: broken, width: 60, height: 8 })).toEqual(["(render error)"]);
  });
});

describe("project registry screen — manage/reconcile variant", () => {
  it("projects the real per-entry gate battery, distinguishing discharge-failed (not run) from a genuine gate failure", () => {
    const projection = projectRegistryScreen.project(manageResult, { width: 120, height: 20 });
    expect(projection.rows).toHaveLength(2);
    const passing = projection.rows.find((row) => row.project_id === "revoy2")!;
    expect(passing.discharge).toBe("OK");
    expect(passing.gates).toContain("2 pass");
    expect(passing.outcome).toBe("PASS");
    const failing = projection.rows.find((row) => row.project_id === "revoy-spec")!;
    expect(failing.discharge).toBe("FAILED");
    expect(failing.gates).toContain("discharge failed");
    expect(failing.outcome).toBe("FAIL");
  });

  it("caption names the real discovered retargetable gates, never fabricated", () => {
    const projection = projectRegistryScreen.project(manageResult, { width: 120, height: 20 });
    expect(projection.caption).toContain("project-conform");
    expect(projection.caption).toContain("tui-catalog-parity");
    expect(projection.caption).toContain("FAILURES PRESENT");
  });

  it("width clips every rendered line", () => {
    const lines = r(manageResult, 40, 12);
    for (const line of lines) expect(displayWidth(line)).toBeLessThanOrEqual(40);
  });

  it("summarizes pass, fail, not-applicable, skipped, and empty gate batteries", () => {
    const projection = projectRegistryScreen.project({
      ok: true,
      retargetable_gate_ids: [],
      entries: [
        { project_id: "mixed", path: "/mixed", discharge_ok: true, ok: true, gates: [
          { status: "pass" }, { status: "fail" }, { status: "not_applicable" }, { status: "not_run_discharge_failed" }, { status: "unknown" },
        ] },
        { project_id: "empty", discharge_ok: true, ok: false, gates: [] },
        { discharge_ok: false, ok: false },
      ],
    }, { width: 120, height: 20 });
    expect(projection.rows[0]).toMatchObject({ gates: "1 pass, 1 FAIL, 1 n/a, 1 skipped", outcome: "PASS" });
    expect(projection.rows[1]).toMatchObject({ gates: "no gates", outcome: "FAIL" });
    expect(projection.rows[2]).toMatchObject({ project_id: "?", path: "?", gates: "not run — discharge failed" });
    expect(projection.caption).toContain("3 projects, all OK");
    expect(projection.caption).toContain("none discovered");
    expect(projection.row_ids?.at(-1)).toBeNull();
  });

  it("distinguishes an empty reconcile pass and contains malformed render projections", () => {
    const empty = projectRegistryScreen.project({ ok: true, retargetable_gate_ids: [], entries: [] }, { width: 60, height: 8 });
    expect(empty.caption).toBe("Reconcile pass — no projects registered yet");
    expect(projectRegistryScreen.render({ projection: empty, width: 60, height: 8 })).toEqual([empty.caption]);

    const populated = projectRegistryScreen.project(manageResult, { width: 60, height: 8 });
    const broken = { ...populated, columns: undefined } as never;
    expect(projectRegistryScreen.render({ projection: broken, width: 60, height: 8 })).toEqual(["(render error)"]);
  });
});

describe("project registry screen — operator actions wired through update.ts", () => {
  it("Enter (view_selected_row_detail) re-verifies the selected entry via a scoped project.registry.list query, not a second evaluation path", () => {
    const model = seeded(registryListResult);
    expect(model.selection.get("project-registry")).toEqual({ id: "revoy2" });
    const result = update(model, { type: "ui_intent", intent: { type: "view_selected_row_detail" }, at: 5 });
    expect(result.effects).toEqual([
      { type: "run_query", request: { kind: "project.registry.list", query_id: "tui:detail:project-registry:5", params: { project_id: "revoy2" } } },
    ]);
  });

  it("view_selected_row_detail no-ops off the project-registry screen and with no selection", () => {
    const noSelection = update(initialModel(), { type: "screen_changed", screen: "project-registry" }).model;
    const result = update(noSelection, { type: "ui_intent", intent: { type: "view_selected_row_detail" }, at: 6 });
    expect(result.effects).toEqual([]);
  });
});
