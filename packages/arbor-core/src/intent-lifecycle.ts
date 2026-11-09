/**
 * Governed by ADR-062: the arbiter's intake decision is durable, replayable
 * evidence, recorded here as an append-only intent ledger.
 *
 * Durable intent admission and execution chronology.
 *
 * The runtime owns this neutral record shape; transports and providers only
 * add evidence through the stage-specific records.  A decision is never
 * inferred from a later operation result, and a refusal is never represented
 * as a missing record.  This keeps the intent -> plan -> review -> dispatch
 * -> verify path replayable after a restart and makes a failed admission
 * inspectable without retaining the original prompt.
 */

import type { ArborCategoryName } from "./agent-taxonomy.js";
import type { Provenance } from "./types.js";

export const INTENT_LIFECYCLE_SCHEMA_VERSION = 1 as const;
export type IntentLifecycleSchemaVersion = typeof INTENT_LIFECYCLE_SCHEMA_VERSION;

export type IntentClass = "build" | "change" | "research" | "explain" | "review" | "operate" | "unknown";
export type IntentConfidence = "high" | "medium" | "low";
export type IntentDisposition = "admit" | "clarify" | "refuse";
export type IntentRefusalCode = "ambiguous" | "insufficient_scope" | "unauthorized" | "policy" | "stale" | "invalid" | "unavailable";

/** A refusal is an outcome with a reason, not the absence of a decision. */
export interface IntentRefusal {
  readonly code: IntentRefusalCode;
  readonly reason: string;
  readonly retryable: boolean;
}

/**
 * The durable result of classifying one operator request.
 *
 * `request_digest` deliberately replaces raw prompt text.  It permits exact
 * correlation and replay checks without turning the governance ledger into a
 * second transcript or persisting secrets that happened to be in a request.
 */
export interface IntentDecision {
  readonly schema_version: IntentLifecycleSchemaVersion;
  readonly decision_id: string;
  readonly intent_id: string;
  readonly actor_id: string;
  readonly requested_at: string;
  readonly request_digest: `sha256:${string}`;
  readonly summary: string;
  readonly classification: IntentClass;
  readonly confidence: IntentConfidence;
  readonly disposition: IntentDisposition;
  readonly route_category: ArborCategoryName | null;
  readonly rationale: string;
  readonly requires_plan: boolean;
  readonly requires_review: boolean;
  readonly refusal: IntentRefusal | null;
}

export type IntentLifecyclePhase = "intent" | "plan" | "review" | "dispatch" | "verify" | "refusal";
export type IntentLifecycleKind =
  | "intent.decided"
  | "intent.planned"
  | "intent.reviewed"
  | "intent.dispatched"
  | "intent.verified"
  | "intent.refused";

interface LifecycleBase {
  readonly schema_version: IntentLifecycleSchemaVersion;
  readonly record_id: string;
  readonly intent_id: string;
  readonly decision_id: string;
  readonly sequence: number;
  readonly occurred_at: string;
  readonly actor_id: string;
  readonly correlation_id: string;
}

export type IntentLifecycleRecord =
  | (LifecycleBase & { readonly phase: "intent"; readonly kind: "intent.decided"; readonly decision: IntentDecision })
  | (LifecycleBase & { readonly phase: "plan"; readonly kind: "intent.planned"; readonly plan_id: string; readonly action_ids: readonly string[]; readonly plan_digest: `sha256:${string}` })
  | (LifecycleBase & { readonly phase: "review"; readonly kind: "intent.reviewed"; readonly reviewer_id: string; readonly verdict: "approved" | "rejected" | "needs_clarification"; readonly rationale: string })
  | (LifecycleBase & { readonly phase: "dispatch"; readonly kind: "intent.dispatched"; readonly operation_id: string; readonly agent_id: string; readonly worktree_id: string | null })
  | (LifecycleBase & { readonly phase: "verify"; readonly kind: "intent.verified"; readonly operation_id: string; readonly verification: Provenance; readonly summary: string })
  | (LifecycleBase & { readonly phase: "refusal"; readonly kind: "intent.refused"; readonly from_phase: Exclude<IntentLifecyclePhase, "refusal">; readonly refusal: IntentRefusal });

