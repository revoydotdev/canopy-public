import { describe, expect, it } from "vitest";
import { gateContractRows } from "../enforcement-audit.mjs";
import { loadExecutionProfile } from "../enforcement-control-plane.mjs";

describe("enforcement contract audit", () => {
  it("renders every gate with no blank contract or timing cells", () => {
    const registry = loadExecutionProfile();
    const first = Object.keys(registry.gates).sort()[0];
    const rows = gateContractRows(registry, { gates: [{ gate: first, duration_ms: 42 }] });
    expect(rows).toHaveLength(Object.keys(registry.gates).length);
    expect(rows.find((row) => row.gate === first)?.last_duration_ms).toBe(42);
    for (const row of rows) for (const value of Object.values(row)) expect(value).not.toBe("");
    expect(rows.some((row) => row.last_duration_ms === "unmeasured")).toBe(true);
  });
});
