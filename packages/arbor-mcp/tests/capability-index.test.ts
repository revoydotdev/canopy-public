import { describe, expect, it } from "vitest";
import { CAPABILITY_TIER, NATIVE_MODEL_TOOL_IDS, NATIVE_ROLE_IDS, NATIVE_TOOL_RISK_MANIFEST } from "@arbor/core";
import { NATIVE_ROLE_PROFILES } from "@arbor/prompts";
import {
  NATIVE_BUS_THREAD_MODEL_TOOLS,
  NATIVE_PLANNING_MODEL_TOOLS,
  NATIVE_REPOSITORY_MODEL_TOOLS,
} from "../src/cli.js";
import { CAPABILITY_INDEX, CAPABILITY_INDEX_REVISION, compareCapabilitySurfaces, type CapabilityObservation } from "../src/capability-index.js";
import { NATIVE_SUBAGENT_TOOL_RISKS } from "../src/native-agent-executor.js";
import { NATIVE_REPOSITORY_TOOL_RISKS } from "../src/native-tools/contracts.js";
import { NATIVE_BROWSER_TOOL_RISKS } from "../src/native-browser-tools.js";
import { NATIVE_IMAGE_TOOL_RISKS, NATIVE_SKILL_TOOL_RISKS, NATIVE_USERINPUT_TOOL_RISKS } from "../src/native-tool-host.js";
import { NATIVE_WEB_TOOL_RISKS } from "../src/native-web-tools.js";
import { RUNTIME_CATALOG } from "../src/runtime-catalog.js";
import { NATIVE_SKILL_CAPABILITY_MANIFEST } from "../src/skills/capabilities.js";

describe("revision-bound capability index", () => {
  it("projects the runtime, hosted model tools, roles, agent tiers, and skill contract from their active owners", () => {
    const modelToolDefinitions = [
      ...NATIVE_REPOSITORY_MODEL_TOOLS,
      ...NATIVE_PLANNING_MODEL_TOOLS,
      ...NATIVE_BUS_THREAD_MODEL_TOOLS,
    ];
    const byName = new Map<string, string>();
    for (const tool of modelToolDefinitions) {
      const previous = byName.get(tool.name);
      expect(previous === undefined || previous === tool.risk, `${tool.name} has one advertised risk`).toBe(true);
      byName.set(tool.name, tool.risk);
    }
    for (const name of NATIVE_MODEL_TOOL_IDS.peer) {
      const risk = NATIVE_TOOL_RISK_MANIFEST.peer[name];
      expect(byName.get(name) ?? risk, `${name} has one advertised risk`).toBe(risk);
      byName.set(name, risk);
    }

    expect(CAPABILITY_INDEX_REVISION).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(CAPABILITY_INDEX.revision).toBe(CAPABILITY_INDEX_REVISION);
    expect(CAPABILITY_INDEX.runtime_catalog).toBe(RUNTIME_CATALOG);
    expect(CAPABILITY_INDEX.model_tools).toEqual([...byName].map(([name, risk]) => ({ name, risk })));
    expect(CAPABILITY_INDEX.host_tool_risks).toEqual({
      ...NATIVE_REPOSITORY_TOOL_RISKS,
      ...NATIVE_SUBAGENT_TOOL_RISKS,
      ...NATIVE_SKILL_TOOL_RISKS,
      ...NATIVE_USERINPUT_TOOL_RISKS,
      ...NATIVE_WEB_TOOL_RISKS,
      ...NATIVE_BROWSER_TOOL_RISKS,
      ...NATIVE_IMAGE_TOOL_RISKS,
      // Every group of the core risk manifest is projected, not just the host-tool groups.
      ...NATIVE_TOOL_RISK_MANIFEST.bus,
      ...NATIVE_TOOL_RISK_MANIFEST.peer,
    });
    expect(Object.keys(CAPABILITY_INDEX.roles)).toEqual([...NATIVE_ROLE_IDS]);
    expect(CAPABILITY_INDEX.roles).toEqual(NATIVE_ROLE_PROFILES);
    expect(CAPABILITY_INDEX.agent_tiers).toBe(CAPABILITY_TIER);
    expect(CAPABILITY_INDEX.skill).toBe(NATIVE_SKILL_CAPABILITY_MANIFEST);

    const advertised = new Set([
      ...CAPABILITY_INDEX.model_tools.map((tool) => tool.name),
      ...Object.keys(CAPABILITY_INDEX.host_tool_risks),
      ...CAPABILITY_INDEX.runtime_catalog.map((entry) => entry.kind),
    ]);
    for (const profile of Object.values(CAPABILITY_INDEX.roles)) {
      for (const tool of profile.tool_policy.allowed_tools) {
        expect(advertised.has(tool), `${profile.role_id} tool ${tool} is advertised`).toBe(true);
      }
    }
  });

  it("reports missing and unexpected live capabilities as typed drift", () => {
    const current: CapabilityObservation = {
      mcp_operations: CAPABILITY_INDEX.mcp_operations,
      runtime_operations: CAPABILITY_INDEX.runtime_catalog.map((entry) => entry.kind),
      host_tool_names: Object.keys(CAPABILITY_INDEX.host_tool_risks),
      model_tool_names: CAPABILITY_INDEX.model_tools.map((tool) => tool.name),
      role_ids: Object.keys(CAPABILITY_INDEX.roles),
      skill_tool_names: Object.keys(CAPABILITY_INDEX.skill.tools),
      skill_structured_output_ids: CAPABILITY_INDEX.skill.structured_output_ids,
    };
    expect(compareCapabilitySurfaces(current)).toMatchObject({ status: "current", drift: [] });

    const drift = compareCapabilitySurfaces({
      ...current,
      mcp_operations: current.mcp_operations.filter((name) => name !== "arbor_query"),
      host_tool_names: [...current.host_tool_names, "unindexed.tool"],
    });
    expect(drift).toMatchObject({
      status: "drift",
      drift: [
        { surface: "mcp_operations", missing: ["arbor_query"], unexpected: [] },
        { surface: "host_tool_names", missing: [], unexpected: ["unindexed.tool"] },
      ],
    });
  });
});