export interface IntentLedger {
  readonly schema_version: IntentLifecycleSchemaVersion;
  readonly intent_id: string;
  readonly decision_id: string;
  readonly records: readonly IntentLifecycleRecord[];
}

export type IntentLifecycleViolationCode = "invalid_record" | "identity" | "sequence" | "order" | "duplicate_phase" | "terminal" | "decision";
export interface IntentLifecycleViolation {
  readonly code: IntentLifecycleViolationCode;
  readonly path: string;
  readonly message: string;
}

export type IntentLifecycleValidation =
  | { readonly ok: true; readonly value: IntentLifecycleRecord }
  | { readonly ok: false; readonly violations: readonly IntentLifecycleViolation[] };

export type IntentLedgerAppendResult =
  | { readonly ok: true; readonly ledger: IntentLedger }
  | { readonly ok: false; readonly violations: readonly IntentLifecycleViolation[] };

const PHASE_ORDER: readonly IntentLifecyclePhase[] = ["intent", "plan", "review", "dispatch", "verify"];
const INTENT_CLASSES: readonly IntentClass[] = ["build", "change", "research", "explain", "review", "operate", "unknown"];
const CONFIDENCES: readonly IntentConfidence[] = ["high", "medium", "low"];
const DISPOSITIONS: readonly IntentDisposition[] = ["admit", "clarify", "refuse"];
const REFUSAL_CODES: readonly IntentRefusalCode[] = ["ambiguous", "insufficient_scope", "unauthorized", "policy", "stale", "invalid", "unavailable"];
const CATEGORIES: readonly ArborCategoryName[] = ["crown-structural", "heartwood-deep", "seed-quick", "leaf-visual", "sap-write"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): value is string { return typeof value === "string" && value.trim().length > 0; }
function timestamp(value: unknown): value is string { return text(value) && !Number.isNaN(Date.parse(value)); }
function digest(value: unknown): value is `sha256:${string}` { return typeof value === "string" && /^sha256:[a-f0-9]{64}$/u.test(value); }
function safeInteger(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0; }
function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}

function violation(code: IntentLifecycleViolationCode, path: string, message: string): IntentLifecycleViolation {
  return { code, path, message };
}

function validRefusal(value: unknown): value is IntentRefusal {
  return isRecord(value) && exactKeys(value, ["code", "reason", "retryable"])
    && typeof value.code === "string" && REFUSAL_CODES.includes(value.code as IntentRefusalCode)
    && text(value.reason) && typeof value.retryable === "boolean";
}

function validDecision(value: unknown): value is IntentDecision {
  if (!isRecord(value) || !exactKeys(value, ["schema_version", "decision_id", "intent_id", "actor_id", "requested_at", "request_digest", "summary", "classification", "confidence", "disposition", "route_category", "rationale", "requires_plan", "requires_review", "refusal"])) return false;
  return value.schema_version === INTENT_LIFECYCLE_SCHEMA_VERSION && text(value.decision_id) && text(value.intent_id)
    && text(value.actor_id) && timestamp(value.requested_at) && digest(value.request_digest) && text(value.summary)
    && typeof value.classification === "string" && INTENT_CLASSES.includes(value.classification as IntentClass)
    && typeof value.confidence === "string" && CONFIDENCES.includes(value.confidence as IntentConfidence)
    && typeof value.disposition === "string" && DISPOSITIONS.includes(value.disposition as IntentDisposition)
    && (value.route_category === null || (typeof value.route_category === "string" && CATEGORIES.includes(value.route_category as ArborCategoryName)))
    && text(value.rationale) && typeof value.requires_plan === "boolean" && typeof value.requires_review === "boolean"
    && (value.refusal === null || validRefusal(value.refusal));
}

