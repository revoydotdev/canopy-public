import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildAgentConfig,
  buildAllAgents,
  CAPABILITY_TIER,
  ARBOR_CATEGORIES,
  routeCategory,
  deriveCandidateNodeCard,
  DEFAULT_NODE_CARD_SECRET,
  deriveAgentForeground,
  deriveDispatchForeground,
  DEFAULT_AGENT_FOREGROUND_SECRET,
  permissionsFor,
  buildArborConfigBlock,
  arborPlugin,
  resolveCategoryModel,
} from "../src/index.js";
import { AGENT_PROMPTS } from "@arbor/prompts";
import type { ArborAgentName, ArborCategoryName } from "../src/index.js";
import * as coreTaxonomy from "@arbor/core";

// The `ARBOR_AGENT_NAMES`/`ARBOR_CATEGORY_NAMES` arrays were deleted 2026-08-06
// as unreached runtime values. The records they used to duplicate are the real
// enumeration, and deriving from them makes each assertion below a genuine
// cross-check between two structures instead of a restatement of one list.
const ARBOR_AGENT_NAMES = Object.keys(CAPABILITY_TIER) as ArborAgentName[];
const ARBOR_CATEGORY_NAMES = Object.keys(ARBOR_CATEGORIES) as ArborCategoryName[];
import { CampaignManager } from "@arbor/mcp";
import type { Action, ScoreContext } from "@arbor/core";

describe("agent taxonomy re-export identity (G-33 shape guard)", () => {
  // The taxonomy moved from `arbor-opencode/src/categories.ts` (plus
  // ArborAgentName/ArborCategoryName from types.ts and CAPABILITY_TIER from
  // agents.ts) into `@arbor/core`'s `agent-taxonomy.ts`, with `@arbor/opencode`
  // re-exporting the same symbols for backward compatibility. A "move" that
  // actually left a copy behind in arbor-opencode would still pass every
  // other test in this file — both tables would agree by construction, right
  // up until someone edited one and not the other (this repo's G-33: a
  // hand-typed model_hint map that happened to agree with MODEL_DEFAULTS by
  // coincidence). `toBe` on the values imported through each package's public
  // entry point proves there is exactly one runtime object/function behind
  // both names, not two that happen to be structurally equal today.
  it("ARBOR_CATEGORIES is the identical object via @arbor/opencode and @arbor/core", () => {
    expect(ARBOR_CATEGORIES).toBe(coreTaxonomy.ARBOR_CATEGORIES);
  });

  it("routeCategory is the identical function via both packages", () => {
    expect(routeCategory).toBe(coreTaxonomy.routeCategory);
  });

  it("deriveCandidateNodeCard is the identical function via both packages", () => {
    expect(deriveCandidateNodeCard).toBe(coreTaxonomy.deriveCandidateNodeCard);
  });

  it("resolveCategoryModel is the identical function via both packages", () => {
    expect(resolveCategoryModel).toBe(coreTaxonomy.resolveCategoryModel);
  });

  it("CAPABILITY_TIER is the identical object via both packages", () => {
    expect(CAPABILITY_TIER).toBe(coreTaxonomy.CAPABILITY_TIER);
  });

  it("the five category constants (CROWN_STRUCTURAL, HEARTWOOD_DEEP, SEED_QUICK, LEAF_VISUAL, SAP_WRITE) are identical via both packages", () => {
    expect(ARBOR_CATEGORIES["crown-structural"]).toBe(coreTaxonomy.CROWN_STRUCTURAL);
    expect(ARBOR_CATEGORIES["heartwood-deep"]).toBe(coreTaxonomy.HEARTWOOD_DEEP);
    expect(ARBOR_CATEGORIES["seed-quick"]).toBe(coreTaxonomy.SEED_QUICK);
    expect(ARBOR_CATEGORIES["leaf-visual"]).toBe(coreTaxonomy.LEAF_VISUAL);
    expect(ARBOR_CATEGORIES["sap-write"]).toBe(coreTaxonomy.SAP_WRITE);
  });
});

