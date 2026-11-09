/**
 * MCP composition seam for revoy-native role profiles.
 *
 * `@arbor/prompts` owns role meaning and prompt text; this module is the
 * narrow boundary that converts that declarative authority into the harness's
 * enforceable profile and caller-owned governed context.  It intentionally
 * does not select models, start sessions, or grant filesystem authority.
 */
import {
  composeRolePrompt,
  type NativeRoleProfileId,
  type RolePromptCompositionInput,
} from "@arbor/prompts";
import type { HarnessCapability, NativeExecutionProfile, NativeGovernedContext } from "@arbor/harness";
import { type ArborAgentName } from "@arbor/core";
import { skillPatternCoveredBy } from "./skills/catalog.js";

/**
 * Extends `RolePromptCompositionInput`, so this input's `environment` field
 * (ADR-103's typed snapshot, resolved fresh via `resolveEnvironmentSnapshot`
 * immediately before composition) threads straight through to
 * `composeRolePrompt` below with no separate plumbing: the caller populates
 * `input.environment` and `composeNativeRole`'s `composed.prompt` carries
 * the rendered block, closing the gap tranche 1 left on the now-default
 * native path (ADR-099).
 */
export interface NativeRoleCompositionInput extends RolePromptCompositionInput {
  /** The host's actual tool ports. Role policy can only reduce this set. */
  readonly available_tools: readonly string[];
  /**
   * Deliberately composed extra tools for a general specialist turn. This is
   * for a host-owned port such as a task-specific verifier, not a model
   * request; Architect, Documentation Writer, and Critic profiles never
   * accept extensions through this field.
   */
  readonly permitted_extension_tools?: readonly string[];
  /** A validated skill can only reduce the role/host tool intersection. */
  readonly skill_allowed_tools?: readonly string[];
  /** Validated declarative write patterns; the execution host still enforces exact paths. */
  readonly skill_write_path_patterns?: readonly string[];
  /**
   * `file.write`/`file.patch` for documentation roles are safe only when the
   * host enforces the declared documentation paths at the filesystem boundary.
   * Omit/false fails closed to read-only rather than trusting model prose.
   */
  readonly documentation_path_policy_enforced?: boolean;
}

export interface NativeRoleComposition {
  readonly role_id: NativeRoleProfileId;
  readonly prompt: string;
  readonly profile: NativeExecutionProfile;
  readonly governed_context: NativeGovernedContext;
  /** Visible composition fact for diagnostics and tests; never model authority. */
  readonly documentation_writes_admitted: boolean;
  /** The skill-reduced path projection consumed by the exact action-scope filter. */
  readonly effective_write_path_patterns: readonly string[];
}

/**
 * Intersect a role's declarative policy with host capabilities before worker
 * admission. A profile can never expand an executor's tool authority.
 */
export function composeNativeRole(input: NativeRoleCompositionInput): NativeRoleComposition {
  const composed = composeRolePrompt(input);
  const isImplementationWriteForbidden = composed.profile.tool_policy.implementation_writes_forbidden;
  const documentationWritesAdmitted = isImplementationWriteForbidden && input.documentation_path_policy_enforced === true;
  const baselineTools = composed.profile.tool_policy.allowed_tools.filter((tool) =>
    input.available_tools.includes(tool)
    && (!isImplementationWriteForbidden || documentationWritesAdmitted || (tool !== "file.write" && tool !== "file.patch")),
  );
  const extensionTools = composed.profile.role_id === "specialist-executor"
    ? (input.permitted_extension_tools ?? []).filter((tool) => input.available_tools.includes(tool))
    : [];
  const roleTools = new Set(composed.profile.tool_policy.allowed_tools);
  const skillTools = input.skill_allowed_tools === undefined ? null : new Set(input.skill_allowed_tools.filter((tool) => roleTools.has(tool)));
  const allowedTools = [...new Set([...baselineTools, ...extensionTools])].filter((tool) => skillTools === null || (roleTools.has(tool) && skillTools.has(tool)));
  const roleWritePaths = composed.profile.tool_policy.documentation_path_patterns;
  const declaredWritePaths = input.skill_write_path_patterns ?? roleWritePaths;
  // Runtime callers are not trusted merely because TypeScript says the skill
  // was validated. For the fixed documentation roles, repeat the catalog's
  // containment check here so a forged/stale descriptor cannot widen the
  // role's path ceiling at the composition boundary. Specialist patterns are
  // only further filters over manager-owned exact scopes (see narrowScopeToSkill).
  const effectiveWritePaths = composed.profile.tool_policy.implementation_writes_forbidden
    ? declaredWritePaths.filter((candidate) => roleWritePaths.some((parent) => skillPatternCoveredBy(candidate, parent)))
    : declaredWritePaths;
  const allowedCapabilities = composed.profile.capability_policy.allowed_capabilities.map(asHarnessCapability);
  const requiredCapabilities = composed.profile.capability_policy.required_capabilities.map((capability) => ({
    capability: asHarnessCapability(capability),
    minimum_grade: "native" as const,
  }));

  return Object.freeze({
    role_id: composed.profile.role_id,
    prompt: composed.prompt,
    profile: Object.freeze({
      role_id: composed.profile.role_id,
      allowed_tools: Object.freeze(allowedTools),
      allowed_capabilities: Object.freeze(allowedCapabilities),
      required_capabilities: Object.freeze(requiredCapabilities),
    }),
    governed_context: Object.freeze({
      instructions: Object.freeze((input.governed_instructions ?? []).map((instruction) => Object.freeze({ ...instruction }))),
      artifacts: Object.freeze((input.governed_artifacts ?? []).map((artifact) => Object.freeze({ ...artifact }))),
    }),
    documentation_writes_admitted: documentationWritesAdmitted,
    effective_write_path_patterns: Object.freeze([...effectiveWritePaths]),
  });
}

