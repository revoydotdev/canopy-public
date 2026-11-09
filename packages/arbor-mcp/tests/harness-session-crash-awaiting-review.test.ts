import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArborRuntime } from "../src/runtime.js";

// WA-34: `reconcileHarnessSessionCrash(id, apply: true)` must not report
// `applied: true` for a node `interruptNode` structurally cannot transition.
// `awaiting_review` (a durably captured specialist candidate still waiting on
// a critic verdict) is exactly such a node — only pending/expanding nodes are
// affected by `interruptNode` (arbor-core/tree.ts:256-269). Uses the real
// runtime (not the mocked one in operator-resume.test.ts).
const dirs: string[] = [];
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });

describe("reconcileHarnessSessionCrash / awaiting_review", () => {
  it("reports applied:false with a resume-review pointer for a node interruptNode cannot transition", () => {
    const persistence_dir = mkdtempSync(join(tmpdir(), "arbor-crash-review-"));
    dirs.push(persistence_dir);
    const first = new ArborRuntime({ persistence_dir });
    first.manager.startCampaign("review-crash", "plan.md", { description: "resume me", estimated_gain: 1, estimated_cost: 1, category: "code", delegate_to: "seed" });
    const root = first.manager.getCampaignSnapshot("review-crash")!.root_id;
    const node = first.manager.branch("review-crash", root, [{ description: "resume me", estimated_gain: 1, estimated_cost: 1, category: "code", delegate_to: "seed" }])[0]!;
    first.manager.expandNode("review-crash", node, { worktree_isolated: true, starting_commit_correct: true, lease_acquired: true });
    // A durably captured candidate awaiting a critic verdict — the node is
    // now `awaiting_review`, not `expanding`.
    first.manager.recordCandidate("review-crash", node, {
      specialist_output: "diff content", specialist_agent: "seed",
      provenance: { tag: "claimed", claimant: "seed" },
    });
    first.harnessSessions!.recordStarted({
      session_id: "review-worker", campaign_id: "review-crash", node_id: node, operation: "specialize",
      connector_id: "revoy-native", execution_kind: "direct_native", profile_id: "architect", state: "running", latest_sequence: 0,
    });

    const restarted = new ArborRuntime({ persistence_dir });
    expect(restarted.manager.getNodeInfo("review-crash", node)?.state).toBe("awaiting_review");

    expect(restarted.reconcileHarnessSessionCrash("review-worker", false)).toMatchObject({ ok: true, applied: false });

    const result = restarted.reconcileHarnessSessionCrash("review-worker", true);
    expect(result).toMatchObject({ ok: false, applied: false });
    expect(result.reason).toContain("arbor recover --campaign review-crash --resume-review");
    // The node must remain exactly what it was — no misreported transition.
    expect(restarted.manager.getNodeInfo("review-crash", node)?.state).toBe("awaiting_review");
  });
});
