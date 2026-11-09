import { describe, expect, it } from "vitest";
// Imported directly from the source module rather than the package barrel
// (src/index.ts): the barrel is a forbidden-to-touch file for this tranche
// of work, and deriveA2ATaskState/deriveA2ATaskFromCommunications are new
// additions this session — see the report for the exact barrel export
// lines to apply.
import {
  deriveA2ATaskState,
  deriveA2ATaskFromCommunications,
  inboundA2AToNodeCommunication,
  outboundNodeCommunicationToA2A,
  type A2ABridgeConfig,
} from "../src/a2a-bridge.js";
import type { A2AMessage } from "../src/a2a-contracts.js";
import type { NodeCommunication, NodeCommunicationKind } from "@arbor/audit";

const config: A2ABridgeConfig = { signing_secret: "task-lifecycle-secret", default_recipient_tier: "specialist" };

function communication(overrides: Partial<NodeCommunication> = {}): NodeCommunication {
  return {
    author_node_id: "root",
    recipient_node_id: "sib-1",
    other_recipient_node_ids: [],
    kind: "delegate",
    payload: { content: "x", provenance: { tag: "claimed", claimant: "root" } },
    capability_tier: "specialist",
    trigger_turn: false,
    as_of: "2026-01-01T00:00:00.000Z",
    correlation_id: "a2a:task-x",
    idempotency_key: "a2a:msg-x",
    acknowledges_communication_id: null,
    retracts_communication_id: null,
    ...overrides,
  };
}

describe("deriveA2ATaskState — pure single-step transition table", () => {
  it("a fresh task (no prior state) seeded by delegate becomes submitted", () => {
    expect(deriveA2ATaskState(undefined, "delegate")).toBe("submitted");
  });

  it("clarify moves an active task to input_required", () => {
    expect(deriveA2ATaskState("working", "clarify")).toBe("input_required");
    expect(deriveA2ATaskState("submitted", "clarify")).toBe("input_required");
  });

  it("reply resolves input_required back to working", () => {
    expect(deriveA2ATaskState("input_required", "reply")).toBe("working");
  });

  it("steer advances a submitted/working task but does not clear a pending question", () => {
    expect(deriveA2ATaskState("submitted", "steer")).toBe("working");
    expect(deriveA2ATaskState("working", "steer")).toBe("working");
    expect(deriveA2ATaskState("input_required", "steer")).toBe("input_required");
  });

  it("promote preserves whatever state already holds, or starts working if none yet", () => {
    expect(deriveA2ATaskState(undefined, "promote")).toBe("working");
    expect(deriveA2ATaskState("input_required", "promote")).toBe("input_required");
  });

  it("report is terminal: completed", () => {
    expect(deriveA2ATaskState("working", "report")).toBe("completed");
  });

  it("retract is terminal: canceled", () => {
    expect(deriveA2ATaskState("working", "retract")).toBe("canceled");
  });

  it("a second delegate never regresses progress already made", () => {
    expect(deriveA2ATaskState("working", "delegate")).toBe("working");
    expect(deriveA2ATaskState("input_required", "delegate")).toBe("input_required");
  });

  const terminalStates = ["completed", "canceled", "failed"] as const;
  const allKinds: NodeCommunicationKind[] = ["delegate", "report", "retract", "steer", "reply", "clarify", "promote"];

  it.each(terminalStates.flatMap((terminal) => allKinds.map((kind) => [terminal, kind] as const)))(
    "terminal state %s is sticky against every communication kind, including %s",
    (terminal, kind) => {
      expect(deriveA2ATaskState(terminal, kind)).toBe(terminal);
    },
  );
});

