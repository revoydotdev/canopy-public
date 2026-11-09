/**
 * Canonical, dependency-free capability declarations shared by the native
 * runtime surfaces. Runtime implementations may add local operational
 * metadata, but capability identity and descriptor bounds live here.
 */
import { createHash } from "node:crypto";
import { canonicalizeForHash } from "./canonical.js";
import {
  DESTRUCTIVE_RUNTIME_KINDS,
  OPEN_WORLD_RUNTIME_KINDS,
  RUNTIME_CATALOG_MANIFEST,
} from "./runtime-catalog-manifest.js";

/** Botanical capability tiers (ADR-005), keyed by native agent ID. */
export const CAPABILITY_TIER = Object.freeze({
  crown: "orchestrator",
  cambium: "orchestrator",
  taproot: "orchestrator",
  heartwood: "specialist",
  seed: "specialist",
  lenticel: "critic",
  burl: "critic",
  xylem: "critic",
  rhizome: "specialist",
  mycelium: "specialist",
  stoma: "specialist",
} as const);

/** Role profile IDs accepted by the native prompt/skill composition surface. */
export const NATIVE_ROLE_IDS = Object.freeze([
  "architect",
  "documentation-writer",
  "specialist-executor",
  "critic-reviewer",
] as const);

export type NativeRoleProfileId = (typeof NATIVE_ROLE_IDS)[number];
/** Alias retained for callers that name these identifiers without “profile”. */
export type NativeRoleId = NativeRoleProfileId;

/**
 * ADR-005 role authority as canonical data. Consumers may reduce this
 * authority, never widen it; the complete descriptor is included in the
 * revision input below.
 */
export const NATIVE_ROLE_AUTHORITY_MANIFEST = Object.freeze({
  architect: Object.freeze({
    phase: "planning",
    allowed_tools: Object.freeze(["repository.search", "repository.graph", "repository.list", "repository.glob", "file.read", "file.write", "file.patch", "git.status", "git.diff"]),
    documentation_path_patterns: Object.freeze(["docs/**/*.md", "README.md", "CHANGELOG.md", ".arbor/**/*.md"]),
    implementation_writes_forbidden: true,
    allowed_capabilities: Object.freeze(["streaming", "interruption"]),
    required_capabilities: Object.freeze(["streaming", "interruption"]),
    self_approval_forbidden: true,
  }),
  "documentation-writer": Object.freeze({
    phase: "execution",
    allowed_tools: Object.freeze(["repository.search", "repository.graph", "repository.list", "repository.glob", "file.read", "file.write", "file.patch", "git.status", "git.diff"]),
    documentation_path_patterns: Object.freeze(["docs/**/*.md", "README.md", "CHANGELOG.md", ".arbor/**/*.md"]),
    implementation_writes_forbidden: true,
    allowed_capabilities: Object.freeze(["streaming", "interruption"]),
    required_capabilities: Object.freeze(["streaming", "interruption"]),
    self_approval_forbidden: true,
  }),
  "specialist-executor": Object.freeze({
    phase: "execution",
    allowed_tools: Object.freeze(["repository.search", "repository.graph", "repository.list", "repository.glob", "file.read", "file.write", "file.patch", "shell.execute", "verification.run", "git.status", "git.diff", "peer.query", "peer.reply", "peer.history"]),
    documentation_path_patterns: Object.freeze([]),
    implementation_writes_forbidden: false,
    allowed_capabilities: Object.freeze(["streaming", "interruption"]),
    required_capabilities: Object.freeze(["streaming", "interruption"]),
    self_approval_forbidden: true,
  }),
  "critic-reviewer": Object.freeze({
    phase: "review",
    allowed_tools: Object.freeze(["repository.search", "repository.graph", "repository.list", "repository.glob", "file.read", "git.status", "git.diff"]),
    documentation_path_patterns: Object.freeze([]),
    implementation_writes_forbidden: true,
    allowed_capabilities: Object.freeze(["streaming", "interruption"]),
    required_capabilities: Object.freeze(["streaming", "interruption"]),
    self_approval_forbidden: true,
  }),
} as const satisfies Readonly<Record<NativeRoleProfileId, {
  readonly phase: "planning" | "execution" | "review";
  readonly allowed_tools: readonly string[];
  readonly documentation_path_patterns: readonly string[];
  readonly implementation_writes_forbidden: boolean;
  readonly allowed_capabilities: readonly string[];
  readonly required_capabilities: readonly string[];
  readonly self_approval_forbidden: true;
}>>);

export type NativeToolRisk = "low" | "high";

/** Dynamic peer model tools are named once; their shared risk facts derive from these IDs. */
const NATIVE_PEER_TOOL_IDS = Object.freeze(["peer.history", "peer.query", "peer.reply"] as const);
const NATIVE_PEER_TOOL_RISK_MANIFEST = Object.freeze(Object.fromEntries(
  NATIVE_PEER_TOOL_IDS.map((tool) => [tool, "low"] as const),
) as Readonly<Record<(typeof NATIVE_PEER_TOOL_IDS)[number], NativeToolRisk>>);

/** Canonical model-visible tool names, grouped as in the native tool catalog. */
export const NATIVE_MODEL_TOOL_IDS = Object.freeze({
  repository: Object.freeze([
    "repository.search", "repository.graph", "repository.list", "repository.glob",
    "file.read", "file.write", "file.patch", "shell.execute", "shell.poll", "shell.stop",
    "verification.run", "evidence.refresh", "git.status", "git.diff", "todo.write", "todo.read",
  ] as const),
  planning: Object.freeze([
    "repository.search", "repository.graph", "repository.list", "repository.glob", "file.read", "git.status", "git.diff",
  ] as const),
  bus: Object.freeze(["bus.thread.send", "bus.thread.ack", "sibling.status"] as const),
  peer: NATIVE_PEER_TOOL_IDS,
  extensions: Object.freeze([
    "subagent.execute", "userinput.ask", "skill.load", "skill.list",
    "web.fetch", "web.search", "browser.observe", "browser.interact",
    "image.attach", "image.list",
  ] as const),
});

