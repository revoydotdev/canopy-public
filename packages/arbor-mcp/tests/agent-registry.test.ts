import { describe, it, expect } from "vitest";
import { agentFromTaskKind, composeAgentRegistry, type AgentDefinition, type AgentDefinitionSource } from "../src/agent-registry.js";
import { RuntimeCatalogRouter } from "../src/runtime-catalog.js";
import { ArborRuntime } from "../src/runtime.js";
import { CampaignManager } from "../src/manager.js";
import { TaskSupervisor } from "@arbor/core";

const definitions: readonly AgentDefinition[] = [
  { name: "crown", tier: "orchestrator", description: "Tree driver" },
  { name: "seed", tier: "specialist", description: "Isolated executor" },
  { name: "lenticel", tier: "critic", description: "Critic" },
  { name: "taproot", tier: "orchestrator", description: "Planner" },
];

const source: AgentDefinitionSource = { definitions: () => definitions };

function makeRuntime(): { supervisor: TaskSupervisor; runtime: ArborRuntime } {
  const manager = new CampaignManager();
  const supervisor = new TaskSupervisor();
  const runtime = new ArborRuntime({ manager, supervisor, agent_definitions: source });
  return { supervisor, runtime };
}

describe("composeAgentRegistry", () => {
  it("surfaces definitions and no fabricated live instances", () => {
    const supervisor = new TaskSupervisor();
    const view = composeAgentRegistry({ definitions, supervisor });
    expect(view.definitions).toHaveLength(4);
    expect(view.live).toHaveLength(0);
    expect(view.active_agent_count).toBe(0);
  });

  it("derives live instances only for known agent definitions", () => {
    const supervisor = new TaskSupervisor();
    supervisor.register({ id: "t-crown", operation_id: "op-1", kind: "crown.select", owner_scope_id: "c1" });
    supervisor.register({ id: "t-seed", operation_id: "op-2", kind: "seed.expand", owner_scope_id: "c1" });
    supervisor.register({ id: "t-unknown", operation_id: "op-3", kind: "compiler.run", owner_scope_id: "c1" });
    const view = composeAgentRegistry({ definitions, supervisor });
    expect(view.live).toHaveLength(2);
    expect(view.live.map((i) => i.agent).sort()).toEqual(["crown", "seed"]);
    expect(view.live.some((i) => i.agent === "crown")).toBe(true);
  });

  it("never fabricates a live instance for a definition that is absent", () => {
    const supervisor = new TaskSupervisor();
    supervisor.register({ id: "t-stoma", operation_id: "op-9", kind: "stoma.vision", owner_scope_id: "c1" });
    // stoma is not in `definitions`, so its running task must NOT surface as a live instance
    const view = composeAgentRegistry({ definitions, supervisor });
    expect(view.live.some((i) => i.agent === "stoma")).toBe(false);
  });

  it("maps task kinds to agent roles and rejects unknown/none", () => {
    expect(agentFromTaskKind("crown.select")).toBe("crown");
    expect(agentFromTaskKind("recovery.retry")).toBeNull();
    expect(agentFromTaskKind("compile")).toBeNull();
  });

  it("bounds live instances to a cap", () => {
    const supervisor = new TaskSupervisor();
    for (let i = 0; i < 12_000; i += 1) supervisor.register({ id: `t${i}`, operation_id: `op${i}`, kind: "seed.expand", owner_scope_id: "c1" });
    const view = composeAgentRegistry({ definitions, supervisor });
    expect(view.live.length).toBeLessThanOrEqual(10_000);
  });
});

describe("AgentRegistry service + catalog agent.list", () => {
  it("returns definitions + live through the catalog router", () => {
    const { supervisor, runtime } = makeRuntime();
    supervisor.register({ id: "t1", operation_id: "o1", kind: "crown.halt", owner_scope_id: "c1" });
    const router = new RuntimeCatalogRouter(runtime);
    const result = router.executeQuery({ schema_version: 1, query_id: "agents", query: { kind: "agent.list" } });
    expect(result.ok).toBe(true);
    if (result.ok) {
      const value = result.value as { definitions: { name: string }[]; active_agent_count: number };
      expect(value.definitions).toHaveLength(4);
      expect(value.active_agent_count).toBe(1);
    }
  });

  it("honors include_terminal to surface terminal tasks", () => {
    const { supervisor, runtime } = makeRuntime();
    supervisor.register({ id: "t1", operation_id: "o1", kind: "seed.expand", owner_scope_id: "c1" });
    supervisor.complete("t1");
    const router = new RuntimeCatalogRouter(runtime);
    const active = router.executeQuery({ schema_version: 1, query_id: "a", query: { kind: "agent.list" } });
    const incl = router.executeQuery({ schema_version: 1, query_id: "b", query: { kind: "agent.list", include_terminal: true } });
    if (active.ok && incl.ok) {
      expect((active.value as { active_agent_count: number }).active_agent_count).toBe(0);
      expect((incl.value as { active_agent_count: number }).active_agent_count).toBe(1);
    }
  });

  it("enforces the agent.read capability gate", () => {
    const { runtime } = makeRuntime();
    const router = new RuntimeCatalogRouter(runtime, { granted_capabilities: new Set(["campaign.read"]) });
    const result = router.executeQuery({ schema_version: 1, query_id: "agents", query: { kind: "agent.list" } });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("permission");
  });

  it("rejects malformed agent.list envelopes", () => {
    const { runtime } = makeRuntime();
    const router = new RuntimeCatalogRouter(runtime);
    const result = router.executeQuery({ schema_version: 1, query_id: "", query: { kind: "agent.list" } });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("validation");
  });
});
