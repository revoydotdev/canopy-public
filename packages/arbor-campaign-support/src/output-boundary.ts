import {
  DEFAULT_OUTPUT_POLICY,
  abbreviateOutput,
  captureDescriptor,
  type CaptureDescriptor,
  type OutputBudget,
  type Provenance,
} from "@arbor/core";

export type OutputEvidenceKind = "specialist" | "critic" | "tool";

export interface OutputEvidenceCapturePort {
  capture(input: {
    campaign_id: string;
    node_id: string;
    kind: OutputEvidenceKind;
    content: string;
    provenance: Provenance;
  }): Promise<{ evidence_pointer: string }>;
}

export interface PreparedOutput {
  /** Safe to propagate to prompts, tree records, KB extraction, and parents. */
  summary: string;
  capture: CaptureDescriptor | null;
  abbreviated: boolean;
}

/**
 * Enforces the model-context boundary. Oversized content is captured before a
 * byte of it is returned for propagation; capture failure therefore fails
 * closed. Provenance is copied into the descriptor, never upgraded.
 */
export async function prepareOutput(input: {
  campaign_id: string;
  node_id: string;
  kind: OutputEvidenceKind;
  content: string;
  provenance: Provenance;
  capture?: OutputEvidenceCapturePort;
  budget?: OutputBudget;
}): Promise<PreparedOutput> {
  const excerpt = abbreviateOutput(input.content, input.budget ?? DEFAULT_OUTPUT_POLICY.model_context);
  if (!excerpt.abbreviated) {
    return { summary: input.content, capture: null, abbreviated: false };
  }
  if (!input.capture) {
    throw new Error(`oversized ${input.kind} output requires an evidence capture port`);
  }
  const persisted = await input.capture.capture({
    campaign_id: input.campaign_id,
    node_id: input.node_id,
    kind: input.kind,
    content: input.content,
    provenance: structuredClone(input.provenance),
  });
  const descriptor = captureDescriptor(input.content, {
    provenance: input.provenance,
    evidence_pointer: persisted.evidence_pointer,
  });
  return {
    summary: [
      excerpt.text,
      "",
      `[full output captured: ${descriptor.evidence_pointer}; sha256=${descriptor.content_sha256}; bytes=${descriptor.content_bytes}; provenance=${descriptor.provenance.tag}]`,
    ].join("\n"),
    capture: descriptor,
    abbreviated: true,
  };
}

/** Suppress low-information success chatter after it has served critic review. */
export function suppressRoutineSuccess(output: PreparedOutput, approved: boolean): string {
  if (!approved || output.abbreviated || output.summary.length > 240 || /\b(error|fail|warning|risk|todo)\b/i.test(output.summary)) {
    return output.summary;
  }
  return `[routine success suppressed; provenance retained separately; ${Buffer.byteLength(output.summary, "utf8")} bytes]`;
}

/** Bound one semantic field that belongs to an already-captured combined artifact. */
export function excerptCapturedField(content: string, artifact: PreparedOutput, budget?: OutputBudget): string {
  const excerpt = abbreviateOutput(content, budget ?? DEFAULT_OUTPUT_POLICY.model_context);
  if (!excerpt.abbreviated || !artifact.capture) return excerpt.text;
  return `${excerpt.text}\n\n[full critic artifact: ${artifact.capture.evidence_pointer}; sha256=${artifact.capture.content_sha256}]`;
}
