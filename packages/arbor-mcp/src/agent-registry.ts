/**
 * Agent registry backend (roadmap 4C, item 15).
 *
 * Distinguishes agent DEFINITIONS (static, bounded config describing an
 * agent's role/identity/capability tier) from LIVE INSTANCES (derived from
 * the canonical supervisor's reconciled task state — never fabricated, never
 * a separate durable counter). Availability/liveness is a projection over
 * live/reconciled tasks, not a second authoritative source. Absent capability
 * tiers stay absent. Never exposes prompt content; only role metadata.
 */

import { compareCodeUnits } from "@arbor/core";
import type { TaskSupervisor } from "@arbor/core";

export type AgentRole = "crown" | "cambium" | "taproot" | "heartwood" | "seed" | "lenticel" | "burl" | "xylem" | "mycelium" | "rhizome" | "stoma";

export type AgentCapabilityTier = "orchestrator" | "specialist" | "critic" | "auditor";

export interface AgentDefinition {
  name: AgentRole;
  tier: AgentCapabilityTier;
  description: string;
  category_specialization?: string;
}

/** Static definition source — injected so mcp never imports arbor-opencode. */
export interface AgentDefinitionSource {
  definitions(): readonly AgentDefinition[];
}

export interface LiveAgentInstance {
  agent: AgentRole;
  operation_id: string;
  task_id: string;
  kind: string;
  state: string;
  owner_scope_id: string;
}

export interface AgentRegistryView {
  definitions: readonly AgentDefinition[];
  live: readonly LiveAgentInstance[];
  active_agent_count: number;
}

const MAX_DEFINITIONS = 64;
const MAX_LIVE_INSTANCES = 10_000;

/** Map a supervised task kind to the agent role it exercises, if any. */
export function agentFromTaskKind(kind: string): AgentRole | null {
  const lowered = kind.toLowerCase();
  for (const role of AGENT_ROLES) {
    if (lowered.includes(role)) return role;
  }
  return null;
}

export const AGENT_ROLES: readonly AgentRole[] = [
  "crown", "cambium", "taproot", "heartwood", "seed",
  "lenticel", "burl", "xylem", "mycelium", "rhizome", "stoma",
];

/** Imported from arbor-config AGENT_NAMES semantics, mirrored as closed ids. */
const AGENT_ROLE_SET = new Set<string>(AGENT_ROLES);

export function isAgentRole(value: string): value is AgentRole {
  return AGENT_ROLE_SET.has(value);
}

/** Compose definitions + live instances into one bounded registry view. */
export function composeAgentRegistry(input: {
  definitions: readonly AgentDefinition[];
  supervisor: TaskSupervisor;
  include_terminal?: boolean;
}): AgentRegistryView {
  const definitions = input.definitions.slice(0, MAX_DEFINITIONS);
  const definitionsByName = new Map<string, AgentDefinition>();
  for (const definition of definitions) definitionsByName.set(definition.name, definition);

  const tasks = input.supervisor.list({ include_terminal: input.include_terminal ?? false });
  const live: LiveAgentInstance[] = [];
  for (const task of tasks.slice(0, MAX_LIVE_INSTANCES)) {
    const agent = agentFromTaskKind(task.kind);
    if (agent === null) continue;
    // Only surface instances whose agent role is a known definition (no fabricated availability)
    if (!definitionsByName.has(agent)) continue;
    live.push({
      agent,
      operation_id: task.operation_id,
      task_id: task.id,
      kind: task.kind,
      state: task.state,
      owner_scope_id: task.owner_scope_id,
    });
  }
  live.sort((left, right) => compareCodeUnits(left.agent, right.agent) || compareCodeUnits(left.task_id, right.task_id));

  return {
    definitions,
    live,
    active_agent_count: live.length,
  };
}

/** Immutable service holding the definition source + supervisor. */
export class AgentRegistry {
  constructor(private readonly source: AgentDefinitionSource, private readonly supervisor: TaskSupervisor) {}

  reg(details: { include_terminal?: boolean } = {}): AgentRegistryView {
    return composeAgentRegistry({ definitions: this.source.definitions(), supervisor: this.supervisor, include_terminal: details.include_terminal });
  }
}
