/**
 * a2a-wire.test.ts — conformance to A2A v1.0.0, without losing the bespoke part.
 *
 * The claim under test is the one that matters for interop: revoy2's internal
 * projection types and the real A2A v1.0.0 wire format coexist, with the
 * evidence-reference extension carried in a place the spec actually sanctions
 * rather than as an invented `kind` no A2A version defines.
 */

import { describe, expect, it } from "vitest";
import {
  EVIDENCE_REF_EXTENSION_URI,
  EVIDENCE_REF_METADATA_KEY,
  messageFromWire,
  messageToWire,
  partFromWire,
  partToWire,
  taskStateFromWire,
  taskStateToWire,
  taskToWire,
  wireStateIsLossy,
  type WirePart,
  type WireTaskState,
} from "../src/a2a-wire.js";
import type { A2AMessage, A2ATaskState } from "../src/a2a-contracts.js";

const INTERNAL_STATES: readonly A2ATaskState[] = ["submitted", "working", "input_required", "completed", "canceled", "failed"];

function message(parts: A2AMessage["parts"]): A2AMessage {
  return {
    id: "msg-1",
    task_id: "task-1",
    author_node_ref: "node-a",
    recipient_node_refs: ["node-c", "node-b"],
    parts,
    as_of: "2026-08-06T00:00:00.000Z",
  };
}

describe("A2A v1.0.0 task state", () => {
  it("emits the spec's SCREAMING_SNAKE_CASE values, not revoy2's lower-case ones", () => {
    // The concrete conformance break this closes: "completed" is not a v1.0.0
    // TaskState and no compliant peer would accept it.
    expect(taskStateToWire("completed")).toBe("TASK_STATE_COMPLETED");
    expect(taskStateToWire("input_required")).toBe("TASK_STATE_INPUT_REQUIRED");
    expect(INTERNAL_STATES.map(taskStateToWire).every((s) => s.startsWith("TASK_STATE_"))).toBe(true);
  });

  it("round-trips every internal state exactly", () => {
    for (const state of INTERNAL_STATES) {
      expect(taskStateFromWire(taskStateToWire(state))).toBe(state);
      expect(wireStateIsLossy(taskStateToWire(state))).toBe(false);
    }
  });

  it("narrows the two v1.0.0 states revoy2 cannot represent, and says so", () => {
    // REJECTED and AUTH_REQUIRED are real spec states with no internal
    // counterpart. Mapping them silently would make an approximate round trip
    // indistinguishable from an exact one, so the narrowing is reported.
    expect(taskStateFromWire("TASK_STATE_REJECTED")).toBe("failed");
    expect(taskStateFromWire("TASK_STATE_AUTH_REQUIRED")).toBe("input_required");
    expect(wireStateIsLossy("TASK_STATE_REJECTED")).toBe(true);
    expect(wireStateIsLossy("TASK_STATE_AUTH_REQUIRED")).toBe(true);
    expect(wireStateIsLossy("TASK_STATE_COMPLETED")).toBe(false);
  });

  it("rejects a state that is not in the spec at all", () => {
    expect(() => taskStateFromWire("TASK_STATE_INVENTED" as WireTaskState)).toThrow(/unknown A2A task state/);
  });
});