describe("agent bindings", () => {
  it("every botanical agent has a prompt in @arbor/prompts", () => {
    for (const name of ARBOR_AGENT_NAMES) {
      expect(AGENT_PROMPTS[name], `agent ${name} must have a prompt`).toBeDefined();
    }
  });

  it("buildAgentConfig returns a valid config for every agent", () => {
    for (const name of ARBOR_AGENT_NAMES) {
      const config = buildAgentConfig(name);
      expect(config.name).toBe(name);
      expect(config.description.length).toBeGreaterThan(10);
      expect(config.system.length).toBeGreaterThan(50);
      expect(config.mode === "primary" || config.mode === "subagent").toBe(true);
      expect(config.model).toMatch(/\//); // provider/model format
      expect(config.steps).toBeGreaterThan(0);
      expect(config.disabled).toBe(false);
      expect(config.permission).toBeDefined();
    }
  });

  it("exactly 3 primary agents (orchestrators) and 8 subagents", () => {
    const all = buildAllAgents();
    const primaries = Object.values(all).filter((a) => a.mode === "primary");
    const subagents = Object.values(all).filter((a) => a.mode === "subagent");
    expect(primaries).toHaveLength(3);
    expect(subagents).toHaveLength(8);
  });

  it("buildAllAgents returns all 11 agents keyed by name", () => {
    const all = buildAllAgents();
    expect(Object.keys(all).sort()).toEqual([...ARBOR_AGENT_NAMES].sort());
  });
});

describe("capability tiers (ADR-005)", () => {
  it("every agent maps to a capability tier", () => {
    for (const name of ARBOR_AGENT_NAMES) {
      expect(CAPABILITY_TIER[name], `${name} needs a capability tier`).toBeDefined();
    }
  });

  it("orchestrators are crown, cambium, taproot", () => {
    expect(CAPABILITY_TIER.crown).toBe("orchestrator");
    expect(CAPABILITY_TIER.cambium).toBe("orchestrator");
    expect(CAPABILITY_TIER.taproot).toBe("orchestrator");
  });

  it("critics are lenticel, burl, xylem", () => {
    expect(CAPABILITY_TIER.lenticel).toBe("critic");
    expect(CAPABILITY_TIER.burl).toBe("critic");
    expect(CAPABILITY_TIER.xylem).toBe("critic");
  });

  it("specialists are heartwood, seed, rhizome, mycelium, stoma", () => {
    expect(CAPABILITY_TIER.heartwood).toBe("specialist");
    expect(CAPABILITY_TIER.seed).toBe("specialist");
    expect(CAPABILITY_TIER.rhizome).toBe("specialist");
    expect(CAPABILITY_TIER.mycelium).toBe("specialist");
    expect(CAPABILITY_TIER.stoma).toBe("specialist");
  });
});

describe("permission rulesets (ADR-001 checks-and-balances)", () => {
  it("critics cannot edit (no agent both proposes and approves)", () => {
    for (const name of ["lenticel", "burl", "xylem"] as ArborAgentName[]) {
      const perm = permissionsFor(name, { canDelegate: false });
      expect(perm.edit, `${name} must be denied edit`).toBe("deny");
      expect(perm.write, `${name} must be denied write`).toBe("deny");
    }
  });

  it("critics cannot delegate (separation of concerns)", () => {
    for (const name of ["lenticel", "burl", "xylem"] as ArborAgentName[]) {
      const perm = permissionsFor(name, { canDelegate: false });
      expect(perm.task, `${name} must be denied task`).toBe("deny");
    }
  });

  it("seed cannot delegate (ADR-001: Seed cannot spawn Seeds)", () => {
    const perm = permissionsFor("seed", { canDelegate: false });
    expect(perm.task).toBe("deny");
  });

  it("seed can edit (leaf executor in isolated worktree)", () => {
    const perm = permissionsFor("seed", { canDelegate: false });
    expect(perm.edit).toBe("allow");
    expect(perm.write).toBe("allow");
  });

  it("heartwood can delegate to rhizome and mycelium only", () => {
    const perm = permissionsFor("heartwood", { canDelegate: true });
    expect(perm.task).toEqual({ rhizome: "allow", mycelium: "allow" });
  });

  it("orchestrators can edit only .arbor/ working state", () => {
    for (const name of ["crown", "cambium"] as ArborAgentName[]) {
      const perm = permissionsFor(name, { canDelegate: true });
      expect(perm.edit).toEqual({ "*": "deny", ".arbor/**": "allow" });
    }
  });

  it("taproot can edit only .arbor/plans/", () => {
    const perm = permissionsFor("taproot", { canDelegate: true });
    expect(perm.edit).toEqual({ "*": "deny", ".arbor/plans/**": "allow" });
  });

  it("research specialists (rhizome, mycelium, stoma) are read-only", () => {
    for (const name of ["rhizome", "mycelium", "stoma"] as ArborAgentName[]) {
      const perm = permissionsFor(name, { canDelegate: false });
      expect(perm.edit, `${name} must be read-only`).toBe("deny");
      expect(perm.write, `${name} must be read-only`).toBe("deny");
      expect(perm.task, `${name} must not delegate`).toBe("deny");
    }
  });

  it("every agent can call arbor_* MCP tools", () => {
    for (const name of ARBOR_AGENT_NAMES) {
      const perm = permissionsFor(name, { canDelegate: CAPABILITY_TIER[name] === "orchestrator" || name === "heartwood" });
      expect(perm.arbor_select_node, `${name} must call arbor_select_node`).toBe("allow");
      expect(perm.arbor_record_result, `${name} must call arbor_record_result`).toBe("allow");
      expect(perm.arbor_kb_inject, `${name} must call arbor_kb_inject`).toBe("allow");
    }
  });

  it("every agent can read and search", () => {
    for (const name of ARBOR_AGENT_NAMES) {
      const perm = permissionsFor(name, { canDelegate: CAPABILITY_TIER[name] === "orchestrator" || name === "heartwood" });
      expect(perm.read).toBe("allow");
      expect(perm.grep).toBe("allow");
      expect(perm.glob).toBe("allow");
    }
  });
});

describe("category routing", () => {
  it("defines all 5 categories", () => {
    expect(Object.keys(ARBOR_CATEGORIES).sort()).toEqual([...ARBOR_CATEGORY_NAMES].sort());
  });

  it("every category dispatches to a valid agent", () => {
    for (const cat of ARBOR_CATEGORY_NAMES) {
      const def = ARBOR_CATEGORIES[cat];
      expect(ARBOR_AGENT_NAMES, `${cat} routes to unknown agent ${def.subagent_type}`).toContain(def.subagent_type);
    }
  });

  it("seed-quick routes to seed", () => {
    expect(ARBOR_CATEGORIES["seed-quick"].subagent_type).toBe("seed");
  });

  it("heartwood-deep routes to heartwood", () => {
    expect(ARBOR_CATEGORIES["heartwood-deep"].subagent_type).toBe("heartwood");
  });

  it("leaf-visual routes to stoma", () => {
    expect(ARBOR_CATEGORIES["leaf-visual"].subagent_type).toBe("stoma");
  });

  it("crown-structural routes to burl (read-only reasoning)", () => {
    expect(ARBOR_CATEGORIES["crown-structural"].subagent_type).toBe("burl");
  });

  it("G-33 (narrowed, wave 3): every category's model_hint is derived from its subagent_type's real default model, not an independent literal", () => {
    // Before the fix, categories.ts's model_hint values were a second,
    // hand-typed map that happened to agree with agents.ts's MODEL_DEFAULTS
    // by coincidence. Both now come from the same AGENT_MODEL_DEFAULTS
    // table (categories.ts), so a category's hint can never drift from the
    // agent it dispatches to's own default model.
    for (const cat of ARBOR_CATEGORY_NAMES) {
      const def = ARBOR_CATEGORIES[cat];
      const agentDefault = buildAgentConfig(def.subagent_type).model;
      expect(def.model_hint?.model, `${cat}'s model_hint must match ${def.subagent_type}'s own default model`).toBe(agentDefault);
    }
  });

  it("routeCategory picks crown-structural for architecture", () => {
    expect(routeCategory("refactor the auth architecture for testability")).toBe("crown-structural");
  });

  it("routeCategory picks leaf-visual for UI", () => {
    expect(routeCategory("QA the new dashboard layout")).toBe("leaf-visual");
  });

  it("routeCategory picks sap-write for docs", () => {
    expect(routeCategory("write up the API documentation")).toBe("sap-write");
  });

  it("routeCategory picks heartwood-deep for complex work", () => {
    expect(routeCategory("investigate this end-to-end concurrency bug")).toBe("heartwood-deep");
  });

  it("routeCategory defaults to seed-quick for single-file work", () => {
    expect(routeCategory("fix the typo in utils.ts")).toBe("seed-quick");
  });
});

describe("deriveCandidateNodeCard — G-01 capability routing", () => {
  const baseNode = {
    id: "node:refactor:1",
    action_description: "refactor the auth architecture for testability",
    action_category: "refactor",
    action_delegate: "seed",
  };

  it("tags the card with the routed category plus the node's raw category/delegate", () => {
    const card = deriveCandidateNodeCard(baseNode, DEFAULT_NODE_CARD_SECRET);
    expect(card.node_id).toBe(baseNode.id);
    expect(card.tier).toBe("specialist");
    expect(card.skills).toEqual(
      expect.arrayContaining([routeCategory(baseNode.action_description), "refactor", "seed"]),
    );
  });

  it("is deterministic — same inputs and secret produce a byte-identical signature", () => {
    const a = deriveCandidateNodeCard(baseNode, DEFAULT_NODE_CARD_SECRET);
    const b = deriveCandidateNodeCard(baseNode, DEFAULT_NODE_CARD_SECRET);
    expect(a.signature).toBe(b.signature);
  });

  it("dedupes when the routed category coincides with the raw category or delegate", () => {
    // "fix the typo" routes to seed-quick; category/delegate are also
    // "seed-quick"/"seed" here, so the dedupe must not throw on a repeated
    // skill (deriveNodeCard rejects duplicate skills).
    const card = deriveCandidateNodeCard(
      { id: "n1", action_description: "fix the typo in utils.ts", action_category: "seed-quick", action_delegate: "seed" },
      DEFAULT_NODE_CARD_SECRET,
    );
    expect(card.skills).toEqual(["seed-quick", "seed"]);
  });

  it("selectNodeWithCard actually routes on a live campaign's cards — the wiring loop.ts now exercises", () => {
    // This is the exact mechanism loop.ts uses: build a card per pending node
    // from the campaign snapshot, then feed it to selectNodeWithCard. Before
    // the fix, `cards` was never passed, so selectNodeByCapability could
    // never fire on a real run (G-01). A single pending child makes UCT's
    // pick unambiguous, so the card match assertion below is unconditional.
    const mgr = new CampaignManager();
    const root: Action = { description: "plan", estimated_gain: 100, estimated_cost: 1, category: "root", delegate_to: "crown" };
    mgr.startCampaign("camp", "plan.md", root);
    const refactor: Action = { description: "refactor auth module internals", estimated_gain: 50, estimated_cost: 10, category: "refactor", delegate_to: "seed" };
    mgr.branch("camp", "root", [refactor]);

    const snapshot = mgr.getCampaignSnapshot("camp");
    expect(snapshot).not.toBeNull();
    const cards = snapshot!.nodes
      .filter((n) => n.state === "pending")
      .map((n) => deriveCandidateNodeCard(
        { id: n.id, action_description: n.action_description, action_category: n.action_category, action_delegate: n.action_delegate },
        DEFAULT_NODE_CARD_SECRET,
      ));
    expect(cards.length).toBe(1);

    const ctx: ScoreContext = { accuracy_regression_rate: 0, crash_regression_rate: 0, best_known: 100, total_visits: 5 };
    const result = mgr.selectNodeWithCard("camp", ctx, { taskSkills: ["refactor"], requestedTier: "specialist", cards });
    expect(result.node_id).toBe(cards[0]!.node_id);
    expect(result.card).not.toBeNull();
    expect(result.card!.node_id).toBe(result.node_id);
    expect(result.card!.skills).toContain("refactor");
  });
});

describe("deriveAgentForeground — G-02 per-model prompt derivation", () => {
  it("re-derives a node-bound dispatch foreground with operator bindings and the configured model", () => {
    const fg = deriveDispatchForeground("seed", "campaign-1:node-7", {
      modes: new Set(["streaming", "steerable"]),
      inputs: ["operator-plan"],
      outputs: ["patch"],
    }, DEFAULT_AGENT_FOREGROUND_SECRET, { seed: "provider/operator-model" });
    expect(fg.card.node_id).toBe("campaign-1:node-7");
    expect(fg.card.source).toBe("node");
    expect([...fg.card.modes]).toEqual(["streaming", "steerable"]);
    expect(fg.card.inputs).toEqual(["operator-plan"]);
    expect(fg.card.outputs).toEqual(["patch"]);
    expect(fg.prompt_fragment).toContain("provider/operator-model");
  });
  it("every agent's foreground uses its own MODEL_DEFAULTS model_family in the derived card and prompt_fragment", () => {
    for (const name of ARBOR_AGENT_NAMES) {
      const fg = deriveAgentForeground(name);
      const config = buildAgentConfig(name);
      expect(fg.prompt_fragment).toContain(config.model);
    }
  });

  it("model choice and prompt text now interact: two agents with different models get different fragments", () => {
    // seed and rhizome run on different model families (MODEL_DEFAULTS).
    const seed = deriveAgentForeground("seed");
    const rhizome = deriveAgentForeground("rhizome");
    expect(seed.prompt_fragment).not.toBe(rhizome.prompt_fragment);
  });

  it("role/tier come from the real CAPABILITY_TIER, not a hand-picked default", () => {
    const orchestrator = deriveAgentForeground("crown");
    expect(orchestrator.card.tier).toBe(CAPABILITY_TIER.crown);
    const critic = deriveAgentForeground("lenticel");
    expect(critic.card.tier).toBe(CAPABILITY_TIER.lenticel);
  });

  it("skills are the agent's own name plus every category that routes to it (Wave 3's live catalog, reused)", () => {
    const fg = deriveAgentForeground("seed");
    expect(fg.card.skills).toContain("seed");
    expect(fg.card.skills).toContain(ARBOR_CATEGORIES["seed-quick"].name);
  });

  it("delegation_catalog is empty for non-delegating agents, non-empty for orchestrators", () => {
    expect(deriveAgentForeground("lenticel").delegation_table).toHaveLength(0);
    expect(deriveAgentForeground("crown").delegation_table.length).toBeGreaterThan(0);
  });

  it("heartwood's delegation catalog matches its real permission ruleset — only rhizome and mycelium", () => {
    const fg = deriveAgentForeground("heartwood");
    expect(fg.delegation_table.map((e) => e.target_node_id).sort()).toEqual(["mycelium", "rhizome"]);
  });

  it("is deterministic — same inputs and secret produce a byte-identical signature", () => {
    const a = deriveAgentForeground("crown", undefined, DEFAULT_AGENT_FOREGROUND_SECRET);
    const b = deriveAgentForeground("crown", undefined, DEFAULT_AGENT_FOREGROUND_SECRET);
    expect(a.card.signature).toBe(b.card.signature);
  });

  it("buildAgentConfig threads the derived fragment into the system prompt for every agent", () => {
    for (const name of ARBOR_AGENT_NAMES) {
      const fg = deriveAgentForeground(name);
      const config = buildAgentConfig(name);
      expect(config.system, `${name} system prompt must contain its derived foreground fragment`).toContain(fg.prompt_fragment);
    }
  });
});

describe("G-10 (ADR-022): buildAgentConfig threads repo instructions to root/plan-level agents only", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "arbor-agent-repo-instructions-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  // The direct proof ROADMAP's "three memory scopes" claim needs: compose a
  // real prompt from a real AGENTS.md on disk and show the content reaching
  // it — the middle scope (checked-in repo instructions) genuinely exists,
  // not just the global-config and per-node-runtime-evidence scopes.
  it("a real AGENTS.md on disk reaches a root/plan-level agent's composed system prompt", () => {
    writeFileSync(join(root, "AGENTS.md"), "MARKER: run npm test before every commit.", "utf8");
    for (const name of ["crown", "cambium", "taproot"] as ArborAgentName[]) {
      const config = buildAgentConfig(name, { worktreePath: root });
      expect(config.system, `${name} must render the repo's AGENTS.md`).toContain("MARKER: run npm test before every commit.");
    }
  });

  it("the same AGENTS.md never reaches a deep-leaf agent's config, even with the same worktreePath passed", () => {
    writeFileSync(join(root, "AGENTS.md"), "MARKER: run npm test before every commit.", "utf8");
    for (const name of ["seed", "heartwood", "lenticel", "burl", "xylem", "rhizome", "mycelium", "stoma"] as ArborAgentName[]) {
      const config = buildAgentConfig(name, { worktreePath: root });
      expect(config.system, `${name} must NOT render repo instructions`).not.toContain("MARKER: run npm test before every commit.");
    }
  });

  it("without a worktreePath, no repo-instructions scope is resolved for any agent (typed absence, not a process.cwd() guess)", () => {
    writeFileSync(join(root, "AGENTS.md"), "MARKER: should never appear", "utf8");
    for (const name of ARBOR_AGENT_NAMES) {
      const config = buildAgentConfig(name);
      expect(config.system).not.toContain("MARKER: should never appear");
    }
  });

  it("a missing AGENTS.md/CLAUDE.md is a no-op, not an error", () => {
    expect(() => buildAgentConfig("crown", { worktreePath: root })).not.toThrow();
    const config = buildAgentConfig("crown", { worktreePath: root });
    expect(config.system).not.toContain("Repo instructions");
  });

  it("buildAllAgents threads options.worktreePath through to every agent it builds", () => {
    writeFileSync(join(root, "CLAUDE.md"), "MARKER-2: prefer worktrees for parallel work.", "utf8");
    const all = buildAllAgents({ worktreePath: root });
    expect(all.taproot.system).toContain("MARKER-2: prefer worktrees for parallel work.");
    expect(all.seed.system).not.toContain("MARKER-2: prefer worktrees for parallel work.");
  });
});

