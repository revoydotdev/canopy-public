/**
 * Arbor agent + category taxonomy — neutral vocabulary shared by every
 * package that dispatches work to a botanical agent, moved here from
 * `@arbor/opencode` because it carries no OpenCode SDK coupling.
 *
 * These categories are consumed by the opencode task tool's category parameter
 * and by the /arbor, /plan, /review-loop skills. Each category bundles:
 *   - subagent_type: which botanical agent handles it
 *   - description: when the dispatcher should pick this category
 *   - model_hint: optional model override (advisory)
 *
 * From ROADMAP §2.2 — the five categories:
 *   crown-structural — architecture, multi-system tradeoffs, design decisions
 *   heartwood-deep    — autonomous multi-step implementation work
 *   seed-quick        — single-file, well-scoped, isolated worktree changes
 *   leaf-visual       — UI/UX, screenshots, design QA (Stoma)
 *   sap-write         — documentation, plans, prose, reports
 */

import { deriveNodeCard, type NodeCard, type NodeCardInputs } from "./node-card.js";
import { CAPABILITY_TIER } from "./capability-manifest.js";

export { CAPABILITY_TIER };

/**
 * The 11 botanical agents.
 *
 * Declared as a union rather than derived from an `as const` array: the array
 * form left a runtime value with no consumer outside its own tests (its
 * reachability waiver recommended deletion, taken 2026-08-06). Nothing is lost
 * by dropping it — `ARBOR_AGENTS` is a `Record<ArborAgentName, ...>`, so the
 * compiler already forces every member of this union to be present there, and
 * that record is the runtime enumeration callers actually use.
 */
export type ArborAgentName =
  | "crown" | "cambium" | "taproot"
  | "heartwood" | "seed"
  | "lenticel" | "burl" | "xylem"
  | "rhizome" | "mycelium" | "stoma";

/** The 5 categories that map intent → specialist routing. Same rationale as above; `ARBOR_CATEGORIES` is the runtime enumeration. */
export type ArborCategoryName =
  | "crown-structural"
  | "heartwood-deep"
  | "seed-quick"
  | "leaf-visual"
  | "sap-write";

/** A category definition — the routing unit for the task tool. */
export interface ArborCategory {
  name: ArborCategoryName;
  description: string;
  /** Which botanical agent this category dispatches to. */
  subagent_type: ArborAgentName;
  /** Model advisory override (stronger reasoning for structural, faster for seed). */
  model_hint?: { model: string; variant?: string };
}

/**
 * G-33 (narrowed, wave 3): the single per-agent default-model table. Lives
 * here, not in `agents.ts`, because `agents.ts` already imports
 * `ARBOR_CATEGORIES` from this file (for `agentSkills`) — the opposite
 * import direction would cycle. `agents.ts` imports this constant for its
 * own `resolveModel`, and every category's `model_hint` below is derived
 * from it by `subagent_type` rather than re-typed as an independent literal.
 * Before this, `model_hint` was its own hand-maintained map that happened to
 * agree with `agents.ts`'s (then-separate) `MODEL_DEFAULTS` by coincidence,
 * not by construction — the exact "two instances of the same shape" defect
 * called out alongside the original G-33 fix. There is now exactly one
 * hardcoded model-per-agent table in the package.
 */
export const AGENT_MODEL_DEFAULTS: Record<ArborAgentName, { model: string; variant?: string }> = {
  crown: { model: "anthropic/claude-opus-4", variant: "high" },
  cambium: { model: "anthropic/claude-sonnet-4" },
  taproot: { model: "anthropic/claude-opus-4" },
  heartwood: { model: "anthropic/claude-sonnet-4" },
  seed: { model: "anthropic/claude-sonnet-4" },
  lenticel: { model: "anthropic/claude-opus-4", variant: "high" },
  burl: { model: "anthropic/claude-opus-4", variant: "high" },
  xylem: { model: "anthropic/claude-sonnet-4" },
  rhizome: { model: "anthropic/claude-haiku" },
  mycelium: { model: "anthropic/claude-haiku" },
  stoma: { model: "anthropic/claude-sonnet-4" },
};