describe("deriveA2ATaskFromCommunications — deterministic ledger-facts fold", () => {
  it("folds a full lifecycle: submitted -> working -> completed", () => {
    const comms = [
      communication({ kind: "delegate", as_of: "2026-01-01T00:00:00.000Z", idempotency_key: "a2a:1" }),
      communication({ kind: "reply", as_of: "2026-01-01T00:00:01.000Z", idempotency_key: "a2a:2" }),
      communication({ kind: "report", as_of: "2026-01-01T00:00:02.000Z", idempotency_key: "a2a:3" }),
    ];
    const task = deriveA2ATaskFromCommunications(comms, "task-x", "sib-1");
    expect(task).toEqual({ id: "task-x", state: "completed", node_ref: "sib-1" });
  });

  it("is order-independent: shuffled input yields the same derived state, ordered by as_of", () => {
    const comms = [
      communication({ kind: "report", as_of: "2026-01-01T00:00:02.000Z", idempotency_key: "a2a:3" }),
      communication({ kind: "delegate", as_of: "2026-01-01T00:00:00.000Z", idempotency_key: "a2a:1" }),
      communication({ kind: "reply", as_of: "2026-01-01T00:00:01.000Z", idempotency_key: "a2a:2" }),
    ];
    const shuffled = [comms[2]!, comms[0]!, comms[1]!];
    expect(deriveA2ATaskFromCommunications(comms, "task-x", "sib-1")).toEqual(
      deriveA2ATaskFromCommunications(shuffled, "task-x", "sib-1"),
    );
    expect(deriveA2ATaskFromCommunications(comms, "task-x", "sib-1").state).toBe("completed");
  });

  it("breaks as_of ties deterministically via idempotency_key (compareCodeUnits order, never localeCompare)", () => {
    const tiedTimestamp = "2026-01-01T00:00:00.000Z";
    const a = communication({ kind: "report", as_of: tiedTimestamp, idempotency_key: "a2a:aaa" });
    const b = communication({ kind: "delegate", as_of: tiedTimestamp, idempotency_key: "a2a:zzz" });
    // "aaa" < "zzz" by code-unit order, so report (a) is folded before delegate (b),
    // but delegate on an already-"completed" (terminal) task is a no-op either way —
    // the point under test is that the ordering itself is deterministic, not racy.
    const first = deriveA2ATaskFromCommunications([a, b], "task-tie", "sib-1");
    const second = deriveA2ATaskFromCommunications([b, a], "task-tie", "sib-1");
    expect(first).toEqual(second);
    expect(first.state).toBe("completed");
  });

  it("an empty communications array yields the honest default: submitted, never a fabricated 'completed'", () => {
    expect(deriveA2ATaskFromCommunications([], "task-empty", "sib-1")).toEqual({
      id: "task-empty", state: "submitted", node_ref: "sib-1",
    });
  });
});

describe("adversarial proof: the A2A surface cannot diverge from the ledger", () => {
  it("ATTACK: a forged post-completion delegate cannot reopen a completed task", () => {
    // Ledger truth: the task was legitimately delegated, then completed.
    const ledgerTruth = [
      communication({ kind: "delegate", as_of: "2026-01-01T00:00:00.000Z", idempotency_key: "a2a:1" }),
      communication({ kind: "report", as_of: "2026-01-01T00:00:01.000Z", idempotency_key: "a2a:2" }),
    ];
    // An attacker (a malicious or buggy external A2A client) appends a new
    // "delegate" communication for the SAME task_id, attempting to smuggle
    // fresh instructions into a task the ledger already closed, hoping the
    // A2A-facing task state will reopen to "submitted"/"working" so a
    // downstream consumer treats it as live, unresolved work again.
    const withForgedContinuation = [
      ...ledgerTruth,
      communication({ kind: "delegate", as_of: "2026-01-01T00:00:02.000Z", idempotency_key: "a2a:attacker-1" }),
    ];

    // FAILS WITHOUT THE GUARD: a naive reducer with no terminal lock — the
    // shape `deriveA2ATaskState` would have if the `A2A_TERMINAL_TASK_STATES`
    // stickiness check were removed — treats every kind as authoritative on
    // arrival, so the attacker's delegate wins and the task regresses.
    function naiveDeriveNoStickiness(comms: readonly NodeCommunication[]): string {
      let state = "submitted";
      for (const c of comms) {
        if (c.kind === "delegate") state = "submitted";
        else if (c.kind === "report") state = "completed";
      }
      return state;
    }

    // ATTACK SUCCEEDS against the naive, unguarded reducer: the task
    // regresses from "completed" back to "submitted".
    expect(naiveDeriveNoStickiness(withForgedContinuation)).toBe("submitted");

    // ATTACK REFUSED by the real, guarded derivation: the terminal lock
    // means the forged continuation is silently ignored — the task stays
    // "completed" exactly as the ledger's real facts dictate.
    const reconciled = deriveA2ATaskFromCommunications(withForgedContinuation, "task-x", "sib-1");
    expect(reconciled.state).toBe("completed");
  });

  it("ATTACK: a forged retract cannot un-cancel a canceled task back into progress via a later delegate/report", () => {
    const ledgerTruth = [
      communication({ kind: "delegate", as_of: "2026-01-01T00:00:00.000Z", idempotency_key: "a2a:1" }),
      communication({ kind: "retract", as_of: "2026-01-01T00:00:01.000Z", idempotency_key: "a2a:2" }),
    ];
    const forgedReport = communication({ kind: "report", as_of: "2026-01-01T00:00:02.000Z", idempotency_key: "a2a:attacker-2" });
    const reconciled = deriveA2ATaskFromCommunications([...ledgerTruth, forgedReport], "task-y", "sib-1");
    // Canceled stays canceled — a later "report" cannot flip a canceled task to completed either.
    expect(reconciled.state).toBe("canceled");
  });

  it("REGRESSION GUARD: deriveA2ATaskState itself refuses every kind once terminal (direct unit proof, not just the fold)", () => {
    for (const kind of ["delegate", "clarify", "reply", "steer", "promote"] as NodeCommunicationKind[]) {
      expect(deriveA2ATaskState("completed", kind)).toBe("completed");
      expect(deriveA2ATaskState("canceled", kind)).toBe("canceled");
    }
  });
});

