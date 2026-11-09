/**
 * Permission rulesets per botanical agent.
 *
 * Enforces ADR-001 (checks-and-balances) and ADR-005 (capability tiers) at the
 * opencode tool layer:
 *
 *   - Orchestrators (crown, cambium, taproot): can edit .arbor/, run MCP tools,
 *     delegate. Crown/Cambium do NOT edit source code — they orchestrate.
 *   - Specialists (heartwood, seed, rhizome, mycelium, stoma):
 *       - Heartwood/Seed: full edit access within their worktree
 *       - Rhizome/Mycelium/Stoma: read-only research tools
 *   - Critics (lenticel, burl, xylem): read-only. Cannot edit, cannot delegate.
 *     This is the structural enforcement that no agent both proposes and approves.
 *
 * Common rules (applied to every agent):
 *   - arbor_* MCP tools: allow (every agent drives the tree search)
 *   - read/grep/glob/list: allow (every agent can read)
 *   - webfetch/websearch: allow (every agent can research)
 *   - external_directory: ask (safety net)
 *
 * The permission object uses opencode v1 nested-glob syntax:
 *   { edit: { "*": "deny", ".arbor/plans/*": "allow" } }
 * Last matching rule wins.
 */

import type { ArborAgentName, PermissionConfig, PermissionContext } from "./types.js";

/** Base permissions every arbor agent inherits. */
function basePermissions(): PermissionConfig {
  return {
    // Arbor MCP tools — all agents drive the tree search via these.
    arbor_start_campaign: "allow",
    arbor_select_node: "allow",
    arbor_expand_node: "allow",
    arbor_record_result: "allow",
    arbor_branch: "allow",
    arbor_prune: "allow",
    arbor_halt_check: "allow",
    arbor_kb_read: "allow",
    arbor_kb_query: "allow",
    arbor_kb_inject: "allow",
    arbor_get_state: "allow",
    // Read-only tools — universal.
    read: "allow",
    grep: "allow",
    glob: "allow",
    list: "allow",
    bash: { "*": "ask", "git status": "allow", "git log *": "allow", "git diff *": "allow", "git branch *": "allow", "npx vitest *": "allow", "npx tsc *": "allow", "npm test": "allow" },
    webfetch: "allow",
    websearch: "allow",
    // Safety nets.
    external_directory: "ask",
    // Editing is denied by default — agents must opt in.
    edit: "deny",
    write: "deny",
    // Delegation denied by default — agents must opt in.
    task: "deny",
    // Q&A and plan tools — primary orchestrators opt in.
    question: "deny",
    todowrite: "deny",
  };
}

/** Merge a partial override onto a base permission config (last write wins per key). */
function merge(base: PermissionConfig, overrides: PermissionConfig): PermissionConfig {
  const out: PermissionConfig = { ...base };
  for (const [key, value] of Object.entries(overrides)) {
    if (typeof value === "string" || typeof out[key] === "string" || out[key] === undefined) {
      out[key] = value;
    } else {
      // Both are nested glob objects — merge the globs.
      out[key] = { ...(out[key] as Record<string, typeof value[keyof typeof value]>), ...(value as Record<string, typeof value[keyof typeof value]>) };
    }
  }
  return out;
}

/**
 * Build the opencode permission config for a given agent.
 *
 * Capability-tier matrix (ADR-005):
 *
 *   tier          | edit code | edit .arbor | delegate | task→critics
 *   --------------|-----------|-------------|----------|-------------
 *   orchestrator  |   no*     |    yes      |   yes    |    yes
 *   specialist    |   yes**   |    no       | varies   |    no
 *   critic        |   no      |    no       |   no     |    no
 *   auditor       |   no      |    no       |   no     |    no
 *
 *   * Crown/Cambium orchestrate — they don't write code themselves. Taproot
 *     writes only to .arbor/plans/.
 *   ** Seed/Heartwood edit within their own worktree. Rhizome/Mycelium/Stoma
 *      are research-only specialists (no edit at all).
 */
export function permissionsFor(name: ArborAgentName, ctx: PermissionContext): PermissionConfig {
  const base = basePermissions();

  switch (name) {
    case "crown":
    case "cambium":
      // Orchestrators: edit only the .arbor/ working state, delegate freely.
      return merge(base, {
        edit: { "*": "deny", ".arbor/**": "allow" },
        write: { "*": "deny", ".arbor/**": "allow" },
        task: "allow",
        todowrite: "allow",
        question: "allow",
      });

    case "taproot":
      // Planner: edits only plans, can ask the human, can delegate to Xylem/Burl.
      return merge(base, {
        edit: { "*": "deny", ".arbor/plans/**": "allow" },
        write: { "*": "deny", ".arbor/plans/**": "allow" },
        task: "allow",
        question: "allow",
      });

    case "heartwood":
      // Deep worker: full edit, can spawn research subagents only if allowed.
      return merge(base, {
        edit: "allow",
        write: "allow",
        task: ctx.canDelegate ? { rhizome: "allow", mycelium: "allow" } : "deny",
        todowrite: "allow",
      });

    case "seed":
      // Isolated worker: full edit, NO delegation (ADR-001: Seed cannot spawn Seeds).
      return merge(base, {
        edit: "allow",
        write: "allow",
        // task: stays "deny" — seeds are leaf executors.
      });

    case "lenticel":
    case "burl":
    case "xylem":
      // Critics: read-only. Cannot edit, cannot delegate, cannot approve their own work.
      // (Approval happens via arbor_record_result which is allowed, but the agent
      // never edits source — this is the structural check against self-approval.)
      return merge(base, {
        // edit/write/task stay "deny" from base.
        question: "allow", // critics may surface blockers via question
      });

    case "rhizome":
    case "mycelium":
    case "stoma":
      // Research specialists: read-only, no delegation, no edits.
      return base;

    default: {
      const _exhaustive: never = name;
      throw new Error(`Unreachable: ${String(_exhaustive)}`);
    }
  }
}
