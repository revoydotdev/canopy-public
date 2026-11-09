import { describe, expect, it } from "vitest";
import { lifecycleNarration } from "../src/narration.js";

describe("operator lifecycle narration vocabulary", () => {
  it("covers every governed lifecycle beat without inventing unavailable detail", () => {
    expect(lifecycleNarration("loop.campaign_start", null, null)).toEqual({ title: "starting governed campaign", detail: null });
    expect(lifecycleNarration("loop.decomposed", {}, "node_root_alpha")).toEqual({ title: "expanding plan into tasks", detail: "node alpha" });
    expect(lifecycleNarration("tree.decomposed", [], "x")).toEqual({ title: "expanding plan into tasks", detail: "node x" });
    expect(lifecycleNarration("loop.node_claimed", {}, "node_claimed_1")).toEqual({ title: "claim recorded", detail: "node node_claimed_1" });
    expect(lifecycleNarration("loop.node_verified", {}, "node_verified_ok")).toEqual({ title: "verification passed", detail: "node ok" });
    expect(lifecycleNarration("loop.backtracked", {}, "")).toEqual({ title: "backtracking to next approach", detail: "campaign" });
    expect(lifecycleNarration("stream.truncated", {}, null)).toEqual({ title: "event stream truncated — older events dropped", detail: null });
    expect(lifecycleNarration("projection.updated", {}, "node-1")).toBeNull();
  });

  it("uses supplied agent identities but falls back to role language", () => {
    expect(lifecycleNarration("loop.specialist_dispatched", { agent: " Heartwood " }, "node_a")).toEqual({
      title: "dispatching Heartwood through flight control", detail: "node node_a",
    });
    expect(lifecycleNarration("loop.specialist_dispatched", { agent: " " }, "node_b")).toEqual({
      title: "dispatching specialist through flight control", detail: "node node_b",
    });
    expect(lifecycleNarration("loop.critic_dispatched", { agent: "Lenticel-2" }, "node_c")).toEqual({
      title: "dispatching Lenticel-2 review", detail: "node node_c",
    });
    expect(lifecycleNarration("loop.critic_dispatched", { agent: 3 }, "node_d")).toEqual({
      title: "dispatching Lenticel review", detail: "node node_d",
    });
  });

  it("prioritizes explicit failure reason, then root cause, then node identity", () => {
    expect(lifecycleNarration("loop.node_failed", { reason: " dependency unavailable ", root_cause: "ignored" }, "node_a")).toEqual({
      title: "Lenticel rejected node", detail: "dependency unavailable",
    });
    expect(lifecycleNarration("loop.node_failed", { reason: "", root_cause: "policy denied" }, "node_b")).toEqual({
      title: "Lenticel rejected node", detail: "policy denied",
    });
    expect(lifecycleNarration("loop.node_failed", null, "node_c")).toEqual({
      title: "Lenticel rejected node", detail: "node node_c",
    });
    expect(lifecycleNarration("loop.halt", { reason: "budget exhausted" }, null)).toEqual({
      title: "campaign halted", detail: "budget exhausted",
    });
    expect(lifecycleNarration("loop.halt", {}, null)).toEqual({ title: "campaign halted", detail: null });
  });

  it("distinguishes gate pass, fail, other, and malformed gate records", () => {
    expect(lifecycleNarration("gate.recorded", { gate: "evidence", result: "pass" }, null)).toEqual({ title: "evidence gate passed", detail: null });
    expect(lifecycleNarration("gate.recorded", { gate: "audit", result: "fail" }, null)).toEqual({ title: "audit gate failed", detail: null });
    expect(lifecycleNarration("gate.recorded", { gate: "isolation", result: "bypassed" }, null)).toEqual({ title: "isolation gate recorded", detail: null });
    expect(lifecycleNarration("gate.recorded", { gate: "admission" }, null)).toEqual({ title: "admission gate recorded", detail: null });
    expect(lifecycleNarration("gate.recorded", { gate: "", result: "pass" }, null)).toBeNull();
    expect(lifecycleNarration("gate.recorded", "not an object", null)).toBeNull();
  });
});
