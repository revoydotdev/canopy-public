import { describe, it, expect } from "vitest";
import { treeScreen, evidencedNodeState } from "../src/screens/tree.js";
import { consoleScreen } from "../src/screens/console.js";
import { approvalsScreen } from "../src/screens/approvals.js";
import { displayWidth } from "../src/widgets.js";

// P4-6 narrow-terminal defects and remediation A05 (lifecycle label vs provenance).
// Frame evidence: pilot runs of the populated campaign at 80x24, 100x30 and 60x20.

const verifiedProv = { tag: "verified", cmd: "bun test", exit: 0, stdout_hash: "abc", strength: "command_executed" };
const criticProv = { tag: "critic_approved", critic: "lenticel", rationale: "looks right" };
const claimedProv = { tag: "claimed", claimant: "seed" };

function treeLines(nodes: readonly Record<string, unknown>[], width: number, height: number, selected?: string, unicode = true): readonly string[] {
  const projection = treeScreen.project({ campaign_id: "c", nodes }, { width, height });
  return treeScreen.render({ projection, width, height, selected_id: selected, unicode });
}

describe("A05: a node's lifecycle label corresponds to its provenance", () => {
  it("never shows verified for a node whose provenance is claimed, critic_approved or generated", () => {
    for (const provenance of [claimedProv, criticProv, { tag: "generated", generator: "g", input_hash: "h" }]) {
      expect(evidencedNodeState({ provenance, provenance_tag: provenance.tag }, "verified")).toBe("claimed");
    }
    expect(evidencedNodeState({ provenance: verifiedProv, provenance_tag: "verified" }, "verified")).toBe("verified");
    // Older projections that carry no provenance field at all are not guessed at.
    expect(evidencedNodeState({}, "verified")).toBe("verified");
    // A snapshot that reports verified with explicitly no provenance is unevidenced...
    expect(evidencedNodeState({ provenance_tag: null }, "verified")).toBe("claimed");
    // ...but an event-sourced advance past a stale snapshot is not.
    expect(evidencedNodeState({ provenance_tag: null }, "verified", true)).toBe("verified");
    expect(evidencedNodeState({ provenance_tag: "claimed" }, "failed")).toBe("failed");
  });

  it("renders a contradictory wire node as claimed, with the verified glyph reserved for machine verification", () => {
    const lines = treeLines([
      { id: "ok", state: "verified", action_description: "machine verified", provenance_tag: "verified", provenance: verifiedProv },
      { id: "liar", state: "verified", action_description: "asserted only", provenance_tag: "claimed", provenance: claimedProv },
    ], 120, 12);
    const ok = lines.find((line) => line.includes("machine verified"))!;
    const liar = lines.find((line) => line.includes("asserted only"))!;
    expect(ok).toContain("✓v");
    expect(liar).not.toContain("✓v");
    expect(liar).toContain("§c");
    expect(lines.join("\n")).toContain("1/2 verified");
  });

  it("distinguishes critic approval from a bare claim and from machine verification", () => {
    const lines = treeLines([
      { id: "a", state: "claimed", action_description: "bare claim", provenance_tag: "claimed", provenance: claimedProv },
      { id: "b", state: "claimed", action_description: "critic approved", provenance_tag: "critic_approved", provenance: criticProv },
      { id: "c", state: "verified", action_description: "command verified", provenance_tag: "verified", provenance: verifiedProv },
    ], 120, 12);
    expect(lines.find((line) => line.includes("bare claim"))).toContain("§c");
    expect(lines.find((line) => line.includes("critic approved"))).toContain("§k");
    expect(lines.find((line) => line.includes("command verified"))).toContain("✓v");
    const ascii = treeLines([{ id: "b", state: "claimed", action_description: "critic approved", provenance_tag: "critic_approved", provenance: criticProv }], 120, 8, undefined, false);
    expect(ascii.find((line) => line.includes("critic approved"))).toMatch(/\S?k critic approved/);
  });

  it("states in the inspector that critic approval and an outputs-only check are not command verification", () => {
    const critic = treeLines([{ id: "b", state: "claimed", action_description: "x", provenance_tag: "critic_approved", provenance: criticProv }], 120, 20, "b").join("\n");
    expect(critic).toContain("not machine verified");
    const outputs = treeLines([{ id: "v", state: "verified", action_description: "x", provenance_tag: "verified", provenance: { ...verifiedProv, strength: "outputs_check" } }], 120, 20, "v").join("\n");
    expect(outputs).toContain("outputs checked only");
  });

  it("keeps the header graph from showing a contradictory node as verified", () => {
    const shape = {
      captured_at: "2026-09-05T12:00:00Z", focused_campaign_id: "camp-01",
      campaigns: { items: [{ id: "camp-01", plan_path: "draft-01.json", active_node_state: "claimed", verified_nodes: 0, total_nodes: 2, halted: false }] },
      tree: { campaign_id: "camp-01", nodes: [
        { id: "root", state: "claimed", parent_id: null, provenance_tag: "claimed", provenance: claimedProv },
        { id: "n1", state: "verified", parent_id: "root", provenance_tag: "critic_approved", provenance: criticProv },
      ] },
    };
    const projection = consoleScreen.project(shape, { width: 100, height: 30 });
    const uct = (projection.rows as readonly Record<string, unknown>[]).find((row) => row.region === "uct") as { nodes: readonly { id: string; state: string }[] };
    expect(uct.nodes.find((node) => node.id === "n1")!.state).toBe("claimed");
  });
});

