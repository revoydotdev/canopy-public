import { createHmac, timingSafeEqual } from "node:crypto";
import { compareCodeUnits, type NodeCard } from "@arbor/core";
import type { NodeCommunication, NodeCommunicationKind } from "@arbor/audit";
import type { A2AMessage, A2AAgentCard, A2APart, A2ATask, A2ATaskState } from "./a2a-contracts.js";
import { EVIDENCE_REF_EXTENSION_URI, type WireAgentCard } from "./a2a-wire.js";

export interface A2ABridgeConfig {
  readonly signing_secret: string;
  readonly default_recipient_tier: "specialist" | "critic" | "auditor" | "orchestrator";
}

/**
 * The bridge configuration for a real deployment, or null when none is set.
 *
 * FAIL-CLOSED BY CONSTRUCTION. Without a configured secret this returns null
 * and the composition root leaves `a2a_bridge` unset, so `a2a.send`/`a2a.receive`
 * keep rejecting with "unavailable". The alternative — enabling the bridge with
 * a default secret — would publish cards signed by a value an attacker also
 * has, which is worse than having no A2A surface at all. A2A is therefore
 * opt-in: set ARBOR_A2A_SIGNING_SECRET to turn it on.
 */
export function a2aBridgeFromEnvironment(
  env: Record<string, string | undefined> = process.env,
): A2ABridgeConfig | null {
  const secret = env.ARBOR_A2A_SIGNING_SECRET;
  if (typeof secret !== "string" || secret.trim().length === 0) return null;
  const tier = env.ARBOR_A2A_DEFAULT_RECIPIENT_TIER;
  const valid = new Set(["specialist", "critic", "auditor", "orchestrator"]);
  return {
    signing_secret: secret,
    default_recipient_tier: (typeof tier === "string" && valid.has(tier)
      ? tier
      : "specialist") as A2ABridgeConfig["default_recipient_tier"],
  };
}

/**
 * The `a2a_bridge` slice of `RuntimeRouterOptions`, spreadable directly into a
 * composition root's router construction.
 *
 * Exists because every root previously wrote
 * `...(a2aBridgeFromEnvironment() === null ? {} : { a2a_bridge: a2aBridgeFromEnvironment()! })`,
 * which reads the environment twice per construction and non-null-asserts the
 * second read on the strength of the first. Harmless in practice, but it is a
 * TOCTOU shape asserted away with `!`, repeated verbatim in three roots — the
 * kind of duplication that drifts. One read, one decision, no assertion.
 */
export function a2aBridgeOption(
  env: Record<string, string | undefined> = process.env,
): { a2a_bridge?: A2ABridgeConfig } {
  const config = a2aBridgeFromEnvironment(env);
  return config === null ? {} : { a2a_bridge: config };
}

type BridgeableKind = "delegate" | "report" | "reply";

function hexSignature(data: string, secret: string): string {
  return createHmac("sha256", secret).update(data, "utf8").digest("hex");
}

function canonicalJsonSorted(data: Record<string, unknown>): string {
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(data).sort()) sorted[key] = data[key];
  return JSON.stringify(sorted);
}

/**
 * Task lifecycle states that are *terminal*: once ledger-witnessed evidence
 * has driven a task here, no later communication — forged, replayed, or
 * legitimately out-of-order — may move it back to a non-terminal state.
 * This is the concrete mechanism behind "the ledger is the sole authority":
 * an A2A client's own claim about task state is never trusted; the state
 * A2A observers see is always *recomputed* from durably recorded
 * NodeCommunication records, and that recomputation refuses to regress.
 */
const A2A_TERMINAL_TASK_STATES: ReadonlySet<A2ATaskState> = new Set(["completed", "canceled", "failed"]);

