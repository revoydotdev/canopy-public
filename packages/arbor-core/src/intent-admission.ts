/**
 * Turn-local intent admission (ADR-062): a malformed or ambiguous request is
 * clarified or refused with a typed reason, never silently downgraded.
 */
import type { ArborAgentName, ArborCategoryName } from "./agent-taxonomy.js";
import type { IntentDecision, IntentRefusal } from "./intent-lifecycle.js";
import type { Provenance } from "./types.js";

/** A bounded, operator-visible scope supplied by the intake surface. */
export type IntentScopeKind = "path" | "symbol" | "package" | "component" | "campaign";

export interface IntentScope {
  readonly kind: IntentScopeKind;
  readonly value: string;
}

/** Dependencies are facts at admission time; provider output never resolves them implicitly. */
export interface IntentDependency {
  readonly id: string;
  readonly owner: "oracle" | "librarian" | "explore" | "operator";
  readonly status: "pending" | "resolved" | "failed";
  readonly blocking: boolean;
}

export type IntentAdmissionVerb =
  | "build" | "change" | "research" | "explain" | "review" | "operate";

export type IntentAdmissionRefusalCode =
  | "ambiguous"
  | "insufficient_scope"
  | "pending_dependency"
  | "stale"
  | "invalid"
  | "policy";

export interface IntentAdmissionInput {
  readonly decision: IntentDecision;
  /** Raw request is used transiently for deterministic verb checking and is never persisted by this module. */
  readonly request: string;
  readonly turn_id: string;
  readonly scope: readonly IntentScope[];
  readonly dependencies?: readonly IntentDependency[];
  readonly policy?: IntentAdmissionPolicy;
}

export interface IntentAdmissionPolicy {
  /** Defaults to true: low-confidence or unknown routing must be clarified. */
  readonly require_confident_route?: boolean;
}

export interface IntentAdmissionBlocker {
  readonly code: IntentAdmissionRefusalCode;
  readonly reason: string;
  readonly retryable: boolean;
}

export type IntentAdmissionResult =
  | { readonly ok: true; readonly verb: IntentAdmissionVerb; readonly route_category: ArborCategoryName }
  | { readonly ok: false; readonly disposition: "clarify" | "refuse"; readonly blockers: readonly IntentAdmissionBlocker[] };

export type IntentAdmissionPhase =
  | "intent"
  | "clarification_required"
  | "admitted"
  | "planned"
  | "reviewed"
  | "dispatched"
  | "verified"
  | "refused";

export interface IntentAdmissionResetOrigin {
  readonly intent_id: string;
  readonly decision_id: string;
  readonly turn_id: string;
}

export interface IntentAdmissionState {
  readonly schema_version: 1;
  readonly intent_id: string;
  readonly decision_id: string;
  readonly turn_id: string;
  readonly phase: IntentAdmissionPhase;
  readonly version: number;
  readonly decision: IntentDecision;
  readonly blockers: readonly IntentAdmissionBlocker[];
  readonly reset_from: IntentAdmissionResetOrigin | null;
}

export type IntentAdmissionEvent =
  | { readonly kind: "admit"; readonly turn_id: string; readonly request: string; readonly scope: readonly IntentScope[]; readonly dependencies?: readonly IntentDependency[]; readonly policy?: IntentAdmissionPolicy }
  | { readonly kind: "plan"; readonly turn_id: string; readonly plan_id: string; readonly action_ids: readonly string[] }
  | { readonly kind: "review"; readonly turn_id: string; readonly reviewer_id: string; readonly verdict: "approved" | "rejected" | "needs_clarification"; readonly rationale: string; readonly verified_blocker?: boolean }
  | { readonly kind: "dispatch"; readonly turn_id: string; readonly operation_id: string; readonly agent_id: ArborAgentName | string; readonly worktree_id: string | null }
  | { readonly kind: "verify"; readonly turn_id: string; readonly operation_id: string; readonly verification: Provenance; readonly summary: string }
  | { readonly kind: "refuse"; readonly turn_id: string; readonly refusal: IntentRefusal };

export interface IntentAdmissionTransitionFailure {
  readonly code: "stale" | "order" | "invalid" | "policy";
  readonly reason: string;
}

export type IntentAdmissionTransitionResult =
  | { readonly ok: true; readonly state: IntentAdmissionState }
  | { readonly ok: false; readonly error: IntentAdmissionTransitionFailure };

const VERB_PATTERNS: readonly [IntentAdmissionVerb, RegExp][] = [
  ["build", /\b(?:build|create|add|implement|introduce|scaffold)\b/iu],
  ["change", /\b(?:change|update|modify|refactor|fix|repair|remove|delete|migrat(?:e|ion)|replace)\b/iu],
  ["research", /\b(?:research|investigate|analy[sz]e|compare|examine|audit)\b/iu],
  ["explain", /\b(?:explain|describe|document|clarify)\b/iu],
  ["review", /\b(?:review|assess|evaluate|critique)\b/iu],
  ["operate", /\b(?:run|start|stop|restart|launch|deploy|serve)\b/iu],
];