describe("P4-6: narrow-terminal gaps found in the populated-campaign pilot", () => {
  const populated = [
    { id: "root", state: "claimed", parent_id: null, action_description: "seeded root objective", provenance_tag: "claimed", provenance: claimedProv },
    { id: "bad", state: "failed", parent_id: "root", action_description: "seeded review", specialist_output: "FAILED: missing evidence",
      gate_records: [{ gate: "isolation", result: "pass", checked_at: "2026-10-07T01:41:21.919Z", detail: "all checks passed" }] },
  ];

  it("keeps the state key in the narrow legend instead of only the selection marker", () => {
    for (const width of [60, 80, 100]) {
      const lines = treeLines(populated, width, 20, "bad");
      const legend = lines[1]!;
      expect(legend).toContain("✓v verified");
      expect(legend).toContain("!f failed");
      expect(displayWidth(legend)).toBeLessThanOrEqual(width);
    }
  });

  it("shows a failed node's outcome before its gate trail at 80x24", () => {
    const lines = treeLines(populated, 78, 16, "bad").join("\n");
    expect(lines).toContain("Outcome: ");
    expect(lines).toContain("missing evidence");
  });

  it("does not let a failed node hide the approvals and interviews only the operator can clear", () => {
    const shape = {
      captured_at: "2026-09-05T12:00:00Z", focused_campaign_id: "camp-01",
      campaigns: { items: [{ id: "camp-01", plan_path: "draft-01.json", active_node_state: "failed", verified_nodes: 0, total_nodes: 2, halted: true, halt_reason: "no_nodes" }] },
      tree: { campaign_id: "camp-01", halted: true, halt_reason: "no_nodes", nodes: populated },
      approvals: { records: [{ id: "a1", status: "pending" }] },
      operator_interviews: { records: [{ id: "q1", question: "Proceed?" }] },
    };
    const projection = consoleScreen.project(shape, { width: 80, height: 24 });
    const text = consoleScreen.render({ projection, width: 80, height: 24, color: false }).join("\n").replace(/\s+/g, " ");
    expect(text).toContain("BLOCKED · missing evidence");
    expect(text).toContain("1 interview [i]");
    expect(text).toContain("1 approval [0]");
  });

  it("renders approvals as wrapped cards when the columns cannot fit, never as an all-ellipsis table", () => {
    const row = { request_id: "seeded-approval", action: "output.raw", subject: "seeded disclosure review", status: "pending", proposer: "seed-operator", resource_id: "seed-campaign", decided_by: null, expires_at: "2099-01-01T00:00:00.000Z" };
    const projection = approvalsScreen.project({ records: [row] }, { width: 60, height: 20 });
    const lines = approvalsScreen.render({ projection, width: 60, height: 20 });
    const text = lines.join("\n");
    expect(text).toContain("seeded-approval");
    expect(text).toContain("seed-operator");
    expect(text).toContain("seed-campaign");
    expect(lines.every((line) => displayWidth(line) <= 60)).toBe(true);
    expect(text).not.toContain("…");
  });

  it("keeps the approvals table when it fits", () => {
    const row = { request_id: "ap-1", action: "campaign.halt", subject: "halt", status: "pending", proposer: "alice", decided_by: null, expires_at: "2099-01-01T00:00:00.000Z" };
    const projection = approvalsScreen.project({ records: [row] }, { width: 200, height: 10 });
    const lines = approvalsScreen.render({ projection, width: 200, height: 10 });
    expect(lines[1]).toContain("Request");
    expect(lines[1]).toContain("Expires");
  });
});
