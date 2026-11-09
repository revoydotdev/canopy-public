import type { OutputArtifactMetadata, OutputArtifactRecord, OutputListEntry } from "@arbor/audit";
import type { CommandAcknowledgement, OperationMetadata, OutputExcerpt } from "@arbor/core";

export interface OutputCaptureCommandEnvelope {
  schema_version: 1;
  metadata: OperationMetadata;
  command: { kind: "output.capture"; artifact: Omit<OutputArtifactMetadata, "operation_id">; content: string };
}

export interface OutputQueryEnvelope {
  schema_version: 1;
  query_id: string;
  query: { kind: "output.descriptor"; evidence_id: string } | { kind: "output.raw"; evidence_id: string; approval_id: string };
}

/**
 * `output.list` — the enumeration query the `output` TUI screen needs and the
 * catalog lacked. Both `output.descriptor` and `output.raw` hard-require an
 * `evidence_id`, so nothing could enumerate one to select from and the screen
 * had no honest query to issue. Backed by the real
 * `OutputEvidenceStore.list()` (arbor-audit/src/output-evidence.ts) — its only
 * enumeration surface — never a synthesized shape.
 *
 * Exactly the shape `operation.list` established for the same problem on the
 * `operations` screen; see operation-list-contracts.ts.
 */
export interface OutputListQueryEnvelope {
  schema_version: 1;
  query_id: string;
  query: { kind: "output.list"; limit?: number };
}

/**
 * Corrupt descriptors are carried through as `{status:"corrupt"}` entries
 * rather than filtered out. Dropping them would make a tampered store
 * indistinguishable from a smaller one — the store's integrity claim is
 * exactly what this screen exists to surface.
 */
export type OutputListProjection = readonly OutputListEntry[];

export interface OutputDescriptorProjection {
  descriptor: OutputArtifactRecord;
  preview: OutputExcerpt;
}

/**
 * What `output.descriptor` returns — deliberately NOT `OutputDescriptorProjection`.
 *
 * A preview is derived from the stored blob (nothing else holds the bytes: an
 * `OutputArtifactRecord` carries only hashes, counts and metadata), so producing
 * one is a raw read however small the excerpt. On the capture path that is
 * harmless — the caller supplied the content in the same request — which is why
 * `OutputDescriptorProjection.preview` stays required there.
 *
 * On the query path the caller supplies nothing and is asking to read back
 * someone else's captured bytes, so `preview` is always omitted. A separately
 * approval-bound `output.raw` query is the only read path for blob bytes.
 * Omission is the fail-closed outcome: a descriptor without a preview is a
 * strictly smaller disclosure, never an error.
 */
export interface OutputDescriptorQueryProjection {
  descriptor: OutputArtifactRecord;
  preview?: OutputExcerpt;
}

export type OutputCaptureAcknowledgement = Extract<CommandAcknowledgement, { accepted: true }> & {
  output: OutputDescriptorProjection;
};

export function isOutputCaptureEnvelope(input: unknown): input is OutputCaptureCommandEnvelope {
  return record(input) && input.schema_version === 1 && record(input.metadata) && record(input.command)
    && input.command.kind === "output.capture";
}

export function isOutputQueryEnvelope(input: unknown): input is OutputQueryEnvelope {
  return record(input) && input.schema_version === 1 && text(input.query_id) && record(input.query)
    && (input.query.kind === "output.descriptor" || (input.query.kind === "output.raw" && text(input.query.approval_id)));
}

export function isOutputListQueryEnvelope(input: unknown): input is OutputListQueryEnvelope {
  return record(input) && input.schema_version === 1 && text(input.query_id) && record(input.query)
    && input.query.kind === "output.list";
}

export function validateOutputListQuery(envelope: OutputListQueryEnvelope): string[] {
  const failures: string[] = [];
  if (envelope.query.limit !== undefined && (!Number.isSafeInteger(envelope.query.limit) || envelope.query.limit <= 0)) {
    failures.push("query.limit must be a positive safe integer");
  }
  return failures;
}

export function validateOutputCapture(envelope: OutputCaptureCommandEnvelope): string[] {
  const failures: string[] = [];
  const { metadata, command } = envelope;
  if (!text(metadata.operation_id) || !text(metadata.idempotency_key) || !text(metadata.correlation_id) || !text(metadata.actor_id)) failures.push("metadata identity fields are required");
  if (!record(command.artifact) || !text(command.artifact.campaign_id) || !text(command.artifact.node_id)
    || !text(command.artifact.media_type) || typeof command.content !== "string") failures.push("artifact identity, media_type, and string content are required");
  if (!record(command.artifact) || !["stdout", "stderr", "model", "transcript", "other"].includes(command.artifact.stream)) failures.push("artifact stream is invalid");
  if (!record(command.artifact?.provenance) || !["verified", "claimed", "critic_approved", "generated"].includes(command.artifact.provenance.tag)) failures.push("artifact provenance is invalid");
  return failures;
}

export function validateOutputQuery(envelope: OutputQueryEnvelope): string[] {
  if (!/^out_[a-f0-9]{64}$/.test(envelope.query.evidence_id)) return ["evidence_id is invalid"];
  return envelope.query.kind === "output.raw" && !text(envelope.query.approval_id) ? ["approval_id is required for output.raw"] : [];
}

function record(value: unknown): value is Record<string, any> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function text(value: unknown): value is string { return typeof value === "string" && value.trim().length > 0; }
