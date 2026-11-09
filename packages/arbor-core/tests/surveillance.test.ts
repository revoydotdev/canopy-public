import { describe, expect, it } from "vitest";
import { detectSurveillanceFindings, type SurveillanceInput } from "../src/index.js";

const BASE: SurveillanceInput = {
  campaign_id: "campaign-1",
  as_of: "2026-08-01T12:00:00.000Z",
  rejections: [],
  branch_selections: [],
  evidence: [],
  work: [],
};

describe("surveillance detector", () => {
  it("detects repeated rejection within the configured window and ignores old rejection", () => {
    const rejections = [0, 1, 2].map((minute) => ({ node_id: `n${minute}`, branch_id: "root", action_fingerprint: "same-action", occurred_at: `2026-08-01T11:${50 + minute}:00.000Z`, evidence_ref: `audit:${minute}` }));
    rejections.push({ node_id: "old", branch_id: "root", action_fingerprint: "same-action", occurred_at: "2026-08-01T09:00:00.000Z", evidence_ref: "audit:old" });
    const findings = detectSurveillanceFindings({ ...BASE, rejections });
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ kind: "repeated_rejection", evidence_refs: ["audit:0", "audit:1", "audit:2"], provenance: { tag: "generated" } });
  });

  it("detects alternating sibling selection and produces replay-stable dedup keys", () => {
    const branch_selections = ["a", "b", "a", "b"].map((node_id, index) => ({ parent_id: "root", node_id, occurred_at: `2026-08-01T11:0${index}:00.000Z` }));
    const first = detectSurveillanceFindings({ ...BASE, branch_selections });
    const replay = detectSurveillanceFindings({ ...BASE, branch_selections: [...branch_selections].reverse() });
    expect(first[0]?.kind).toBe("branch_oscillation");
    expect(replay[0]?.dedup_key).toBe(first[0]?.dedup_key);
  });

  it("detects stale non-terminal evidence but not terminal evidence", () => {
    const findings = detectSurveillanceFindings({ ...BASE, evidence: [
      { evidence_ref: "audit:stale", node_id: "n1", as_of: "2026-08-01T10:00:00.000Z", terminal: false },
      { evidence_ref: "audit:terminal", node_id: "n2", as_of: "2026-08-01T09:00:00.000Z", terminal: true },
    ] });
    expect(findings.map((finding) => finding.kind)).toEqual(["stale_evidence"]);
  });

  it("detects active work without an expanding node owner", () => {
    const findings = detectSurveillanceFindings({ ...BASE, work: [
      { operation_id: "op-orphan", node_id: "missing", work_active: true, node_state: "missing", evidence_ref: "lease:1" },
      { operation_id: "op-owned", node_id: "n2", work_active: true, node_state: "expanding", evidence_ref: "lease:2" },
    ] });
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ kind: "orphaned_work", severity: "critical", evidence_refs: ["lease:1"] });
  });

  it("detects convergence claims that disagree with the supplied projection", () => {
    const convergence = { reported_converged: true, iterations_without_kb_entry: 1, configured_iterations: 2, new_kb_entries: 1, selectable_nodes: 2, evidence_ref: "snapshot:v4" };
    expect(detectSurveillanceFindings({ ...BASE, convergence })[0]).toMatchObject({ kind: "convergence_anomaly", evidence_refs: ["snapshot:v4"] });
    expect(detectSurveillanceFindings({ ...BASE, convergence: { ...convergence, iterations_without_kb_entry: 2, new_kb_entries: 0, selectable_nodes: 0 } })).toEqual([]);
    expect(detectSurveillanceFindings({ ...BASE, convergence: { ...convergence, iterations_without_kb_entry: 2, new_kb_entries: 0, selectable_nodes: 5 } })).toEqual([]);
  });

  it("rejects unbounded input before detection", () => {
    const work = Array.from({ length: 3 }, (_, index) => ({ operation_id: `op${index}`, node_id: `n${index}`, work_active: false, node_state: "pending" as const, evidence_ref: `e:${index}` }));
    expect(() => detectSurveillanceFindings({ ...BASE, work }, { max_signals_per_kind: 2, repeated_rejection_threshold: 2, rejection_window_ms: 1, oscillation_sample_size: 2, stale_evidence_ms: 1 })).toThrow("max_signals_per_kind");
  });

  it("does not mutate the frozen projection", () => {
    const input = Object.freeze({ ...BASE, work: Object.freeze([{ operation_id: "op", node_id: "n", work_active: true, node_state: "failed" as const, evidence_ref: "e" }]) });
    expect(() => detectSurveillanceFindings(input)).not.toThrow();
    expect(input.work[0]?.node_state).toBe("failed");
  });
});