describe("G-33: arbor.jsonc's agents.*.model reaches the live agent config", () => {
  it("a real modelOverride replaces MODEL_DEFAULTS for that agent only", () => {
    const overridden = buildAgentConfig("seed", { modelOverrides: { seed: "openrouter/deepseek/deepseek-v4" } });
    expect(overridden.model).toBe("openrouter/deepseek/deepseek-v4");
    const untouched = buildAgentConfig("rhizome", { modelOverrides: { seed: "openrouter/deepseek/deepseek-v4" } });
    expect(untouched.model).toBe(buildAgentConfig("rhizome").model);
  });

  it("the built-in MODEL_DEFAULTS variant is dropped once a real override is set — never silently paired with the wrong model", () => {
    // crown's default carries variant "high"; a plain override must not inherit it.
    const base = buildAgentConfig("crown");
    expect(base.variant).toBe("high");
    const overridden = buildAgentConfig("crown", { modelOverrides: { crown: "openrouter/deepseek/deepseek-v4" } });
    expect(overridden.model).toBe("openrouter/deepseek/deepseek-v4");
    expect(overridden.variant).toBeUndefined();
  });

  it('the "auto" sentinel (DEFAULT_CONFIG.agents[name].model) is not treated as a real override', () => {
    const config = buildAgentConfig("seed", { modelOverrides: { seed: "auto" } });
    expect(config.model).toBe(buildAgentConfig("seed").model);
  });

  it("an empty-string override is not treated as real either", () => {
    const config = buildAgentConfig("seed", { modelOverrides: { seed: "" } });
    expect(config.model).toBe(buildAgentConfig("seed").model);
  });

  it("buildAllAgents threads modelOverrides to every agent it builds", () => {
    const all = buildAllAgents({ modelOverrides: { seed: "openrouter/deepseek/deepseek-v4", rhizome: "openrouter/deepseek/deepseek-v4" } });
    expect(all.seed.model).toBe("openrouter/deepseek/deepseek-v4");
    expect(all.rhizome.model).toBe("openrouter/deepseek/deepseek-v4");
    expect(all.crown.model).toBe(buildAgentConfig("crown").model);
  });

  it("G-02 interaction: deriveAgentForeground's derived prompt_fragment follows the same override buildAgentConfig used, never drifting apart", () => {
    const overrides = { seed: "openrouter/deepseek/deepseek-v4" };
    const config = buildAgentConfig("seed", { modelOverrides: overrides });
    const fgWithOverride = deriveAgentForeground("seed", undefined, DEFAULT_AGENT_FOREGROUND_SECRET, overrides);
    const fgWithoutOverride = deriveAgentForeground("seed");
    expect(config.model).toBe("openrouter/deepseek/deepseek-v4");
    expect(fgWithOverride.prompt_fragment).toContain(config.model);
    expect(fgWithOverride.prompt_fragment).not.toBe(fgWithoutOverride.prompt_fragment);
    // And the config's own system prompt carries the *overridden* fragment, not the stale built-in one.
    expect(config.system).toContain(fgWithOverride.prompt_fragment);
    expect(config.system).not.toContain(fgWithoutOverride.prompt_fragment);
  });

  it("G-02 interaction: without an override, foreground and config still agree (no regression)", () => {
    for (const name of ARBOR_AGENT_NAMES) {
      const config = buildAgentConfig(name);
      const fg = deriveAgentForeground(name);
      expect(fg.prompt_fragment).toContain(config.model);
      expect(config.system).toContain(fg.prompt_fragment);
    }
  });
});

