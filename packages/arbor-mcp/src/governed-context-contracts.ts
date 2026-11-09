import type { OperationMetadata, ContextArtifactRef, FoldProposal, HarnessRevision, PlaybookDelta, RevisionEvaluation } from "@arbor/core";

export type GovernedContextCommand =
  | { kind: "context.artifact.capture"; artifact: Omit<ContextArtifactRef, "id" | "sha256" | "byte_length">; content: string }
  | { kind: "fold.propose"; proposal: FoldProposal }
  | { kind: "fold.approve"; fold_id: string; fidelity_ratio: number }
  | { kind: "fold.rollback"; fold_id: string }
  | { kind: "playbook.propose"; delta: Omit<PlaybookDelta, "status"> }
  | { kind: "playbook.approve"; delta_id: string }
  | { kind: "harness.propose"; revision: Omit<HarnessRevision, "status" | "evaluation"> & { evaluation?: RevisionEvaluation } }
  | { kind: "harness.approve"; revision_id: string }
  | { kind: "harness.rollback"; revision_id: string }
  | { kind: "harness.evaluate"; revision_id: string; evaluation: RevisionEvaluation }
  | { kind: "harness.promote"; revision_id: string; human_approver: string }
  /** Explicit, capability-gated execution; distinct from context-only subagent.describe. */
  | { kind: "subagent.execute"; campaign_id: string; parent_node_id: string; revision_id: string }
  | { kind: "harness.evaluation.start"; revision_id: string }
  | { kind: "harness.quarantine"; revision_id: string; reason: string; evidence_ids: readonly string[] };

export type GovernedContextQuery =
  | { kind: "context.workspace"; artifact_id: string; offset?: number; max_bytes?: number; visibility: "campaign" | "critic_only" }
  | { kind: "context.overlays"; campaign_id: string }
  | { kind: "context.governance"; campaign_id: string }
  | { kind: "subagent.executions"; campaign_id: string }
  | { kind: "harness.evaluation.candidates"; campaign_id: string }
  | { kind: "harness.evaluation.runs"; campaign_id: string }
  | { kind: "harness.evaluation.detail"; run_id: string };

export interface GovernedContextCommandEnvelope { schema_version: 1; metadata: OperationMetadata; command: GovernedContextCommand; }
export interface GovernedContextQueryEnvelope { schema_version: 1; query_id: string; query: GovernedContextQuery; }

const commands = new Set<GovernedContextCommand["kind"]>([
  "context.artifact.capture", "fold.propose", "fold.approve", "fold.rollback", "playbook.propose", "playbook.approve",
  "harness.propose", "harness.approve", "harness.rollback", "harness.evaluate", "harness.promote", "subagent.execute", "harness.evaluation.start", "harness.quarantine",
]);
const queries = new Set<GovernedContextQuery["kind"]>(["context.workspace", "context.overlays", "context.governance", "subagent.executions", "harness.evaluation.candidates", "harness.evaluation.runs", "harness.evaluation.detail"]);
export function isGovernedContextCommandEnvelope(value: unknown): value is GovernedContextCommandEnvelope {
  return record(value) && value.schema_version === 1 && record(value.metadata) && record(value.command) && commands.has(value.command.kind as GovernedContextCommand["kind"]);
}
export function isGovernedContextQueryEnvelope(value: unknown): value is GovernedContextQueryEnvelope {
  return record(value) && value.schema_version === 1 && text(value.query_id) && record(value.query) && queries.has(value.query.kind as GovernedContextQuery["kind"]);
}
export function validateGovernedContextCommand(envelope: GovernedContextCommandEnvelope): string[] {
  const c = envelope.command; const failures: string[] = [];
  if (!metadata(envelope.metadata)) failures.push("metadata identity fields are required");
  if (c.kind === "context.artifact.capture" && (!record(c.artifact) || !text(c.artifact.campaign_id) || !text(c.artifact.media_type) || !text(c.artifact.producer) || typeof c.content !== "string")) failures.push("artifact campaign, media type, producer and content are required");
  if (c.kind === "fold.propose" && (!record(c.proposal) || !text(c.proposal.id) || !text(c.proposal.task_id) || c.proposal.source_event_ids.length === 0 || !messageRanges(c.proposal.source_message_ranges) || c.proposal.retained_claims.length === 0)) failures.push("fold id, task, source events, message ranges and retained claims are required");
  if (c.kind === "fold.approve" && (!text(c.fold_id) || !Number.isFinite(c.fidelity_ratio) || c.fidelity_ratio < 0 || c.fidelity_ratio > 1)) failures.push("fold approval requires id and fidelity ratio 0..1");
  if ((c.kind === "fold.rollback" && !text(c.fold_id)) || (c.kind === "playbook.approve" && !text(c.delta_id)) || (["harness.approve", "harness.rollback", "harness.promote", "harness.evaluate"].includes(c.kind) && !text((c as { revision_id?: string }).revision_id))) failures.push("target id is required");
  if (c.kind === "playbook.propose" && (!record(c.delta) || !text(c.delta.id) || !text(c.delta.task_id) || c.delta.source_event_ids.length === 0 || !messageRanges(c.delta.source_message_ranges))) failures.push("playbook id, task, source events and message ranges are required");
  if (c.kind === "harness.propose" && (!record(c.revision) || !text(c.revision.id) || !text(c.revision.task_id) || !text(c.revision.component) || c.revision.source_event_ids.length === 0 || !messageRanges(c.revision.source_message_ranges))) failures.push("harness id, task, component, source events and message ranges are required");
  if (c.kind === "harness.promote" && !text(c.human_approver)) failures.push("human approver is required");
  if (c.kind === "subagent.execute" && (!text(c.campaign_id) || !text(c.parent_node_id) || !text(c.revision_id))) failures.push("campaign, parent node and active descriptor revision are required");
  if (c.kind === "harness.evaluation.start" && !text(c.revision_id)) failures.push("revision id is required");
  if (c.kind === "harness.quarantine" && (!text(c.revision_id) || !text(c.reason) || !Array.isArray(c.evidence_ids) || c.evidence_ids.length === 0 || c.evidence_ids.some((id) => !text(id)))) failures.push("quarantine requires revision, reason, and evidence ids");
  return failures;
}
export function validateGovernedContextQuery(envelope: GovernedContextQueryEnvelope): string[] {
  const q = envelope.query; const failures: string[] = [];
  if (q.kind === "context.workspace" && (!text(q.artifact_id) || !["campaign", "critic_only"].includes(q.visibility))) failures.push("workspace artifact id and visibility are required");
  if ((q.kind === "context.overlays" || q.kind === "context.governance" || q.kind === "subagent.executions" || q.kind === "harness.evaluation.candidates" || q.kind === "harness.evaluation.runs") && !text(q.campaign_id)) failures.push("campaign_id is required");
  if (q.kind === "harness.evaluation.detail" && !text(q.run_id)) failures.push("run_id is required");
  return failures;
}
function record(value: unknown): value is Record<string, any> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function text(value: unknown): value is string { return typeof value === "string" && value.trim().length > 0; }
function metadata(value: unknown): boolean { return record(value) && text(value.operation_id) && text(value.idempotency_key) && text(value.correlation_id) && text(value.actor_id); }
function messageRanges(value: unknown): boolean {
  return Array.isArray(value) && value.length > 0 && value.every((range) => record(range)
    && text(range.context_id) && text(range.thread_id) && text(range.start_communication_id) && text(range.end_communication_id)
    && Number.isSafeInteger(range.start_byte) && Number.isSafeInteger(range.end_byte) && range.start_byte >= 0 && range.end_byte >= range.start_byte);
}
