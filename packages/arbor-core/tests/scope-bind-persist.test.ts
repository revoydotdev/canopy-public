/**
 * ADR-119 (scope binds at first use, not predicted at plan time):
 * `persist.ts`'s snapshot round-trip for the widened `ActionHighRiskToolScope
 * .command_argv` union (a literal argv array OR an intent entry) and for
 * `TreeNode.bound_scope_intents` -- the O3 durable record a bind produces.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCampaign, saveCampaign, loadCampaignResult } from "../src/index.js";

let tempDir: string;

beforeEach(() => { tempDir = mkdtempSync(join(tmpdir(), "arbor-adr119-")); });
afterEach(() => { rmSync(tempDir, { recursive: true, force: true }); });

describe("ADR-119: persist.ts round-trips intent-entry declarations and bound_scope_intents", () => {
  it("round-trips a command_argv list mixing a literal argv and an ADR-119 intent entry", () => {
    const campaign = createCampaign("adr119-intent-roundtrip", "plan.md", {
      description: "scaffold and verify", estimated_gain: 1, estimated_cost: 1, category: "root", delegate_to: "seed",
      high_risk_tool_scope: {
        write_paths: [],
        command_argv: [["npm", "test"], { argv_prefix: ["npm", "create"], purpose: "scaffold a project whose exact name is only known at runtime" }],
      },
    });
    saveCampaign(campaign, tempDir);
    const loaded = loadCampaignResult("adr119-intent-roundtrip", tempDir).value;
    expect(loaded).not.toBeNull();
    expect(loaded!.tree.get(loaded!.root_id)!.action.high_risk_tool_scope).toEqual({
      write_paths: [],
      command_argv: [["npm", "test"], { argv_prefix: ["npm", "create"], purpose: "scaffold a project whose exact name is only known at runtime" }],
    });
  });

  it("quarantines an intent entry missing purpose (structurally invalid, not silently accepted)", () => {
    const campaign = createCampaign("adr119-bad-intent", "plan.md", {
      description: "root", estimated_gain: 1, estimated_cost: 1, category: "root", delegate_to: "seed",
      high_risk_tool_scope: { write_paths: [], command_argv: [["npm", "test"]] },
    });
    saveCampaign(campaign, tempDir);
    const path = join(tempDir, "tree", "adr119-bad-intent.json");
    const snapshot = JSON.parse(readFileSync(path, "utf-8"));
    snapshot.nodes[0].action.high_risk_tool_scope.command_argv = [{ argv_prefix: ["npm", "create"] }];
    writeFileSync(path, JSON.stringify(snapshot));
    expect(loadCampaignResult("adr119-bad-intent", tempDir).value).toBeNull();
  });

  it("round-trips a durable bound_scope_intents record on a node", () => {
    const campaign = createCampaign("adr119-bound-roundtrip", "plan.md", {
      description: "root", estimated_gain: 1, estimated_cost: 1, category: "root", delegate_to: "seed",
    });
    const root = campaign.tree.get(campaign.root_id)!;
    root.bound_scope_intents = [{
      intent_index: 0, argv_prefix: ["npm", "create"], purpose: "scaffold a project whose exact name is only known at runtime",
      bound_argv: ["npm", "create", "astro@latest", "generated-site"], bound_at: "2026-08-26T00:00:00.000Z", session_id: "s1",
    }];
    saveCampaign(campaign, tempDir);
    const loaded = loadCampaignResult("adr119-bound-roundtrip", tempDir).value!;
    expect(loaded.tree.get(loaded.root_id)!.bound_scope_intents).toEqual([{
      intent_index: 0, argv_prefix: ["npm", "create"], purpose: "scaffold a project whose exact name is only known at runtime",
      bound_argv: ["npm", "create", "astro@latest", "generated-site"], bound_at: "2026-08-26T00:00:00.000Z", session_id: "s1",
    }]);
  });

  it("quarantines a snapshot with a duplicate intent_index in bound_scope_intents", () => {
    const campaign = createCampaign("adr119-dup-bind", "plan.md", {
      description: "root", estimated_gain: 1, estimated_cost: 1, category: "root", delegate_to: "seed",
    });
    saveCampaign(campaign, tempDir);
    const path = join(tempDir, "tree", "adr119-dup-bind.json");
    const snapshot = JSON.parse(readFileSync(path, "utf-8"));
    const record = { intent_index: 0, argv_prefix: ["npm", "create"], purpose: "x", bound_argv: ["npm", "create", "a"], bound_at: "2026-08-26T00:00:00.000Z", session_id: "s1" };
    snapshot.nodes[0].bound_scope_intents = [record, record];
    writeFileSync(path, JSON.stringify(snapshot));
    expect(loadCampaignResult("adr119-dup-bind", tempDir).value).toBeNull();
  });

  // A bound intent is promoted back into LITERAL command authority by
  // `bindNativeHighRiskScope`, so this load-path validator must bound tokens
  // exactly as tightly as the declaration validator that admitted them.
  // Looser here would let a tampered snapshot widen authority past anything a
  // declaration could ever have carried.
  it.each([
    ["an over-long argv_prefix token", { argv_prefix: ["npm", "x".repeat(4_097)], bound_argv: ["npm", "create", "a"] }],
    ["an over-long bound_argv token", { argv_prefix: ["npm", "create"], bound_argv: ["npm", "create", "x".repeat(4_097)] }],
    ["a NUL-bearing argv_prefix token", { argv_prefix: ["npm", `cre${String.fromCharCode(0)}ate`], bound_argv: ["npm", "create", "a"] }],
    ["a NUL-bearing bound_argv token", { argv_prefix: ["npm", "create"], bound_argv: ["npm", "create", `a${String.fromCharCode(0)}b`] }],
    ["an over-long purpose", { argv_prefix: ["npm", "create"], bound_argv: ["npm", "create", "a"], purpose: "p".repeat(4_097) }],
  ])("quarantines a bound_scope_intents record carrying %s", (_label, overrides) => {
    const name = `adr119-bound-bounds-${_label.replace(/[^a-z]+/gi, "-").toLowerCase()}`;
    const campaign = createCampaign(name, "plan.md", {
      description: "root", estimated_gain: 1, estimated_cost: 1, category: "root", delegate_to: "seed",
    });
    saveCampaign(campaign, tempDir);
    const path = join(tempDir, "tree", `${name}.json`);
    const snapshot = JSON.parse(readFileSync(path, "utf-8"));
    snapshot.nodes[0].bound_scope_intents = [{
      intent_index: 0, purpose: "x", bound_at: "2026-08-26T00:00:00.000Z", session_id: "s1", ...overrides,
    }];
    writeFileSync(path, JSON.stringify(snapshot));
    expect(loadCampaignResult(name, tempDir).value).toBeNull();
  });
});
