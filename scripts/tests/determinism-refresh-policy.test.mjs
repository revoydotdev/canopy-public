import { describe, expect, it } from "vitest";
import { mergeMeasuredBaselines, selectSeamsToMeasure } from "../lib/determinism-refresh-policy.mjs";

const baseline = (path, revision) => ({
  id: `seam:${path}`,
  roundtrip_path: path,
  measured_at: "2026-08-29T00:00:00.000Z",
  git_revision: revision,
  node_version: "v22",
  repeat_count: 3,
  pass_count: 3,
  fail_count: 0,
  flake_rate: 0,
  wall_clock_ms_median: 1,
  wall_clock_ms_spread_pct: 0,
  nondeterministic: false,
});

describe("bounded determinism repair", () => {
  it("measures only cited seams absent from the current baseline", () => {
    const current = new Map([["old.test.ts", baseline("old.test.ts", "old")]]);
    expect(selectSeamsToMeasure(["new.test.ts", "old.test.ts"], current, false)).toEqual(["new.test.ts"]);
    expect(selectSeamsToMeasure(["new.test.ts", "old.test.ts"], current, true)).toEqual(["new.test.ts", "old.test.ts"]);
  });

  it("retains old measurements, replaces measured rows, and drops no-longer-cited rows", () => {
    const current = new Map([
      ["keep.test.ts", baseline("keep.test.ts", "old")],
      ["replace.test.ts", baseline("replace.test.ts", "old")],
      ["retired.test.ts", baseline("retired.test.ts", "old")],
    ]);
    const merged = mergeMeasuredBaselines(
      ["keep.test.ts", "replace.test.ts"],
      current,
      [baseline("replace.test.ts", "new")],
    );
    expect(merged.map((row) => [row.roundtrip_path, row.git_revision])).toEqual([
      ["keep.test.ts", "old"],
      ["replace.test.ts", "new"],
    ]);
  });
});
