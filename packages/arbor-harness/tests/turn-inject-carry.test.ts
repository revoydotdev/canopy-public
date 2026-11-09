/**
 * The ADVISORY half of the per-turn boundary: a tropism resolved at turn N's
 * boundary reaches turn N+1's PROMPT, and is consumed by doing so.
 *
 * Three properties, and each one is a way the lane could have shipped broken:
 *
 *  - IT REACHES THE NEXT TURN, NOT THIS ONE. An inject's product is text for a
 *    prompt that does not exist yet, so resolving it at the boundary cannot
 *    retroactively change the turn that just ended. A lane that appended to the
 *    CURRENT prompt would be a turn that waits for its own advisory.
 *  - IT IS CONSUMED BY DELIVERY. The carry is a per-iteration value, not a slot
 *    a handler can refill, so one settled scope reaches the model exactly once
 *    however many turns run afterwards. This is a DIFFERENT property from the
 *    inject lane's §5.3 dedupe, which suppresses a scope whose `derived_from`
 *    has not MOVED: dedupe stops an unchanged nudge being re-derived at all,
 *    and consumption stops a delivered one being repeated. Both are wanted, and
 *    `turn-inject-lane.test.ts` proves the first against the real bus while this
 *    file proves the second against the real worker.
 *  - IT NEVER BLOCKS A TURN. A handler that has not settled when the next
 *    boundary arrives is DROPPED WITH A NAMED DIAGNOSTIC. The alternative —
 *    carrying it stale, or awaiting it indefinitely — turns an advisory into a
 *    turn tax or a hang, and a silently dropped advisory is indistinguishable
 *    from a handler with nothing to say, which is the defect class this
 *    repository has now shipped four times.
 */
import { describe, expect, it, vi } from "vitest";

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

/**
 * Records every prompt the worker composed, so an advisory can be shown to have
 * REACHED the model rather than merely having been computed. `toolTurns` model
 * turns dispatch a tool call first, which is what makes a multi-turn run.
 */
const scriptedModel = (prompts: string[], toolTurns: number): NativeModelPort => ({
  async run(request) {
    prompts.push(request.prompt);
    return prompts.length <= toolTurns
      ? { text: [], tool_calls: [{ call_id: `c${prompts.length}`, tool: "read", input: { path: "a.ts" }, input_summary: "read a.ts", risk: "low" }], final_message: null }
      : { text: [], tool_calls: [], final_message: "the answer" };
  },
});

const run = (overrides: Partial<NativeHarnessWorkerOptions>, options: { maxTurns: number; sessionId?: string; toolTurns?: number }) => {
  const prompts: string[] = [];
  const engine = new NativeSessionEngine({ clock: new TestClock(), capabilities });
  const sessionId = options.sessionId ?? "turn-inject";
  const worker = new NativeHarnessWorker({
    session_engine: engine,
    model: scriptedModel(prompts, options.toolTurns ?? 0),
    tools: [{ tool: "read", async execute() { return succeeded("read", "source text"); } }],
    ...overrides,
  });
  return worker.run({
    start: start(sessionId, { tool_allow: ["read"], approvals: "never" }),
    prompt: "do the work",
    max_turns: options.maxTurns,
  }).then((result) => ({ result, prompts, engine }));
};

const diagnostics = (engine: NativeSessionEngine, sessionId: string): readonly string[] =>
  engine.observe(sessionId).flatMap((event) => event.kind === "diagnostic" ? [event.payload.code] : []);

const occurrences = (text: string, needle: string): number => text.split(needle).length - 1;

