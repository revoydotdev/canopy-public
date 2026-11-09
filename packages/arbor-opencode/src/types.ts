/**
 * Shared types for the arbor opencode plugin.
 *
 * These mirror the opencode v1/v2 agent + permission schemas but are declared
 * locally so the package type-checks and tests without `@opencode-ai/plugin`
 * installed as a hard dependency (it's an optional peer). At runtime, when the
 * plugin is loaded by opencode, the SDK types take precedence.
 */

/**
 * `ArborAgentName` and `ArborCategoryName` moved to `@arbor/core` — they are
 * plain string unions with no OpenCode coupling. Re-exported here for
 * backward compatibility.
 */
export type { ArborAgentName, ArborCategoryName } from "@arbor/core";

/** Opencode permission effect — last matching rule wins. */
export type PermissionEffect = "allow" | "deny" | "ask";

/** Opencode v1 permission config: { toolName: effect | { glob: effect } }. */
export type PermissionConfig = Record<string, PermissionEffect | Record<string, PermissionEffect>>;

/** Opencode agent config (v1 JSON shape — plugin merges this into opencode.json). */
export interface OpencodeAgentConfig {
  name: string;
  description: string;
  system: string;
  mode: "primary" | "subagent";
  model: string;
  variant?: string;
  color?: string;
  permission: PermissionConfig;
  /** Max tool calls before the agent is auto-stopped. */
  steps: number;
  disabled: boolean;
}

/** Read-only context the permission builder consumes. */
export interface PermissionContext {
  /** Whether the agent may invoke the task tool (delegate). */
  canDelegate: boolean;
}

// ============================================================
// PLANNING LAYER TYPES (ROADMAP §2.4 — Taproot + Xylem)
// ============================================================

/** Classical Taproot intent classification (plan.md Phase 1). */
export type PlanIntent =
  | "refactoring"
  | "greenfield"
  | "mid-sized"
  | "architecture"
  | "bug-fix";

/** One numbered step in a plan's Approach — becomes a candidate tree node. */
export interface PlanStep {
  description: string;
  estimated_gain: number;
  estimated_cost: number;
  category: string;
  delegate_to: "seed" | "heartwood" | "burl" | "stoma" | "taproot";
  constraints?: string[];
}

/** A named, specific risk (plan.md Phase 3 — risks are named, not generic). */
export interface PlanRisk {
  name: string;
  severity: "high" | "medium" | "low";
  detail: string;
}

/** A Xylem finding from gap analysis. */
export interface XylemFinding {
  category: "hidden_intention" | "ambiguity" | "ai_slop" | "missing_acceptance" | "edge_case";
  severity: "high" | "medium" | "low";
  issue: string;
  resolution?: string;
}

/** Lenticel's review verdict on a plan (Five-Point Mandate). */
export interface LenticelPlanVerdict {
  approved: boolean;
  rationale: string;
  root_cause?: string;
}

/** Burl's architectural review verdict. */
export interface BurlPlanVerdict {
  verdict: "ship" | "revise" | "reject";
  concerns: { severity: "high" | "medium" | "low"; issue: string; recommendation: string }[];
}

/**
 * The structured plan document. Produced by the planning layer (§2.4), written
 * to `.arbor/plans/<slug>.md`, and consumed by the campaign loop (root_action).
 */
export interface PlanDocument {
  title: string;
  slug: string;
  intent: PlanIntent;
  summary: string;
  context: string[];
  approach: PlanStep[];
  acceptance_criteria: string[];
  risks: PlanRisk[];
  out_of_scope: string[];
  status: "draft" | "xylem_reviewed" | "needs_revision" | "reviewed" | "approved";
  review?: {
    lenticel: LenticelPlanVerdict;
    burl: BurlPlanVerdict;
  };
  created_at: string; // ISO 8601
}

/** The review decision synthesized from Lenticel + Burl. */
export interface PlanReviewDecision {
  status: PlanDocument["status"];
  approved: boolean;
  rationale: string;
  lenticel: LenticelPlanVerdict;
  burl: BurlPlanVerdict;
}
