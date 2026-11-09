/**
 * Arbor agent definitions for opencode.
 *
 * Each agent binds a botanical prompt (from @arbor/prompts) to an opencode agent
 * config. The capability tiers from ADR-005 (orchestrator / specialist / critic /
 * auditor) are enforced by the permission rulesets in `permissions.ts`.
 *
 * Agents:
 *   Crown    — tree driver, selects nodes via UCT (mode: primary)
 *   Cambium   — task conductor, delegates to specialists (mode: primary)
 *   Taproot   — strategic planner, interviews human (mode: primary)
 *   Heartwood — deep autonomous worker (mode: subagent, can spawn Rhizome/Mycelium)
 *   Seed      — isolated worktree executor (mode: subagent, cannot delegate)
 *   Lenticel  — critic, approval-biased (mode: subagent, read-only)
 *   Burl      — reasoning consultant (mode: subagent, read-only)
 *   Xylem     — gap analyzer (mode: subagent, read-only)
 *   Rhizome   — codebase search (mode: subagent, read-only)
 *   Mycelium  — external research (mode: subagent, read-only)
 *   Stoma     — vision / multimodal (mode: subagent, read-only)
 *
 * Checks-and-balances (ADR-001, ADR-003):
 *   - No agent both proposes and approves an action.
 *   - Specialists cannot read critic-only KB entries (enforced at MCP layer).
 *   - Self-approval is forbidden (enforced by tree controller).
 *   - Lenticel/Burl/Xylem are read-only — no edit permission.
 *   - Seed cannot spawn other agents — task permission denied.
 */

import { AGENT_PROMPTS, resolveEnvironmentSnapshot, resolveRepoInstructions, type TropismScope } from "@arbor/prompts";
import { deriveForeground, type ForegroundDelegationEntry, type ForegroundInputs, type ForegroundProjection, ARBOR_CATEGORIES, AGENT_MODEL_DEFAULTS, CAPABILITY_TIER } from "@arbor/core";
import type { ArborAgentName, OpencodeAgentConfig } from "./types.js";
import { permissionsFor } from "./permissions.js";

/** `CAPABILITY_TIER` moved to `@arbor/core`; re-exported for backward compatibility. */
export { CAPABILITY_TIER } from "@arbor/core";

/**
 * Model routing per agent. Crown/Burl/Lenticel run on stronger reasoning models;
 * Seeds run on capable code models; read-only research agents on cheaper models.
 * These are advisory defaults — consumers can override via opencode config merge.
 *
 * G-33 (narrowed, wave 3): this table now lives in `categories.ts` as
 * `AGENT_MODEL_DEFAULTS` — see its doc comment there for why (avoiding an
 * import cycle with `ARBOR_CATEGORIES`'s own `model_hint`, which is derived
 * from the same table). Bound to the pre-existing local name here so the
 * rest of this file (and its callers below) needs no further change.
 */
const MODEL_DEFAULTS = AGENT_MODEL_DEFAULTS;

/**
 * G-33: per-agent model overrides sourced from `arbor.jsonc`'s
 * `agents.*.model` (`@arbor/config`'s `ArborConfig.agents`). This module
 * stays structurally decoupled from `@arbor/config` — matching the
 * "compose at the CLI-leaf boundary" pattern `arbor-mcp`'s
 * `loop-ports-helper.ts` already uses — by accepting a plain
 * `Record<name, model>` here instead of importing `ArborConfig`. The real
 * composition root is `plugin.ts`'s `arborPlugin`, the one place a live
 * opencode session actually reads `arbor.jsonc` and registers these agent
 * configs; `"auto"` is `@arbor/config`'s own `DEFAULT_CONFIG.agents[name].model`
 * sentinel for "no override configured" and is filtered there, but is
 * defended against here too so any other caller can't misread the sentinel
 * as a real model id.
 */
export type AgentModelOverrides = Partial<Record<ArborAgentName, string>>;

/**
 * G-33: resolve the model (and advisory variant) `name` actually runs on.
 * A real `arbor.jsonc` override wins outright — and drops the built-in
 * variant hint, since a hand-picked variant (e.g. `"high"` reasoning
 * effort) is tied to the specific default model it was chosen for and may
 * not apply to whatever model the operator switched to. Absent a real
 * override, `MODEL_DEFAULTS` (and its variant) stays authoritative.
 */
