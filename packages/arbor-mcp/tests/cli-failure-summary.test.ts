import { describe, expect, it } from "vitest";

import { campaignFailureSummary, latestGateRefusal } from "../src/cli.js";
import { GATE_REFUSAL_PROJECTION_SCHEMA_VERSION } from "../src/gate-refusal-projection.js";

describe("campaignFailureSummary", () => {
  it("returns null when no campaign snapshot exists", () => {
    expect(campaignFailureSummary(null)).toBeNull();
  });

  it("returns null when failed nodes have no specialist output", () => {
    expect(
      campaignFailureSummary({
        nodes: [{ state: "failed", specialist_output: null }],
      } as never),
    ).toBeNull();
  });

  it("ignores non-failures and whitespace-only failure output", () => {
    expect(
      campaignFailureSummary({
        nodes: [
          { state: "claimed", specialist_output: "not a failure" },
          { state: "failed", specialist_output: "   \n" },
        ],
      } as never),
    ).toBeNull();
  });

  it("returns the latest failed node output", () => {
    expect(
      campaignFailureSummary({
        nodes: [
          { state: "failed", specialist_output: "earlier failure" },
          { state: "failed", specialist_output: "actionable root cause" },
        ],
      } as never),
    ).toBe("actionable root cause");
  });

  it("normalizes surrounding whitespace in actionable output", () => {
    expect(
      campaignFailureSummary({
        nodes: [{ state: "failed", specialist_output: "  bounded reason \n" }],
      } as never),
    ).toBe("bounded reason");
  });

  it("bounds verbose failure output", () => {
    const summary = campaignFailureSummary({
      nodes: [{ state: "failed", specialist_output: "x".repeat(2_048) }],
    } as never);

    expect(summary).toHaveLength(1_025);
    expect(summary).toBe(`${"x".repeat(1_024)}…`);
  });
});

describe("latestGateRefusal (ADR-118)", () => {
  it("returns null when no campaign snapshot exists", () => {
    expect(latestGateRefusal(null)).toBeNull();
  });

  it("returns null when every recorded gate passed", () => {
    expect(latestGateRefusal({
      nodes: [{ gate_records: [{ gate: "isolation", result: "pass", checked_at: "2026-09-18T00:00:00.000Z", detail: "all checks passed" }] }],
    } as never)).toBeNull();
  });

  it("projects the latest fail/bypass gate record across every node, owning gate and evidence deficit included", () => {
    const projection = latestGateRefusal({
      nodes: [
        { gate_records: [{ gate: "admission", result: "pass", checked_at: "2026-09-18T00:00:00.000Z", detail: "all checks passed" }] },
        { gate_records: [{ gate: "isolation", result: "bypass", checked_at: "2026-09-18T00:01:00.000Z", detail: "worktree not isolated", bypass_evidence_deficit: "no lease evidence" }] },
      ],
    } as never);
    expect(projection).toMatchObject({
      schema_version: GATE_REFUSAL_PROJECTION_SCHEMA_VERSION,
      kind: "gate.refusal",
      state: "refused",
      gate: "isolation",
      evidence_deficit: "no lease evidence",
      correcting_actor: "runtime_host",
      corrective_action: "restore_isolation",
    });
    expect(projection?.remediation).toBeTruthy();
  });
});