function validProvenance(value: unknown): value is Provenance {
  if (!isRecord(value) || typeof value.tag !== "string") return false;
  if (value.tag === "claimed") return text(value.claimant);
  if (value.tag === "critic_approved") return text(value.critic) && text(value.rationale);
  if (value.tag === "generated") return text(value.generator) && text(value.input_hash);
  return value.tag === "verified" && text(value.cmd) && Number.isSafeInteger(value.exit)
    && text(value.stdout_hash);
}

function validBase(value: Record<string, unknown>): boolean {
  return value.schema_version === INTENT_LIFECYCLE_SCHEMA_VERSION && text(value.record_id) && text(value.intent_id)
    && text(value.decision_id) && safeInteger(value.sequence) && timestamp(value.occurred_at)
    && text(value.actor_id) && text(value.correlation_id);
}

/** Validate a single record at the untrusted persistence/transport boundary. */
export function validateIntentLifecycleRecord(value: unknown): IntentLifecycleValidation {
  if (!isRecord(value) || !validBase(value)) return { ok: false, violations: [violation("invalid_record", "$", "intent lifecycle record has an invalid base shape")] };
  if (value.kind === "intent.decided") {
    if (!exactKeys(value, ["schema_version", "record_id", "intent_id", "decision_id", "sequence", "occurred_at", "actor_id", "correlation_id", "phase", "kind", "decision"]) || value.phase !== "intent" || value.sequence !== 0 || !validDecision(value.decision)) return { ok: false, violations: [violation("invalid_record", "$.decision", "intent.decided requires sequence zero, phase intent, and a valid decision")] };
  } else if (value.kind === "intent.planned") {
    if (!exactKeys(value, ["schema_version", "record_id", "intent_id", "decision_id", "sequence", "occurred_at", "actor_id", "correlation_id", "phase", "kind", "plan_id", "action_ids", "plan_digest"]) || value.phase !== "plan" || !text(value.plan_id) || !Array.isArray(value.action_ids) || value.action_ids.length === 0 || !value.action_ids.every(text) || !digest(value.plan_digest)) return { ok: false, violations: [violation("invalid_record", "$.plan", "intent.planned requires a plan id, action ids, and plan digest")] };
  } else if (value.kind === "intent.reviewed") {
    if (!exactKeys(value, ["schema_version", "record_id", "intent_id", "decision_id", "sequence", "occurred_at", "actor_id", "correlation_id", "phase", "kind", "reviewer_id", "verdict", "rationale"]) || value.phase !== "review" || !text(value.reviewer_id) || !["approved", "rejected", "needs_clarification"].includes(String(value.verdict)) || !text(value.rationale)) return { ok: false, violations: [violation("invalid_record", "$.review", "intent.reviewed requires reviewer, closed verdict, and rationale")] };
  } else if (value.kind === "intent.dispatched") {
    if (!exactKeys(value, ["schema_version", "record_id", "intent_id", "decision_id", "sequence", "occurred_at", "actor_id", "correlation_id", "phase", "kind", "operation_id", "agent_id", "worktree_id"]) || value.phase !== "dispatch" || !text(value.operation_id) || !text(value.agent_id) || (value.worktree_id !== null && !text(value.worktree_id))) return { ok: false, violations: [violation("invalid_record", "$.dispatch", "intent.dispatched requires operation, agent, and nullable worktree ids")] };
  } else if (value.kind === "intent.verified") {
    if (!exactKeys(value, ["schema_version", "record_id", "intent_id", "decision_id", "sequence", "occurred_at", "actor_id", "correlation_id", "phase", "kind", "operation_id", "verification", "summary"]) || value.phase !== "verify" || !text(value.operation_id) || !validProvenance(value.verification) || !text(value.summary)) return { ok: false, violations: [violation("invalid_record", "$.verify", "intent.verified requires operation, provenance, and summary")] };
  } else if (value.kind === "intent.refused") {
    if (!exactKeys(value, ["schema_version", "record_id", "intent_id", "decision_id", "sequence", "occurred_at", "actor_id", "correlation_id", "phase", "kind", "from_phase", "refusal"]) || value.phase !== "refusal" || !PHASE_ORDER.slice(0, -1).includes(value.from_phase as Exclude<IntentLifecyclePhase, "refusal">) || !validRefusal(value.refusal)) return { ok: false, violations: [violation("invalid_record", "$.refusal", "intent.refused requires a prior lifecycle phase and refusal reason")] };
  } else return { ok: false, violations: [violation("invalid_record", "$.kind", "unknown intent lifecycle kind")] };
  return { ok: true, value: value as unknown as IntentLifecycleRecord };
}

