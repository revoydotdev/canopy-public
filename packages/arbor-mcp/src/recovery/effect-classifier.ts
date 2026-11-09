import { createHash } from "node:crypto";
import type { HarnessSessionEventProjection, HarnessSessionSummary, HarnessSessionToolAuditProjection } from "../harness-session-journal.js";
import { RECOVERY_MAX_OPERATIONS, type RecoveryEffectClass, type RecoveryFailureEvidence, type RecoveryOperationCheckpoint } from "./contracts.js";

export type EffectClassification =
  | Classification<"observed-complete", false>
  | Classification<"observed-failed", true>
  | Classification<"safely-idempotent", true>
  | Classification<"compensatable", false>
  | Classification<"indeterminate", false>;

interface Classification<K extends RecoveryEffectClass, A extends boolean> {
  readonly operation_id: string;
  readonly operation: string;
  readonly classification: K;
  readonly automatic_continuation: A;
  readonly reason: string;
  readonly evidence_ids: readonly string[];
  /**
   * S02: bounded argv/exit/stderr for a failed command, when the checkpoint
   * carried one — surfaced here so a retry (via `ContinuationPlan.admitted_
   * context`, see `continuation-plan.ts`) is informed instead of only
   * knowing "failed". Absent when no checkpoint in the group recorded one
   * (e.g. every checkpoint predates the field, or the operation never
   * reached a command outcome).
   */
  readonly failure_evidence?: RecoveryFailureEvidence;
}

export interface EffectClassifierInput {
  readonly session: HarnessSessionSummary;
  readonly checkpoints: readonly RecoveryOperationCheckpoint[];
  readonly tool_audits: readonly HarnessSessionToolAuditProjection[];
  readonly events?: readonly HarnessSessionEventProjection[];
}

/** Pure conservative projection from durable structural evidence. */
export class EffectClassifier {
  static classify(input: EffectClassifierInput): readonly EffectClassification[] {
    if (input.checkpoints.length > RECOVERY_MAX_OPERATIONS) throw new Error(`recovery operation checkpoint projection exceeds ${RECOVERY_MAX_OPERATIONS}`);
    const groups = new Map<string, RecoveryOperationCheckpoint[]>();
    for (const checkpoint of input.checkpoints) {
      const group = groups.get(checkpoint.operation_id) ?? [];
      group.push(checkpoint); groups.set(checkpoint.operation_id, group);
    }
    const classifications: EffectClassification[] = [];
    for (const [operationId, records] of groups) classifications.push(classifyOperation(operationId, records, input.tool_audits));

    // Legacy journals have canonical tool intents/audits but predate explicit
    // operation checkpoints. Preserve useful terminal evidence and fail closed
    // for unmatched intents rather than pretending they were not dispatched.
    const representedCalls = new Set(groups.keys());
    for (const audit of input.tool_audits) if (!representedCalls.has(audit.call_id)) classifications.push(classifyAudit(audit));
    const events = input.events ?? [];
    let legacyIntent = 0;
    for (const event of events) {
      if (event.kind !== "tool_intent") continue;
      const tool = typeof event.payload.tool === "string" ? event.payload.tool : "unknown-tool";
      // A matching tool name is not a join: several calls to the same tool
      // can occur in one session. Only an explicit call identity on the
      // intent can let a legacy audit cover this particular dispatch.
      const callId = typeof event.payload.call_id === "string" ? event.payload.call_id : null;
      const hasTerminalAudit = callId !== null && input.tool_audits.some((audit) => audit.call_id === callId);
      if (!hasTerminalAudit) classifications.push(Object.freeze({
        operation_id: `legacy-intent:${++legacyIntent}`,
        operation: tool,
        classification: "indeterminate",
        automatic_continuation: false,
        reason: "durable intent has no call identity or terminal effect evidence",
        evidence_ids: Object.freeze([eventEvidence(event)]),
      }));
    }
    // Tool evidence (including unrelated terminal audits) cannot establish
    // whether a provider request crossed its dispatch boundary. Keep that
    // uncertainty visible for every nonterminal session lacking a provider
    // checkpoint, even when other operations have classifications.
    if (input.session.terminal === null && !input.checkpoints.some((checkpoint) => checkpoint.operation_kind === "provider")) {
      classifications.push(Object.freeze({
        operation_id: `session:${input.session.session_id}:pre-dispatch`,
        operation: "provider",
        classification: "indeterminate",
        automatic_continuation: false,
        reason: "no durable operation checkpoint proves whether a provider request crossed the dispatch boundary",
        evidence_ids: Object.freeze([`session:${input.session.session_id}:checkpoint:${input.session.latest_sequence}`]),
      }));
    }
    if (classifications.length > 0) return Object.freeze(classifications);

    if (input.session.terminal !== null) {
      const complete = input.session.terminal.state === "completed";
      return Object.freeze([Object.freeze({
        operation_id: `session:${input.session.session_id}`,
        operation: input.session.operation,
        classification: complete ? "observed-complete" : "observed-failed",
        automatic_continuation: complete ? false : true,
        reason: `durable terminal session state is ${input.session.terminal.state}`,
        evidence_ids: Object.freeze([`session:${input.session.session_id}:terminal`]),
      } as EffectClassification)]);
    }
    return Object.freeze([Object.freeze({
      operation_id: `session:${input.session.session_id}:pre-dispatch`,
      operation: "provider",
      classification: "indeterminate",
      automatic_continuation: false,
      reason: "no durable operation checkpoint proves whether a provider request crossed the dispatch boundary",
      evidence_ids: Object.freeze([`session:${input.session.session_id}:checkpoint:${input.session.latest_sequence}`]),
    })]);
  }
}

