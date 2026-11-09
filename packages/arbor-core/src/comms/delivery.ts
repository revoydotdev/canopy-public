/**
 * Delivery policy (operator decision 4, 2026-10-07): C2 commands, C2 replies
 * and commons @mentions are INJECTED into the recipient's live session at its
 * next turn boundary; everything else is PULL-only (the recipient reads it
 * through a tool). Injected text is labelled by its source and is never
 * framed as the operator unless the operator sent it.
 */
import type { CommsEnvelope } from "./envelope.js";
import type { CommsRoom } from "./rooms.js";

export type CommsDeliveryMode = "inject" | "pull" | "none";

/**
 * How `envelope` reaches `recipientNodeId`. `room` is required for commons
 * and ignored otherwise. A sender never receives its own message, and a
 * commons post reaches only room members.
 */
export function deliveryModeFor(envelope: CommsEnvelope, recipientNodeId: string, room?: CommsRoom): CommsDeliveryMode {
  if (envelope.sender.kind === "agent" && envelope.sender.node_id === recipientNodeId) return "none";
  switch (envelope.channel) {
    case "c2":
      return envelope.recipients.includes(recipientNodeId) ? "inject" : "none";
    case "thread":
      return envelope.recipients.includes(recipientNodeId) ? "pull" : "none";
    case "commons":
      if (room === undefined || room.room_id !== envelope.conversation_id || !room.members.includes(recipientNodeId)) return "none";
      return envelope.mentions.includes(recipientNodeId) ? "inject" : "pull";
  }
}

/**
 * The one-line source label an injected message is framed with. Only an
 * operator-sent envelope is labelled as the operator; an agent's message names
 * its agent and node, and the host loop is named as the host loop.
 */
export function injectionLabel(envelope: CommsEnvelope): string {
  const source = envelope.sender.kind === "operator"
    ? "operator"
    : envelope.sender.kind === "host_loop"
      ? "host loop (crown)"
      : `agent ${envelope.sender.agent} at node ${envelope.sender.node_id}`;
  const what = envelope.payload.type === "command"
    ? `c2 command ${envelope.payload.command.kind}`
    : envelope.payload.type === "reply"
      ? `c2 reply ${envelope.payload.reply.kind}`
      : envelope.channel === "commons" ? `commons mention in ${envelope.conversation_id}` : `thread message in ${envelope.conversation_id}`;
  return `[${what} from ${source}; provenance ${envelope.provenance.tag}]`;
}
