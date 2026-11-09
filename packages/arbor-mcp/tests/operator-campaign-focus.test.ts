import { describe, expect, it } from "vitest";
import { newestVisibleCampaignId, shouldRefreshFocusedTree } from "../src/operator-campaign-focus.js";

describe("operator campaign review focus", () => {
  it("fetches the final tree once and stops periodic refresh after receiving it", () => {
    expect(shouldRefreshFocusedTree("latest", undefined)).toBe(true);
    expect(shouldRefreshFocusedTree("latest", { campaign_id: "latest", halted: false })).toBe(true);
    expect(shouldRefreshFocusedTree("latest", { campaign_id: "latest", halted: true })).toBe(false);
    expect(shouldRefreshFocusedTree("next", { campaign_id: "latest", halted: true })).toBe(true);
    expect(shouldRefreshFocusedTree(null, { campaign_id: "latest", halted: true })).toBe(false);
    expect(shouldRefreshFocusedTree("latest", { campaign_id: "latest" })).toBe(true);
  });
  const old = { id: "old-unfinished", started_at: "2026-09-05T09:00:00Z", halted: false };
  const latest = { id: "latest", started_at: "2026-09-05T10:00:00Z", halted: false };
  it("retains the latest campaign through completion despite older unfinished work", () => {
    expect(newestVisibleCampaignId([old, latest], new Set())).toBe("latest");
    expect(newestVisibleCampaignId([{ ...latest, halted: true }, old], new Set())).toBe("latest");
  });
  it("follows a newly admitted campaign without depending on list order", () => {
    const next = { id: "next", started_at: "2026-09-05T11:00:00Z" };
    expect(newestVisibleCampaignId([next, old, latest], new Set())).toBe("next");
  });
  it("does not foreground historical active work in a fresh session", () => {
    expect(newestVisibleCampaignId([old], new Set([old.id]))).toBeNull();
    expect(newestVisibleCampaignId([old, latest], new Set([old.id]))).toBe("latest");
  });
  it("resolves equal start times deterministically and handles no campaigns", () => {
    expect(newestVisibleCampaignId([{ id: "a", started_at: latest.started_at }, { id: "z", started_at: latest.started_at }], new Set())).toBe("z");
    expect(newestVisibleCampaignId([], new Set())).toBeNull();
  });
});
