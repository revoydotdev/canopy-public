import { describe, expect, it } from "vitest";
import { REBIND_STEPS, runRebind } from "../evidence-rebind.mjs";

describe("evidence-rebind — the post-source-commit producer chain", () => {
  it("names the automatic producers in dependency order and excludes manual determinism measurement", () => {
    expect(REBIND_STEPS.map((s) => s.label)).toEqual([
      "build:dist",
      "vi:refresh",
      "vi:observe",
      "claims:refresh",
      "completion-depth:refresh",
    ]);
    expect(REBIND_STEPS.some((step) => step.label === "determinism:refresh")).toBe(false);
    for (const step of REBIND_STEPS) expect(step.argv).toEqual(["bun", "run", step.label]);
  });

  it("runs every step in order when all succeed", () => {
    const calls = [];
    const run = (argv) => { calls.push(argv.join(" ")); return { status: 0 }; };
    const result = runRebind(REBIND_STEPS, run, () => {});
    expect(result.ok).toBe(true);
    expect(result.completed).toEqual(REBIND_STEPS.map((s) => s.label));
    expect(calls).toEqual(REBIND_STEPS.map((s) => s.argv.join(" ")));
  });

  it("stops at the first failure and never runs a later, dependent producer", () => {
    const calls = [];
    const run = (argv) => {
      calls.push(argv.join(" "));
      return { status: argv.join(" ") === "bun run claims:refresh" ? 1 : 0 };
    };
    const result = runRebind(REBIND_STEPS, run, () => {});
    expect(result.ok).toBe(false);
    expect(result.failed_step).toBe("claims:refresh");
    expect(result.exit_code).toBe(1);
    // vi:refresh and vi:observe ran (they precede the failure); nothing after did.
    expect(calls).toEqual(["bun run build:dist", "bun run vi:refresh", "bun run vi:observe", "bun run claims:refresh"]);
  });

  it("reports the honest per-step log, not a silent pass-through", () => {
    const lines = [];
    const run = () => ({ status: 0 });
    runRebind(REBIND_STEPS, run, (line) => lines.push(line));
    // Every step logs a start and an ok line.
    for (const step of REBIND_STEPS) {
      expect(lines.some((l) => l.includes(step.label) && l.includes("running"))).toBe(true);
      expect(lines.some((l) => l.includes(step.label) && l.includes("ok"))).toBe(true);
    }
    // The commit reminder — constraint 2 — is stated, not left implicit.
    expect(lines.some((l) => /not committed/i.test(l) && /COMMITTED/.test(l))).toBe(true);
  });

  it("a failure logs which step and stops naming later steps as completed", () => {
    const lines = [];
    const run = (argv) => ({ status: argv.join(" ") === "bun run vi:observe" ? 7 : 0 });
    const result = runRebind(REBIND_STEPS, run, (line) => lines.push(line));
    expect(result.ok).toBe(false);
    expect(result.completed).toEqual(["build:dist", "vi:refresh"]);
    expect(lines.some((l) => l.includes("FAILED") && l.includes("vi:observe") && l.includes("exit 7"))).toBe(true);
  });
});
