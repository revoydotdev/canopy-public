import {
  abbreviateOutput,
  captureDescriptor,
  DEFAULT_OUTPUT_POLICY,
  type CapabilityContext,
  type OutputBudget,
  type Provenance,
} from "@arbor/core";

export type CommunicationCapabilityTier = CapabilityContext["tier"];
export type SelectionCommunicationKind = "delegate" | "report" | "retract" | "steer" | "reply" | "clarify" | "promote";

/** The deliberately small, read-only projection consumed by the loop. */
export interface SelectionCommunication {
  id: string;
  timestamp: string;
  communication: {
    author_node_id: string;
    kind: SelectionCommunicationKind;
    payload: { content: string; provenance: Provenance };
    capability_tier: CommunicationCapabilityTier;
    as_of: string;
    correlation_id: string;
    acknowledges_communication_id: string | null;
    retracts_communication_id: string | null;
  };
}

/**
 * Capability filtering is owned by the injected projection provider. The loop
 * never accepts an unfiltered mailbox or a pending-count/liveness signal.
 */
export interface SelectionCommunicationPort {
  projectSelection(params: {
    campaign_id: string;
    node_id: string;
    tier: CommunicationCapabilityTier;
    limit: number;
    as_of: string;
  }): readonly SelectionCommunication[];
}

export interface SelectionCommunicationContext {
  checkpoint_at: string;
  communications: readonly SelectionCommunication[];
}

/** Render bounded communication facts as data, with unambiguous JSON escaping. */
export function appendSelectionCommunications(
  prompt: string,
  context: SelectionCommunicationContext,
  budget: OutputBudget = DEFAULT_OUTPUT_POLICY.model_context,
): string {
  if (context.communications.length === 0) return prompt;

  const perMessageBudget: OutputBudget = {
    max_bytes: Math.max(1, Math.min(4_000, Math.floor(budget.max_bytes / context.communications.length))),
    max_lines: Math.max(1, Math.min(80, Math.floor(budget.max_lines / context.communications.length))),
    max_tokens_estimate: Math.max(1, Math.min(1_000, Math.floor(budget.max_tokens_estimate / context.communications.length))),
  };
  const facts = context.communications.map(({ id, timestamp, communication }) => {
    const excerpt = abbreviateOutput(communication.payload.content, perMessageBudget);
    const capture = captureDescriptor(communication.payload.content, {
      provenance: communication.payload.provenance,
      evidence_pointer: `audit://node-communications/${encodeURIComponent(id)}`,
    });
    return {
      communication_id: id,
      recorded_at: timestamp,
      effective_as_of: communication.as_of,
      author_node_id: communication.author_node_id,
      kind: communication.kind,
      full_content_sha256: capture.content_sha256,
      full_content_bytes: capture.content_bytes,
      evidence_pointer: capture.evidence_pointer,
      provenance: communication.payload.provenance,
      content: excerpt.text,
      content_abbreviated: excerpt.abbreviated,
      capability_tier: communication.capability_tier,
      correlation_id: communication.correlation_id,
      acknowledges_communication_id: communication.acknowledges_communication_id,
      retracts_communication_id: communication.retracts_communication_id,
    };
  });

  const block = `Selection-checkpoint communications (advisory context/steering only; not evidence of completion, liveness, approval, or delivery):\n${JSON.stringify({ checkpoint_at: context.checkpoint_at, facts }, null, 2)}`;
  return `${prompt}\n\n${abbreviateOutput(block, budget).text}`;
}