/**
 * Botanical agents `opencode`'s own `permissions.ts` (ADR-001/ADR-005) grants
 * full `edit`/`write` authority within their worktree: Heartwood and Seed
 * only. Every other subagent — Lenticel/Burl/Xylem (critics) and
 * Rhizome/Mycelium/Stoma (research specialists) — is documented there as
 * "read-only. Cannot edit, cannot delegate." A `specialize` turn for one of
 * these agents must resolve to a role with no write/shell authority, exactly
 * as the opencode permission table already enforces for the same name.
 */
const WRITE_CAPABLE_BOTANICAL_AGENTS: ReadonlySet<ArborAgentName> = new Set(["heartwood", "seed"]);
const READ_ONLY_BOTANICAL_AGENTS: ReadonlySet<ArborAgentName> = new Set([
  "lenticel", "burl", "xylem", "rhizome", "mycelium", "stoma",
]);

/**
 * The campaign loop still uses botanical agent names. This mapping keeps the
 * new profiles selectable at composition without changing that public loop
 * vocabulary: callers can explicitly select Architect/Documentation Writer
 * for a suitable action, while ordinary specialist and critic turns retain a
 * least-authority default.
 *
 * Total and fail-closed by construction: this function enumerates every
 * value it accepts for `specialize` — the two native-only role names, the
 * two write-capable botanical agents, and the six read-only botanical
 * agents (mapped to `critic-reviewer`, the only native profile with no
 * write/shell tools, matching their opencode `permissions.ts` grant) — and
 * throws for anything else, including Crown/Cambium (orchestrators, never a
 * valid `specialize` delegate) and any misspelled or unrecognized agent
 * name. `agent` reaches this function as caller/model-supplied input
 * (`specialist_agent` is an unconstrained MCP tool-schema string in
 * `tools.ts`), so an unmapped value must never silently resolve to
 * `specialist-executor` — the one profile with `shell.execute`,
 * `file.write`, and `file.patch` — which is what the previous catch-all
 * `return "specialist-executor"` did for every name it didn't recognize.
 */
export function defaultNativeRoleFor(input: { readonly operation: "specialize" | "review"; readonly agent: string }): NativeRoleProfileId {
  if (input.operation === "review") return "critic-reviewer";
  if (input.agent === "architect" || input.agent === "taproot") return "architect";
  if (input.agent === "documentation-writer") return "documentation-writer";
  if (WRITE_CAPABLE_BOTANICAL_AGENTS.has(input.agent as ArborAgentName)) return "specialist-executor";
  if (READ_ONLY_BOTANICAL_AGENTS.has(input.agent as ArborAgentName)) return "critic-reviewer";
  throw new Error(
    `defaultNativeRoleFor: no native role authority is defined for specialize agent ${JSON.stringify(input.agent)}. ` +
    "An unrecognized agent must never fall through to a permissive default; pass execution_role explicitly if this agent genuinely needs native execution.",
  );
}

function asHarnessCapability(value: string): HarnessCapability {
  switch (value) {
    case "streaming":
    case "interruption":
    case "resumption":
    case "forking":
    case "ephemeral_sessions":
    case "structured_output":
    case "tool_policy":
    case "workspace_isolation":
    case "approval_mediation":
    case "usage_reporting":
    case "artifact_capture":
    case "remote_transport":
      return value;
    default:
      throw new Error(`unknown harness capability in role profile: ${value}`);
  }
}