const CLASS_FOR_VERB: Record<IntentAdmissionVerb, IntentDecision["classification"]> = {
  build: "build", change: "change", research: "research", explain: "explain", review: "review", operate: "operate",
};

const SCOPE_KINDS: readonly IntentScopeKind[] = ["path", "symbol", "package", "component", "campaign"];

function blocker(code: IntentAdmissionRefusalCode, reason: string, retryable: boolean): IntentAdmissionBlocker {
  return Object.freeze({ code, reason, retryable });
}

function validScope(scope: readonly IntentScope[]): boolean {
  return Array.isArray(scope) && scope.length > 0 && scope.every((item) => item !== null && typeof item === "object" && SCOPE_KINDS.includes(item.kind) && typeof item.value === "string" && item.value.trim().length > 0 && item.value.length <= 512);
}

function detectedVerb(request: string): IntentAdmissionVerb | null {
  for (const [verb, pattern] of VERB_PATTERNS) if (pattern.test(request)) return verb;
  return null;
}

function matchingClass(verb: IntentAdmissionVerb, classification: IntentDecision["classification"]): boolean {
  return CLASS_FOR_VERB[verb] === classification;
}

/**
 * Check the semantic facts that a prompt cannot safely assert for itself.
 * This function is deterministic: no model calls, wall clock, mutable state,
 * or provider registry are consulted.
 */
export function validateIntentAdmission(input: IntentAdmissionInput): IntentAdmissionResult {
  const blockers: IntentAdmissionBlocker[] = [];
  if (typeof input.request !== "string" || input.request.trim().length === 0 || input.request.length > 16_384) {
    blockers.push(blocker("invalid", "the request must be bounded and non-empty", false));
  }
  if (typeof input.turn_id !== "string" || input.turn_id.trim().length === 0) {
    blockers.push(blocker("invalid", "turn_id is required for turn-local admission", false));
  }
  const verb = detectedVerb(input.request);
  if (verb === null) blockers.push(blocker("ambiguous", "the request does not contain an explicit implementation or operation verb", true));
  else if (!matchingClass(verb, input.decision.classification)) blockers.push(blocker("ambiguous", `the explicit request verb ${verb} conflicts with decision classification ${input.decision.classification}`, true));
  if (!validScope(input.scope)) blockers.push(blocker("insufficient_scope", "admission requires at least one bounded concrete scope item", true));
  const dependencies = input.dependencies ?? [];
  if (!Array.isArray(dependencies)) blockers.push(blocker("invalid", "dependencies must be a list", false));
  for (const dependency of Array.isArray(dependencies) ? dependencies : []) {
    if (dependency === null || typeof dependency !== "object" || typeof dependency.id !== "string" || !["oracle", "librarian", "explore", "operator"].includes(dependency.owner) || typeof dependency.blocking !== "boolean" || !["pending", "resolved", "failed"].includes(dependency.status)) {
      blockers.push(blocker("invalid", "dependency records must have an owner, id, and closed status", false));
      continue;
    }
    if (dependency.status === "pending" && dependency.owner === "oracle" && dependency.blocking) {
      blockers.push(blocker("pending_dependency", `Oracle dependency ${dependency.id} is still pending`, true));
    }
    if (dependency.id.trim().length === 0) {
      blockers.push(blocker("invalid", "dependency records must have an id and a closed status", false));
    }
  }
  if (input.decision.disposition === "refuse") blockers.push(blocker(input.decision.refusal?.code === "policy" ? "policy" : "invalid", input.decision.refusal?.reason ?? "the decision refuses admission", input.decision.refusal?.retryable ?? false));
  if (input.decision.disposition === "clarify") blockers.push(blocker("ambiguous", input.decision.refusal?.reason ?? "the decision requires clarification", true));
  if ((input.policy?.require_confident_route ?? true) && (input.decision.confidence === "low" || input.decision.route_category === null)) blockers.push(blocker("ambiguous", "a low-confidence decision or missing route requires clarification", true));
  if (blockers.length > 0) return { ok: false, disposition: blockers.some((item) => item.retryable) ? "clarify" : "refuse", blockers: Object.freeze(blockers) };
  return { ok: true, verb: verb!, route_category: input.decision.route_category! };
}

function transitionError(code: IntentAdmissionTransitionFailure["code"], reason: string): IntentAdmissionTransitionResult {
  return { ok: false, error: Object.freeze({ code, reason }) };
}

