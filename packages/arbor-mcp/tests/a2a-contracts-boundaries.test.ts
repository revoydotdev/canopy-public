import { describe, expect, it } from "vitest";
import {
  A2A_MAX_NODE_REF_BYTES,
  A2A_MAX_PARTS,
  A2A_MAX_RECIPIENTS,
  A2A_MAX_TEXT_PART_BYTES,
  isA2AMessage,
  validateA2AMessage,
  validateA2ATask,
  type A2AMessage,
} from "../src/a2a-contracts.js";

function message(overrides: Partial<A2AMessage> = {}): A2AMessage {
  return {
    id: "message-1",
    task_id: "task-1",
    author_node_ref: "author-1",
    recipient_node_refs: ["recipient-1"],
    parts: [{ kind: "text", text: "hello" }],
    as_of: "2026-08-25T12:00:00.000Z",
    ...overrides,
  };
}

const overlongNodeRef = "n".repeat(A2A_MAX_NODE_REF_BYTES + 1);

describe("A2A contract boundary validation", () => {
  it("reports blank and oversized message identity fields independently", () => {
    const cases: Array<[Partial<A2AMessage>, string]> = [
      [{ id: " " }, "id must be non-empty"],
      [{ task_id: " " }, "task_id must be non-empty"],
      [{ author_node_ref: " " }, "author_node_ref must be non-empty"],
      [{ id: overlongNodeRef }, `id exceeds ${A2A_MAX_NODE_REF_BYTES} bytes`],
      [{ task_id: overlongNodeRef }, `task_id exceeds ${A2A_MAX_NODE_REF_BYTES} bytes`],
      [{ author_node_ref: overlongNodeRef }, `author_node_ref exceeds ${A2A_MAX_NODE_REF_BYTES} bytes`],
      [{ as_of: " " }, "as_of must be non-empty"],
    ];
    for (const [overrides, failure] of cases) expect(validateA2AMessage(message(overrides))).toContain(failure);
  });

  it("rejects missing runtime message fields without relying on TypeScript declarations", () => {
    for (const [field, failure] of [
      ["id", "id must be non-empty"],
      ["task_id", "task_id must be non-empty"],
      ["author_node_ref", "author_node_ref must be non-empty"],
      ["as_of", "as_of must be non-empty"],
    ] as const) {
      const invalid = { ...message(), [field]: undefined } as unknown as A2AMessage;
      expect(validateA2AMessage(invalid)).toContain(failure);
    }
  });

  it("enforces recipient collection type, count, and individual reference boundaries", () => {
    expect(validateA2AMessage(message({ recipient_node_refs: "recipient-1" as never }))).toContain("recipient_node_refs must be an array");
    expect(validateA2AMessage(message({ recipient_node_refs: Array.from({ length: A2A_MAX_RECIPIENTS + 1 }, (_, index) => `recipient-${index}`) })))
      .toContain(`recipient_node_refs exceeds ${A2A_MAX_RECIPIENTS}`);
    for (const recipient_node_refs of [[""], [" "], [overlongNodeRef]] as const) {
      expect(validateA2AMessage(message({ recipient_node_refs }))).toContain("each recipient_node_ref must be non-empty and ≤128 bytes");
    }
    expect(validateA2AMessage(message({ recipient_node_refs: Array.from({ length: A2A_MAX_RECIPIENTS }, (_, index) => `recipient-${index}`) }))).toEqual([]);
  });

  it("enforces part collection type, count, kind, and content boundaries", () => {
    expect(validateA2AMessage(message({ parts: "text" as never }))).toContain("parts must be an array");
    expect(validateA2AMessage(message({ parts: Array.from({ length: A2A_MAX_PARTS + 1 }, () => ({ kind: "text", text: "x" })) })))
      .toContain(`parts exceeds ${A2A_MAX_PARTS}`);
    expect(validateA2AMessage(message({ parts: [{ kind: "unknown" as never }] }))).toContain("part[0].kind must be text or evidence_ref");
    expect(validateA2AMessage(message({ parts: [{ kind: "text", text: "x".repeat(A2A_MAX_TEXT_PART_BYTES + 1) }] })))
      .toContain(`part[0].text exceeds ${A2A_MAX_TEXT_PART_BYTES} bytes`);
    expect(validateA2AMessage(message({ parts: [{ kind: "text", text: "x".repeat(A2A_MAX_TEXT_PART_BYTES) }] }))).toEqual([]);
  });

  it("fails closed when a typed part lacks its required content", () => {
    for (const parts of [
      [{ kind: "text" as const }],
      [{ kind: "text" as const, text: "" }],
      [{ kind: "evidence_ref" as const }],
      [{ kind: "evidence_ref" as const, evidence_ref: "" }],
    ]) {
      expect(() => validateA2AMessage(message({ parts }))).toThrow(/must be non-empty/);
    }
    expect(validateA2AMessage(message({ parts: [{ kind: "evidence_ref", evidence_ref: "ledger://verified/result-1" }] }))).toEqual([]);
  });

  it("validates every declared task state and reports each task identity boundary", () => {
    for (const state of ["submitted", "working", "input_required", "completed", "canceled", "failed"] as const) {
      expect(validateA2ATask({ id: "task-1", state, node_ref: "node-1" })).toEqual([]);
    }
    for (const [task, failure] of [
      [{ id: " ", state: "working", node_ref: "node-1" }, "id must be non-empty"],
      [{ id: undefined, state: "working", node_ref: "node-1" }, "id must be non-empty"],
      [{ id: overlongNodeRef, state: "working", node_ref: "node-1" }, `id exceeds ${A2A_MAX_NODE_REF_BYTES} bytes`],
      [{ id: "task-1", state: "unknown", node_ref: "node-1" }, "state must be one of:"],
      [{ id: "task-1", state: "working", node_ref: " " }, "node_ref must be non-empty"],
      [{ id: "task-1", state: "working", node_ref: undefined }, "node_ref must be non-empty"],
      [{ id: "task-1", state: "working", node_ref: overlongNodeRef }, `node_ref exceeds ${A2A_MAX_NODE_REF_BYTES} bytes`],
    ] as const) {
      expect(validateA2ATask(task as never).join(" ")).toContain(failure);
    }
  });

  it("uses the shallow message guard only for transport shape, leaving detailed diagnostics to the validator", () => {
    for (const value of [null, "message", [], 7, { id: "m" }, { ...message(), recipient_node_refs: "not-array" }, { ...message(), parts: {} }, { ...message(), as_of: 7 }]) {
      expect(isA2AMessage(value)).toBe(false);
    }
    expect(isA2AMessage(message({ parts: [{ kind: "not-validated-here" as never }] }))).toBe(true);
  });
});
