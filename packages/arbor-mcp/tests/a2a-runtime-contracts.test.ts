import { describe, expect, it } from "vitest";
import {
  isA2ASendCommandEnvelope,
  isA2AReceiveCommandEnvelope,
  validateA2ASendCommand,
  validateA2AReceiveCommand,
  type A2ASendCommandEnvelope,
  type A2AReceiveCommandEnvelope,
} from "../src/a2a-runtime-contracts.js";
import type { NodeCommunication } from "@arbor/audit";

function metadata(overrides: Partial<Record<string, string>> = {}) {
  return {
    operation_id: "op-1", idempotency_key: "key-1", correlation_id: "correlation-1", actor_id: "operator",
    requested_at: "2026-08-01T00:00:00.000Z", ...overrides,
  };
}

function communication(overrides: Partial<NodeCommunication> = {}): NodeCommunication {
  return {
    author_node_id: "root", recipient_node_id: "external-agent", other_recipient_node_ids: [],
    kind: "report", payload: { content: "done", provenance: { tag: "claimed", claimant: "root" } },
    capability_tier: "specialist", trigger_turn: false, as_of: "2026-08-01T00:00:00.000Z",
    correlation_id: "a2a:task-1", idempotency_key: "a2a:msg-1",
    acknowledges_communication_id: null, retracts_communication_id: null,
    ...overrides,
  };
}

function sendEnvelope(overrides: Partial<A2ASendCommandEnvelope["command"]> = {}, metaOverrides: Partial<Record<string, string>> = {}): A2ASendCommandEnvelope {
  return {
    schema_version: 1,
    metadata: metadata(metaOverrides),
    command: { kind: "a2a.send", campaign_id: "campaign", node_id: "root", communication: communication(), ...overrides },
  };
}

function receiveEnvelope(messageOverrides: Partial<A2AReceiveCommandEnvelope["command"]["message"]> = {}, metaOverrides: Partial<Record<string, string>> = {}): A2AReceiveCommandEnvelope {
  return {
    schema_version: 1,
    metadata: metadata(metaOverrides),
    command: {
      kind: "a2a.receive", campaign_id: "campaign", node_id: "root",
      message: {
        id: "msg-in", task_id: "task-in", author_node_ref: "external-agent",
        recipient_node_refs: ["root"], parts: [{ kind: "text", text: "hello" }],
        as_of: "2026-08-01T00:00:00.000Z", ...messageOverrides,
      },
    },
  };
}

describe("isA2ASendCommandEnvelope", () => {
  it("accepts a well-formed a2a.send envelope", () => {
    expect(isA2ASendCommandEnvelope(sendEnvelope())).toBe(true);
  });
  it("rejects a receive envelope (wrong kind discriminator)", () => {
    expect(isA2ASendCommandEnvelope(receiveEnvelope())).toBe(false);
  });
  it("rejects null/primitive/array input", () => {
    expect(isA2ASendCommandEnvelope(null)).toBe(false);
    expect(isA2ASendCommandEnvelope("a2a.send")).toBe(false);
    expect(isA2ASendCommandEnvelope([])).toBe(false);
    expect(isA2ASendCommandEnvelope(42)).toBe(false);
  });
  it("rejects a missing schema_version", () => {
    const { schema_version: _drop, ...rest } = sendEnvelope();
    expect(isA2ASendCommandEnvelope(rest)).toBe(false);
  });
  it("rejects a non-object metadata or command", () => {
    expect(isA2ASendCommandEnvelope({ schema_version: 1, metadata: "nope", command: {} })).toBe(false);
    expect(isA2ASendCommandEnvelope({ schema_version: 1, metadata: {}, command: "nope" })).toBe(false);
  });
});

describe("isA2AReceiveCommandEnvelope", () => {
  it("accepts a well-formed a2a.receive envelope", () => {
    expect(isA2AReceiveCommandEnvelope(receiveEnvelope())).toBe(true);
  });
  it("rejects a send envelope (wrong kind discriminator)", () => {
    expect(isA2AReceiveCommandEnvelope(sendEnvelope())).toBe(false);
  });
});

describe("validateA2ASendCommand", () => {
  it("passes a well-formed command", () => {
    expect(validateA2ASendCommand(sendEnvelope())).toEqual([]);
  });

  it("rejects missing metadata identity fields one at a time", () => {
    expect(validateA2ASendCommand(sendEnvelope({}, { operation_id: "" }))).toContain("metadata identity fields are required");
    expect(validateA2ASendCommand(sendEnvelope({}, { idempotency_key: "" }))).toContain("metadata identity fields are required");
    expect(validateA2ASendCommand(sendEnvelope({}, { correlation_id: "" }))).toContain("metadata identity fields are required");
    expect(validateA2ASendCommand(sendEnvelope({}, { actor_id: "" }))).toContain("metadata identity fields are required");
  });

  it("rejects a missing campaign_id, node_id, or communication", () => {
    expect(validateA2ASendCommand(sendEnvelope({ campaign_id: "" }))).toContain("campaign, node, and communication are required");
    expect(validateA2ASendCommand(sendEnvelope({ node_id: "" }))).toContain("campaign, node, and communication are required");
    expect(validateA2ASendCommand(sendEnvelope({ communication: undefined as never }))).toContain("campaign, node, and communication are required");
  });
});

describe("validateA2AReceiveCommand", () => {
  it("passes a well-formed command", () => {
    expect(validateA2AReceiveCommand(receiveEnvelope())).toEqual([]);
  });

  it("rejects missing metadata identity fields", () => {
    expect(validateA2AReceiveCommand(receiveEnvelope({}, { actor_id: "" }))).toContain("metadata identity fields are required");
  });

  it("rejects a missing campaign_id or node_id", () => {
    const env = receiveEnvelope();
    expect(validateA2AReceiveCommand({ ...env, command: { ...env.command, campaign_id: "" } }))
      .toContain("campaign_id and node_id are required");
    expect(validateA2AReceiveCommand({ ...env, command: { ...env.command, node_id: "" } }))
      .toContain("campaign_id and node_id are required");
  });

  it("rejects a malformed message and surfaces the underlying validateA2AMessage failures", () => {
    const failures = validateA2AReceiveCommand(receiveEnvelope({ id: "" }));
    expect(failures).toContain("id must be non-empty");
  });

  it("rejects a message with an oversized text part, delegated to validateA2AMessage", () => {
    const failures = validateA2AReceiveCommand(receiveEnvelope({ parts: [{ kind: "text", text: "x".repeat(4097) }] }));
    expect(failures).toContain("part[0].text exceeds 4096 bytes");
  });

  it("rejects a non-well-formed message object entirely (isA2AMessage guard fails)", () => {
    const env = receiveEnvelope();
    const failures = validateA2AReceiveCommand({ ...env, command: { ...env.command, message: { bogus: true } as never } });
    expect(failures).toContain("a well-formed A2A message is required");
  });
});
