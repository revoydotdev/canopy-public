import type { Provenance } from "@arbor/core";
import type { HarnessSessionArtifactProjection, HarnessSessionSummary } from "../harness-session-journal.js";
import { EffectClassifier, classificationFingerprint, type EffectClassification, type EffectClassifierInput } from "./effect-classifier.js";
import { FRESH_ADMISSION_KINDS, RECOVERY_MAX_CONTEXT_FACTS, RECOVERY_MAX_SUMMARY_BYTES, type ContinuationContextFact, type FreshAdmissionKind, type RecoveryDisposition } from "./contracts.js";

/**
 * WA-18: an executor's honest declaration of whether it actually consumes
 * `ContinuationPlan.admitted_context` (the bounded, redacted continuation
 * facts a fresh continuation session is admitted with — never a raw
 * transcript). `"native"` means the executor wires a real continuation
 * side-channel into the dispatched session (as `native-agent-executor.ts`
 * does via its own `continuation_for_node`/`replay_for_continuation`
 * options); `"unsupported"` means it has no such channel and would silently
 * re-run the raw prompt from scratch if continuation dispatch let it
 * through. This is read from the executor's own composition — never
 * inferred — because only the executor's composition root knows whether it
 * wires continuation data into what it actually sends the model.
 */
export type ContinuationExecutorSupport = "native" | "unsupported";
export interface ContinuationCapableExecutor {
  /** A stable, human-readable identity for diagnostics (e.g. "opencode-cli-loop-executor"). */
  readonly connector_id: string;
  readonly continuation_support: ContinuationExecutorSupport;
}

export interface ContinuationPlan {
  readonly campaign_id: string;
  readonly node_id: string;
  readonly source_session_id: string;
  readonly source_checkpoint: number;
  readonly source_model_identity: HarnessSessionSummary["model_identity"];
  readonly classifications: readonly EffectClassification[];
  readonly classification_fingerprint: string;
  readonly required_admissions: readonly FreshAdmissionKind[];
  readonly admitted_context: readonly ContinuationContextFact[];
  readonly requires_disposition: readonly string[];
  readonly automatic_continuation_allowed: boolean;
}

export function buildContinuationPlan(input: EffectClassifierInput & { readonly artifacts?: readonly HarnessSessionArtifactProjection[] }): ContinuationPlan {
  const classifications = EffectClassifier.classify(input);
  const requiresDisposition = classifications
    .filter((item) => item.classification === "indeterminate" || item.classification === "compensatable")
    .map((item) => item.operation_id);
  return Object.freeze({
    campaign_id: input.session.campaign_id,
    node_id: input.session.node_id,
    source_session_id: input.session.session_id,
    source_checkpoint: input.session.latest_sequence,
    source_model_identity: input.session.model_identity,
    classifications,
    classification_fingerprint: classificationFingerprint(classifications),
    required_admissions: FRESH_ADMISSION_KINDS,
    admitted_context: boundedContext(input.session, classifications, input.artifacts ?? []),
    requires_disposition: Object.freeze(requiresDisposition),
    automatic_continuation_allowed: requiresDisposition.length === 0 && classifications.every((item) => item.classification === "observed-complete" || item.automatic_continuation),
  });
}

export function validateContinuationDispositions(plan: ContinuationPlan, dispositions: readonly RecoveryDisposition[]): string | null {
  const byOperation = new Map(dispositions.map((item) => [item.operation_id, item]));
  if (byOperation.size !== dispositions.length) return "each recovery operation may have only one disposition";
  for (const operationId of plan.requires_disposition) {
    const disposition = byOperation.get(operationId);
    if (disposition === undefined) return `operation ${operationId} requires an explicit disposition`;
    if (!disposition.reason.trim()) return `operation ${operationId} disposition requires a reason`;
    const classification = plan.classifications.find((item) => item.operation_id === operationId)!;
    if (classification.classification === "compensatable" && disposition.decision !== "compensate" && disposition.decision !== "abandon") {
      return `compensatable operation ${operationId} must be compensated or abandoned`;
    }
  }
  for (const disposition of dispositions) if (!plan.classifications.some((item) => item.operation_id === disposition.operation_id)) return `disposition names unknown operation ${disposition.operation_id}`;
  return null;
}

function boundedContext(session: HarnessSessionSummary, classifications: readonly EffectClassification[], artifacts: readonly HarnessSessionArtifactProjection[]): readonly ContinuationContextFact[] {
  const provenance: Extract<Provenance, { tag: "generated" }> = Object.freeze({ tag: "generated", generator: "governed-crash-continuation", input_hash: `session:${session.session_id}:checkpoint:${session.latest_sequence}` });
  const facts: ContinuationContextFact[] = [{
    kind: "summary",
    reference_id: `session:${session.session_id}:checkpoint:${session.latest_sequence}`,
    summary: bounded(`Interrupted ${session.operation} session at structural checkpoint ${session.latest_sequence}; raw transcript is not admitted.`),
    provenance,
  }];
  for (const item of classifications.slice(0, RECOVERY_MAX_CONTEXT_FACTS - 1)) facts.push({
    kind: "decision", reference_id: `operation:${item.operation_id}`,
    // `item.reason` already embeds the bounded failed argv/exit/stderr when
    // `EffectClassifier` attached `failure_evidence` (S02: this is the
    // retry-informing evidence the manifest found missing — see
    // `effect-classifier.ts`'s `result()`).
    summary: bounded(`${item.operation} is classified ${item.classification}: ${item.reason}`), provenance,
  });
  for (const artifact of artifacts.slice(0, RECOVERY_MAX_CONTEXT_FACTS - facts.length)) facts.push({
    kind: "artifact", reference_id: artifact.artifact_id,
    summary: bounded(`Redacted ${artifact.kind} (${artifact.media_type}, ${artifact.size_bytes} bytes).`),
    provenance: artifact.provenance,
  });
  return Object.freeze(facts.map((fact) => Object.freeze({ ...fact, provenance: Object.freeze({ ...fact.provenance }) })));
}
function bounded(value: string): string { return Buffer.byteLength(value, "utf8") <= RECOVERY_MAX_SUMMARY_BYTES ? value : Buffer.from(value).subarray(0, RECOVERY_MAX_SUMMARY_BYTES).toString("utf8"); }
