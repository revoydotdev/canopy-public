import { describe, expect, it } from "vitest";
import { consoleScreen } from "../src/screens/console.js";

const size = { width: 140, height: 40 };
const raw = {
  captured_at: "2026-09-05T12:00:00Z", focused_campaign_id: "latest", sidebar_visibility: "hidden",
  campaigns: { items: [
    { id: "old", halted: false, active_node_state: "claimed", verified_nodes: 0, total_nodes: 2 },
    { id: "latest", halted: true, halt_reason: "verified_result", verified_nodes: 1, total_nodes: 3 },
  ] },
  drafts: { items: [{ campaign_id: "latest", job_id: "latest-job", task: "Latest task" }] },
  jobs: { jobs: [{ id: "old-job", state: "cancelled" }, { id: "latest-job", state: "completed" }] },
  tree: { campaign_id: "latest", halted: true, halt_reason: "verified_result", nodes: [
    { id: "root", parent_id: null, state: "claimed" },
    { id: "failed", parent_id: "root", state: "failed", critic_verdict: { root_cause: "earlier attempt failed" } },
    { id: "recovery", parent_id: "root", state: "verified" },
  ] },
  result_review: { status: "ready_for_review" },
};
const project = (value: unknown) => consoleScreen.project(value, size);
const render = (value: unknown) => consoleScreen.render({ projection: project(value), ...size, color: false }).join("\n");

describe("Console focused campaign coherence", () => {
  it("uses the focused terminal campaign instead of older unfinished work", () => {
    const header = project(raw).rows.find((row) => row.region === "header");
    expect(header).toMatchObject({ campaign: "Latest task", verified: 1, total: 3 });
    expect(header?.status).not.toBe("Stopped");
    expect(render(raw)).not.toContain("Stopped · ready for your next instruction");
  });
  it("retains cancellation for the focused campaign's own job", () => {
    const value = { ...raw, jobs: { jobs: [{ id: "latest-job", state: "cancelled" }] } };
    expect(project(value).rows.find((row) => row.region === "header")?.status).toBe("Stopped");
  });
  it("does not fall back to another campaign when focused data is missing", () => {
    expect(project({ ...raw, focused_campaign_id: "missing" }).rows.some((row) => row.region === "header")).toBe(false);
    expect(project({ ...raw, focused_campaign_id: null }).rows.some((row) => row.region === "header")).toBe(false);
  });
  it("keeps an earlier failure as history rather than a recovered campaign's current blocker", () => {
    expect(render(raw)).not.toContain("BLOCKED · earlier attempt failed");
    expect(render(raw)).toContain("result ready");
  });
  it("still surfaces a failure when the campaign has no verified result", () => {
    expect(render({ ...raw, tree: { ...raw.tree, halt_reason: "no_nodes", nodes: raw.tree.nodes.slice(0, 2) }, result_review: null }))
      .toContain("BLOCKED · earlier attempt failed");
  });
});
