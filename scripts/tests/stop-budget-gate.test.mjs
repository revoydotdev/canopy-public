/**
 * scripts/tests/stop-budget-gate.test.mjs — ADR-156.
 *
 * A budget gate is worth exactly as much as its ability to go red, so both
 * directions are pinned here: it fails on a sustained breach and it does NOT
 * fail on a single slow run, which is what would otherwise train people to
 * raise the ceiling until it stopped talking.
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const GATE = join(REPO_ROOT, "scripts", "stop-budget-gate.mjs");
const { auditStopBudget, evaluateStopBudget, main, median, readBudget, readCosts, resolveCostsPath } = await import(GATE);
const { mergeMeasuredCosts } = await import(join(REPO_ROOT, "scripts", "gate-all.mjs"));

describe("median", () => {
  it("is the middle of an odd series and the mean of the middle two of an even one", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([1, 2, 3, 4])).toBe(3);
    expect(median([])).toBeNull();
  });
});

describe("the committed ceiling", () => {
  it("parses, and carries the measurement that justified it", () => {
    const budget = readBudget();
    expect(budget.ok).toBe(true);
    expect(budget.ceilingMs).toBeGreaterThan(0);
    // A ceiling with no recorded basis is a number someone picked.
    expect(budget.raw.adopted.median_measured_ms).toBeGreaterThan(0);
    expect(budget.raw.adopted.why_this_ceiling.length).toBeGreaterThan(40);
  });

  it("is a blocker when unreadable, never a permissive default", () => {
    const dir = mkdtempSync(join(tmpdir(), "revoy2-stop-budget-"));
    try {
      const path = join(dir, "b.json");
      writeFileSync(path, "{ not json");
      expect(readBudget(path).ok).toBe(false);
      writeFileSync(path, JSON.stringify({ ceiling_ms: 0 }));
      expect(readBudget(path).ok).toBe(false);
      expect(readBudget(join(dir, "absent.json")).ok).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("holds against the tier as it stands today", () => {
    // If this ever fails, the stop tier really has outgrown its budget and the
    // remedy is to move a gate's cost_class, not to edit the ceiling.
    const budget = readBudget();
    expect(budget.raw.adopted.median_measured_ms).toBeLessThanOrEqual(budget.ceilingMs);
  });
});

describe("auditStopBudget", () => {
  const ceilingMs = 25000;

  it("passes when the median is within budget", () => {
    const result = auditStopBudget({ recentTotalsMs: [14000, 15000, 16000], ceilingMs });
    expect(result).toMatchObject({ ok: true, verdict: "within_budget", median_ms: 15000 });
  });

  it("FAILS on a sustained breach", () => {
    const result = auditStopBudget({ recentTotalsMs: [30000, 31000, 29000], ceilingMs });
    expect(result).toMatchObject({ ok: false, verdict: "over_budget", median_ms: 30000 });
  });

  it("is not moved by a single slow run", () => {
    // Wall clock on a shared workstation spikes. A gate that flapped on that
    // would be tuned into silence within a week.
    const result = auditStopBudget({ recentTotalsMs: [14000, 90000, 15000], ceilingMs });
    expect(result.ok).toBe(true);
    expect(result.median_ms).toBe(15000);
  });

  it("refuses to judge before it has enough samples", () => {
    const result = auditStopBudget({ recentTotalsMs: [99999], ceilingMs });
    expect(result).toMatchObject({ ok: true, verdict: "insufficient_samples" });
  });

  it("ignores a non-numeric entry rather than treating it as zero", () => {
    const result = auditStopBudget({ recentTotalsMs: [30000, null, 31000, 29000], ceilingMs });
    expect(result).toMatchObject({ ok: false, samples: 3, median_ms: 30000 });
  });
});

/**
 * The ratchet's own input. `readBudget` has always refused a permissive
 * default for the CEILING ("An unreadable budget is a blocker, never a
 * permissive default"); the measured series, read a few lines below it, did
 * the opposite — a missing or corrupt costs file became an empty series,
 * which is `insufficient_samples`, which is `ok: true`, which is a permanent
 * silent pass. A ratchet that cannot be seen to slip is not a ratchet.
 */
