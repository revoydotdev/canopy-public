import { describe, expect, it } from "vitest";
import { deriveForeground, deriveNodeCard, type ForegroundInputs, FOREGROUND_MAX_DELEGATION_ENTRIES, FOREGROUND_MAX_MODEL_FAMILY_BYTES, type Action, type ScoreContext } from "@arbor/core";
import { CampaignManager } from "../src/manager.js";

const SECRET = "test-secret-32-bytes-ok-ok-ok";

const rootAction: Action = {
  description: "execute plan",
  estimated_gain: 100,
  estimated_cost: 1,
  category: "root",
  delegate_to: "crown",
};

const ctx: ScoreContext = {
  accuracy_regression_rate: 0,
  crash_regression_rate: 0,
  best_known: 100,
  total_visits: 5,
};

const baseInputs: ForegroundInputs = {
  node_id: "lead-1",
  role: "orchestrator",
  tier: "orchestrator",
  model_family: "claude-opus-4",
  skills: ["planning", "review"],
  delegation_catalog: [
    { skill: "code-edit", target_node_id: "seed-1", target_tier: "specialist" },
    { skill: "security-audit", target_node_id: "lent-1", target_tier: "critic" },
  ],
  source: "builtin",
};

describe("deriveForeground", () => {
  it("produces a signed card + delegation table + bounded prompt_fragment", () => {
    const fg = deriveForeground(baseInputs, SECRET);
    expect(fg.card.node_id).toBe("lead-1");
    expect(fg.card.signature).toHaveLength(64); // HMAC-SHA256 hex
    expect(fg.delegation_table.length).toBe(2);
    expect(fg.delegation_table[0]!.skill).toBe("code-edit"); // sorted
    expect(fg.prompt_fragment).toContain("lead-1");
    expect(fg.prompt_fragment).toContain("claude-opus-4");
  });

  it("is deterministic: same inputs → byte-identical prompt_fragment", () => {
    const a = deriveForeground(baseInputs, SECRET);
    const b = deriveForeground(baseInputs, SECRET);
    expect(a.prompt_fragment).toBe(b.prompt_fragment);
    expect(a.card.signature).toBe(b.card.signature);
  });

  it("applies operator_overrides (modes/inputs/outputs)", () => {
    const fg = deriveForeground(
      { ...baseInputs, operator_overrides: { modes: new Set(["promote"]), inputs: ["spec.md"], outputs: ["review.md"] } },
      SECRET,
    );
    expect([...fg.card.modes]).toEqual(["promote"]);
    expect(fg.card.inputs).toEqual(["spec.md"]);
    expect(fg.card.outputs).toEqual(["review.md"]);
  });

  it("rejects delegation_catalog exceeding max entries", () => {
    const tooMany = Array.from({ length: FOREGROUND_MAX_DELEGATION_ENTRIES + 1 }, (_, i) => ({
      skill: `s-${i}`, target_node_id: `n-${i}`, target_tier: "specialist" as const,
    }));
    expect(() => deriveForeground({ ...baseInputs, delegation_catalog: tooMany }, SECRET)).toThrow(/delegation_catalog/);
  });

  it("rejects model_family exceeding max bytes", () => {
    const longFamily = "x".repeat(FOREGROUND_MAX_MODEL_FAMILY_BYTES + 1);
    expect(() => deriveForeground({ ...baseInputs, model_family: longFamily }, SECRET)).toThrow(/model_family/);
  });

  it("rejects duplicate delegation skills", () => {
    const dups = [
      { skill: "same", target_node_id: "n1", target_tier: "specialist" as const },
      { skill: "same", target_node_id: "n2", target_tier: "specialist" as const },
    ];
    expect(() => deriveForeground({ ...baseInputs, delegation_catalog: dups }, SECRET)).toThrow(/unique/);
  });

  it("rejects empty delegation skill/target", () => {
    expect(() =>
      deriveForeground({ ...baseInputs, delegation_catalog: [{ skill: "", target_node_id: "n1", target_tier: "specialist" }] }, SECRET),
    ).toThrow(/non-empty/);
  });

  it("rejects invalid target_tier", () => {
    expect(() =>
      deriveForeground({ ...baseInputs, delegation_catalog: [{ skill: "x", target_node_id: "n1", target_tier: "invalid" as never }] }, SECRET),
    ).toThrow();
  });
});

describe("CampaignManager.selectNodeWithCard", () => {
  it("returns UCT-selected node and null card when no cards provided", () => {
    const mgr = new CampaignManager();
    mgr.startCampaign("c1", "/plan", rootAction);
    mgr.branch("c1", "root", [rootAction]);
    const result = mgr.selectNodeWithCard("c1", ctx);
    expect(result.node_id).not.toBeNull();
    expect(result.card).toBeNull();
  });

  it("returns the card when UCT node matches the capability-selected card", () => {
    const mgr = new CampaignManager();
    mgr.startCampaign("c1", "/plan", rootAction);
    const childIds = mgr.branch("c1", "root", [rootAction]);
    const nodeId = mgr.selectNode("c1", ctx)!;
    expect(childIds).toContain(nodeId);
    const card = deriveNodeCard({
      node_id: nodeId, role: "specialist", skills: ["test"], tier: "specialist",
      modes: ["steerable"], inputs: [], outputs: [], source: "builtin",
    }, SECRET);
    const result = mgr.selectNodeWithCard("c1", ctx, {
      taskSkills: ["test"], requestedTier: "specialist", cards: [card],
    });
    expect(result.node_id).toBe(nodeId);
    expect(result.card?.node_id).toBe(nodeId);
  });

  it("returns UCT node and null card on mismatch (UCT wins)", () => {
    const mgr = new CampaignManager();
    mgr.startCampaign("c1", "/plan", rootAction);
    mgr.branch("c1", "root", [rootAction]);
    const wrongCard = deriveNodeCard({
      node_id: "nonexistent-node", role: "specialist", skills: ["test"], tier: "specialist",
      modes: ["steerable"], inputs: [], outputs: [], source: "builtin",
    }, SECRET);
    const result = mgr.selectNodeWithCard("c1", ctx, {
      taskSkills: ["test"], requestedTier: "specialist", cards: [wrongCard],
    });
    expect(result.card).toBeNull();
    expect(result.node_id).not.toBe("nonexistent-node");
  });
});
