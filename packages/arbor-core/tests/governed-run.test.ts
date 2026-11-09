import { describe, expect, it } from "vitest";
import { GOVERNED_RUN_ENV, isGovernedRun, withGovernedRun } from "../src/index.js";

describe("governed-run marker", () => {
  it("adds the marker without mutating the input environment", () => {
    const base = { PATH: "/usr/bin" };
    const env = withGovernedRun(base);
    expect(env).toEqual({ PATH: "/usr/bin", [GOVERNED_RUN_ENV]: "1" });
    expect(base).toEqual({ PATH: "/usr/bin" });
    expect(isGovernedRun(env)).toBe(true);
  });

  it("treats an absent or non-\"1\" value as not governed", () => {
    expect(isGovernedRun({})).toBe(false);
    expect(isGovernedRun({ [GOVERNED_RUN_ENV]: "" })).toBe(false);
    expect(isGovernedRun({ [GOVERNED_RUN_ENV]: "true" })).toBe(false);
  });
});
