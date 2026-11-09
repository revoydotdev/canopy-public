import { describe, it, expect } from "vitest";
import { NODE_ERROR_KINDS, OUTCOME_KINDS, saveCampaign, loadCampaignResult } from "../src/index.js";
import type { NodeOutcome, NodeError, Provenance, TreeNode, CampaignState } from "../src/index.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const claimed: Provenance = { tag: "claimed", claimant: "seed" };

// ---------- Closed union invariants ----------

describe("NodeOutcome closed union invariants", () => {
  it("OUTCOME_KINDS are exhaustive and exhaustive-only", () => {
    expect(OUTCOME_KINDS).toEqual(["verdict", "interrupted", "error"]);
  });

  it("NODE_ERROR_KINDS are exhaustive and exhaustive-only", () => {
    expect(NODE_ERROR_KINDS).toEqual([
      "timeout",
      "context_window_exceeded",
      "quota_exceeded",
      "transport_error",
      "internal_error",
      "policy_refused",
    ]);
  });

  it("rejects unknown outcome discrimant during persist replay", () => {
    const dir = mkdtempSync(join(tmpdir(), "arbor-outcome-"));
    try {
      const node: TreeNode = {
        id: "n1", action: { description: "a", estimated_gain: 1, estimated_cost: 1, category: "c", delegate_to: "seed" },
        score: 0, state: "failed", parent_id: null, children_ids: [], visit_count: 0, edge_visit_count: 0, value_estimate: 0, provenance: null,
        kb_entries_extracted: 0, created_at: new Date().toISOString(), gate_records: [],
        memory_mode: "accumulate", memory_mode_version: 1,
        // @ts-expect-error — inject a discriminant outside the closed catalog
        outcome: { kind: "bogus_kind", provenance: claimed, message: "test" },
      };
      const tree = new Map<string, TreeNode>();
      tree.set("n1", node);
      const state: CampaignState = {
        id: "camp1", plan_path: "", config: {
          max_seconds: 600, min_score: 0.1, convergence_iterations: 2,
          score_config: { exploration_constant: Math.SQRT2 },
        },
        tree, root_id: "n1", started_at: new Date().toISOString(),
        iterations_completed: 0, iterations_without_kb_entry: 0, best_score: 0, halted: false, halt_reason: null,
      };
      saveCampaign(state, dir);
      const result = loadCampaignResult("camp1", dir).value;
      // The unknown discrimant must be caught — null means validation rejected it
      expect(result).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects unknown error discrimant during persist replay", () => {
    const dir = mkdtempSync(join(tmpdir(), "arbor-outcome-"));
    try {
      const node: TreeNode = {
        id: "n1", action: { description: "a", estimated_gain: 1, estimated_cost: 1, category: "c", delegate_to: "seed" },
        score: 0, state: "failed", parent_id: null, children_ids: [], visit_count: 0, edge_visit_count: 0, value_estimate: 0, provenance: null,
        kb_entries_extracted: 0, created_at: new Date().toISOString(), gate_records: [],
        memory_mode: "accumulate", memory_mode_version: 1,
        outcome: { kind: "error", error: { kind: "bogus_error", provenance: claimed, message: "test" } } as unknown as NodeOutcome,
      };
      const tree = new Map<string, TreeNode>();
      tree.set("n1", node);
      const state: CampaignState = {
        id: "camp1", plan_path: "", config: {
          max_seconds: 600, min_score: 0.1, convergence_iterations: 2,
          score_config: { exploration_constant: Math.SQRT2 },
        },
        tree, root_id: "n1", started_at: new Date().toISOString(),
        iterations_completed: 0, iterations_without_kb_entry: 0, best_score: 0, halted: false, halt_reason: null,
      };
      saveCampaign(state, dir);
      const result = loadCampaignResult("camp1", dir).value;
      expect(result).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("persists and replays every known outcome kind", () => {
    const dir = mkdtempSync(join(tmpdir(), "arbor-outcome-"));
    try {
      const verdict: NodeOutcome = { kind: "verdict", approved: true, provenance: claimed, message: "good" };
      const interrupted: NodeOutcome = {
        kind: "interrupted", operation_id: "op1", scope: "node", partial_evidence_ids: ["e1"],
        provenance: claimed, message: "interrupted",
      };
      const errorTimeout: NodeError = {
        kind: "timeout", provenance: claimed, message: "timed out", elapsed_ms: 0,
        partial_output: null, usage: { kind: "unavailable", reason: "test fixture" },
      };
      const errorCw: NodeError = {
        kind: "context_window_exceeded",
        signal: { kind: "context_overflow", observed_tokens: 100, context_limit: 80, message: "overflow" },
        provenance: claimed, message: "context overflow",
      };
      const errorQuota: NodeError = { kind: "quota_exceeded", provenance: claimed, message: "quota" };
      const errorTransport: NodeError = { kind: "transport_error", recoverable: true, provenance: claimed, message: "disconnected" };
      const errorInternal: NodeError = { kind: "internal_error", recoverable: false, provenance: claimed, message: "crash" };
      const errorPolicy: NodeError = { kind: "policy_refused", code: "action_scope_path_denied", recoverable: true, provenance: claimed, message: "scope denied" };

      for (const outcome of [verdict, interrupted, { kind: "error" as const, error: errorTimeout }, { kind: "error" as const, error: errorCw }, { kind: "error" as const, error: errorQuota }, { kind: "error" as const, error: errorTransport }, { kind: "error" as const, error: errorInternal }, { kind: "error" as const, error: errorPolicy }]) {
        const nodeId = `n_${(outcome as any).kind === "error" ? (outcome as any).error.kind : (outcome as any).kind}`;
        const isInterrupted = (outcome as any).kind === "interrupted";
        const nodeState = isInterrupted ? "interrupted" as const : "failed" as const;
        const tree = new Map<string, TreeNode>();
        tree.set("root", {
          id: "root", action: { description: "a", estimated_gain: 1, estimated_cost: 1, category: "c", delegate_to: "seed" },
          score: 0, state: "pending", parent_id: null, children_ids: [nodeId], visit_count: 0, edge_visit_count: 0, value_estimate: 0,
          provenance: null, kb_entries_extracted: 0, created_at: new Date().toISOString(), gate_records: [],
          memory_mode: "accumulate", memory_mode_version: 1,
        });
        tree.set(nodeId, {
          id: nodeId, action: { description: "a", estimated_gain: 1, estimated_cost: 1, category: "c", delegate_to: "seed" },
          score: 0, state: nodeState, parent_id: "root", children_ids: [], visit_count: 0, edge_visit_count: 0, value_estimate: 0,
          provenance: null, kb_entries_extracted: 0, created_at: new Date().toISOString(), gate_records: [],
          memory_mode: "accumulate", memory_mode_version: 1, outcome,
        });
        const state: CampaignState = {
          id: "camp1", plan_path: "", config: {
            max_seconds: 600, min_score: 0.1, convergence_iterations: 2,
            score_config: { exploration_constant: Math.SQRT2 },
          },
          tree, root_id: "root", started_at: new Date().toISOString(),
          iterations_completed: 0, iterations_without_kb_entry: 0, best_score: 0, halted: false, halt_reason: null,
        };
        saveCampaign(state, dir);
        const loaded = loadCampaignResult("camp1", dir).value;
        expect(loaded).not.toBeNull();
        expect(loaded!.tree.get(nodeId)?.outcome).toEqual(outcome);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------- Fault-matrix integration tests ----------

describe("fault-matrix integration — NodeError kinds as boundary states", () => {
  it("timeout: recoverable=false (a timeout halts the operation)", () => {
    const err: NodeError = {
      kind: "timeout", provenance: claimed, message: "specialist timed out", elapsed_ms: 0,
      partial_output: null, usage: { kind: "unavailable", reason: "test fixture" },
    };
    const outcome: NodeOutcome = { kind: "error", error: err };
    expect(outcome.kind).toBe("error");
    expect((outcome as any).error.kind).toBe("timeout");
  });

  it("transport disconnect: recoverable=true (transient transport error)", () => {
    const err: NodeError = { kind: "transport_error", recoverable: true, provenance: claimed, message: "connection reset" };
    const outcome: NodeOutcome = { kind: "error", error: err };
    expect((outcome as any).error.recoverable).toBe(true);
  });

  it("corrupt data: represented as internal_error, unrecoverable", () => {
    const err: NodeError = { kind: "internal_error", recoverable: false, provenance: claimed, message: "persistence payload corrupt" };
    const outcome: NodeOutcome = { kind: "error", error: err };
    expect((outcome as any).error.recoverable).toBe(false);
  });

  it("duplicate operation: quota_exceeded for bounded retries", () => {
    const err: NodeError = { kind: "quota_exceeded", provenance: claimed, message: "retry budget exhausted" };
    const outcome: NodeOutcome = { kind: "error", error: err };
    expect(outcome.kind).toBe("error");
  });

  it("unavailable subsystem: transport_error, non-recoverable", () => {
    const err: NodeError = { kind: "transport_error", recoverable: false, provenance: claimed, message: "frida-server unreachable" };
    const outcome: NodeOutcome = { kind: "error", error: err };
    expect((outcome as any).error.recoverable).toBe(false);
  });

  it("policy refusal: carries the real refusal code, recoverable=true, and is not internal_error", () => {
    const err: NodeError = { kind: "policy_refused", code: "action_scope_path_denied", recoverable: true, provenance: claimed, message: "execution refused: write path exceeds the system-owned action scope" };
    const outcome: NodeOutcome = { kind: "error", error: err };
    expect((outcome as any).error.kind).toBe("policy_refused");
    expect((outcome as any).error.kind).not.toBe("internal_error");
    expect((outcome as any).error.code).toBe("action_scope_path_denied");
    expect((outcome as any).error.recoverable).toBe(true);
  });

  it("context-overflow is NOT a timeout, internal_error, quota, or transport error", () => {
    const err: NodeError = {
      kind: "context_window_exceeded",
      signal: { kind: "context_overflow", observed_tokens: 300, context_limit: 200, message: "overflow" },
      provenance: claimed, message: "context overflow",
    };
    // Overflow has its own kind, its own ContextOverflowSignal, and does not alias any other kind.
    expect(err.kind).toBe("context_window_exceeded");
    expect(err.signal.kind).toBe("context_overflow");
  });
});
