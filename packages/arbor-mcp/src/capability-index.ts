import {
  CAPABILITY_MANIFEST_REVISION,
  CAPABILITY_TIER,
  MCP_SERVER_OPERATION_NAMES,
  NATIVE_MODEL_TOOL_IDS,
  NATIVE_ROLE_AUTHORITY_MANIFEST,
  NATIVE_ROLE_IDS,
  NATIVE_SKILL_CAPABILITY_MANIFEST,
  NATIVE_SKILL_DESCRIPTOR_MANIFEST,
  NATIVE_TOOL_RISK_MANIFEST,
  RUNTIME_CATALOG_MANIFEST,
} from "@arbor/core";
import type { NativeRoleProfileId } from "@arbor/core";
import { NATIVE_ROLE_PROFILES } from "@arbor/prompts";
import {
  NATIVE_BUS_THREAD_MODEL_TOOLS,
  NATIVE_PLANNING_MODEL_TOOLS,
  NATIVE_REPOSITORY_MODEL_TOOLS,
} from "./native-model-tool-catalog.js";

/** MCP exposes its host-owned risk projection; core owns every risk value. */
const hostToolRisks = Object.freeze(Object.assign({},
  ...Object.entries(NATIVE_TOOL_RISK_MANIFEST)
    .map(([, risks]) => risks),
));

const modelToolMap = [
  ...NATIVE_REPOSITORY_MODEL_TOOLS,
  ...NATIVE_PLANNING_MODEL_TOOLS,
  ...NATIVE_BUS_THREAD_MODEL_TOOLS,
  ...NATIVE_MODEL_TOOL_IDS.peer.map((name) => ({ name, risk: NATIVE_TOOL_RISK_MANIFEST.peer[name] })),
].reduce((byName, tool) => {
  const current = byName.get(tool.name);
  if (current !== undefined && current.risk !== tool.risk) throw new Error(`model tool ${tool.name} has conflicting risk declarations`);
  byName.set(tool.name, Object.freeze({ name: tool.name, risk: tool.risk }));
  return byName;
}, new Map<string, { readonly name: string; readonly risk: string }>());
const modelTools = Object.freeze([...modelToolMap.values()]);

const peerHostToolRisks = NATIVE_TOOL_RISK_MANIFEST.peer;

const roleProfiles = Object.freeze(Object.fromEntries(
  NATIVE_ROLE_IDS.map((roleId) => [roleId, NATIVE_ROLE_PROFILES[roleId]]),
) as Readonly<Record<NativeRoleProfileId, (typeof NATIVE_ROLE_PROFILES)[NativeRoleProfileId]>>);

/** The public discovery revision is the canonical core manifest revision. */
export const CAPABILITY_INDEX_REVISION = CAPABILITY_MANIFEST_REVISION;

/** Consumer-facing projection of the canonical core declarations and schemas. */
export const CAPABILITY_INDEX = Object.freeze({
  revision: CAPABILITY_INDEX_REVISION,
  runtime_catalog: RUNTIME_CATALOG_MANIFEST,
  host_tool_risks: hostToolRisks,
  peer_host_tool_risks: peerHostToolRisks,
  model_tools: modelTools,
  model_tool_ids: NATIVE_MODEL_TOOL_IDS,
  roles: roleProfiles,
  role_authorities: NATIVE_ROLE_AUTHORITY_MANIFEST,
  role_ids: NATIVE_ROLE_IDS,
  agent_tiers: CAPABILITY_TIER,
  skill: NATIVE_SKILL_CAPABILITY_MANIFEST,
  skill_descriptor: NATIVE_SKILL_DESCRIPTOR_MANIFEST,
  mcp_operations: MCP_SERVER_OPERATION_NAMES,
});

/**
 * Parity inputs are canonical owner declarations; only `mcp_operations` is
 * sampled from live server registration. This checks declaration alignment,
 * not runtime reachability or behavioral health.
 */
export interface CapabilityObservation {
  readonly mcp_operations: readonly string[];
  readonly runtime_operations: readonly string[];
  readonly host_tool_names: readonly string[];
  readonly model_tool_names: readonly string[];
  readonly role_ids: readonly string[];
  readonly skill_tool_names: readonly string[];
  readonly skill_structured_output_ids: readonly string[];
}

export interface CapabilitySurfaceDrift {
  readonly surface: keyof CapabilityObservation;
  readonly missing: readonly string[];
  readonly unexpected: readonly string[];
}

export interface CapabilityDriftReport {
  readonly status: "current" | "drift";
  readonly revision: string;
  readonly drift: readonly CapabilitySurfaceDrift[];
}

/** Compare canonical consumer declarations, plus live MCP registration, with the revision-bound capability contract. */
export function compareCapabilitySurfaces(observed: CapabilityObservation): CapabilityDriftReport {
  const expected: Readonly<Record<keyof CapabilityObservation, readonly string[]>> = {
    mcp_operations: CAPABILITY_INDEX.mcp_operations,
    runtime_operations: CAPABILITY_INDEX.runtime_catalog.map((entry) => entry.kind),
    host_tool_names: Object.keys(CAPABILITY_INDEX.host_tool_risks),
    model_tool_names: CAPABILITY_INDEX.model_tools.map((tool) => tool.name),
    role_ids: Object.keys(CAPABILITY_INDEX.roles),
    skill_tool_names: Object.keys(CAPABILITY_INDEX.skill.tools),
    skill_structured_output_ids: CAPABILITY_INDEX.skill.structured_output_ids,
  };
  const drift = (Object.keys(expected) as (keyof CapabilityObservation)[])
    .map((surface) => compareNames(surface, expected[surface], observed[surface]))
    .filter((entry) => entry.missing.length > 0 || entry.unexpected.length > 0);
  return Object.freeze({ status: drift.length === 0 ? "current" : "drift", revision: CAPABILITY_INDEX_REVISION, drift: Object.freeze(drift) });
}

function compareNames(surface: keyof CapabilityObservation, expected: readonly string[], observed: readonly string[]): CapabilitySurfaceDrift {
  const expectedSet = new Set(expected);
  const observedSet = new Set(observed);
  return Object.freeze({
    surface,
    missing: Object.freeze([...expectedSet].filter((name) => !observedSet.has(name)).sort()),
    unexpected: Object.freeze([...observedSet].filter((name) => !expectedSet.has(name)).sort()),
  });
}