/** An operator's real `categories.*.model` values from `arbor.jsonc`, keyed by category. */
export type CategoryModelOverrides = Partial<Record<ArborCategoryName, string>>;

/** Runtime model identities advertised by the composed harness. */
export type AvailableModelCatalog = ReadonlySet<string>;

export interface CategoryModelResolution {
  readonly model: string;
  readonly variant?: string;
  readonly source: "configured" | "default";
  readonly requested_model?: string;
}

/**
 * G-35: the single read point for a category's effective model.
 *
 * `arbor.jsonc`'s `categories.*.model` had a schema entry and no reader — an
 * operator could set it and nothing anywhere would change, which is the same
 * shape as G-33's `agents.*.model` before that was wired. This mirrors
 * `agents.ts`'s `resolveModel`: an operator's configured value wins, and the
 * built-in `model_hint` (itself derived from `AGENT_MODEL_DEFAULTS` by
 * `subagent_type`) is the fallback.
 *
 * The category model stays *advisory*, exactly as `model_hint` always was —
 * ADR-001's routing is capability-based and a model hint has never overridden
 * where work is dispatched. Wiring the config key changes which model a
 * category suggests, never which agent it routes to.
 */
export function resolveCategoryModel(
  name: ArborCategoryName,
  overrides?: CategoryModelOverrides,
  availableModels?: AvailableModelCatalog,
): { model: string; variant?: string } | undefined {
  const configured = overrides?.[name];
  const fallback = ARBOR_CATEGORIES[name].model_hint;
  if (!configured || configured === "auto") return fallback;
  if (availableModels === undefined || availableModels.has(configured)) return { model: configured };
  if (fallback !== undefined && availableModels.has(fallback.model)) return fallback;
  throw new Error(`category model unavailable: ${name} requested ${configured}; no configured fallback is available`);
}

/** Resolve a category against the live catalog, retaining fallback provenance. */
export function resolveCategoryModelWithFallback(
  name: ArborCategoryName,
  overrides: CategoryModelOverrides | undefined,
  availableModels: AvailableModelCatalog,
): CategoryModelResolution {
  const configured = overrides?.[name];
  const fallback = ARBOR_CATEGORIES[name].model_hint;
  if (configured && configured !== "auto" && availableModels.has(configured)) {
    return Object.freeze({ model: configured, source: "configured" as const });
  }
  if (fallback !== undefined && availableModels.has(fallback.model)) {
    return Object.freeze({
      model: fallback.model,
      ...(fallback.variant === undefined ? {} : { variant: fallback.variant }),
      source: "default" as const,
      ...(configured && configured !== "auto" ? { requested_model: configured } : {}),
    });
  }
  const requested = configured && configured !== "auto" ? configured : "<default>";
  throw new Error(`category model unavailable: ${name} requested ${requested}; no configured fallback is available`);
}

export const CROWN_STRUCTURAL: ArborCategory = {
  name: "crown-structural",
  description:
    "Architecture decisions, multi-system tradeoffs, design choices. " +
    "Dispatches to Burl (read-only reasoning consultant) for analysis, or " +
    "Crown (orchestrator) when the loop must drive tree-search selection.",
  subagent_type: "burl",
  model_hint: AGENT_MODEL_DEFAULTS.burl,
};

export const HEARTWOOD_DEEP: ArborCategory = {
  name: "heartwood-deep",
  description:
    "Goal-oriented autonomous problem-solving on hairy, multi-step work. " +
    "Dispatches to Heartwood, which can spawn Rhizome/Mycelium for research " +
    "and self-plans during execution.",
  subagent_type: "heartwood",
  model_hint: AGENT_MODEL_DEFAULTS.heartwood,
};

