import { describe, expect, it } from "vitest";
import { formatOperatorResume, resumeInterruptedWork, type OperatorResumeRuntime, type OperatorResumeSession } from "../src/operator-resume.js";

function session(id: string, campaign = "campaign", checkpoint = 7): OperatorResumeSession {
  return {
    session_id: id, campaign_id: campaign, node_id: `node-${id}`, state: "interrupted", latest_sequence: checkpoint,
    recovery: { kind: "recovery_required", checkpoint: { state: "running", latest_sequence: checkpoint } }, lineage: { kind: "new" },
  };
}

function runtime(sessions: OperatorResumeSession[], available: boolean | ((sessionId: string) => boolean) = true): OperatorResumeRuntime {
  return {
    listHarnessSessions: (campaign) => sessions.filter((item) => campaign === undefined || item.campaign_id === campaign),
    sessionContinuationAvailability: (sessionId) => { const admitted = typeof available === "function" ? available(sessionId) : available; return { resume: admitted, reason: admitted ? "fresh governed admission is required" : "model revision changed" }; },
    reconcileHarnessSessionCrash: (_sessionId, apply) => ({ ok: true, applied: apply, reason: "hard-crash checkpoint can be reconciled" }),
    sessionContinuationRequirements: () => [],
    awaitCampaignRun: async () => ({ task_state: "completed" }),
  };
}

describe("repository-level operator resume", () => {
  it("is a calm no-op when no interrupted work exists", async () => {
    let dispatches = 0;
    const result = await resumeInterruptedWork({ runtime: runtime([]), dispatch: async () => { dispatches += 1; return { ok: true }; } });
    expect(result).toEqual({ status: "idle", message: "No interrupted governed work is waiting in this repository." });
    expect(dispatches).toBe(0);
  });

  it("refuses to guess when separate branches are recoverable", async () => {
    const result = await resumeInterruptedWork({ runtime: runtime([session("second"), session("first")]), dispatch: async () => ({ ok: true }) });
    expect(result).toMatchObject({ status: "ambiguous", candidates: [{ session_id: "first" }, { session_id: "second" }] });
    expect(formatOperatorResume(result)).toContain("arbor resume <session-id>");
  });

  it("previews without minting authority and exposes fresh-admission refusal", async () => {
    let dispatches = 0;
    const preview = await resumeInterruptedWork({ runtime: runtime([session("one")]), preview: true, dispatch: async () => { dispatches += 1; return { ok: true }; } });
    const deniedRuntime = { ...runtime([session("one")], false), reconcileHarnessSessionCrash: () => ({ ok: false, applied: false, reason: "model revision changed" }) };
    const unavailable = await resumeInterruptedWork({ runtime: deniedRuntime, dispatch: async () => { dispatches += 1; return { ok: true }; } });
    expect(preview).toMatchObject({ status: "preview", candidate: { checkpoint: 7 } });
    expect(unavailable).toMatchObject({ status: "unavailable", message: "model revision changed" });
    expect(dispatches).toBe(0);
  });

  it("durably reconciles a hard-crash orphan before asking continuation authority again", async () => {
    let reconciled = false; let dispatches = 0;
    const source = session("hard-crash");
    const crashRuntime: OperatorResumeRuntime = {
      ...runtime([source], false),
      sessionContinuationAvailability: () => ({ resume: reconciled, reason: reconciled ? "ready" : "source node is still expanding" }),
      reconcileHarnessSessionCrash: (_id, apply) => { if (apply) reconciled = true; return { ok: true, applied: apply, reason: "reconciled" }; },
    };
    const result = await resumeInterruptedWork({ runtime: crashRuntime, dispatch: async () => { dispatches += 1; return { ok: true, value: { accepted: true } }; } });
    expect(result).toMatchObject({ status: "continued", candidate: { session_id: "hard-crash" } });
    expect(reconciled).toBe(true); expect(dispatches).toBe(1);
  });

  it("previews indeterminate effects and forwards only explicit operator dispositions", async () => {
    const source = session("effects"); const observed: any[] = [];
    const effectRuntime = { ...runtime([source]), sessionContinuationRequirements: () => [{ operation_id: "provider-1", classification: "indeterminate", reason: "dispatch had no settlement" }] };
    const preview = await resumeInterruptedWork({ runtime: effectRuntime, preview: true, dispatch: async () => ({ ok: true }) });
    expect(preview).toMatchObject({ status: "preview", required_dispositions: [{ operation_id: "provider-1", classification: "indeterminate" }] });
    const disposition = { operation_id: "provider-1", decision: "retry" as const, reason: "operator confirmed no external effect" };
    await resumeInterruptedWork({ runtime: effectRuntime, dispositions: [disposition], dispatch: async (envelope) => { observed.push(envelope); return { ok: true, value: { accepted: true } }; } });
    expect(observed[0].command.dispositions).toEqual([disposition]);
  });

  it("discovers a terminal cancelled session whose campaign node remains interrupted", async () => {
    const cancelled = { ...session("cancelled"), state: "cancelled", recovery: { kind: "not_required" } };
    const result = await resumeInterruptedWork({ runtime: runtime([cancelled]), preview: true, dispatch: async () => ({ ok: true }) });
    expect(result).toMatchObject({ status: "preview", candidate: { session_id: "cancelled", checkpoint: 7 } });
  });

  it("uses a checkpoint-stable idempotency key, waits for settlement, and reports continuation lineage", async () => {
    const source = session("source");
    const continued: OperatorResumeSession = { ...session("continuation", "campaign", 1), recovery: { kind: "not_required" }, lineage: { kind: "continuation", source_session_id: "source" } };
    const observed: unknown[] = [];
    const availability = (id: string) => id === "source";
    const first = await resumeInterruptedWork({ runtime: runtime([source, continued], availability), now: () => "2026-08-22T00:00:00.000Z", dispatch: async (envelope) => { observed.push(envelope); return { ok: true, value: { accepted: true, operation_id: "accepted-operation" } }; } });
    await resumeInterruptedWork({ runtime: runtime([source, continued], availability), now: () => "2030-01-01T00:00:00.000Z", dispatch: async (envelope) => { observed.push(envelope); return { ok: true, value: { accepted: true } }; } });
    expect(first).toMatchObject({ status: "continued", continuation_session_id: "continuation", task_state: "completed", operation_id: "accepted-operation" });
    expect((observed[0] as any).metadata.idempotency_key).toBe((observed[1] as any).metadata.idempotency_key);
    expect((observed[0] as any).command).toMatchObject({ kind: "harness.session.resume", session_id: "source", dispositions: [] });
  });

  it("preserves a governed dispatch rejection instead of claiming continuation", async () => {
    const result = await resumeInterruptedWork({ runtime: runtime([session("source")]), dispatch: async () => ({ ok: false, error: { code: "conflict", message: "lease collision" } }) });
    expect(result).toMatchObject({ status: "rejected", code: "conflict", message: "lease collision" });
  });
});
