/**
 * Y-1 (ADR-068): `CampaignManager.recordResult`'s optional `advisory_evidence`
 * param journals durable `advisory_evidence` ledger records into the same
 * staged target/fsync as the trace, witnessed by that same call's own
 * freshly-appended trace id -- mirrors `scope_observation`'s wiring in
 * `journalResult` one-for-one. See `manager-scope-lineage.test.ts` for the
 * sibling scope-observation wiring this mirrors.
 */
import { describe, expect, it } from "vitest";
import type { Action, Provenance, ScoreContext } from "@arbor/core";
import { CampaignManager } from "../src/manager.js";

const rootAction: Action = { description: "execute plan", estimated_gain: 100, estimated_cost: 1, category: "root", delegate_to: "crown" };
function action(name: string): Action { return { description: name, estimated_gain: 10, estimated_cost: 1, category: "testing", delegate_to: "seed" }; }
const ctx: ScoreContext = { accuracy_regression_rate: 0, crash_regression_rate: 0, best_known: 100, total_visits: 5 };
const claimedProv: Provenance = { tag: "claimed", claimant: "seed" };

function chain(mgr: CampaignManager, campaignId: string) {
  mgr.startCampaign(campaignId, "plan.md", rootAction);
  const [a] = mgr.branch(campaignId, "root", [action("a")]);
  return { a: a! };
}

describe("CampaignManager.recordResult advisory_evidence (Y-1, ADR-068)", () => {
  it("journals one advisory_evidence record per finding, witnessed by this call's trace id", () => {
    const mgr = new CampaignManager();
    const { a } = chain(mgr, "camp1");
    mgr.expandNode("camp1", a, { worktree_isolated: true, starting_commit_correct: true, lease_acquired: true });
    mgr.recordResult("camp1", a, {
      specialist_output: "done", specialist_agent: "seed", provenance: claimedProv,
      critic_agent: "lenticel", critic_approved: true, critic_rationale: "approved",
      result_operation_id: "op-a",
      advisory_evidence: [
        { generator: "sibling_scan", activity: "scanned sibling files", payload: "finding 1" },
        { generator: "test_amplifier", activity: "amplified tests", payload: "finding 2" },
      ],
      score_ctx: ctx,
    });

    const records = mgr.getAdvisoryEvidence("camp1");
    expect(records).toHaveLength(2);
    expect(records.map((r) => r.evidence.generator).sort()).toEqual(["sibling_scan", "test_amplifier"]);
    const traceId = mgr.getAuditRecords("camp1").find((record) => record.kind === undefined || record.kind === "trace")?.id;
    expect(traceId).toBeDefined();
    for (const record of records) {
      expect(record.evidence.source_evidence_id).toBe(traceId);
    }
  });

  it("is idempotent: replaying the same result_operation_id and findings does not double-journal", () => {
    const mgr = new CampaignManager();
    const { a } = chain(mgr, "camp1");
    mgr.expandNode("camp1", a, { worktree_isolated: true, starting_commit_correct: true, lease_acquired: true });
    const params = {
      specialist_output: "done", specialist_agent: "seed", provenance: claimedProv,
      critic_agent: "lenticel", critic_approved: true, critic_rationale: "approved",
      result_operation_id: "op-a",
      advisory_evidence: [{ generator: "mutation_probe" as const, activity: "probed mutants", payload: "1 survivor" }],
      score_ctx: ctx,
    };
    mgr.recordResult("camp1", a, params);
    expect(mgr.getAdvisoryEvidence("camp1")).toHaveLength(1);
  });

  it("recordResult without advisory_evidence journals none", () => {
    const mgr = new CampaignManager();
    const { a } = chain(mgr, "camp1");
    mgr.expandNode("camp1", a, { worktree_isolated: true, starting_commit_correct: true, lease_acquired: true });
    mgr.recordResult("camp1", a, {
      specialist_output: "done", specialist_agent: "seed", provenance: claimedProv,
      critic_agent: "lenticel", critic_approved: true, critic_rationale: "approved",
      result_operation_id: "op-a",
      score_ctx: ctx,
    });
    expect(mgr.getAdvisoryEvidence("camp1")).toHaveLength(0);
  });
});