/** Canonical names for operations registered by the built-in MCP server. */
export const MCP_SERVER_OPERATIONS = Object.freeze({
  start_campaign: "arbor_start_campaign",
  select_node: "arbor_select_node",
  expand_node: "arbor_expand_node",
  record_result: "arbor_record_result",
  branch: "arbor_branch",
  prune: "arbor_prune",
  halt_check: "arbor_halt_check",
  gate_status: "arbor_gate_status",
  kb_read: "arbor_kb_read",
  kb_query: "arbor_kb_query",
  kb_inject: "arbor_kb_inject",
  interrupt_campaign: "arbor_interrupt_campaign",
  get_state: "arbor_get_state",
  catalog_search: "arbor_catalog_search",
  command: "arbor_command",
  query: "arbor_query",
  devtools_open_campaign: "devtools_open_campaign",
  devtools_snapshot: "devtools_snapshot",
  devtools_liveness: "devtools_liveness",
  devtools_probe: "devtools_probe",
  devtools_trace_tail: "devtools_trace_tail",
  devtools_step: "devtools_step",
  devtools_break_on: "devtools_break_on",
  devtools_clear: "devtools_clear",
} as const);

export const MCP_SERVER_OPERATION_NAMES: readonly string[] = Object.freeze(Object.values(MCP_SERVER_OPERATIONS));

/** Risk metadata for native host and model-visible tools. */
export const NATIVE_TOOL_RISK_MANIFEST = Object.freeze({
  repository: Object.freeze({
    "repository.search": "low", "repository.graph": "low", "repository.list": "low", "repository.glob": "low",
    "file.read": "low", "file.write": "high", "file.patch": "high", "shell.execute": "high",
    "git.status": "low", "git.diff": "low", "verification.run": "high", "evidence.refresh": "high",
    "shell.poll": "low", "shell.stop": "low", "todo.write": "low", "todo.read": "low",
  } as const satisfies Record<string, NativeToolRisk>),
  subagent: Object.freeze({ "subagent.execute": "high" } as const satisfies Record<string, NativeToolRisk>),
  skill: Object.freeze({ "skill.load": "low", "skill.list": "low" } as const satisfies Record<string, NativeToolRisk>),
  userinput: Object.freeze({ "userinput.ask": "low" } as const satisfies Record<string, NativeToolRisk>),
  web: Object.freeze({ "web.fetch": "high", "web.search": "high" } as const satisfies Record<string, NativeToolRisk>),
  browser: Object.freeze({ "browser.observe": "high", "browser.interact": "high" } as const satisfies Record<string, NativeToolRisk>),
  image: Object.freeze({ "image.attach": "low", "image.list": "low" } as const satisfies Record<string, NativeToolRisk>),
  bus: Object.freeze({ "bus.thread.send": "low", "bus.thread.ack": "low", "sibling.status": "low" } as const satisfies Record<string, NativeToolRisk>),
  peer: NATIVE_PEER_TOOL_RISK_MANIFEST,
});

/** Skill descriptor contract and authority-reducing input/budget bounds. */
export const NATIVE_SKILL_CAPABILITY_MANIFEST = Object.freeze({
  descriptor_schema_version: 1,
  tools: NATIVE_TOOL_RISK_MANIFEST.skill,
  structured_output_ids: Object.freeze(["revoy.native.skill-result.v1"] as const),
});

/** Input and budget contract advertised by native skill descriptors. */
export const NATIVE_SKILL_DESCRIPTOR_MANIFEST = Object.freeze({
  schema_version: NATIVE_SKILL_CAPABILITY_MANIFEST.descriptor_schema_version,
  structured_output_ids: NATIVE_SKILL_CAPABILITY_MANIFEST.structured_output_ids,
  input_contract: Object.freeze({
    max_names: 16,
    max_name_bytes: 64,
    max_value_bytes: 8 * 1024,
    name_pattern: "^[a-z][a-z0-9_]{0,31}$",
  }),
  budget_contract: Object.freeze({ max_turns: 64, authority: "reduction_only" as const }),
});

const capabilityManifestRevisionInput = Object.freeze({
  agent_tiers: CAPABILITY_TIER,
  roles: NATIVE_ROLE_IDS,
  role_authority: NATIVE_ROLE_AUTHORITY_MANIFEST,
  model_tool_ids: NATIVE_MODEL_TOOL_IDS,
  operations: MCP_SERVER_OPERATIONS,
  tool_risks: NATIVE_TOOL_RISK_MANIFEST,
  skills: NATIVE_SKILL_CAPABILITY_MANIFEST,
  skill_descriptor: NATIVE_SKILL_DESCRIPTOR_MANIFEST,
  runtime_catalog: RUNTIME_CATALOG_MANIFEST,
  destructive_runtime_kinds: DESTRUCTIVE_RUNTIME_KINDS,
  open_world_runtime_kinds: OPEN_WORLD_RUNTIME_KINDS,
});

/** Stable hash binding the shared declarations, including the runtime catalog. */
export const CAPABILITY_MANIFEST_REVISION = `sha256:${createHash("sha256")
  .update(canonicalizeForHash(capabilityManifestRevisionInput))
  .digest("hex")}`;