function resolveModel(name: ArborAgentName, overrides?: AgentModelOverrides): { model: string; variant?: string } {
  const override = overrides?.[name];
  if (override && override !== "auto") return { model: override };
  return MODEL_DEFAULTS[name];
}

/**
 * Human-readable descriptions shown in the opencode agent selector.
 * These drive routing decisions in the task tool's `describeTask` output.
 */
const DESCRIPTIONS: Record<ArborAgentName, string> = {
  crown: "Tree-search orchestrator. Selects nodes via UCT, delegates expansion, scores results. Does NOT write code.",
  cambium: "Task conductor. Decomposes plans into actions, delegates to specialists, collects results.",
  taproot: "Strategic planner. Interviews the human to produce a reviewed plan in .arbor/plans/.",
  heartwood: "Deep autonomous worker for complex architectural work and cross-domain synthesis.",
  seed: "Isolated worktree executor. Single task, self-validates, cannot delegate.",
  lenticel: "Critic. Approval-biased but rigorous — runs the Five-Point Mandate before approving any action.",
  burl: "Read-only reasoning consultant for architecture decisions and hard debugging.",
  xylem: "Pre-planning gap analyzer. Catches what Taproot missed.",
  rhizome: "Fast codebase search. Answers where/which/find questions with file:line citations.",
  mycelium: "External research agent. Searches docs, OSS repos, and the web with citations.",
  stoma: "Vision and multimodal agent. Analyzes screenshots, UI layouts, diagrams.",
};

/**
 * `CAPABILITY_TIER` moved to `@arbor/core` — re-exported below for backward
 * compatibility (imported above, alongside `ARBOR_CATEGORIES`).
 */

/**
 * Primary agents drive the loop and can be invoked as the active agent in a session.
 * Subagents are dispatched via the task tool and cannot self-spawn except as noted.
 */
const PRIMARY_AGENTS: ReadonlySet<ArborAgentName> = new Set(["crown", "cambium", "taproot"]);
const SUBAGENT_AGENTS: ReadonlySet<ArborAgentName> = new Set([
  "heartwood", "seed", "lenticel", "burl", "xylem", "rhizome", "mycelium", "stoma",
]);

/**
 * Agents that may call the task tool (delegate to other agents).
 * Per ADR-001: Heartwood can spawn Rhizome/Mycelium. Seed cannot delegate.
 * Critic agents cannot delegate (separation of concerns — they only judge).
 */
const DELEGATING_AGENTS: ReadonlySet<ArborAgentName> = new Set([
  "crown", "cambium", "taproot", "heartwood",
]);

/**
 * HMAC secret for the live per-agent `ForegroundProjection` derived below
 * (Phase 4D.4, Appendix A). Same status as `loop.ts`'s
 * `DEFAULT_NODE_CARD_SECRET`: an internal-integrity signature over a
 * re-derivable projection, not a trust boundary yet — no external party
 * verifies it.
 */
export const DEFAULT_AGENT_FOREGROUND_SECRET = "arbor-agent-foreground-v1";

/**
 * G-02: the durable catalog half of an agent's per-model prompt derivation.
 * An agent's addressable skills are its own name plus every `ArborCategory`
 * whose `subagent_type` routes to it (Wave 3's live-card catalog — the same
 * `ARBOR_CATEGORIES` `deriveCandidateNodeCard` reads for tree nodes, reused
 * here for agents). Deduped: a category name and the agent's own name never
 * collide for any of the 11 agents, but dedupe defensively anyway since
 * `deriveNodeCard` rejects duplicate skills.
 */
function agentSkills(name: ArborAgentName): string[] {
  const fromCategories = Object.values(ARBOR_CATEGORIES)
    .filter((cat) => cat.subagent_type === name)
    .map((cat) => cat.name as string);
  return Array.from(new Set([name as string, ...fromCategories]));
}

