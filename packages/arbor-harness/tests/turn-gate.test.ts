/**
 * The per-turn boundary seam: `on_turn_end` observes every turn that ends
 * successfully, and `turn_gate` can REFUSE one — reusing the correction path
 * the file already ships, under a bounded budget.
 *
 * The refusal budget is the load-bearing assertion here. A turn gate that is
 * consulted forever is not a guard, it is a wall: the model produces a final
 * result, the gate refuses it, the model is told why and produces another, and
 * a permanently-red gate means the session can only end by exhausting
 * `max_turns` — a full turn budget burned producing output nobody accepts.
 * `MAX_TURN_GATE_REFUSALS` is the same shape of bound as the structured-output
 * correction budget a few lines away, and the test below pins the property that
 * matters: the gate stops being consulted while most of the turn budget is
 * still unspent, and it says so in a ledger row rather than going quiet.
 *
 * The seam deliberately adds no timer around the gate. A worker cannot preempt
 * an in-line `await` any more than a single-threaded bus can preempt a running
 * synchronous handler, and a timer that discarded a slow gate's verdict would
 * ALLOW the turn — a silently-dropped guard, which is the exact defect class
 * this whole bus exists to eliminate. So a slow gate costs budget and produces
 * diagnostics instead.
 */
import { describe, expect, it } from "vitest";

import type { CapabilitySupport } from "../src/capabilities.js";
import { NativeSessionEngine } from "../src/native-session.js";
import {
  NativeHarnessWorker,
  type NativeHarnessWorkerOptions,
  type NativeModelPort,
  type NativeToolResponse,
  type NativeTurnBoundary,
} from "../src/native-worker.js";
import type { ExecutionPolicy, SessionStartRequest } from "../src/protocol.js";

const succeeded = (result_summary: string, model_output: string): NativeToolResponse => ({
  result_summary, model_output,
  evidence: { outcome: "succeeded", stage: "execution", code: "ok", effect: "observed", action_scope: { status: "not_required" } },
});

class TestClock {
  constructor(private current = 1_700_000_000_000) {}
  now(): number { return this.current; }
}

const capabilities: readonly CapabilitySupport[] = [
  "streaming", "interruption", "resumption", "forking", "ephemeral_sessions", "structured_output", "tool_policy", "workspace_isolation", "approval_mediation", "usage_reporting", "artifact_capture", "remote_transport",
].map((capability) => ({
  capability,
  grade: "native",
  evidence: { implementation_id: "native-reference", observed_at: "2026-08-09T00:00:00.000Z", detail: "native conformance" },
})) as readonly CapabilitySupport[];

const policy: ExecutionPolicy = {
  filesystem: "read_only",
  approvals: "always",
  tool_allow: [],
  tool_deny: [],
  workspace_roots: ["/workspace"],
  max_wall_clock_ms: 3_600_000,
  max_events: 200,
  network_allowed: false,
  ambient_plugins_allowed: false,
  user_configuration_allowed: false,
  inherited_credentials_allowed: false,
};

const start = (sessionId: string, overrides: Partial<ExecutionPolicy> = {}): SessionStartRequest => ({
  session_id: sessionId, policy: { ...policy, ...overrides }, required_capabilities: [], lineage: { kind: "new" }, ephemeral: false,
});

/** Records every prompt the worker composed, so a refusal can be shown to have reached the model rather than merely been computed. */
const finalModel = (prompts: string[]): NativeModelPort => ({
  async run(request) {
    prompts.push(request.prompt);
    return { text: [], tool_calls: [], final_message: "the answer" };
  },
});

const run = (overrides: Partial<NativeHarnessWorkerOptions>, maxTurns: number, sessionId = "turn-boundary") => {
  const prompts: string[] = [];
  const engine = new NativeSessionEngine({ clock: new TestClock(), capabilities });
  const worker = new NativeHarnessWorker({ session_engine: engine, model: finalModel(prompts), ...overrides });
  return worker.run({ start: start(sessionId), prompt: "do the work", max_turns: maxTurns }).then((result) => ({ result, prompts, engine }));
};