describe("G-33: arborPlugin loads real agents.*.model overrides from arbor.jsonc", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "arbor-plugin-model-config-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("an operator's real arbor.jsonc agents.*.model edit reaches the registered opencode agent config", async () => {
    writeFileSync(
      join(root, "arbor.jsonc"),
      JSON.stringify({ agents: { seed: { model: "openrouter/deepseek/deepseek-v4" } } }),
      "utf8",
    );
    const hooks = await arborPlugin({ project: {}, directory: root, worktree: root });
    const config: Record<string, unknown> = {};
    await hooks.config!({ config });
    const agent = config.agent as Record<string, { model: string }>;
    expect(agent.seed.model).toBe("openrouter/deepseek/deepseek-v4");
    // Untouched agents keep their built-in default.
    expect(agent.rhizome.model).toBe(buildAgentConfig("rhizome").model);
  });

  it("no arbor.jsonc on disk is a no-op — built-in MODEL_DEFAULTS still governs (an operator who never sets the key sees no effect, per G-33's contract)", async () => {
    const hooks = await arborPlugin({ project: {}, directory: root, worktree: root });
    const config: Record<string, unknown> = {};
    await hooks.config!({ config });
    const agent = config.agent as Record<string, { model: string }>;
    expect(agent.crown.model).toBe(buildAgentConfig("crown").model);
  });

  it('an arbor.jsonc that only sets the "auto" sentinel is also a no-op', async () => {
    writeFileSync(join(root, "arbor.jsonc"), JSON.stringify({ agents: { crown: { model: "auto" } } }), "utf8");
    const hooks = await arborPlugin({ project: {}, directory: root, worktree: root });
    const config: Record<string, unknown> = {};
    await hooks.config!({ config });
    const agent = config.agent as Record<string, { model: string }>;
    expect(agent.crown.model).toBe(buildAgentConfig("crown").model);
  });

  it("buildArborConfigBlock accepts and threads a real modelOverrides map directly", () => {
    const block = buildArborConfigBlock({ heartwood: "openrouter/deepseek/deepseek-v4" });
    expect(block.agent.heartwood.model).toBe("openrouter/deepseek/deepseek-v4");
  });
});