describe("the advisory turn-injection carry", () => {
  it("delivers a settled injection into the NEXT turn's prompt, never the one that produced it", async () => {
    const started: number[] = [];
    const { result, prompts } = await run({
      turn_inject: async (boundary: NativeTurnBoundary) => { started.push(boundary.turn); return "ADVISORY-BODY"; },
    }, { maxTurns: 3, toolTurns: 1 });

    expect(result.session.state).toBe("completed");
    expect(prompts).toHaveLength(2);
    // Turn 1's boundary fired after turn 1's prompt was already built and sent,
    // so the only place this text can appear is turn 2.
    expect(prompts[0]).not.toContain("ADVISORY-BODY");
    expect(prompts[1]).toContain("ADVISORY-BODY");
    // The lane starts once per turn and is offered the turn number, so a
    // handler can tell a first turn from the twentieth.
    expect(started).toEqual([1, 2]);
  });

  it("consumes the carry: one settled scope is delivered once, however many turns follow", async () => {
    let derived = 0;
    const { result, prompts } = await run({
      // The handler says something on turn 1 and nothing thereafter, which is
      // the shape a real handler has when its derivation moved exactly once.
      // A carry that were a SLOT rather than a consumed value would re-deliver
      // this same settlement on every remaining turn.
      turn_inject: async () => (derived++ === 0 ? "ONCE-ONLY" : null),
    }, { maxTurns: 5, toolTurns: 3 });

    expect(result.session.state).toBe("completed");
    expect(prompts).toHaveLength(4);
    const total = prompts.reduce((sum, prompt) => sum + occurrences(prompt, "ONCE-ONLY"), 0);
    expect(total).toBe(1);
    expect(prompts[1]).toContain("ONCE-ONLY");
  });

  it("still delivers each turn's OWN injection — suppression of a repeated finding is the bus's job, not the worker's", async () => {
    // The other half of the boundary, and the one most likely to be
    // "simplified" into the test above. A handler that keeps saying something
    // must keep reaching the model: §5.3's dedupe suppresses a scope whose
    // `derived_from` did not MOVE, and a worker that dropped repeats itself
    // would silently suppress a finding that DID change — which is the
    // opposite failure, and a model told nothing when something changed.
    const { result, prompts } = await run({ turn_inject: async () => "EVERY-TURN" }, { maxTurns: 4, toolTurns: 2 });

    expect(result.session.state).toBe("completed");
    expect(prompts).toHaveLength(3);
    const total = prompts.reduce((sum, prompt) => sum + occurrences(prompt, "EVERY-TURN"), 0);
    expect(total).toBe(2);
  });

  it("composes the injection after the turn-budget note and before the turn-gate correction", async () => {
    let consulted = 0;
    const { prompts } = await run({
      turn_inject: async () => "PLACEMENT-MARKER",
      turn_gate: async () => (consulted++ === 0 ? "the battery is red" : null),
    }, { maxTurns: 4, toolTurns: 1 });

    const budgeted = prompts.find((prompt) => prompt.includes("[Turn budget:"));
    expect(budgeted).toBeDefined();
    const refused = prompts.find((prompt) => prompt.includes("REFUSED at the turn boundary"));
    expect(refused).toBeDefined();
    expect(refused).toContain("PLACEMENT-MARKER");
    // The correction answers the model's MOST RECENT output, so it is last: a
    // reader working down the prompt meets the refusal after the advisory it
    // is reacting to, and the refusal is never buried under later text.
    expect(refused!.indexOf("[Turn budget:")).toBeLessThan(refused!.indexOf("PLACEMENT-MARKER"));
    expect(refused!.indexOf("PLACEMENT-MARKER")).toBeLessThan(refused!.indexOf("REFUSED at the turn boundary"));
  });

  it("drops an unsettled injection with a named diagnostic within one turn, and does not block it", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const pending = new Promise<string>(() => { /* never settles */ });
      const finished = run({ turn_inject: async () => pending }, { maxTurns: 3, toolTurns: 1 });
      // Let turn 1 run, then give the worker its whole settle window.
      await vi.advanceTimersByTimeAsync(30_000);
      const { result, prompts, engine } = await finished;

      expect(result.session.state).toBe("completed");
      // Two prompts, so turn 2 was BUILT — a lane that waited for the handler
      // would have produced one prompt and hung or burned the budget.
      expect(prompts).toHaveLength(2);
      expect(prompts.join("\n")).not.toContain("PLACEMENT-MARKER");
      // Named, not silent. An advisory that vanishes with no row is
      // indistinguishable from a handler that had nothing to say.
      expect(diagnostics(engine, "turn-inject")).toContain("turn_injection_dropped");
    } finally {
      vi.useRealTimers();
    }
  });

  it("records a rejecting injection as a named failure and carries nothing", async () => {
    const { result, prompts, engine } = await run({
      turn_inject: async () => { throw new Error("the evidence store was locked"); },
    }, { maxTurns: 3, toolTurns: 1 });

    expect(result.session.state).toBe("completed");
    expect(prompts).toHaveLength(2);
    expect(diagnostics(engine, "turn-inject").filter((code) => code.startsWith("turn_injection_"))).not.toHaveLength(0);
  });

  it("is inert on a worker composed with no turn_inject, and appends no tropism frame to any prompt", async () => {
    const { result, prompts } = await run({}, { maxTurns: 2, toolTurns: 1 });

    expect(result.session.state).toBe("completed");
    // `formatTropism` frames every injection with its provenance, so the frame
    // is how "no advisory reached the model" is asserted rather than inferred
    // from the absence of one handler's particular body text.
    expect(prompts.some((prompt) => prompt.includes("provenance=generated"))).toBe(false);
    expect(prompts[0]).toBe("do the work");
  });
});
