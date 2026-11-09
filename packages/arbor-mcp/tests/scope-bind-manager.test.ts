/**
 * ADR-119 (scope binds at first use, not predicted at plan time):
 * `CampaignManager.deriveNativeHighRiskToolScope`/`bindNativeHighRiskScope`
 * splitting a declared `command_argv` into literal entries and still-unbound
 * intents, the durable O3 bind record (`recordScopeIntentBind`/
 * `getBoundScopeIntents`), its persistence roundtrip, and the `governed`
 * tier boundary (Decision §3).
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Action, ArbiterDecision } from "@arbor/core";
import { CampaignManager } from "../src/manager.js";

function decision(tier: ArbiterDecision["tier"]): ArbiterDecision {
  return { tier, rationale: "test", blast_radius: { reversibility: "reversible" }, source: "arbiter", decided_at: "2026-08-26T00:00:00.000Z" };
}

function intentAction(description: string): Action {
  return {
    description, estimated_gain: 1, estimated_cost: 1, category: "verify", delegate_to: "seed",
    high_risk_tool_scope: { write_paths: [], command_argv: [{ argv_prefix: ["npm", "create"], purpose: "scaffold a project whose exact name is only known at runtime" }] },
  };
}

describe("ADR-119: CampaignManager derives, binds, and durably journals scope intents", () => {
  it("a direct/reviewed-tier declaration surfaces an unbound intent in command_intents, with a real bind_intent closure", () => {
    const manager = new CampaignManager();
    const action = intentAction("run npm create");
    const admitted = manager.admitCampaignPlan({
      id: "adr119-direct", plan_path: "plan.md", root_action: action,
      actions: [{ ...action, description: "noop placeholder" }],
      governance: decision("direct"),
    });
    expect(admitted.ok).toBe(true);
    if (!admitted.ok) return;
    const scope = manager.deriveNativeHighRiskToolScope({ campaign_id: "adr119-direct", node_id: admitted.root_id, session_id: "s1", worktree_path: "/wt" });
    expect(scope?.command_argv).toEqual([]);
    expect(scope?.command_intents).toEqual([{ bind_id: 0, intent: { argv_prefix: ["npm", "create"], purpose: "scaffold a project whose exact name is only known at runtime" } }]);
    expect(typeof scope?.bind_intent).toBe("function");
    expect(manager.getBoundScopeIntents("adr119-direct", admitted.root_id)).toEqual([]);
  });

  it("bind_intent durably records the bind (O3) and is monotonic: a second bind of the same intent_index is refused", () => {
    const manager = new CampaignManager();
    const action = intentAction("run npm create");
    const admitted = manager.admitCampaignPlan({
      id: "adr119-bind", plan_path: "plan.md", root_action: action,
      actions: [{ ...action, description: "noop placeholder" }],
      governance: decision("reviewed"),
    });
    if (!admitted.ok) throw new Error("admission failed");
    const scope = manager.deriveNativeHighRiskToolScope({ campaign_id: "adr119-bind", node_id: admitted.root_id, session_id: "s1", worktree_path: "/wt" })!;
    const argv = ["npm", "create", "astro@latest", "generated-site-42"];
    const first = scope.bind_intent!({ bind_id: 0, argv });
    expect(first).toBe(true);
    const record = manager.getBoundScopeIntents("adr119-bind", admitted.root_id);
    expect(record).toEqual([{
      intent_index: 0, argv_prefix: ["npm", "create"], purpose: "scaffold a project whose exact name is only known at runtime",
      bound_argv: argv, bound_at: expect.any(String), session_id: "s1",
    }]);
    // Monotonic / single-shot: rebinding the same slot (even with the same
    // observed argv) is refused -- the durable record is append-only.
    expect(scope.bind_intent!({ bind_id: 0, argv })).toBe(false);
    expect(manager.getBoundScopeIntents("adr119-bind", admitted.root_id)).toHaveLength(1);
  });

  it("a fresh derivation (a new session) promotes an already-bound intent to a literal command_argv entry and drops it from command_intents", () => {
    const manager = new CampaignManager();
    const action = intentAction("run npm create");
    const admitted = manager.admitCampaignPlan({
      id: "adr119-promote", plan_path: "plan.md", root_action: action,
      actions: [{ ...action, description: "noop placeholder" }],
      governance: decision("reviewed"),
    });
    if (!admitted.ok) throw new Error("admission failed");
    const first = manager.deriveNativeHighRiskToolScope({ campaign_id: "adr119-promote", node_id: admitted.root_id, session_id: "s1", worktree_path: "/wt" })!;
    const argv = ["npm", "create", "astro@latest", "generated-site-9"];
    expect(first.bind_intent!({ bind_id: 0, argv })).toBe(true);
    // A brand new session (e.g. a resumed/continued specialist) re-derives
    // the scope: the bound intent is now a literal, byte-exact entry, and
    // no longer an open intent slot.
    const second = manager.deriveNativeHighRiskToolScope({ campaign_id: "adr119-promote", node_id: admitted.root_id, session_id: "s2", worktree_path: "/wt" })!;
    expect(second.command_argv).toEqual([argv]);
    expect(second.command_intents ?? []).toEqual([]);
  });

  it("governed tier: a declaration carrying an intent entry is refused whole (fail-closed), never silently stripped to its literal entries (Decision §3)", () => {
    const manager = new CampaignManager();
    const action = intentAction("run npm create");
    const admitted = manager.admitCampaignPlan({
      id: "adr119-governed", plan_path: "plan.md", root_action: action,
      actions: [{ ...action, description: "noop placeholder" }],
      governance: decision("governed"),
    });
    if (!admitted.ok) throw new Error("admission failed");
    const scope = manager.deriveNativeHighRiskToolScope({ campaign_id: "adr119-governed", node_id: admitted.root_id, session_id: "s1", worktree_path: "/wt" });
    expect(scope).toBeNull();
  });

  it("O3 durability: a bind survives a process restart via the real persistence path (saveCampaign/reload)", () => {
    const dir = mkdtempSync(join(tmpdir(), "adr119-persist-"));
    try {
      const manager = new CampaignManager({ persistence_dir: dir });
      const action = intentAction("run npm create");
      const admitted = manager.admitCampaignPlan({
        id: "adr119-persist", plan_path: "plan.md", root_action: action,
        actions: [{ ...action, description: "noop placeholder" }],
        governance: decision("direct"),
      });
      if (!admitted.ok) throw new Error("admission failed");
      const scope = manager.deriveNativeHighRiskToolScope({ campaign_id: "adr119-persist", node_id: admitted.root_id, session_id: "s1", worktree_path: "/wt" })!;
      const argv = ["npm", "create", "astro@latest", "generated-site-restart"];
      expect(scope.bind_intent!({ bind_id: 0, argv })).toBe(true);

      // A brand new manager instance, pointed at the same persistence_dir,
      // reconstructs its campaigns from disk exactly like a real process
      // restart -- proving the bind is a real durable, replayable record,
      // not something living only in this process's memory.
      const restarted = new CampaignManager({ persistence_dir: dir });
      expect(restarted.getBoundScopeIntents("adr119-persist", admitted.root_id)).toEqual([{
        intent_index: 0, argv_prefix: ["npm", "create"], purpose: "scaffold a project whose exact name is only known at runtime",
        bound_argv: argv, bound_at: expect.any(String), session_id: "s1",
      }]);
      // And re-deriving on the restarted manager promotes it to literal,
      // exactly as within the same process.
      const rederived = restarted.deriveNativeHighRiskToolScope({ campaign_id: "adr119-persist", node_id: admitted.root_id, session_id: "s3", worktree_path: "/wt" })!;
      expect(rederived.command_argv).toEqual([argv]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