describe("plugin config builder", () => {
  it("buildArborConfigBlock returns agent + categories", () => {
    const block = buildArborConfigBlock();
    expect(Object.keys(block.agent).sort()).toEqual([...ARBOR_AGENT_NAMES].sort());
    expect(Object.keys(block.arbor_categories).sort()).toEqual([...ARBOR_CATEGORY_NAMES].sort());
  });

  it("arborPlugin config hook merges agents into an empty config", async () => {
    const hooks = await arborPlugin({ project: {}, directory: ".", worktree: "." });
    expect(hooks.config).toBeDefined();

    const config: Record<string, unknown> = {};
    await hooks.config!({ config });

    const agent = config.agent as Record<string, unknown>;
    expect(Object.keys(agent).sort()).toEqual([...ARBOR_AGENT_NAMES].sort());
    expect(config.arbor_categories).toBeDefined();
  });

  it("arborPlugin config hook does not clobber user overrides", async () => {
    const hooks = await arborPlugin({ project: {}, directory: ".", worktree: "." });
    const userCrownSteps = 99;
    const config: Record<string, unknown> = {
      agent: { crown: { steps: userCrownSteps } },
    };
    await hooks.config!({ config });

    const agent = config.agent as Record<string, { steps: number; name: string }>;
    expect(agent.crown.steps).toBe(userCrownSteps);
    // But other fields are still populated from the plugin default.
    expect(agent.crown.name).toBe("crown");
  });

  it("arborPlugin dispose resolves without error", async () => {
    const hooks = await arborPlugin({ project: {}, directory: ".", worktree: "." });
    await expect(hooks.dispose!()).resolves.toBeUndefined();
  });
});

