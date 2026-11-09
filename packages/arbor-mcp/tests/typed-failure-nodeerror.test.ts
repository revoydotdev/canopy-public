import { describe, expect, it } from "vitest";
import type { SessionEvent, SessionInspection, CapabilitySupport, ExecutionPolicy } from "@arbor/harness";
import { nodeError } from "../src/native-agent-executor.js";

// ADR-120: nodeError's catch-all used to discard diagnostic.payload.code for
// every non-timeout, non-retry-exhausted failure, collapsing deterministic
// policy refusals into the same internal_error/abandon path as a crash.
// These tests drive nodeError (a pure function, exported for exactly this
// purpose — see its own doc comment) directly against synthetic event
// streams, the same pattern already used for elapsedMs/partialModelText.

function diagnosticEvent(code: string): SessionEvent {
  return { protocol_version: "1", session_id: "s", sequence: 1, occurred_at: "2026-08-26T00:00:00.000Z", kind: "diagnostic", payload: { code, message: `diagnostic:${code}` } } as unknown as SessionEvent;
}

function inspectionWithTerminal(message: string): SessionInspection {
  return {
    session_id: "s",
    state: "failed",
    policy: {} as ExecutionPolicy,
    capabilities: [] as readonly CapabilitySupport[],
    lineage: { kind: "new" } as unknown as SessionInspection["lineage"],
    ephemeral: true,
    latest_sequence: 1,
    terminal: { state: "failed", message } as unknown as SessionInspection["terminal"],
  };
}

describe("nodeError — ADR-120 typed policy-refusal codes survive routing", () => {
  const cases: readonly string[] = [
    "action_scope_command_denied",
    "action_scope_path_denied",
    "action_scope_missing_or_stale",
    "approval_denied",
  ];

  for (const code of cases) {
    it(`recognizes ${code} as policy_refused, carrying the real code and recoverable=true`, () => {
      const inspection = inspectionWithTerminal("refused");
      const events = [diagnosticEvent(code)];
      const error = nodeError(inspection, events);
      expect(error.kind).toBe("policy_refused");
      expect((error as { code: string }).code).toBe(code);
      expect((error as { recoverable: boolean }).recoverable).toBe(true);
    });
  }

  it("still collapses an unrecognized diagnostic code to internal_error (unchanged fall-through)", () => {
    const inspection = inspectionWithTerminal("native session crashed");
    const events = [diagnosticEvent("tool_preflight_failed")];
    const error = nodeError(inspection, events);
    expect(error).toMatchObject({ kind: "internal_error", recoverable: false });
  });

  it("still collapses a missing diagnostic to internal_error (unchanged fall-through)", () => {
    const inspection = inspectionWithTerminal("native session crashed with no diagnostic");
    const error = nodeError(inspection, []);
    expect(error).toMatchObject({ kind: "internal_error", recoverable: false });
  });

  it("model_retry_exhausted still routes to transport_error, not policy_refused (unchanged branch, checked ahead of the new set)", () => {
    const inspection = inspectionWithTerminal("retries exhausted");
    const events = [diagnosticEvent("model_retry_exhausted")];
    const error = nodeError(inspection, events);
    expect(error).toMatchObject({ kind: "transport_error", recoverable: true });
  });

  it("a wall-clock terminal cause still routes to timeout, not policy_refused, even if the last diagnostic looks like a policy code", () => {
    const inspection: SessionInspection = {
      session_id: "s", state: "failed", policy: {} as ExecutionPolicy, capabilities: [] as readonly CapabilitySupport[],
      lineage: { kind: "new" } as unknown as SessionInspection["lineage"], ephemeral: true, latest_sequence: 1,
      terminal: { state: "failed", cause: "wall_clock_limit", message: "session wall-clock limit exceeded" } as unknown as SessionInspection["terminal"],
    };
    const events = [diagnosticEvent("approval_denied")];
    const error = nodeError(inspection, events);
    expect(error.kind).toBe("timeout");
  });
});
