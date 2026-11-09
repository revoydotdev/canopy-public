import { describe, it, expect } from "vitest";
import { saveCampaign, loadCampaignResult, createChild, createCampaign } from "../src/index.js";
import type { Action, DecomposerPort, DecompositionRequest, DecompositionResult } from "../src/index.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * `Action.decomposition_depth` and `DecomposerPort` (types.ts) back the G-08
 * "decompose" recovery wired in arbor-opencode's loop.ts. This file covers
 * the two things that live at the arbor-core layer: the field survives a
 * real disk round-trip (it is the sole durable record of decomposition
 * depth — arbor-opencode's decompose-policy.ts trusts nothing else), and the
 * port's contract shape is satisfiable by a real async implementation.
 */

const baseAction: Action = {
  description: "an ordinary action",
  estimated_gain: 10,
  estimated_cost: 5,
  category: "c",
  delegate_to: "seed",
};

describe("Action.decomposition_depth — durable tree ancestry", () => {
  it("is absent (undefined) on an ordinarily-authored action", () => {
    expect(baseAction.decomposition_depth).toBeUndefined();
  });

  it("survives a real save/load round-trip through persist.ts, unlike a value that would need special-casing", () => {
    const dir = mkdtempSync(join(tmpdir(), "arbor-decompose-depth-"));
    try {
      const state = createCampaign("camp1", "plan.md", baseAction);
      const childId = createChild(state.tree, state.root_id, { ...baseAction, description: "decomposed child", decomposition_depth: 2 });

      saveCampaign(state, dir);
      const loaded = loadCampaignResult("camp1", dir).value;

      expect(loaded).not.toBeNull();
      const child = loaded!.tree.get(childId);
      expect(child?.action.decomposition_depth).toBe(2);
      // The root's action never had the field set — it must not appear as 0
      // or any other fabricated default after a round-trip.
      const root = loaded!.tree.get(state.root_id);
      expect(root?.action.decomposition_depth).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("DecomposerPort — contract shape", () => {
  it("is satisfiable by a real async implementation and round-trips a rejection", async () => {
    const port: DecomposerPort = {
      async decompose(request: DecompositionRequest): Promise<DecompositionResult> {
        if (request.depth >= 3) return { ok: false, reason: "depth bound reached" };
        return {
          ok: true,
          children: [
            { ...request.action, description: `${request.action.description} — part 1` },
            { ...request.action, description: `${request.action.description} — part 2` },
          ],
        };
      },
    };

    const accepted = await port.decompose({ campaign_id: "camp1", node_id: "n1", action: baseAction, reason: "timeout", depth: 0 });
    expect(accepted.ok).toBe(true);
    if (accepted.ok) expect(accepted.children).toHaveLength(2);

    const rejected = await port.decompose({ campaign_id: "camp1", node_id: "n2", action: baseAction, reason: "timeout", depth: 3 });
    expect(rejected.ok).toBe(false);
  });
});