/**
 * G-35: `arbor.jsonc`'s `categories.*.model` had a schema entry in
 * `arbor-config` and no reader anywhere, so an operator could set it and
 * nothing in the running system changed. G-33 collapsed the two hardcoded
 * agent-model tables into one, but a category's model still came only from
 * that built-in table. These assert the config key now genuinely reaches the
 * emitted opencode config block.
 */
describe("G-35: arbor.jsonc's categories.*.model reaches the emitted category block", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "arbor-plugin-category-config-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("an operator's real categories.*.model edit reaches the registered category config", async () => {
    writeFileSync(
      join(root, "arbor.jsonc"),
      JSON.stringify({ categories: { "seed-quick": { model: "openrouter/qwen/qwen-3-coder" } } }),
      "utf8",
    );
    const hooks = await arborPlugin({ project: {}, directory: root, worktree: root });
    const config: Record<string, unknown> = {};
    await hooks.config!({ config });

    const categories = config.arbor_categories as Record<string, { model?: string; subagent_type: string }>;
    expect(categories["seed-quick"].model).toBe("openrouter/qwen/qwen-3-coder");
    // Routing is capability-based and a model hint has never decided it — the
    // configured model must not change which agent the category dispatches to.
    expect(categories["seed-quick"].subagent_type).toBe(ARBOR_CATEGORIES["seed-quick"].subagent_type);
  });

  it("an untouched category keeps its built-in model_hint", async () => {
    writeFileSync(
      join(root, "arbor.jsonc"),
      JSON.stringify({ categories: { "seed-quick": { model: "openrouter/qwen/qwen-3-coder" } } }),
      "utf8",
    );
    const hooks = await arborPlugin({ project: {}, directory: root, worktree: root });
    const config: Record<string, unknown> = {};
    await hooks.config!({ config });

    const categories = config.arbor_categories as Record<string, { model?: string }>;
    expect(categories["crown-structural"].model).toBe(ARBOR_CATEGORIES["crown-structural"].model_hint?.model);
  });

  it("no arbor.jsonc on disk is a no-op — every category keeps its built-in hint", async () => {
    const hooks = await arborPlugin({ project: {}, directory: root, worktree: root });
    const config: Record<string, unknown> = {};
    await hooks.config!({ config });

    const categories = config.arbor_categories as Record<string, { model?: string }>;
    for (const name of Object.keys(ARBOR_CATEGORIES) as (keyof typeof ARBOR_CATEGORIES)[]) {
      expect(categories[name].model).toBe(ARBOR_CATEGORIES[name].model_hint?.model);
    }
  });

  it("resolveCategoryModel prefers a configured value and falls back to the built-in hint", () => {
    expect(resolveCategoryModel("seed-quick", { "seed-quick": "x/y" })).toEqual({ model: "x/y" });
    expect(resolveCategoryModel("seed-quick")).toEqual(ARBOR_CATEGORIES["seed-quick"].model_hint);
  });
});