/**
 * Pure, single-step reconciliation of A2A task lifecycle state from one
 * ledger-witnessed NodeCommunication kind. Never reads or trusts a
 * caller-supplied "current state" claim — the only inputs are the prior
 * *derived* state and the kind of the next durably-recorded communication.
 *
 * Transition table (NodeCommunicationKind -> effect, absent terminal lock):
 *   delegate -> "submitted" the first time a task is seen, otherwise a
 *               no-op (a later delegate cannot un-do progress already made).
 *   clarify  -> "input_required" (the node is blocked on more input).
 *   reply    -> "working" (resolves a pending input_required, or is a
 *               no-op continuation of already-active work).
 *   steer    -> "working", unless currently input_required (a steer is not
 *               the reply that clears a pending question).
 *   promote  -> preserves the current state if one exists, else "working".
 *   report   -> "completed" (terminal).
 *   retract  -> "canceled" (terminal).
 */
export function deriveA2ATaskState(priorState: A2ATaskState | undefined, kind: NodeCommunicationKind): A2ATaskState {
  if (priorState !== undefined && A2A_TERMINAL_TASK_STATES.has(priorState)) return priorState;
  switch (kind) {
    case "delegate": return priorState ?? "submitted";
    case "clarify": return "input_required";
    case "reply": return "working";
    case "steer": return priorState === "input_required" ? "input_required" : "working";
    case "promote": return priorState ?? "working";
    case "report": return "completed";
    case "retract": return "canceled";
    default: return priorState ?? "submitted";
  }
}

/**
 * Folds an *unordered* set of ledger-witnessed NodeCommunication records
 * into the current A2A task lifecycle snapshot. This is the ledger-facts
 * projection described by ROADMAP 4D.6 ("bridges A2A Task lifecycle to
 * ledger BusMessage records") — always recomputed, never cached, and never
 * overridden by anything the A2A wire side claims. Ordering is by `as_of`
 * with `idempotency_key` (via `compareCodeUnits`, never `localeCompare`) as
 * a deterministic tiebreak, so replaying the same evidence set always
 * yields the same task snapshot regardless of the array's input order.
 */
export function deriveA2ATaskFromCommunications(
  communications: readonly NodeCommunication[],
  task_id: string,
  node_ref: string,
): A2ATask {
  const ordered = [...communications].sort((a, b) => {
    if (a.as_of !== b.as_of) return a.as_of < b.as_of ? -1 : 1;
    return compareCodeUnits(a.idempotency_key, b.idempotency_key);
  });
  let state: A2ATaskState | undefined;
  for (const communication of ordered) state = deriveA2ATaskState(state, communication.kind);
  return { id: task_id, state: state ?? "submitted", node_ref };
}

export function inboundA2AToNodeCommunication(
  message: A2AMessage,
  config: A2ABridgeConfig,
  priorCommunications: readonly NodeCommunication[] = [],
): { kind: BridgeableKind; communication: NodeCommunication; task: A2ATask } {
  const primaryRecipient = message.recipient_node_refs[0] ?? "";
  const textPart = message.parts.find((p) => p.kind === "text");
  const content = textPart?.text ?? "";
  const kind: BridgeableKind = "delegate";

  const communication: NodeCommunication = {
    author_node_id: message.author_node_ref,
    recipient_node_id: primaryRecipient,
    other_recipient_node_ids: message.recipient_node_refs.slice(1),
    kind,
    payload: { content, provenance: { tag: "claimed", claimant: message.author_node_ref } },
    capability_tier: config.default_recipient_tier,
    trigger_turn: false,
    as_of: message.as_of,
    correlation_id: `a2a:${message.task_id}`,
    idempotency_key: `a2a:${message.id}`,
    acknowledges_communication_id: null,
    retracts_communication_id: null,
  };
  const task = deriveA2ATaskFromCommunications([...priorCommunications, communication], message.task_id, primaryRecipient);
  return { kind, communication, task };
}

