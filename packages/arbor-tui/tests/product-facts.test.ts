import { describe, expect, it } from "vitest";
import { completionManifestLines, operatorFleetFacts, type ProductSurfaceSnapshot } from "../src/screens/product.js";

function snapshot(overrides: Partial<ProductSurfaceSnapshot> = {}): ProductSurfaceSnapshot {
  return {
    captured_at: "2026-08-31T00:00:00.000Z",
    campaigns: { items: [] }, governance: null, backlog: null, jobs: null,
    approvals: null, drafts: null, sessions: null, readiness: null, project: null,
    agents: null, extensions: null,
    ...overrides,
  };
}

function fact(data: ProductSurfaceSnapshot, label: string): string | undefined {
  return operatorFleetFacts(data).find((item) => item.label === label)?.value;
}

describe("operator fleet facts", () => {
  it("counts only explicit active scheduler states instead of treating every state-based job as running", () => {
    const data = snapshot({
      jobs: { jobs: [
        { id: "queued", state: "queued" },
        { id: "started", state: "started" },
        { id: "retrying", state: "retrying" },
        { id: "cancelling", state: "cancel_requested" },
        { id: "completed", state: "completed" },
        { id: "failed", state: "failed" },
        { id: "cancelled", state: "cancelled" },
        { id: "timed-out", state: "timed_out" },
        // Unknown future/malformed states are not evidence of active work.
        { id: "unknown", state: "paused" },
      ] },
    });

    expect(fact(data, "ACTIVE JOBS")).toBe("4");
    expect(operatorFleetFacts(data).some((item) => item.label === "RUNNING JOBS")).toBe(false);
  });

  it("retains a legacy status fallback without allowing terminal statuses to inflate active work", () => {
    const data = snapshot({
      jobs: { jobs: [
        { id: "old-live", status: "running" },
        { id: "old-done", status: "completed" },
      ] },
    });

    // Historical `status: running` remains a compatibility mapping; terminal
    // values no longer inflate the active-work claim.
    expect(fact(data, "ACTIVE JOBS")).toBe("1");
  });

  it("counts only currently live native sessions, not the journal's lifetime history", () => {
    const data = snapshot({
      sessions: { sessions: [
        { session_id: "live", state: "running", terminal: null },
        { session_id: "draining", state: "draining", terminal: null },
        { session_id: "complete", state: "completed", terminal: { state: "completed" } },
        { session_id: "failed", state: "failed", terminal: { state: "failed" } },
        // A contradictory record is terminal, regardless of stale state text.
        { session_id: "stale", state: "running", terminal: { state: "completed" } },
      ] },
    });

    expect(fact(data, "LIVE NATIVE SESSIONS")).toBe("2");
    expect(operatorFleetFacts(data).some((item) => item.label === "NATIVE SESSIONS")).toBe(false);
  });
});

describe("captured-result completion manifest", () => {
  it("keeps final result, files, verification, evidence, and available actions together in a source-honest manifest", () => {
    const lines = completionManifestLines({
      status: "ready_for_review",
      summary: "Verified captured result for campaign c1, node n1.",
      changed_files: [{ path: "packages/arbor-tui/src/screens/console.ts", status: "changed" }],
      patch_summary: "Captured patch: 412 bytes; sha256 0123456789ab.",
      verification: "Command and critic verification passed.",
      metrics: "files 1; checks 2; provenance verified capture",
      adoption: "not adopted; review required",
      follow_up: "Create a campaign-linked follow-up after review.",
      controls: "A arm adoption; S choose files; R unavailable until adoption",
    });

    expect(lines).toEqual([
      { label: "STATUS", value: "ready for review" },
      { label: "RESULT", value: "Verified captured result for campaign c1, node n1." },
      { label: "FILES", value: "packages/arbor-tui/src/screens/console.ts · changed" },
      { label: "PATCH", value: "Captured patch: 412 bytes; sha256 0123456789ab." },
      { label: "VERIFICATION", value: "Command and critic verification passed." },
      { label: "EVIDENCE", value: "files 1; checks 2; provenance verified capture" },
      { label: "ADOPTION", value: "not adopted; review required" },
      { label: "FOLLOW-UP", value: "Create a campaign-linked follow-up after review." },
      { label: "ACTIONS", value: "A arm adoption; S choose files; R unavailable until adoption" },
    ]);
  });

  it("does not turn a partial result-review payload into a fabricated completion manifest", () => {
    // The producer's explicit capture disposition remains visible, but absent
    // summary/files/evidence/actions are never invented around it.
    expect(completionManifestLines({ status: "captured_unverified", changed_files: [{ status: "changed" }] })).toEqual([
      { label: "STATUS", value: "captured unverified" },
    ]);
    expect(completionManifestLines(null)).toEqual([]);
  });
});