describe("readCosts", () => {
  const withCosts = (body) => {
    const dir = mkdtempSync(join(tmpdir(), "revoy2-stop-costs-"));
    const path = join(dir, "measured-costs.json");
    writeFileSync(path, typeof body === "string" ? body : JSON.stringify(body));
    return { dir, path };
  };

  it("reads a recorded series", () => {
    const { dir, path } = withCosts({ tiers: { stop: { recent_totals_ms: [100, 200, 300] } } });
    try {
      const costs = readCosts(path);
      expect(costs).toMatchObject({ ok: true, blocking: false, series: [100, 200, 300] });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("treats an ABSENT file as unmeasured, not as a pass", () => {
    const costs = readCosts(join(tmpdir(), "revoy2-definitely-absent-costs.json"));
    expect(costs.ok).toBe(false);
    expect(costs.error).toMatch(/no measured-cost series/);
    // Not a blocker only because `.arbor/` is gitignored and gate-all.mjs
    // records the series AFTER the roster runs, so a fresh clone legitimately
    // has none. It is still never reported as a pass.
    expect(costs.blocking).toBe(false);
  });

  it("treats a file the caller NAMED as a blocker, because that is a caller error", () => {
    const missing = readCosts(join(tmpdir(), "revoy2-absent-named.json"), { substituted: true });
    expect(missing).toMatchObject({ ok: false, blocking: true });
    const { dir, path } = withCosts("{ not json");
    try {
      expect(readCosts(path)).toMatchObject({ ok: false, blocking: true });
      expect(readCosts(path, { substituted: true })).toMatchObject({ ok: false, blocking: true });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("rejects a series of the wrong shape rather than coercing it to []", () => {
    // `?? []` would have turned this into the same silent pass. A malformed
    // series is a corrupted store, and the ratchet must not judge from it.
    const { dir, path } = withCosts({ tiers: { stop: { recent_totals_ms: "18122" } } });
    try {
      const costs = readCosts(path);
      expect(costs).toMatchObject({ ok: false, blocking: true });
      expect(costs.error).toMatch(/malformed/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe("evaluateStopBudget — a missing costs file is not a pass", () => {
  const ceilingMs = 25000;

  it("reports costs_unavailable, distinctly from insufficient_samples", () => {
    // The distinction is the whole point: "not enough real measurements" and
    // "no measurement exists at all" are different facts and used to be
    // reported through one verdict.
    const result = evaluateStopBudget({
      costs: readCosts(join(tmpdir(), "revoy2-absent-eval.json")),
      ceilingMs, costsPath: "/nope.json", substituted: false,
    });
    expect(result).toMatchObject({
      ok: false, measured: false, verdict: "costs_unavailable", median_ms: null, samples: 0,
    });
    expect(result.verdict).not.toBe("insufficient_samples");
  });

  it("PASSES a valid series within the ceiling", () => {
    const result = evaluateStopBudget({
      costs: { ok: true, blocking: false, series: [17000, 18000, 19000] },
      ceilingMs, costsPath: "/c.json", substituted: false,
    });
    expect(result).toMatchObject({ ok: true, measured: true, verdict: "within_budget", median_ms: 18000 });
  });

  it("FAILS a valid series over the ceiling", () => {
    const result = evaluateStopBudget({
      costs: { ok: true, blocking: false, series: [30000, 31000, 29000] },
      ceilingMs, costsPath: "/c.json", substituted: false,
    });
    expect(result).toMatchObject({ ok: false, measured: true, verdict: "over_budget", median_ms: 30000 });
  });
});

describe("disclosure of a substituted series", () => {
  it("names the --costs path and marks the substitution on every result", () => {
    // `--costs` was added for a canary fixture, and enforcement-control-plane
    // spawns gates with no arguments, so in production no flag reaches here.
    // The risk is confined to direct invocation — but a direct invocation that
    // judged a fixture and printed an ordinary green was indistinguishable
    // from a real verdict, which is how a substituted ratchet reads as a real
    // one. `--json` used to disclose; text mode did not.
    const within = evaluateStopBudget({
      costs: { ok: true, blocking: false, series: [1, 2, 3] },
      ceilingMs: 25000, costsPath: "/fixture.json", substituted: true,
    });
    expect(within).toMatchObject({ costs: "/fixture.json", costs_substituted: true });
    expect(evaluateStopBudget({
      costs: { ok: true, blocking: false, series: [1, 2, 3] },
      ceilingMs: 25000, costsPath: "/real.json", substituted: false,
    })).toMatchObject({ costs: "/real.json", costs_substituted: false });
  });

  it("resolveCostsPath defaults to the recorded series and reports substitution", () => {
    expect(resolveCostsPath([])).toMatchObject({ substituted: false });
    expect(resolveCostsPath(["--costs", "/tmp/x.json"])).toEqual({ path: "/tmp/x.json", substituted: true });
  });

  it("text mode says which series it judged, and flags a substituted one", () => {
    // The end-to-end disclosure, on the one path that has no --json. Asserted
    // on the real printed lines because the point is what an operator sees.
    const lines = [];
    const originalLog = console.log;
    console.log = (...args) => lines.push(args.join(" "));
    try {
      const dir = mkdtempSync(join(tmpdir(), "revoy2-stop-text-"));
      const path = join(dir, "costs.json");
      writeFileSync(path, JSON.stringify({ tiers: { stop: { recent_totals_ms: [17000, 18000, 19000] } } }));
      try {
        expect(main(["--costs", path])).toBe(0);
        const out = lines.join("\n");
        expect(out).toContain("SUBSTITUTED SERIES");
        expect(out).toContain(path);
        // And the NOT MEASURED text mode, which must not read as a green.
        lines.length = 0;
        expect(main(["--costs", join(dir, "absent.json")])).toBe(1);
        expect(lines.join("\n")).toMatch(/NOT MEASURED/);
      } finally { rmSync(dir, { recursive: true, force: true }); }
    } finally { console.log = originalLog; }
  });
});

describe("mergeMeasuredCosts", () => {
  const at = "2026-09-02T00:00:00.000Z";

  it("merges per gate so a stop run cannot blank a CI-only gate's measurement", () => {
    const previous = mergeMeasuredCosts(null, { tier: "ci", runs: [{ gate: "gate:coverage", duration_ms: 900000 }], at });
    const merged = mergeMeasuredCosts(previous, { tier: "stop", runs: [{ gate: "gate:lockfile", duration_ms: 20 }], at });
    expect(merged.gates["gate:coverage"].duration_ms).toBe(900000);
    expect(merged.gates["gate:lockfile"].duration_ms).toBe(20);
  });

  it("keeps a rolling series per tier, capped at ten", () => {
    let costs = null;
    for (let i = 1; i <= 12; i += 1) {
      costs = mergeMeasuredCosts(costs, { tier: "stop", runs: [{ gate: "g", duration_ms: i * 1000 }], at });
    }
    expect(costs.tiers.stop.recent_totals_ms).toHaveLength(10);
    expect(costs.tiers.stop.recent_totals_ms.at(-1)).toBe(12000);
    expect(costs.tiers.stop.recent_totals_ms.at(0)).toBe(3000);
  });

  it("keeps each tier's series separate", () => {
    let costs = mergeMeasuredCosts(null, { tier: "stop", runs: [{ gate: "g", duration_ms: 100 }], at });
    costs = mergeMeasuredCosts(costs, { tier: "ci", runs: [{ gate: "g", duration_ms: 5000 }], at });
    expect(costs.tiers.stop.recent_totals_ms).toEqual([100]);
    expect(costs.tiers.ci.recent_totals_ms).toEqual([5000]);
  });
});