/**
 * The agents `name` may delegate to, read from the same `permissionsFor`
 * ruleset the opencode `task` permission is built from (not a second,
 * hand-authored copy of the delegation rule) — crown/cambium/taproot's
 * `task: "allow"` is unrestricted (any subagent is a legal target); Heartwood's
 * narrower `{rhizome, mycelium}` object names its exact targets; everyone
 * else cannot delegate.
 */
function delegationCatalog(name: ArborAgentName): readonly ForegroundDelegationEntry[] {
  if (!DELEGATING_AGENTS.has(name)) return [];
  const task = permissionsFor(name, { canDelegate: true }).task;
  const targets: ArborAgentName[] =
    task === "allow"
      ? [...SUBAGENT_AGENTS]
      : typeof task === "object"
        ? (Object.keys(task) as ArborAgentName[]).filter((target) => task[target] === "allow")
        : [];
  return targets.map((target) => ({
    skill: target,
    target_node_id: target,
    target_tier: CAPABILITY_TIER[target],
  }));
}

/**
 * Derive the live `ForegroundProjection` (Phase 4D.4, Appendix A) for a
 * botanical agent: model family (from `MODEL_DEFAULTS`, or a real
 * `arbor.jsonc` override per G-33's `resolveModel`), tier (from
 * `CAPABILITY_TIER`), skills and delegation catalog (from the two helpers
 * above) — all durable, already-authoritative inputs. `deriveForeground` is
 * the pure re-derivable projection; nothing here is cached or baked.
 *
 * G-33/G-02: `modelOverrides` threads the same config-derived value
 * `buildAgentConfig` resolves the live `model` field from, so a config-
 * changed model and its derived prompt fragment can never drift apart into
 * a second two-sources-of-truth defect one level down.
 */
export function deriveAgentForeground(
  name: ArborAgentName,
  overrides?: ForegroundInputs["operator_overrides"],
  secret: string = DEFAULT_AGENT_FOREGROUND_SECRET,
  modelOverrides?: AgentModelOverrides,
): ForegroundProjection {
  const input: ForegroundInputs = {
    node_id: name,
    role: CAPABILITY_TIER[name],
    tier: CAPABILITY_TIER[name],
    model_family: resolveModel(name, modelOverrides).model,
    skills: agentSkills(name),
    delegation_catalog: delegationCatalog(name),
    operator_overrides: overrides,
    source: "builtin",
  };
  return deriveForeground(input, secret);
}

/** Re-derive a foreground projection for one live campaign dispatch.
 * Unlike the static registration projection above, this binds the card to
 * the selected tree node and accepts the operator override resolved for that
 * dispatch. Nothing is cached or persisted as a second authority. */
export function deriveDispatchForeground(
  name: ArborAgentName,
  nodeId: string,
  overrides?: ForegroundInputs["operator_overrides"],
  secret: string = DEFAULT_AGENT_FOREGROUND_SECRET,
  modelOverrides?: AgentModelOverrides,
): ForegroundProjection {
  return deriveForeground({
    node_id: nodeId,
    role: CAPABILITY_TIER[name],
    tier: CAPABILITY_TIER[name],
    model_family: resolveModel(name, modelOverrides).model,
    skills: agentSkills(name),
    delegation_catalog: delegationCatalog(name),
    operator_overrides: overrides,
    source: "node",
  }, secret);
}

/**
 * Build the opencode agent config for a single botanical agent.
 *
 * G-02: the system prompt is no longer the botanical role text alone — it's
 * derived from `(model family, catalog, tier, overrides)` via
 * `deriveAgentForeground`, and the resulting `prompt_fragment` (a bounded,
 * re-derivable projection, never a cached baked string) is threaded into
 * `@arbor/prompts` through `PromptContext.foregroundFragment`. Model choice
 * (`MODEL_DEFAULTS`) and prompt text now read from the same source instead
 * of being two independent maps. `campaignId`/`taskDescription` stay absent
 * here — those are genuinely unknown at static registration time; the loop
 * injects them via the skill prompts at runtime.
 *
 * `options.worktreePath` feeds ADR-022 (G-10)'s repo-instructions scope
 * (`resolveRepoInstructions`), resolved and rendered here for the same
 * reason `foregroundFragment` is: it is genuinely known at static
 * registration time (a root-level agent's worktree is the repo itself, not
 * a per-campaign value). Deliberately **root/plan-level only**
 * (`PRIMARY_AGENTS`: Crown/Cambium/Taproot) — a deep leaf (Seed, Heartwood,
 * the critics, the research specialists) never receives it here, matching
 * the scoping rule ADR-022 draws from Appendix E's OMO critique: repo
 * instructions must not be blanket-injected into every node regardless of
 * that node's own worktree. Absent `worktreePath` means "no repo-
 * instructions scope resolved" — typed absence, not a silent `process.cwd()`
 * guess.
 *
 * `options.modelOverrides` (G-33) resolves the live `model`/`variant` and
 * the derived `foreground.prompt_fragment` from the same
 * `arbor.jsonc`-sourced value via `resolveModel`/`deriveAgentForeground`, so
 * an operator's config edit reaches both together, never just one.
 */