export const SEED_QUICK: ArborCategory = {
  name: "seed-quick",
  description:
    "Single-file, well-scoped changes in an isolated git worktree. " +
    "Dispatches to Seed — the leaf executor. Cannot delegate. Self-validates " +
    "(compile, typecheck, tests, lsp_diagnostics) before submitting.",
  subagent_type: "seed",
  model_hint: AGENT_MODEL_DEFAULTS.seed,
};

export const LEAF_VISUAL: ArborCategory = {
  name: "leaf-visual",
  description:
    "Visual QA, screenshot analysis, UI/UX evaluation, diagram interpretation. " +
    "Dispatches to Stoma (vision/multimodal agent).",
  subagent_type: "stoma",
  model_hint: AGENT_MODEL_DEFAULTS.stoma,
};

export const SAP_WRITE: ArborCategory = {
  name: "sap-write",
  description:
    "Documentation, plans, reports, and prose. Dispatches to Taproot for plans, " +
    "or Cambium for collecting accumulated wisdom into documents.",
  subagent_type: "taproot",
  model_hint: AGENT_MODEL_DEFAULTS.taproot,
};

/** All five arbor categories, keyed by name. */
export const ARBOR_CATEGORIES: Record<ArborCategoryName, ArborCategory> = {
  "crown-structural": CROWN_STRUCTURAL,
  "heartwood-deep": HEARTWOOD_DEEP,
  "seed-quick": SEED_QUICK,
  "leaf-visual": LEAF_VISUAL,
  "sap-write": SAP_WRITE,
};

/**
 * Resolve an intent string to the best-fit category.
 *
 * This is used by the /arbor skill when it needs to pick a category for a
 * task(description, prompt, category=...) dispatch. The router is keyword-based
 * and intentionally simple — the intelligence is in the agent prompts.
 *
 * Returns the default category (seed-quick) when nothing matches, because
 * seed-quick is the safest leaf executor and the most common dispatch path.
 */
export function routeCategory(intent: string): ArborCategoryName {
  const lower = intent.toLowerCase();
  if (/(architecture|design decision|tradeoff|refactor strategy|risk|adr)/.test(lower)) {
    return "crown-structural";
  }
  if (/(screenshot|visual|ui|ux|design qa|layout|diagram|figure)/.test(lower)) {
    return "leaf-visual";
  }
  if (/(doc|document|plan|readme|report|prose|write up)/.test(lower)) {
    return "sap-write";
  }
  if (/(multi-step|complex|autonomous|investigate|deep dive|cross-cutting|end to end)/.test(lower)) {
    return "heartwood-deep";
  }
  // Default: well-scoped single-file work.
  return "seed-quick";
}

/**
 * Derive a live `NodeCard` for a campaign tree node so `selectNodeWithCard`
 * (Phase 4D.3, G-01) has real cards to route against instead of the
 * always-empty set that previously made `selectNodeByCapability` unreachable.
 *
 * Every node in the tree is a specialist-tier work item (the action a node
 * carries is dispatched to `action.delegate_to`), so `role`/`tier` are fixed
 * at "specialist". The card's `skills` are the routed category — this is
 * `routeCategory`'s one real caller outside its own tests — plus the node's
 * raw action category and delegate, so a task can match on either the
 * canonical 5-category vocabulary or the node's own labels.
 */
export function deriveCandidateNodeCard(
  node: {
    id: string;
    action_description: string;
    action_category: string;
    action_delegate: string;
  },
  secret: string,
): NodeCard {
  const routed = routeCategory(node.action_description);
  const skills = Array.from(
    new Set([routed, node.action_category, node.action_delegate].filter((s) => s.length > 0)),
  );
  const input: NodeCardInputs = {
    node_id: node.id,
    role: "specialist",
    skills,
    tier: "specialist",
    modes: ["steerable"],
    inputs: [],
    outputs: [],
    source: "node",
  };
  return deriveNodeCard(input, secret);
}
