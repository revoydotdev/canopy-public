import { describe, expect, it } from "vitest";
import { fidelityMeter, campaignFidelityMeter } from "../src/fidelity-meter.js";
import type { AppModel } from "../src/types.js";

describe("fidelityMeter (feature 5 — adaptive taper)", () => {
  it("returns full budget at campaign start (remaining=1)", () => {
    const m = fidelityMeter({ elapsed_seconds: 0, max_seconds: 100 });
    expect(m.scale).toBe(1);
    expect(m.remaining).toBe(1);
    expect(m.tapered).toBe(false);
  });

  it("tapers toward the 0.25 floor as elapsed approaches max", () => {
    const m = fidelityMeter({ elapsed_seconds: 90, max_seconds: 100 });
    expect(m.remaining).toBeCloseTo(0.1, 2);
    expect(m.scale).toBeCloseTo(0.25 + 0.75 * 0.1, 2);
    expect(m.tapered).toBe(true);
  });

  it("renders a bounded bar", () => {
    const m = fidelityMeter({ elapsed_seconds: 0, max_seconds: 100 });
    expect(m.bar.length).toBeGreaterThanOrEqual(8);
    expect(m.bar).toMatch(/[█░\u2001]/); // some blocks
  });

  it("clamps remaining to [0,1] and floors at the taper floor", () => {
    const over = fidelityMeter({ elapsed_seconds: 200, max_seconds: 100 });
    expect(over.remaining).toBe(0);
    expect(over.scale).toBe(0.25);
    const before = fidelityMeter({ elapsed_seconds: -5, max_seconds: 100 });
    expect(before.remaining).toBe(1);
    expect(before.scale).toBe(1);
  });

  it("rejects a non-positive max_seconds", () => {
    expect(() => fidelityMeter({ elapsed_seconds: 0, max_seconds: 0 })).toThrow(/positive max/);
  });
});

describe("campaignFidelityMeter", () => {
  it("neutral full-budget meter at boot (no snapshot)", () => {
    const app = { snapshot: null } as unknown as AppModel;
    const m = campaignFidelityMeter(app);
    expect(m.scale).toBe(1);
  });

  it("reads elapsed/max from the snapshot summary", () => {
    const app = { snapshot: { summary: { elapsed_seconds: 50, max_seconds: 100 } } } as unknown as AppModel;
    const m = campaignFidelityMeter(app);
    expect(m.remaining).toBeCloseTo(0.5, 2);
    expect(m.tapered).toBe(true);
  });
});