/**
 * Append one record only when it is the next legal stage.  The function is
 * pure, returns cloned data, and is therefore suitable for file/SQLite
 * adapters that use compare-and-swap around their own commit.
 */
export function appendIntentLifecycleRecord(ledger: IntentLedger | null, record: IntentLifecycleRecord): IntentLedgerAppendResult {
  const shape = validateIntentLifecycleRecord(record);
  if (!shape.ok) return shape;
  if (ledger === null) {
    if (record.kind !== "intent.decided") return { ok: false, violations: [violation("order", "$.kind", "an intent ledger must begin with intent.decided")] };
    return { ok: true, ledger: { schema_version: INTENT_LIFECYCLE_SCHEMA_VERSION, intent_id: record.intent_id, decision_id: record.decision_id, records: [structuredClone(record)] } };
  }
  const violations: IntentLifecycleViolation[] = [];
  if (ledger.schema_version !== INTENT_LIFECYCLE_SCHEMA_VERSION || ledger.intent_id !== record.intent_id || ledger.decision_id !== record.decision_id) violations.push(violation("identity", "$", "ledger and record identities must match"));
  const prior = ledger.records[ledger.records.length - 1];
  if (!prior) violations.push(violation("order", "$.records", "an existing ledger must contain its decision record"));
  if (prior && record.sequence !== prior.sequence + 1) violations.push(violation("sequence", "$.sequence", "record sequence must increase by one"));
  if (prior && (prior.phase === "refusal" || prior.phase === "verify")) violations.push(violation("terminal", "$.phase", "a refused or verified intent is terminal"));
  if (prior && record.kind === "intent.decided") violations.push(violation("duplicate_phase", "$.kind", "intent.decided may occur only once"));
  if (prior && record.kind !== "intent.refused") {
    const priorIndex = PHASE_ORDER.indexOf(prior.phase);
    const currentIndex = PHASE_ORDER.indexOf(record.phase);
    if (prior.phase === "intent" && record.phase !== "plan" && record.phase !== "review") violations.push(violation("order", "$.phase", "intent must move to plan or review"));
    else if (prior.phase !== "intent" && currentIndex !== priorIndex + 1) violations.push(violation("order", "$.phase", "lifecycle phases must advance in order"));
  }
  if (violations.length > 0) return { ok: false, violations };
  return { ok: true, ledger: { ...ledger, records: [...ledger.records, structuredClone(record)] } };
}

/** Parse a JSON value before it becomes a durable typed ledger. */
export function parseIntentLedger(value: unknown): IntentLedger | null {
  if (!isRecord(value) || !exactKeys(value, ["schema_version", "intent_id", "decision_id", "records"]) || value.schema_version !== INTENT_LIFECYCLE_SCHEMA_VERSION || !text(value.intent_id) || !text(value.decision_id) || !Array.isArray(value.records)) return null;
  let ledger: IntentLedger | null = null;
  for (const record of value.records) {
    const parsed = validateIntentLifecycleRecord(record);
    if (!parsed.ok) return null;
    const appended = appendIntentLifecycleRecord(ledger, parsed.value);
    if (!appended.ok) return null;
    ledger = appended.ledger;
  }
  if (ledger === null || ledger.intent_id !== value.intent_id || ledger.decision_id !== value.decision_id) return null;
  return ledger;
}

export function serializeIntentLedger(ledger: IntentLedger): string {
  if (parseIntentLedger(ledger) === null) throw new Error("cannot serialize an invalid intent ledger");
  return JSON.stringify(ledger);
}