/** The most recent non-null `failure_evidence` in occurrence order, or undefined when no checkpoint in the group carried one. */
function latestFailureEvidence(ordered: readonly RecoveryOperationCheckpoint[]): RecoveryFailureEvidence | undefined {
  for (let i = ordered.length - 1; i >= 0; i -= 1) {
    const evidence = ordered[i]!.failure_evidence;
    if (evidence !== undefined && evidence !== null) return evidence;
  }
  return undefined;
}

function classifyOperation(operationId: string, records: readonly RecoveryOperationCheckpoint[], audits: readonly HarnessSessionToolAuditProjection[]): EffectClassification {
  const ordered = [...records].sort((a, b) => Date.parse(a.occurred_at) - Date.parse(b.occurred_at));
  const last = ordered.at(-1)!;
  const evidence = Object.freeze(ordered.map(checkpointEvidence));
  const failureEvidence = latestFailureEvidence(ordered);
  const settled = [...ordered].reverse().find((record) => record.phase === "settled");
  const audit = audits.find((item) => item.call_id === operationId);
  if (settled !== undefined) {
    if (settled.outcome === "succeeded") return result(last, "observed-complete", false, "durable settlement proves the operation succeeded", evidence);
    if (settled.effect === "applied" || settled.effect === "unknown") {
      if (ordered.some((record) => record.phase === "compensation_available" || record.compensation_id !== null)) return result(last, "compensatable", false, "failed settlement reports a possible effect and a durable compensation contract exists", evidence, failureEvidence);
      return result(last, "indeterminate", false, "failed settlement cannot prove whether its reported effect was absent", evidence, failureEvidence);
    }
    return result(last, "observed-failed", true, `durable settlement proves ${settled.outcome ?? "failure"} without a mutation`, evidence, failureEvidence);
  }
  if (audit !== undefined) return classifyAudit(audit, last, evidence, failureEvidence);
  if (ordered.some((record) => record.phase === "compensation_available" || record.compensation_id !== null)) {
    return result(last, "compensatable", false, "a durable compensation contract exists but requires explicit authority", evidence, failureEvidence);
  }
  const dispatched = ordered.some((record) => record.phase === "dispatched");
  if (!dispatched) return result(last, "safely-idempotent", true, "dispatch was never durably observed", evidence);
  if (last.effect_kind === "read_only" && last.repeatable) return result(last, "safely-idempotent", true, "the dispatched operation is independently read-only", evidence);
  const acknowledged = ordered.some((record) => record.phase === "idempotency_acknowledged"
    && record.idempotency_key_hash !== null && record.acknowledged_by !== null);
  if (last.repeatable && acknowledged) return result(last, "safely-idempotent", true, "a repeatable operation has a durable provider/tool idempotency acknowledgement", evidence);
  return result(last, "indeterminate", false, "dispatch crossed an effect boundary without terminal or duplication-protection evidence", evidence, failureEvidence);
}

function classifyAudit(audit: HarnessSessionToolAuditProjection, operation?: RecoveryOperationCheckpoint, priorEvidence: readonly string[] = [], failureEvidence?: RecoveryFailureEvidence): EffectClassification {
  const evidence = Object.freeze([...priorEvidence, `tool-audit:${audit.session_id}:${audit.call_id}:${audit.stage}:${audit.outcome}`]);
  const base = operation ?? ({ operation_id: audit.call_id, operation: audit.tool } as RecoveryOperationCheckpoint);
  const resolvedFailureEvidence = failureEvidence ?? operation?.failure_evidence ?? undefined;
  if (audit.outcome === "succeeded") return result(base, "observed-complete", false, `host audit durably observed effect ${audit.effect}`, evidence);
  if (audit.effect === "applied" || audit.effect === "unknown") return result(base, "indeterminate", false, "host reported a possible effect without successful settlement", evidence, resolvedFailureEvidence);
  return result(base, "observed-failed", true, `host audit durably observed ${audit.outcome}`, evidence, resolvedFailureEvidence);
}

function result<K extends RecoveryEffectClass, A extends boolean>(operation: Pick<RecoveryOperationCheckpoint, "operation_id" | "operation">, classification: K, automatic: A, reason: string, evidence: readonly string[], failureEvidence?: RecoveryFailureEvidence): Classification<K, A> {
  return Object.freeze({
    operation_id: operation.operation_id, operation: operation.operation, classification, automatic_continuation: automatic,
    reason: failureEvidence === undefined ? reason : `${reason}; failed command [${failureEvidence.command_argv.join(" ")}] exit=${failureEvidence.exit_code ?? "unknown"}${failureEvidence.stderr_excerpt !== null ? ` stderr: ${failureEvidence.stderr_excerpt}` : ""}`,
    evidence_ids: evidence,
    ...(failureEvidence === undefined ? {} : { failure_evidence: failureEvidence }),
  });
}
function checkpointEvidence(value: RecoveryOperationCheckpoint): string { return `operation:${value.operation_id}:${value.phase}`; }
function eventEvidence(value: HarnessSessionEventProjection): string { return `event:${value.session_id}:${value.sequence}`; }
export function classificationFingerprint(value: readonly EffectClassification[]): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}
