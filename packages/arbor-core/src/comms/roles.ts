/**
 * Communication roles: who a message comes from, and which botanical agents
 * may command another (ADR-083 amendment; operator decisions of 2026-10-07).
 *
 * Pure data and predicates. Nothing here reads a ledger or a session; the
 * caller resolves identities from the host (never from model input) and
 * hands them in.
 */
import type { ArborAgentName } from "../agent-taxonomy.js";

/**
 * Communication tier of each botanical agent. It refines `CAPABILITY_TIER`
 * (ADR-005) without widening it: the capability tier `orchestrator` splits
 * into `orchestrator` (may issue C2) and `planner` (may not).
 *
 * - `crown`, `cambium` — orchestrator. Crown is today the deterministic host
 *   loop (`arbor-opencode/src/loop.ts`), represented by the `host_loop`
 *   principal rather than a node; a node occupied by `crown` keeps the tier.
 *   Cambium is the LIVE MODEL ORCHESTRATOR (`LIVE_MODEL_ORCHESTRATOR_AGENT`).
 * - `taproot` — planner. It interviews the human and writes only `.arbor/`;
 *   it plans, it does not command running work.
 * - `heartwood`, `seed`, `rhizome`, `mycelium`, `stoma` — specialist. They
 *   never issue commands (operator decision 3).
 * - `lenticel`, `burl`, `xylem` — critic. Outside the command chain entirely:
 *   they neither issue nor receive C2 (operator decisions 3 and 6).
 */
export type CommsRoleTier = "orchestrator" | "planner" | "specialist" | "critic";

export const COMMS_ROLE_TIER: Readonly<Record<ArborAgentName, CommsRoleTier>> = Object.freeze({
  crown: "orchestrator",
  cambium: "orchestrator",
  taproot: "planner",
  heartwood: "specialist",
  seed: "specialist",
  rhizome: "specialist",
  mycelium: "specialist",
  stoma: "specialist",
  lenticel: "critic",
  burl: "critic",
  xylem: "critic",
});

/** Every botanical agent, in `COMMS_ROLE_TIER` declaration order. */
export const COMMS_AGENTS: readonly ArborAgentName[] = Object.freeze(Object.keys(COMMS_ROLE_TIER) as ArborAgentName[]);

/** The agent whose session is the live model orchestrator in v1 (operator decision 2). */
export const LIVE_MODEL_ORCHESTRATOR_AGENT = "cambium" as const satisfies ArborAgentName;

/**
 * A message author or command issuer. `operator` is the human; `host_loop` is
 * Crown's deterministic campaign loop; `agent` is a model session occupying a
 * tree node. The node id and agent are host-resolved from the session.
 */
export type CommsPrincipal =
  | { readonly kind: "operator" }
  | { readonly kind: "host_loop" }
  | CommsAgentPrincipal;

export interface CommsAgentPrincipal {
  readonly kind: "agent";
  readonly agent: ArborAgentName;
  readonly node_id: string;
}

/**
 * The structural slice of a campaign tree the authority rules read: each
 * node's direct parent and the agent occupying it. Built by the caller from
 * the real tree; this module never constructs one.
 */
export interface CommsTreeView {
  readonly nodes: Readonly<Record<string, { readonly parent_id: string | null; readonly agent: ArborAgentName }>>;
}

export function isArborAgentName(value: unknown): value is ArborAgentName {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(COMMS_ROLE_TIER, value);
}

/** True when the agent's tier may issue C2 at all (before any edge check). */
export function isC2IssuerAgent(agent: ArborAgentName): boolean {
  return COMMS_ROLE_TIER[agent] === "orchestrator";
}

/** True when the agent can be a C2 target. Critics never can. */
export function isC2TargetAgent(agent: ArborAgentName): boolean {
  return COMMS_ROLE_TIER[agent] !== "critic";
}
