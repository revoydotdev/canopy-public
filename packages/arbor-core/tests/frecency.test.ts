import { describe, expect, it } from "vitest";
import { frecencyScore, rankByFrecency } from "../src/frecency.js";

describe("frecency recall ranking", () => {
  it("uses frequency / (1 + days_since_last_use)", () => {
    expect(frecencyScore(6, "2026-08-10T00:00:00.000Z", "2026-08-12T00:00:00.000Z")).toBe(2);
    expect(frecencyScore(3, "2026-08-12T00:00:00.000Z", "2026-08-12T00:00:00.000Z")).toBe(3);
  });
  it("rejects invalid frequency and timestamp inputs instead of producing an unstable score", () => {
    expect(() => frecencyScore(-1, "2026-08-12T00:00:00.000Z", 1_755_043_200_000)).toThrow("non-negative finite number");
    expect(() => frecencyScore(1, "not-a-date", 1_755_043_200_000)).toThrow("timestamps must be valid");
  });
  it("accepts numeric time and clamps future observations to zero elapsed days", () => {
    expect(frecencyScore(4, "2026-08-13T00:00:00.000Z", Date.parse("2026-08-12T00:00:00.000Z"))).toBe(4);
  });
  it("ranks campaigns, nodes, or worktrees stably from the same scoped facts", () => {
    const values = [{ id: "old-frequent", frequency: 9, at: "2026-08-09T00:00:00.000Z" }, { id: "recent", frequency: 3, at: "2026-08-12T00:00:00.000Z" }];
    expect(rankByFrecency(values, (value) => ({ frequency: value.frequency, last_used_at: value.at }), "2026-08-12T00:00:00.000Z").map((value) => value.id)).toEqual(["recent", "old-frequent"]);
  });
  it("retains source order when two entries have equal frecency", () => {
    const values = [{ id: "first", frequency: 3, at: "2026-08-12T00:00:00.000Z" }, { id: "second", frequency: 3, at: "2026-08-12T00:00:00.000Z" }];
    expect(rankByFrecency(values, (value) => ({ frequency: value.frequency, last_used_at: value.at }), "2026-08-12T00:00:00.000Z").map((value) => value.id)).toEqual(["first", "second"]);
  });
});
