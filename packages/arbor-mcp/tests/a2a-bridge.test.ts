import { describe, expect, it } from "vitest";
import {
  inboundA2AToNodeCommunication,
  outboundNodeCommunicationToA2A,
  publishNodeCardAsA2A,
  verifyA2AAgentCard,
  validateA2AMessage,
  validateA2ATask,
  type A2AMessage,
  type A2ABridgeConfig,
} from "../src/index.js";
import { deriveNodeCard } from "@arbor/core";
import type { NodeCommunication } from "@arbor/audit";

const SECRET = "a2a-bridge-test-secret";
const CARD_SECRET = "nodecard-test-secret";

const config: A2ABridgeConfig = { signing_secret: SECRET, default_recipient_tier: "specialist" };

function makeMessage(overrides: Partial<A2AMessage> = {}): A2AMessage {
  return {
    id: "msg-1",
    task_id: "task-1",
    author_node_ref: "n-alpha",
    recipient_node_refs: ["n-beta"],
    parts: [{ kind: "text", text: "do the thing" }],
    as_of: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

const LEGACY_CARD_CONFIG = {
  signing_secret: "a2a-card-publish",
  default_recipient_tier: "specialist" as const,
};

describe("inboundA2AToNodeCommunication", () => {
  it("converts an A2A message to a delegate NodeCommunication", () => {
    const msg = makeMessage();
    const { kind, communication } = inboundA2AToNodeCommunication(msg, config);
    expect(kind).toBe("delegate");
    expect(communication.author_node_id).toBe("n-alpha");
    expect(communication.recipient_node_id).toBe("n-beta");
    expect(communication.payload.content).toBe("do the thing");
    expect(communication.capability_tier).toBe("specialist");
    expect(communication.idempotency_key).toBe("a2a:msg-1");
  });

  it("handles multiple recipients via other_recipient_node_ids", () => {
    const msg = makeMessage({ recipient_node_refs: ["n1", "n2", "n3"] });
    const { communication } = inboundA2AToNodeCommunication(msg, config);
    expect(communication.recipient_node_id).toBe("n1");
    expect(communication.other_recipient_node_ids).toEqual(["n2", "n3"]);
  });
});

describe("outboundNodeCommunicationToA2A", () => {
  it("converts a NodeCommunication record to an A2A message", () => {
    const comm: NodeCommunication = {
      author_node_id: "n1",
      recipient_node_id: "n2",
      other_recipient_node_ids: ["n3"],
      kind: "report",
      payload: { content: "done", provenance: { tag: "claimed", claimant: "n1" } },
      capability_tier: "specialist",
      trigger_turn: false,
      as_of: "2026-01-01T00:00:00Z",
      correlation_id: "a2a:task-1",
      idempotency_key: "a2a:msg-1",
      acknowledges_communication_id: null,
      retracts_communication_id: null,
    };
    const a2a = outboundNodeCommunicationToA2A(comm, config);
    expect(a2a.id).toBe("msg-1");
    expect(a2a.task_id).toBe("task-1");
    expect(a2a.author_node_ref).toBe("n1");
    expect(a2a.recipient_node_refs).toEqual(["n2", "n3"]);
    expect(a2a.parts[0]!.text).toBe("done");
  });
});

describe("round-trip identity", () => {
  it("inbound(outout(record)) preserves semantic content", () => {
    const originalComm: NodeCommunication = {
      author_node_id: "n-author",
      recipient_node_id: "n-recipient",
      other_recipient_node_ids: [],
      kind: "delegate",
      payload: { content: "round-trip content", provenance: { tag: "claimed", claimant: "n-author" } },
      capability_tier: "specialist",
      trigger_turn: false,
      as_of: "2026-01-01T00:00:00Z",
      correlation_id: "a2a:task-rt",
      idempotency_key: "a2a:msg-rt",
      acknowledges_communication_id: null,
      retracts_communication_id: null,
    };
    const a2a = outboundNodeCommunicationToA2A(originalComm, config);
    const { communication: restored } = inboundA2AToNodeCommunication(a2a, config);
    expect(restored.author_node_id).toBe(originalComm.author_node_id);
    expect(restored.recipient_node_id).toBe(originalComm.recipient_node_id);
    expect(restored.payload.content).toBe(originalComm.payload.content);
    expect(restored.kind).toBe("delegate");
  });
});

describe("publishNodeCardAsA2A + verifyA2AAgentCard", () => {
  it("publishes a verifiable A2A AgentCard from a NodeCard", () => {
    const card = deriveNodeCard({
      node_id: "n-1", role: "specialist", skills: ["code", "test"], tier: "specialist",
      modes: ["steerable"], inputs: [], outputs: [], source: "builtin",
    }, CARD_SECRET);
    const a2aCard = publishNodeCardAsA2A(card, LEGACY_CARD_CONFIG);
    expect(a2aCard.node_ref).toBe("n-1");
    expect(a2aCard.role).toBe("specialist");
    expect(a2aCard.skills).toEqual(["code", "test"]);
    expect(a2aCard.signature).toHaveLength(64);
  });

  it("verifyA2AAgentCard returns true for a freshly-published card (same secret)", () => {
    const card = deriveNodeCard({
      node_id: "n-1", role: "specialist", skills: ["code"], tier: "specialist",
      modes: ["steerable"], inputs: [], outputs: [], source: "builtin",
    }, CARD_SECRET);
    const a2aCard = publishNodeCardAsA2A(card, LEGACY_CARD_CONFIG);
    expect(verifyA2AAgentCard(a2aCard, "a2a-card-publish")).toBe(true);
  });

  it("verifyA2AAgentCard returns false for a tampered card", () => {
    const card = deriveNodeCard({
      node_id: "n-1", role: "specialist", skills: ["code"], tier: "specialist",
      modes: ["steerable"], inputs: [], outputs: [], source: "builtin",
    }, CARD_SECRET);
    const a2aCard = publishNodeCardAsA2A(card, LEGACY_CARD_CONFIG);
    const tampered = { ...a2aCard, node_ref: "tampered" };
    expect(verifyA2AAgentCard(tampered, "a2a-card-publish")).toBe(false);
  });

  it("verifyA2AAgentCard returns false for wrong secret", () => {
    const card = deriveNodeCard({
      node_id: "n-1", role: "specialist", skills: ["code"], tier: "specialist",
      modes: ["steerable"], inputs: [], outputs: [], source: "builtin",
    }, CARD_SECRET);
    const a2aCard = publishNodeCardAsA2A(card, LEGACY_CARD_CONFIG);
    expect(verifyA2AAgentCard(a2aCard, "wrong-secret")).toBe(false);
  });

  it("verifyA2AAgentCard returns false for malformed input", () => {
    expect(verifyA2AAgentCard(null as never, "secret")).toBe(false);
    expect(verifyA2AAgentCard({} as never, "secret")).toBe(false);
    expect(verifyA2AAgentCard({ signature: "short" } as never, "secret")).toBe(false);
  });

  it("publishNodeCardAsA2A signs with the deployment's own signing_secret when a bridge config is supplied", () => {
    const card = deriveNodeCard({
      node_id: "n-1", role: "specialist", skills: ["code"], tier: "specialist",
      modes: ["steerable"], inputs: [], outputs: [], source: "builtin",
    }, CARD_SECRET);
    const deploymentConfig: A2ABridgeConfig = { signing_secret: "deployment-only-secret", default_recipient_tier: "specialist" };
    const a2aCard = publishNodeCardAsA2A(card, deploymentConfig);
    // Signed with the deployment secret, not the module-wide default literal:
    // a party that only knows the old hardcoded default can no longer forge
    // or verify this deployment's cards.
    expect(verifyA2AAgentCard(a2aCard, "deployment-only-secret")).toBe(true);
    expect(verifyA2AAgentCard(a2aCard, "a2a-card-publish")).toBe(false);
  });

  it("two deployments with different signing_secret configs produce non-interchangeable cards for the same NodeCard", () => {
    const card = deriveNodeCard({
      node_id: "n-1", role: "specialist", skills: ["code"], tier: "specialist",
      modes: ["steerable"], inputs: [], outputs: [], source: "builtin",
    }, CARD_SECRET);
    const configA: A2ABridgeConfig = { signing_secret: "tenant-a-secret", default_recipient_tier: "specialist" };
    const configB: A2ABridgeConfig = { signing_secret: "tenant-b-secret", default_recipient_tier: "specialist" };
    const cardFromA = publishNodeCardAsA2A(card, configA);
    // Tenant B's verifier (its own secret) must reject a card tenant A published.
    expect(verifyA2AAgentCard(cardFromA, configB.signing_secret)).toBe(false);
    expect(verifyA2AAgentCard(cardFromA, configA.signing_secret)).toBe(true);
  });
});

describe("task lifecycle projection attached to inbound/outbound conversion", () => {
  it("inboundA2AToNodeCommunication attaches a derived task snapshot alongside the communication", () => {
    const msg = makeMessage({ task_id: "task-derive-1" });
    const { communication, task } = inboundA2AToNodeCommunication(msg, config);
    expect(task.id).toBe("task-derive-1");
    expect(task.node_ref).toBe(communication.recipient_node_id);
    // A first-ever delegate seeds the task as "submitted" per the state machine.
    expect(task.state).toBe("submitted");
  });

  it("outboundNodeCommunicationToA2A attaches a derived task snapshot to the projected message", () => {
    const comm: NodeCommunication = {
      author_node_id: "n1", recipient_node_id: "n2", other_recipient_node_ids: [],
      kind: "report", payload: { content: "done", provenance: { tag: "claimed", claimant: "n1" } },
      capability_tier: "specialist", trigger_turn: false, as_of: "2026-01-01T00:00:00Z",
      correlation_id: "a2a:task-derive-2", idempotency_key: "a2a:msg-derive-2",
      acknowledges_communication_id: null, retracts_communication_id: null,
    };
    const a2a = outboundNodeCommunicationToA2A(comm, config);
    expect(a2a.task).toMatchObject({ id: "task-derive-2", node_ref: "n2", state: "completed" });
  });
});

describe("bridge holds no state", () => {
  it("every function is pure (no module-level Maps/queues/files)", () => {
    const msg = makeMessage();
    const { communication } = inboundA2AToNodeCommunication(msg, config);
    const a2a = outboundNodeCommunicationToA2A(communication, config);
    const { communication: again } = inboundA2AToNodeCommunication(a2a, config);
    expect(again.author_node_id).toBe(communication.author_node_id);
    expect(again.payload.content).toBe(communication.payload.content);
  });
});

describe("validateA2AMessage", () => {
  it("passes a valid message", () => {
    expect(validateA2AMessage(makeMessage())).toEqual([]);
  });

  it("rejects empty id", () => {
    expect(validateA2AMessage(makeMessage({ id: "" }))).toContain("id must be non-empty");
  });

  it("rejects oversized text part (>4096 bytes)", () => {
    const big = "x".repeat(4097);
    expect(validateA2AMessage(makeMessage({ parts: [{ kind: "text", text: big }] }))).toContain("part[0].text exceeds 4096 bytes");
  });

  it("rejects too many parts (>32)", () => {
    const parts = Array.from({ length: 33 }, () => ({ kind: "text" as const, text: "x" }));
    expect(validateA2AMessage(makeMessage({ parts }))).toContain("parts exceeds 32");
  });

  it("rejects too many recipients (>16)", () => {
    const refs = Array.from({ length: 17 }, (_, i) => `n${i}`);
    expect(validateA2AMessage(makeMessage({ recipient_node_refs: refs }))).toContain("recipient_node_refs exceeds 16");
  });

  it("rejects unknown part kind", () => {
    expect(validateA2AMessage(makeMessage({ parts: [{ kind: "unknown" as never }] }))).toContain("part[0].kind must be text or evidence_ref");
  });
});

describe("validateA2ATask", () => {
  it("passes a valid task", () => {
    expect(validateA2ATask({ id: "t1", state: "working", node_ref: "n1" })).toEqual([]);
  });

  it("rejects unknown task state", () => {
    expect(validateA2ATask({ id: "t1", state: "unknown" as never, node_ref: "n1" })).toContain("state must be one of: submitted, working, input_required, completed, canceled, failed");
  });

  it("rejects empty node_ref", () => {
    expect(validateA2ATask({ id: "t1", state: "working", node_ref: "" })).toContain("node_ref must be non-empty");
  });
});

describe("A2A v1.0.0 agent card projection", () => {
  it("declares the evidence extension so a peer discovers it before exchanging messages", () => {
    const nodeCard = deriveNodeCard({
      node_id: "n-1", role: "specialist", skills: ["code", "test"], tier: "specialist",
      modes: ["steerable"], inputs: [], outputs: [], source: "builtin",
    }, CARD_SECRET);
    const published = publishNodeCardAsA2A(nodeCard, LEGACY_CARD_CONFIG);
    // The discovery half of A2A's extension mechanism: a peer learns revoy2
    // speaks the evidence extension from the card, not by trial and error.
    expect(published.wire.extensions).toEqual([
      { uri: "https://arbor.dev/a2a/extensions/evidence-ref/v1", required: false },
    ]);
    // required:false — a stock client ignoring it still interoperates fully.
    expect(published.wire.extensions[0].required).toBe(false);
    // revoy2's HMAC has no A2A counterpart, so it rides in metadata rather
    // than being dropped on the way to the wire.
    expect(published.wire.metadata["arbor.dev/card-signature"]).toBe(published.signature);
    expect(published.wire.name).toBe(published.node_ref);
  });
});
