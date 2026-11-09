import { describe, it, expect } from "vitest";
import { buildAgentDefinitionSource } from "../src/loop-ports-helper.js";
import { AGENT_ROLES, composeAgentRegistry } from "../src/agent-registry.js";
import { TaskSupervisor } from "@arbor/core";

describe("buildAgentDefinitionSource (A-7: agent_definitions)", () => {
  it("returns a real, non-fabricated definition for every botanical agent role", () => {
    const source = buildAgentDefinitionSource();
    const definitions = source.definitions();

    // Every known role is present, exactly once, with no invented roles.
    expect(definitions.map((d) => d.name).sort()).toEqual([...AGENT_ROLES].sort());

    // Tiers and descriptions are the real catalog data (ADR-005 tiers), not
    // placeholders — spot-check a representative agent per tier.
    const byName = new Map(definitions.map((d) => [d.name, d]));
    expect(byName.get("crown")).toMatchObject({ tier: "orchestrator" });
    expect(byName.get("seed")).toMatchObject({ tier: "specialist" });
    expect(byName.get("lenticel")).toMatchObject({ tier: "critic" });
    for (const definition of definitions) {
      expect(definition.description.length).toBeGreaterThan(0);
    }
  });

  it("feeds a real, non-empty AgentRegistry view when composed with a supervisor (proves the field arrives, not just the assignment)", () => {
    const source = buildAgentDefinitionSource();
    const supervisor = new TaskSupervisor();
    supervisor.register({ id: "t-crown", operation_id: "op-1", kind: "crown.select", owner_scope_id: "c1" });

    const view = composeAgentRegistry({ definitions: source.definitions(), supervisor });
    expect(view.definitions.length).toBe(AGENT_ROLES.length);
    expect(view.live).toHaveLength(1);
    expect(view.live[0]!.agent).toBe("crown");
  });
});