export function buildAgentConfig(
  name: ArborAgentName,
  options: { worktreePath?: string; modelOverrides?: AgentModelOverrides; tropisms?: TropismScope } = {},
): OpencodeAgentConfig {
  const promptFn = AGENT_PROMPTS[name];
  if (!promptFn) {
    throw new Error(`Unknown arbor agent: ${name}`);
  }
  const isPrimary = PRIMARY_AGENTS.has(name);
  const isSubagent = SUBAGENT_AGENTS.has(name);
  if (!isPrimary && !isSubagent) {
    throw new Error(`Agent ${name} has no mode (not primary, not subagent)`);
  }
  const canDelegate = DELEGATING_AGENTS.has(name);

  const model = resolveModel(name, options.modelOverrides);
  const foreground = deriveAgentForeground(name, undefined, undefined, options.modelOverrides);
  const repoInstructions = isPrimary && options.worktreePath ? resolveRepoInstructions(options.worktreePath) : undefined;
  // ADR-103: environment facts are observed inputs, resolved at composition
  // time rather than cached, because git status moves under a concurrent
  // agent. Unlike repo instructions (root-only), every role gets the block —
  // a subagent that does not know its cwd or branch infers them, which is the
  // failure this decision exists to remove.
  const environment = options.worktreePath ? resolveEnvironmentSnapshot(options.worktreePath) : undefined;
  const config: OpencodeAgentConfig = {
    name,
    description: DESCRIPTIONS[name],
    system: promptFn({ foregroundFragment: foreground.prompt_fragment, repoInstructions, environment, ...(options.tropisms === undefined ? {} : { tropisms: options.tropisms }) }),
    mode: isPrimary ? "primary" : "subagent",
    model: model.model,
    ...(model.variant ? { variant: model.variant } : {}),
    color: agentColor(name),
    permission: permissionsFor(name, { canDelegate }),
    // Specialists must self-limit steps; orchestrators get more room.
    steps: isPrimary ? 48 : name === "heartwood" ? 32 : name === "seed" ? 16 : 24,
    disabled: false,
  };
  return config;
}

/**
 * All 11 botanical agent configs, keyed by agent name.
 * Used by the plugin's config hook to merge into opencode's `agent` block.
 * `options.worktreePath` and `options.modelOverrides` (G-33) both thread
 * through to `buildAgentConfig` — see its doc comment.
 */
export function buildAllAgents(
  options: { worktreePath?: string; modelOverrides?: AgentModelOverrides } = {},
): Record<ArborAgentName, OpencodeAgentConfig> {
  const out = {} as Record<ArborAgentName, OpencodeAgentConfig>;
  for (const name of Object.keys(AGENT_PROMPTS) as ArborAgentName[]) {
    out[name] = buildAgentConfig(name, options);
  }
  return out;
}

/**
 * Color hint for the TUI status indicator (opencode color tokens).
 * Trees: crown/cambium/taproot/heartwood/seed = green.
 * Bark: lenticel/burl/xylem = warning (amber).
 * Network: rhizome/mycelium/stoma = accent (blue).
 */
function agentColor(name: ArborAgentName): string {
  if (name === "crown" || name === "cambium" || name === "taproot" || name === "heartwood" || name === "seed") {
    return "success";
  }
  if (name === "lenticel" || name === "burl" || name === "xylem") {
    return "warning";
  }
  return "accent";
}