describe("A2A v1.0.0 parts — no `kind` discriminator", () => {
  it("emits a text part with no kind field, per v1.0.0's removal of the discriminator", () => {
    const wire = partToWire({ kind: "text", text: "hello" });
    expect(wire).toEqual({ text: "hello" });
    expect("kind" in wire).toBe(false);
  });

  it("carries the bespoke evidence reference as a conformant DataPart plus metadata", () => {
    const wire = partToWire({ kind: "evidence_ref", evidence_ref: "trace_7" });
    // A stock v1.0.0 client sees an ordinary DataPart it can parse and ignore.
    expect(wire.data).toEqual({ [EVIDENCE_REF_METADATA_KEY]: "trace_7" });
    // A client that knows the extension reads it from Part.metadata, which the
    // spec provides precisely for vendor data.
    expect(wire.metadata?.[EVIDENCE_REF_METADATA_KEY]).toBe("trace_7");
    expect("kind" in wire).toBe(false);
  });

  it("recovers the evidence reference from either metadata or data", () => {
    expect(partFromWire({ metadata: { [EVIDENCE_REF_METADATA_KEY]: "trace_9" } }))
      .toEqual({ kind: "evidence_ref", evidence_ref: "trace_9" });
    // A peer that echoed only the DataPart body still round-trips.
    expect(partFromWire({ data: { [EVIDENCE_REF_METADATA_KEY]: "trace_9" } }))
      .toEqual({ kind: "evidence_ref", evidence_ref: "trace_9" });
  });

  it("degrades a foreign part type to text rather than dropping the part", () => {
    // url/raw/data parts come from peers that do not speak our extension.
    // Losing them silently would make a message look emptier than it was.
    expect(partFromWire({ url: "https://example.test/x" })).toEqual({ kind: "text", text: "https://example.test/x" });
    expect(partFromWire({ data: { other: 1 } }).kind).toBe("text");
    expect(partFromWire({} as WirePart)).toEqual({ kind: "text", text: "" });
  });
});

describe("A2A v1.0.0 messages", () => {
  it("uses the spec's field names and ROLE_AGENT", () => {
    const wire = messageToWire(message([{ kind: "text", text: "hi" }]));
    expect(wire.messageId).toBe("msg-1");
    expect(wire.taskId).toBe("task-1");
    expect(wire.role).toBe("ROLE_AGENT");
    // The internal snake_case names must not leak onto the wire.
    expect("id" in wire).toBe(false);
    expect("task_id" in wire).toBe(false);
  });

  it("declares the extension URI only when a part actually carries evidence", () => {
    // Declaring it unconditionally would be extension noise on plain text
    // exchanges; omitting it when present would leave a peer unable to discover
    // why a DataPart is there.
    expect(messageToWire(message([{ kind: "text", text: "hi" }])).extensions).toBeUndefined();
    expect(messageToWire(message([{ kind: "evidence_ref", evidence_ref: "trace_3" }])).extensions)
      .toEqual([EVIDENCE_REF_EXTENSION_URI]);
  });

  it("round-trips a mixed message without losing the bespoke part", () => {
    // The whole point: conformance and the bespoke capability at once.
    const original = message([
      { kind: "text", text: "please verify" },
      { kind: "evidence_ref", evidence_ref: "trace_42" },
    ]);
    const restored = messageFromWire(messageToWire(original), { author_node_ref: "fallback", as_of: "1970-01-01T00:00:00.000Z" });
    expect(restored.parts).toEqual(original.parts);
    expect(restored.id).toBe(original.id);
    expect(restored.task_id).toBe(original.task_id);
    expect(restored.author_node_ref).toBe("node-a");
    expect(restored.as_of).toBe(original.as_of);
    expect(restored.recipient_node_refs).toEqual(["node-b", "node-c"]);
  });

  it("falls back rather than fabricating provenance for a foreign message", () => {
    // A peer that never set arbor.dev metadata has no author to report.
    // Inventing one would manufacture provenance for a record that will be
    // witnessed in the ledger, which is worse than an explicit fallback.
    const restored = messageFromWire(
      { messageId: "m", taskId: "t", role: "ROLE_USER", parts: [{ text: "x" }] },
      { author_node_ref: "peer-unknown", as_of: "2026-08-06T00:00:00.000Z" },
    );
    expect(restored.author_node_ref).toBe("peer-unknown");
    expect(restored.recipient_node_refs).toEqual([]);
  });

  it("orders recipients by code unit, never by locale", () => {
    const wire = messageToWire({ ...message([{ kind: "text", text: "x" }]), recipient_node_refs: ["b", "A", "a", "B"] });
    expect(wire.metadata?.["arbor.dev/recipient-node-refs"]).toEqual(["A", "B", "a", "b"]);
  });
});

describe("task projection", () => {
  it("emits a conformant Task with the spec's nested status.state", () => {
    expect(taskToWire({ id: "task-1", state: "completed", node_ref: "node-a" })).toEqual({
      id: "task-1",
      contextId: "task-1",
      status: { state: "TASK_STATE_COMPLETED" },
      metadata: { "arbor.dev/node-ref": "node-a" },
    });
  });
});
