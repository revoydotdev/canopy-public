import { describe, expect, it } from "vitest";
import {
  GATE_REFUSAL_PROJECTION_MAX_TEXT,
  initialProjectionLifecycle,
  isGateRefusalProjection,
  projectGateRecord,
  projectGateRefusal,
  projectGateRefusalLifecycle,
  projectGateUnavailable,
  resolveProjectionFreshnessPolicy,
} from "../src/index.js";
import { projectApprovalRefusal, projectBudgetRefusal, projectCapabilityRefusal, projectToolVeto } from "../src/gate-refusal-projection.js";
import { validateRuntimeError } from "@arbor/core";

const clock = { now: () => "2026-09-13T12:00:00.000Z" };

describe("shared gate refusal/remediation projection", () => {
  it("projects the owning gate, evidence deficit, and bounded remediation", () => {
    const projection = projectGateRecord({
      gate: "evidence",
      result: "bypass",
      checked_at: "2026-09-13T11:59:00.000Z",
      detail: "critic evidence was not durable",
      bypass_evidence_deficit: "missing signed test receipt",
    }, "Persist a signed receipt, then rerun the evidence gate.");

    expect(projection).toEqual({
      schema_version: 2,
      kind: "gate.refusal",
      state: "refused",
      gate: "evidence",
      code: "gate_evidence_bypass",
      summary: "critic evidence was not durable",
      evidence_deficit: "missing signed test receipt",
      remediation: "Persist a signed receipt, then rerun the evidence gate.",
      correcting_actor: "specialist",
      corrective_action: "attach_verified_evidence",
    });
    expect(projection && Object.isFrozen(projection)).toBe(true);
    expect(isGateRefusalProjection(projection)).toBe(true);
  });

  it("does not manufacture a refusal from a passing gate", () => {
    expect(projectGateRecord({
      gate: "admission", result: "pass", checked_at: "2026-09-13T11:59:00.000Z", detail: "ready",
    }, "No remediation required.")).toBeNull();
  });

  it("keeps unavailable distinct from a recorded refusal", () => {
    const projection = projectGateUnavailable({
      gate: "isolation",
      code: "isolation_source_unavailable",
      reason: "worktree verifier is not composed",
      remediation: "Compose the worktree verifier and retry the read.",
    });
    expect(projection.state).toBe("unavailable");
    expect(projection.evidence_deficit).toBeNull();
    expect(projection.correcting_actor).toBe("runtime_host");
    expect(projection.corrective_action).toBe("compose_gate_authority");
    expect(isGateRefusalProjection(projection)).toBe(true);
  });

  it("runs the catalog lifecycle through ready-empty, refusal, expiry, and unavailable", () => {
    const initial = initialProjectionLifecycle<ReturnType<typeof projectGateRefusal> | null>("gate-refusal");
    const empty = projectGateRefusalLifecycle(initial, {
      source: { kind: "available", value: null }, clock, transport: "connected",
    });
    expect(empty.lifecycle).toBe("ready");
    expect(empty.value).toBeNull();
    expect(empty.expires_at).toBe("2026-09-13T12:00:00.000Z");

    const refusal = projectGateRefusalLifecycle(empty, {
      source: { kind: "available", value: projectGateRefusal({
        gate: "audit", code: "audit_failed", summary: "audit gate failed", remediation: "Resolve the listed audit findings.",
      }) }, clock, transport: "connected",
    });
    expect(refusal.lifecycle).toBe("ready");
    expect(refusal.value?.gate).toBe("audit");

    const unavailable = projectGateRefusalLifecycle(refusal, {
      source: { kind: "unavailable", code: "gate_source_unavailable", diagnostic_ref: "diag:gate-source" },
      clock, transport: "disconnected",
    });
    expect(unavailable.lifecycle).toBe("unavailable");
    expect(unavailable.value).toBeNull();
    expect(unavailable.last_failure).toMatchObject({ code: "gate_source_unavailable", diagnostic_ref: "diag:gate-source" });
    expect(resolveProjectionFreshnessPolicy("gate.refusal")).toMatchObject({ fresh_for_ms: 0, max_poll_age_ms: 0 });
  });

  it("rejects malformed or unbounded values at construction and validation", () => {
    expect(() => projectGateRefusal({ gate: "evidence", code: "", summary: "bad", remediation: "retry" })).toThrow(/code/);
    expect(() => projectGateRefusal({ gate: "evidence", code: "bad", summary: "x", remediation: "z".repeat(GATE_REFUSAL_PROJECTION_MAX_TEXT + 1) })).toThrow(/remediation/);
    expect(isGateRefusalProjection({ schema_version: 2, kind: "gate.refusal", state: "refused", gate: "evidence", code: "x", summary: "x", evidence_deficit: null, remediation: "x".repeat(GATE_REFUSAL_PROJECTION_MAX_TEXT + 1), correcting_actor: "specialist", corrective_action: "attach_verified_evidence" })).toBe(false);
  });

  it("rejects actor/action mismatch and stale schema payloads at the boundary", () => {
    const current = projectGateRefusal({ gate: "evidence", code: "missing_receipt", summary: "receipt absent", remediation: "Attach the verified receipt." });
    expect(isGateRefusalProjection({ ...current, schema_version: 1 })).toBe(false);
    expect(isGateRefusalProjection({ ...current, correcting_actor: "untrusted_agent" })).toBe(false);
    expect(isGateRefusalProjection({ ...current, corrective_action: "approve_self" })).toBe(false);
    expect(isGateRefusalProjection({ ...current, correcting_actor: "operator", corrective_action: "attach_verified_evidence" })).toBe(false);
    expect(projectGateRefusal({ gate: "admission", code: "bad_plan", summary: "plan incomplete", remediation: "Repair the plan." })).toMatchObject({ correcting_actor: "campaign_planner", corrective_action: "repair_plan_or_config" });
  });

  it("assigns each gate refusal to the actor authorized to repair that gate", () => {
    const cases = [
      { gate: "admission", correcting_actor: "campaign_planner", corrective_action: "repair_plan_or_config" },
      { gate: "isolation", correcting_actor: "runtime_host", corrective_action: "restore_isolation" },
      { gate: "evidence", correcting_actor: "specialist", corrective_action: "attach_verified_evidence" },
      { gate: "audit", correcting_actor: "operator", corrective_action: "resolve_audit_findings" },
    ] as const;
    for (const expected of cases) {
      const projection = projectGateRefusal({ gate: expected.gate, code: "blocked", summary: "gate blocked", remediation: "Follow the corrective action." });
      expect(projection).toMatchObject(expected);
      expect(isGateRefusalProjection(projection)).toBe(true);
    }
  });

  it("projects non-gate refusals through the same v2 contract, each to the actor that can clear it", () => {
    const cases = [
      [projectCapabilityRefusal("CapabilityError: action x requires capability senior but caller is junior", "Relaunch trusted."), { gate: "capability", correcting_actor: "operator", corrective_action: "grant_capability" }],
      [projectCapabilityRefusal("local session signature did not verify", "unused"), { gate: "capability", correcting_actor: "caller", corrective_action: "reauthenticate" }],
      [projectApprovalRefusal("output.raw", "raw output approval denied: approval record was not found"), { gate: "capability", code: "approval_not_granted", correcting_actor: "caller", corrective_action: "request_approval" }],
      [projectBudgetRefusal("usage_budget", "prospective cost budget would be exceeded"), { gate: "budget", correcting_actor: "operator", corrective_action: "raise_budget" }],
      [projectToolVeto("hook_denied", "denied by hook h@1: no"), { gate: "tool_veto", state: "refused", correcting_actor: "specialist", corrective_action: "revise_tool_call" }],
      [projectToolVeto("hook_veto_failed", "denied by hook h@1: threw"), { gate: "tool_veto", state: "unavailable", correcting_actor: "runtime_host", corrective_action: "compose_gate_authority" }],
    ] as const;
    for (const [projection, expected] of cases) {
      expect(projection).toMatchObject({ schema_version: 2, kind: "gate.refusal", ...expected });
      expect(isGateRefusalProjection(projection)).toBe(true);
      // The core runtime-error boundary accepts the same remedy unchanged.
      expect(validateRuntimeError({ code: "permission", severity: "warning", recoverable: true, source: "test", summary: "refused", gate_refusal: projection }).ok).toBe(true);
    }
    // A valid action handed to an actor who cannot perform it is still rejected, at both boundaries.
    const forged = { ...projectBudgetRefusal("campaign_budget", "over"), correcting_actor: "specialist" };
    expect(isGateRefusalProjection(forged)).toBe(false);
    expect(validateRuntimeError({ code: "permission", severity: "warning", recoverable: true, source: "test", summary: "refused", gate_refusal: forged }).ok).toBe(false);
    expect(() => projectGateRefusal({ gate: "tool_veto", code: "x", summary: "x", remediation: "x", correcting_actor: "operator", corrective_action: "revise_tool_call" })).toThrow();
    // request_approval belongs to the capability authority's caller only.
    expect(() => projectGateRefusal({ gate: "capability", code: "x", summary: "x", remediation: "x", correcting_actor: "operator", corrective_action: "request_approval" })).toThrow();
    expect(() => projectGateRefusal({ gate: "admission", code: "x", summary: "x", remediation: "x", correcting_actor: "caller", corrective_action: "request_approval" })).toThrow();
  });
});
