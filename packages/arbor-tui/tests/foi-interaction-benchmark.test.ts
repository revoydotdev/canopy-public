import { describe, expect, it } from "vitest";
import { captureFOIInteractionBenchmark } from "../src/foi-interaction-benchmark.js";

describe("FOI production interaction benchmark", () => {
  it("measures bounded command search and 1000-line result disclosure", () => {
    const report = captureFOIInteractionBenchmark(20);
    expect(report.search).toMatchObject({ samples: 20, budget_ms: 50, pass: true });
    expect(report.disclosure).toMatchObject({ samples: 20, budget_ms: 50, diff_lines: 1000, pass: true });
    expect(report.disclosure.bounded_render_rows).toBeLessThanOrEqual(30);
  });

  it("rejects unbounded sample counts", () => {
    expect(() => captureFOIInteractionBenchmark(0)).toThrow("samples must be from 1 to 10000");
    expect(() => captureFOIInteractionBenchmark(10_001)).toThrow("samples must be from 1 to 10000");
  });
});
