import { createHash } from "node:crypto";
import { INTENT_LIFECYCLE_SCHEMA_VERSION, routeCategory } from "@arbor/core";
import type {
  ArborCategoryName,
  GovernanceTier,
  IntentClass,
  IntentConfidence,
  IntentDecision,
  IntentAdmissionVerb,
  IntentScope,
} from "@arbor/core";

/**
 * Bridges `@arbor/core`'s `intent-admission.ts`/`intent-lifecycle.ts` —
 * built for ADR-062 but never reached by a production caller — onto the
 * one real intake surface that decides governance tier today:
 * `TaskComposer.classifyAndPlan` (task-composer.ts), which already computes
 * an `ArbiterDecision` for every `arbor task` submission.
 *
 * `validateIntentAdmission` (intent-admission.ts) requires its caller to
 * supply a `decision.classification` that already agrees with whatever
 * explicit verb it independently detects in the raw request text — its own
 * `VERB_PATTERNS`/`CLASS_FOR_VERB` tables are private (unexported), so the
 * only way for a caller to guarantee agreement (and not manufacture a
 * spurious "ambiguous" refusal on every real request whose classification
 * was derived some other way) is to classify the SAME text with the SAME
 * verb vocabulary before constructing the `IntentDecision`. The tables
 * below are a deliberate, documented duplication of intent-admission.ts's
 * private `VERB_PATTERNS`/`CLASS_FOR_VERB` for exactly that reason — this
 * is the sole production call site, so the duplication has exactly one
 * place to go stale, and it fails safe (an out-of-sync copy only ever
 * produces MORE "ambiguous" verdicts, never a false admit).
 */
const VERB_PATTERNS: readonly [IntentAdmissionVerb, RegExp][] = [
  ["build", /\b(?:build|create|add|implement|introduce|scaffold)\b/iu],
  ["change", /\b(?:change|update|modify|refactor|fix|repair|remove|delete|migrat(?:e|ion)|replace)\b/iu],
  ["research", /\b(?:research|investigate|analy[sz]e|compare|examine|audit)\b/iu],
  ["explain", /\b(?:explain|describe|document|clarify)\b/iu],
  ["review", /\b(?:review|assess|evaluate|critique)\b/iu],
  ["operate", /\b(?:run|start|stop|restart|launch|deploy|serve)\b/iu],
];

const CLASS_FOR_VERB: Record<IntentAdmissionVerb, IntentClass> = {
  build: "build", change: "change", research: "research", explain: "explain", review: "review", operate: "operate",
};

/** Detect the explicit verb (if any) intent-admission.ts's own `detectedVerb` would find in the same text. */
function detectVerb(request: string): IntentAdmissionVerb | null {
  for (const [verb, pattern] of VERB_PATTERNS) if (pattern.test(request)) return verb;
  return null;
}

/**
 * The classification a real request maps to under intent-admission.ts's own
 * vocabulary. `"unknown"` (a legal `IntentClass`, but never a
 * `CLASS_FOR_VERB` value) is the honest answer when no explicit verb is
 * present — `validateIntentAdmission` will correctly (not spuriously) raise
 * `ambiguous` for that text, exactly as it would for any other caller.
 */
export function deriveIntentClassification(request: string): IntentClass {
  const verb = detectVerb(request);
  return verb === null ? "unknown" : CLASS_FOR_VERB[verb];
}

function sha256Digest(value: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

export interface BuildIntentDecisionInput {
  readonly intent_id: string;
  readonly task: string;
  readonly actor_id: string;
  readonly tier: GovernanceTier;
  readonly rationale: string;
  readonly clock: () => string;
}

/**
 * Project the composer's already-computed `ArbiterDecision` (ADR-062, the
 * shipped mechanism) onto the separate, richer `IntentDecision` vocabulary
 * `intent-lifecycle.ts` defines. Confidence is an honest reflection of the
 * arbiter's own posture: `direct`/`reviewed` are decisive (the arbiter
 * committed to a narrow tier), `governed` is the arbiter's least-certain
 * default (ADR-062: "default whenever the arbiter is unsure, absent, or its
 * output fails schema validation") and is mapped to `"low"` rather than
 * inflated — this deliberately lets a genuinely uncertain (governed) request
 * exercise `validateIntentAdmission`'s own low-confidence policy blocker
 * rather than being masked.
 */
export function buildIntentDecision(input: BuildIntentDecisionInput): IntentDecision {
  const classification = deriveIntentClassification(input.task);
  const confidence: IntentConfidence = input.tier === "direct" ? "high" : input.tier === "reviewed" ? "medium" : "low";
  const routeCategoryValue: ArborCategoryName = routeCategory(input.task);
  return Object.freeze({
    schema_version: INTENT_LIFECYCLE_SCHEMA_VERSION,
    decision_id: `intent-decision:${input.intent_id}`,
    intent_id: input.intent_id,
    actor_id: input.actor_id,
    requested_at: input.clock(),
    request_digest: sha256Digest(input.task),
    summary: input.task.slice(0, 500),
    classification,
    confidence,
    disposition: "admit",
    route_category: routeCategoryValue,
    rationale: input.rationale,
    requires_plan: input.tier === "governed",
    requires_review: input.tier !== "direct",
    refusal: null,
  });
}

/**
 * A bounded, operator-visible scope for the admission call. The composer
 * has no Oracle-dependency model yet (nothing on this path produces
 * `IntentDependency` records), so admission always runs with an empty
 * dependency list — a real, not a stubbed, absence: there is genuinely
 * nothing to report blocking. `campaign` scope always anchors the call so
 * `validateIntentAdmission`'s `insufficient_scope` blocker only fires when
 * the arbiter itself named no scope (a `governed` task where no path was
 * declared and none was mined).
 */
export function buildIntentScope(input: { readonly campaign_scope_value: string; readonly write_paths?: readonly string[] }): readonly IntentScope[] {
  const scope: IntentScope[] = [{ kind: "campaign", value: input.campaign_scope_value.slice(0, 512) }];
  for (const path of input.write_paths ?? []) {
    if (path.trim().length === 0) continue;
    scope.push({ kind: "path", value: path.slice(0, 512) });
  }
  return scope;
}