function requireTurn(state: IntentAdmissionState, turn_id: string): IntentAdmissionTransitionResult | null {
  return state.turn_id === turn_id ? null : transitionError("stale", `turn ${turn_id} is stale; active turn is ${state.turn_id}`);
}

function next(state: IntentAdmissionState, phase: IntentAdmissionPhase, blockers: readonly IntentAdmissionBlocker[] = []): IntentAdmissionState {
  return Object.freeze({ ...state, phase, version: state.version + 1, blockers: Object.freeze([...blockers]) });
}

/** Create a fresh turn with no inherited plan, dependencies, or refusal. */
export function createIntentAdmissionState(decision: IntentDecision, turn_id: string, reset_from: IntentAdmissionResetOrigin | null = null): IntentAdmissionState {
  if (turn_id.trim().length === 0) throw new Error("turn_id is required");
  return Object.freeze({ schema_version: 1, intent_id: decision.intent_id, decision_id: decision.decision_id, turn_id, phase: "intent", version: 0, decision, blockers: Object.freeze([]), reset_from });
}

/** Turn-local reset: a new decision and turn are required; prior blockers cannot leak forward. */
export function resetIntentTurn(state: IntentAdmissionState, decision: IntentDecision, turn_id: string): IntentAdmissionState {
  if (turn_id === state.turn_id) throw new Error("intent reset requires a new turn_id");
  return createIntentAdmissionState(decision, turn_id, { intent_id: state.intent_id, decision_id: state.decision_id, turn_id: state.turn_id });
}

/** Apply one legal event. The returned state is immutable and suitable for CAS persistence. */
export function transitionIntentAdmission(state: IntentAdmissionState, event: IntentAdmissionEvent): IntentAdmissionTransitionResult {
  const stale = requireTurn(state, event.turn_id);
  if (stale !== null) return stale;
  if (state.phase === "verified" || state.phase === "refused") return transitionError("order", `intent is terminal in phase ${state.phase}`);
  if (event.kind === "admit") {
    if (state.phase !== "intent") return transitionError("order", `admission requires intent phase, got ${state.phase}`);
    const result = validateIntentAdmission({ decision: state.decision, request: event.request, turn_id: event.turn_id, scope: event.scope, dependencies: event.dependencies, policy: event.policy });
    if (!result.ok) return { ok: true, state: next(state, result.disposition === "clarify" ? "clarification_required" : "refused", result.blockers) };
    return { ok: true, state: next(state, "admitted") };
  }
  if (event.kind === "refuse") {
    if (event.refusal.reason.trim().length === 0) return transitionError("invalid", "refusal reason is required");
    return { ok: true, state: next(state, "refused", [blocker(event.refusal.code as IntentAdmissionRefusalCode, event.refusal.reason, event.refusal.retryable)]) };
  }
  if (event.kind === "plan") {
    if (state.phase !== "admitted" || !state.decision.requires_plan) return transitionError("order", "planning is only legal after admission when the decision requires a plan");
    if (event.plan_id.trim().length === 0 || event.action_ids.length === 0) return transitionError("invalid", "plan_id and action_ids are required");
    return { ok: true, state: next(state, "planned") };
  }
  if (event.kind === "review") {
    const legal = state.phase === "planned" || (state.phase === "admitted" && !state.decision.requires_plan);
    if (!legal || !state.decision.requires_review) return transitionError("order", "review is not legal at the current phase or is not required");
    if (event.reviewer_id.trim().length === 0 || event.rationale.trim().length === 0) return transitionError("invalid", "reviewer and rationale are required");
    if (event.verdict === "needs_clarification") return { ok: true, state: next(state, "clarification_required", [blocker("ambiguous", event.rationale, true)]) };
    if (event.verdict === "rejected") {
      if (event.verified_blocker !== true) return transitionError("policy", "a rejected review must carry a verified blocker (Momus rule)");
      return { ok: true, state: next(state, "refused", [blocker("policy", event.rationale, false)]) };
    }
    return { ok: true, state: next(state, "reviewed") };
  }
  if (event.kind === "dispatch") {
    if (state.phase !== (state.decision.requires_review ? "reviewed" : state.decision.requires_plan ? "planned" : "admitted")) return transitionError("order", "dispatch requires all mandated admission stages");
    if (event.operation_id.trim().length === 0 || event.agent_id.trim().length === 0) return transitionError("invalid", "operation_id and agent_id are required");
    return { ok: true, state: next(state, "dispatched") };
  }
  if (event.kind === "verify") {
    if (state.phase !== "dispatched" || event.operation_id.trim().length === 0 || event.summary.trim().length === 0) return transitionError("order", "verification requires a dispatched operation and summary");
    return { ok: true, state: next(state, "verified") };
  }
  return transitionError("invalid", "unsupported intent admission event");
}