const diagnostics = (engine: NativeSessionEngine, sessionId: string): readonly string[] =>
  engine.observe(sessionId).flatMap((event) => event.kind === "diagnostic" ? [event.payload.code] : []);

describe("the per-turn boundary seam", () => {
  it("observes every turn that ends successfully, before the gate is consulted", async () => {
    const order: string[] = [];
    const boundaries: NativeTurnBoundary[] = [];

    const { result } = await run({
      on_turn_end: (boundary) => { order.push("observe"); boundaries.push(boundary); },
      turn_gate: async () => { order.push("gate"); return null; },
    }, 2);

    expect(result.session.state).toBe("completed");
    // The observer is not suppressed by the gate, and the gate is not
    // consulted before the boundary exists: the turn boundary is the event,
    // the gate is one consumer of it.
    expect(order).toEqual(["observe", "gate"]);
    expect(boundaries).toHaveLength(1);
    expect(boundaries[0]).toMatchObject({ session_id: "turn-boundary", turn: 1, max_turns: 2 });
  });

  it("offers the boundary only where a turn ends successfully, never after a tool call", async () => {
    const turns: number[] = [];
    let requested = 0;
    const model: NativeModelPort = {
      async run() {
        requested += 1;
        return requested === 1
          ? { text: [], tool_calls: [{ call_id: "c1", tool: "read", input: { path: "a.ts" }, input_summary: "read a.ts", risk: "low" }], final_message: null }
          : { text: [], tool_calls: [], final_message: "the answer" };
      },
    };
    const engine = new NativeSessionEngine({ clock: new TestClock(), capabilities });
    const result = await new NativeHarnessWorker({
      session_engine: engine,
      model,
      tools: [{ tool: "read", async execute() { return succeeded("read", "source text"); } }],
      on_turn_end: (boundary) => { turns.push(boundary.turn); },
    }).run({ start: start("multi", { tool_allow: ["read"], approvals: "never" }), prompt: "do the work", max_turns: 4 });

    expect(result.session.state).toBe("completed");
    // Turn 1 dispatched a tool, which continues the turn rather than ending it.
    expect(turns).toEqual([2]);
  });

  it("allows the turn when the gate returns null", async () => {
    let consulted = 0;
    const { result, prompts } = await run({ turn_gate: async () => { consulted += 1; return null; } }, 2);

    expect(consulted).toBe(1);
    expect(result.session.state).toBe("completed");
    // Nothing was refused, so no correction is ever added to the prompt.
    expect(prompts[0]).toBe("do the work");
  });

  it("refuses the turn and feeds the gate's own reason back to the model", async () => {
    const reason = "gate:stop-budget is red: median 27666 ms exceeds the 25000 ms ceiling";
    let consulted = 0;
    const { result, prompts } = await run({
      turn_gate: async () => (consulted++ === 0 ? reason : null),
    }, 4);

    expect(result.session.state).toBe("completed");
    expect(prompts).toHaveLength(2);
    // The reason the gate returned is the value that must reach the model; a
    // refusal whose text never arrives is a refusal that cannot be acted on.
    expect(prompts[1]).toContain(reason);
    // The turn was not accepted on the first pass — a second model request
    // exists at all, which is what "refused" means operationally.
    expect(prompts[0]).not.toContain(reason);
  });

  it("never checkpoints a refused final result as the conversation's next state", async () => {
    const checkpoints: number[] = [];
    let consulted = 0;
    await run({
      on_checkpoint: (checkpoint) => { checkpoints.push(checkpoint.next_turn); },
      turn_gate: async () => (consulted++ === 0 ? "not yet" : null),
    }, 4);

    // One checkpoint per started turn plus the protected final one. A refused
    // turn contributes no final checkpoint, because the gate is consulted
    // BEFORE the checkpoint — a final result nobody accepted must not become
    // the state a resume would continue from.
    expect(checkpoints).toEqual([1, 2, 3]);
  });

  it("stops consulting a permanently-refusing gate while most of the turn budget is unspent", async () => {
    let consulted = 0;
    const { result, engine } = await run({
      turn_gate: async () => { consulted += 1; return "permanently red"; },
    }, 20);

    // The whole point of the bounded budget: a gate that refuses everything
    // must NOT be able to spend the entire turn budget. It is consulted a
    // bounded number of times, the turn then completes, and the session ends
    // `completed` rather than dying on `turn_limit`.
    expect(consulted).toBe(2);
    expect(result.session.state).toBe("completed");
    expect(result.turns_started).toBe(3);
    // Both refusals are ledgered, and the turn in which the gate stopped being
    // consulted says so. A guard that silently stops consulting is the defect
    // this bus keeps being audited for.
    expect(diagnostics(engine, "turn-boundary").filter((code) => code === "turn_gate_refused")).toHaveLength(2);
    expect(diagnostics(engine, "turn-boundary")).toContain("turn_gate_budget_exhausted");
  });

  it("never consults the gate on the final turn, because a refusal there has nowhere to go", async () => {
    let consulted = 0;
    const { result } = await run({ turn_gate: async () => { consulted += 1; return "red"; } }, 1);

    expect(consulted).toBe(0);
    expect(result.session.state).toBe("completed");
  });

  it("treats a gate that REJECTS as a refusal, names it, and does not leave an unhandled rejection", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => { unhandled.push(reason); };
    process.on("unhandledRejection", onUnhandled);
    try {
      const { result, engine } = await run({
        turn_gate: async () => { throw new Error("window state probe blew up"); },
      }, 5);

      // Fail CLOSED on the decision, exactly as the bus fails a veto handler
      // closed on a throw: an unevaluable guard is not a passing guard.
      expect(result.session.state).toBe("completed");
      expect(diagnostics(engine, "turn-boundary")).toContain("turn_gate_refused");
      // ...and bounded, so a permanently-throwing gate costs the same two
      // consultations a permanently-refusing one does.
      expect(diagnostics(engine, "turn-boundary").filter((code) => code === "turn_gate_refused")).toHaveLength(2);
      expect(diagnostics(engine, "turn-boundary")).toContain("turn_gate_budget_exhausted");
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("bounds a refusal reason to the same byte budget a provider error detail gets", async () => {
    const huge = "x".repeat(4_096);
    const { prompts } = await run({ turn_gate: async () => huge }, 3);

    // Unbounded reason text would grow every subsequent prompt without limit.
    // Truncation is announced rather than silent, so a model told to act on a
    // half-reason knows it is one.
    expect(prompts[1]).toContain("truncated");
    expect(prompts[1]).not.toContain("x".repeat(1_100));
  });

  it("repeats a refusal on every turn until the gate is satisfied", async () => {
    let requested = 0;
    const prompts: string[] = [];
    const engine = new NativeSessionEngine({ clock: new TestClock(), capabilities });
    const result = await new NativeHarnessWorker({
      session_engine: engine,
      model: {
        async run(request) {
          prompts.push(request.prompt);
          requested += 1;
          return requested === 2
            ? { text: [], tool_calls: [{ call_id: "c1", tool: "read", input: { path: "a.ts" }, input_summary: "read a.ts", risk: "low" }], final_message: null }
            : { text: [], tool_calls: [], final_message: "the answer" };
        },
      },
      tools: [{ tool: "read", async execute() { return succeeded("read", "source text"); } }],
      turn_gate: async (boundary) => (boundary.turn === 1 ? "fix the tree first" : null),
    }).run({ start: start("repeats", { tool_allow: ["read"], approvals: "never" }), prompt: "do the work", max_turns: 5 });

    expect(result.session.state).toBe("completed");
    // Turn 2 dispatched a tool rather than offering a result, so the gate could
    // not say it was satisfied and the reason stayed true. It is carried until
    // a result is actually accepted, not dropped after one turn.
    expect(prompts[1]).toContain("fix the tree first");
    expect(prompts[2]).toContain("fix the tree first");
  });
});