/**
 * ADR-001: `resolveCategoryModelWithFallback` was built and unit-tested
 * (`agent-taxonomy-fallback.test.ts`) but had no production caller. It is
 * wired into `arborPlugin`'s real `config` hook — the actual opencode
 * plugin entry point — whenever the host supplies a client that can answer
 * `client.config.providers()` (the live model catalog). These drive that
 * real hook, not `resolveCategoryModelWithFallback` directly.
 */
describe("ADR-001: a live model catalog reaches category model resolution through the real plugin config hook", () => {
  function fakeClientWithModels(models: readonly string[]): { config: { providers: () => Promise<{ data: { providers: Array<{ id: string; models: Record<string, unknown> }> } }> } } {
    const byProvider = new Map<string, Record<string, unknown>>();
    for (const full of models) {
      const [providerId, ...rest] = full.split("/");
      const modelId = rest.join("/");
      const bucket = byProvider.get(providerId!) ?? {};
      bucket[modelId] = { limit: { context: 1_000, output: 100 } };
      byProvider.set(providerId!, bucket);
    }
    return {
      config: {
        providers: async () => ({ data: { providers: [...byProvider.entries()].map(([id, models]) => ({ id, models })) } }),
      },
    };
  }

  it("no client on the plugin context: identical to pre-ADR-001 behavior, no model_source field", async () => {
    const hooks = await arborPlugin({ project: {}, directory: ".", worktree: "." });
    const config: Record<string, unknown> = {};
    await hooks.config!({ config });
    const categories = config.arbor_categories as Record<string, { model?: string; model_source?: string }>;
    for (const name of Object.keys(ARBOR_CATEGORIES) as (keyof typeof ARBOR_CATEGORIES)[]) {
      expect(categories[name].model).toBe(ARBOR_CATEGORIES[name].model_hint?.model);
      expect(categories[name].model_source).toBeUndefined();
    }
  });

  it("a live catalog containing the built-in default: source is configured (no override was set)", async () => {
    const heartwoodDefault = ARBOR_CATEGORIES["heartwood-deep"].model_hint!.model;
    const client = fakeClientWithModels([heartwoodDefault]);
    const hooks = await arborPlugin({ project: {}, directory: ".", worktree: ".", client });
    const config: Record<string, unknown> = {};
    await hooks.config!({ config });
    const categories = config.arbor_categories as Record<string, { model?: string; model_source?: string }>;
    expect(categories["heartwood-deep"]).toMatchObject({ model: heartwoodDefault, model_source: "fallback" });
  });

  it("a configured-but-unavailable category model falls back to the built-in default and reports source fallback", async () => {
    const heartwoodDefault = ARBOR_CATEGORIES["heartwood-deep"].model_hint!.model;
    const root = mkdtempSync(join(tmpdir(), "arbor-plugin-adr001-"));
    try {
      writeFileSync(join(root, "arbor.jsonc"), JSON.stringify({ categories: { "heartwood-deep": { model: "openrouter/not-actually-installed" } } }), "utf8");
      // The live catalog has the built-in default but NOT the operator's configured model.
      const client = fakeClientWithModels([heartwoodDefault]);
      const hooks = await arborPlugin({ project: {}, directory: root, worktree: root, client });
      const config: Record<string, unknown> = {};
      await hooks.config!({ config });
      const categories = config.arbor_categories as Record<string, { model?: string; model_source?: string }>;
      expect(categories["heartwood-deep"]).toMatchObject({ model: heartwoodDefault, model_source: "fallback" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("a configured category model that IS in the live catalog: source is configured", async () => {
    const root = mkdtempSync(join(tmpdir(), "arbor-plugin-adr001-configured-"));
    try {
      writeFileSync(join(root, "arbor.jsonc"), JSON.stringify({ categories: { "seed-quick": { model: "openrouter/qwen/qwen-3-coder" } } }), "utf8");
      const client = fakeClientWithModels(["openrouter/qwen/qwen-3-coder", ARBOR_CATEGORIES["seed-quick"].model_hint!.model]);
      const hooks = await arborPlugin({ project: {}, directory: root, worktree: root, client });
      const config: Record<string, unknown> = {};
      await hooks.config!({ config });
      const categories = config.arbor_categories as Record<string, { model?: string; model_source?: string }>;
      expect(categories["seed-quick"]).toMatchObject({ model: "openrouter/qwen/qwen-3-coder", model_source: "configured" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("a catalog with neither the configured nor the default model: a typed unavailable absence, not a thrown error", async () => {
    const client = fakeClientWithModels(["openrouter/some-other-model"]);
    const hooks = await arborPlugin({ project: {}, directory: ".", worktree: ".", client });
    const config: Record<string, unknown> = {};
    await expect(hooks.config!({ config })).resolves.toBeUndefined();
    const categories = config.arbor_categories as Record<string, { model?: string; model_source?: string }>;
    expect(categories["heartwood-deep"]).toMatchObject({ model_source: "unavailable" });
    expect(categories["heartwood-deep"].model).toBeUndefined();
  });

  it("a client whose providers() call throws: falls back to no-catalog behavior instead of failing the whole config hook", async () => {
    const client = { config: { providers: async () => { throw new Error("network unreachable"); } } };
    const hooks = await arborPlugin({ project: {}, directory: ".", worktree: ".", client });
    const config: Record<string, unknown> = {};
    await expect(hooks.config!({ config })).resolves.toBeUndefined();
    const categories = config.arbor_categories as Record<string, { model?: string; model_source?: string }>;
    expect(categories["heartwood-deep"]).toMatchObject({ model: ARBOR_CATEGORIES["heartwood-deep"].model_hint?.model });
    expect(categories["heartwood-deep"].model_source).toBeUndefined();
  });
});