describe("round trip: an A2A client's task closes with the ledger as sole authority", () => {
  it("inbound SendMessage durably seeds a task, and the eventual outbound report closes it — never the reverse claim", () => {
    const inboundMessage: A2AMessage = {
      id: "msg-in-1", task_id: "task-roundtrip", author_node_ref: "external-agent",
      recipient_node_refs: ["root"], parts: [{ kind: "text", text: "please do X" }],
      as_of: "2026-01-01T00:00:00.000Z",
    };
    // Step 1: inbound A2A SendMessage becomes ledger evidence (simulated
    // durable append — no network, no real ledger, just the pure
    // conversion this file owns; the real durability guarantee is proven
    // separately by manager.recordNodeCommunication and exercised through
    // the catalog router in bus-a2a-sibling-runtime.test.ts).
    const { communication: seeded, task: taskAfterInbound } = inboundA2AToNodeCommunication(inboundMessage, config);
    expect(taskAfterInbound.state).toBe("submitted");

    // Step 2: the node internally processes the task (represented by a
    // "reply" ledger record — not itself projected to A2A in this test,
    // standing in for internal node communication that never crosses the
    // external boundary).
    const internalProgress = communication({
      author_node_id: "root", recipient_node_id: "external-agent", other_recipient_node_ids: [],
      kind: "reply", as_of: "2026-01-01T00:00:01.000Z",
      correlation_id: seeded.correlation_id, idempotency_key: "a2a:internal-1",
    });

    // Step 3: the node reports completion. The projection outward (a2a.send)
    // folds every prior ledger-witnessed communication for this task,
    // proving the outbound A2A message's task snapshot is derived — not
    // separately tracked, not a second authority.
    const outboundReport = communication({
      author_node_id: "root", recipient_node_id: "external-agent", other_recipient_node_ids: [],
      kind: "report", payload: { content: "X is done", provenance: { tag: "claimed", claimant: "root" } },
      as_of: "2026-01-01T00:00:02.000Z",
      correlation_id: seeded.correlation_id, idempotency_key: "a2a:internal-2",
    });
    const a2aOut = outboundNodeCommunicationToA2A(outboundReport, config, [seeded, internalProgress]);

    expect(a2aOut.task_id).toBe("task-roundtrip");
    expect(a2aOut.task).toMatchObject({ id: "task-roundtrip", state: "completed" });
    expect(a2aOut.parts[0]!.text).toBe("X is done");

    // Round trip closed: a client re-deriving the task from the SAME
    // ledger-witnessed evidence set gets the identical, sole-authoritative
    // answer — the A2A wire projection and the ledger cannot disagree,
    // because the projection IS the ledger fold, never a cache of it.
    const rederived = deriveA2ATaskFromCommunications([seeded, internalProgress, outboundReport], "task-roundtrip", "external-agent");
    expect(rederived).toEqual({ id: "task-roundtrip", state: "completed", node_ref: "external-agent" });
  });
});
