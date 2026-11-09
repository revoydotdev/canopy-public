import { describe, expect, it } from "vitest";
import { EvidenceLedger } from "../src/index.js";

function trace(overrides: Record<string, unknown> = {}): any {
  return {
    campaign_id: "campaign",
    node_id: "node",
    timestamp: "2026-01-01T00:00:00.000Z",
    action_description: "action",
    action_category: "implementation",
    specialist_agent: "seed",
    critic_agent: null,
    node_state_before: "expanding",
    node_state_after: "claimed",
    provenance: { tag: "claimed", claimant: "seed" },
    specialist_output: null,
    critic_verdict_approved: null,
    critic_root_cause: null,
    score_before: 0,
    score_after: 1,
    gates: [],
    kb_entries_written: [],
    ...overrides,
  };
}

describe("audit hardening regressions", () => {
  it("rejects a trace whose structured fields have the wrong runtime type", () => {
    const ledger = new EvidenceLedger();
    expect(() => ledger.record(trace({ critic_agent: 42 }))).toThrow(/schema/i);
  });

  it("rejects traversal campaign IDs before accepting a trace", () => {
    const ledger = new EvidenceLedger();
    expect(() => ledger.record(trace({ campaign_id: "../outside" }))).toThrow(/campaign_id/i);
  });
});