export function outboundNodeCommunicationToA2A(
  record: NodeCommunication,
  _config: A2ABridgeConfig,
  priorCommunications: readonly NodeCommunication[] = [],
): A2AMessage {
  const parts: A2APart[] = [
    { kind: "text", text: record.payload.content },
  ];
  const task_id = record.correlation_id.startsWith("a2a:") ? record.correlation_id.slice(4) : record.correlation_id;
  const task = deriveA2ATaskFromCommunications([...priorCommunications, record], task_id, record.recipient_node_id);
  return {
    id: record.idempotency_key.startsWith("a2a:") ? record.idempotency_key.slice(4) : record.idempotency_key,
    task_id,
    author_node_ref: record.author_node_id,
    recipient_node_refs: [record.recipient_node_id, ...record.other_recipient_node_ids],
    parts,
    as_of: record.as_of,
    task,
  };
}

/**
 * Sign a node card for publication.
 *
 * `config` is REQUIRED. It used to be optional with the signing secret falling
 * back to the literal "a2a-card-publish", which meant every deployment signed
 * and verified with the same public constant — a signature whose key is a
 * published string is obfuscation, not tamper-evidence, and it would have been
 * a trap for the first caller to wire this up. Making the parameter required
 * moves that from a runtime footgun to a compile error.
 */
/**
 * Internal agent card -> conformant A2A v1.0.0 AgentCard.
 *
 * Module-private and deliberately NOT exported from the conformance layer: an
 * exported projection here would be an unreachable symbol, because its only
 * possible caller is `publishNodeCardAsA2A`, which is itself blocked on G-01
 * (no live source of campaign node cards is wired yet). Keeping it private
 * removes the symbol instead of papering it with a second waiver for a gap
 * that already has one.
 *
 * The card DECLARES the evidence-ref extension — that declaration is how a peer
 * discovers revoy2 speaks it before exchanging any message, which is the
 * discovery half of A2A's extension mechanism. `required: false`, because a
 * peer that ignores the extension still interoperates fully; marking it
 * required would exclude stock clients for no benefit. revoy2's HMAC signature
 * has no A2A counterpart, so it rides in `metadata` rather than being dropped.
 */
function agentCardToWire(card: A2AAgentCard): WireAgentCard {
  return {
    name: card.node_ref,
    description: `revoy2 ${card.role} node (tier ${card.tier})`,
    skills: [...card.skills].sort(compareCodeUnits).map((skill) => ({ id: skill, name: skill })),
    extensions: [{ uri: EVIDENCE_REF_EXTENSION_URI, required: false }],
    metadata: {
      "arbor.dev/role": card.role,
      "arbor.dev/tier": card.tier,
      "arbor.dev/card-signature": card.signature,
    },
  };
}

export function publishNodeCardAsA2A(card: NodeCard, config: A2ABridgeConfig): A2AAgentCard & { readonly wire: WireAgentCard } {
  const data = {
    node_ref: card.node_id,
    role: card.role,
    skills: [...card.skills].sort(),
    tier: card.tier,
  };
  const published: A2AAgentCard = {
    ...data,
    signature: hexSignature(canonicalJsonSorted(data), config.signing_secret),
  };
  // The card a peer actually discovers is the v1.0.0 shape, which is also
  // where the evidence-ref extension is DECLARED — that declaration is how a
  // peer learns revoy2 speaks it before any message is exchanged. Attached
  // rather than returned separately so the two can never be published apart.
  return { ...published, wire: agentCardToWire(published) };
}

export function verifyA2AAgentCard(card: A2AAgentCard, secret: string): boolean {
  if (!card || typeof card !== "object") return false;
  if (!card.signature || card.signature.length !== 64) return false;
  const data = {
    node_ref: card.node_ref,
    role: card.role,
    skills: [...(card.skills ?? [])].sort(),
    tier: card.tier,
  };
  const expected = hexSignature(canonicalJsonSorted(data), secret);
  const a = Buffer.from(expected, "hex");
  const b = Buffer.from(card.signature, "hex");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
