/**
 * evidence-restart-amnesia.test.ts — X-4 (blindspot class 7, restart amnesia).
 *
 * WHY THIS EXISTS. ADR-070 documents ONE piece of `CampaignManager` state as
 * deliberately in-memory-only: the scope-decision signing key
 * (`scopeDecisionKeys`). A process restart silently starts a new signing
 * generation rather than reusing a lost key -- documented, and already
 * covered narrowly in `manager-scope-decision.test.ts`. Class 7's claim is
 * broader: other in-memory-only state can have the same property WITHOUT
 * being documented or tested, and the dangerous failure mode is not "state
 * is lost" (restarts always lose something) but "state is lost SILENTLY,
 * producing a plausible-looking wrong answer" rather than a loud, honest
 * refusal.
 *
 * This file constructs a SECOND `CampaignManager` over the SAME
 * `persistence_dir` (the honest simulation of a process restart -- the
 * technique `manager-scope-decision.test.ts`'s own restart case already
 * uses) and asserts, for each category of manager state, explicitly what
 * survives, what does not, and that what does not fails LOUDLY:
 *
 *   - campaign/tree state: SURVIVES (persisted snapshot, reloaded by
 *     `restoreCampaigns` in the constructor).
 *   - waiver-outcome folding (`getWaiverOutcomes`): SURVIVES (folded
 *     read-side view derived live from durable ledger records, not from any
 *     manager-held cache).
 *   - scope-observation folding (`getFoldedScopeObservations`,
 *     `hasApprovedWideningPrecedent`'s lineage read): SURVIVES for the same
 *     reason -- ledger-derived, not manager-cached.
 *   - scope-decision signing generation (`scopeDecisionKeys`): DOES NOT
 *     SURVIVE, by design (ADR-070). The restarted manager starts a fresh
 *     genesis generation, and any attempt to act on the OLD generation
 *     (revoking a decision minted before the restart) throws loudly rather
 *     than silently signing with the wrong key or silently no-op'ing.
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Action, Provenance, ScoreContext } from "@arbor/core";
import { CampaignManager } from "../src/manager.js";

const rootAction: Action = { description: "execute plan", estimated_gain: 100, estimated_cost: 1, category: "root", delegate_to: "crown" };
function action(name: string): Action { return { description: name, estimated_gain: 10, estimated_cost: 1, category: "testing", delegate_to: "seed" }; }
const ctx: ScoreContext = { accuracy_regression_rate: 0, crash_regression_rate: 0, best_known: 100, total_visits: 5 };
const claimedProv: Provenance = { tag: "claimed", claimant: "seed" };
const verifiedProv: Provenance = { tag: "verified", cmd: "true", exit: 0, stdout_hash: "hash-1" };

function withTmpDir(prefix: string, fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function chain(mgr: CampaignManager, campaignId: string) {
  mgr.startCampaign(campaignId, "plan.md", rootAction);
  const [a] = mgr.branch(campaignId, "root", [action("a")]);
  const [b] = mgr.branch(campaignId, a!, [action("b")]);
  return { a: a!, b: b! };
}

function settle(mgr: CampaignManager, campaignId: string, nodeId: string, operationId: string, options: {
  readonly verified?: boolean;
  readonly waived?: { by: string; reason: string };
  readonly scope?: { declared: readonly string[]; observed_out_of_scope: readonly string[]; enforcement: "audit" | "blocked" };
} = {}) {
  mgr.expandNode(campaignId, nodeId, { worktree_isolated: true, starting_commit_correct: true, lease_acquired: true });
  mgr.recordResult(campaignId, nodeId, {
    specialist_output: "done", specialist_agent: "seed", provenance: options.verified ? verifiedProv : claimedProv,
    critic_agent: "lenticel", critic_approved: true, critic_rationale: "approved",
    ...(options.waived ? { review_waived: options.waived } : {}),
    ...(options.scope ? { scope_observation: options.scope } : {}),
    result_operation_id: operationId, score_ctx: ctx,
  });
}

describe("CampaignManager restart amnesia (X-4, class 7)", () => {
  it("campaign/tree state SURVIVES a restart -- durable snapshot, not manager memory", () => {
    withTmpDir("arbor-restart-tree-", (dir) => {
      const first = new CampaignManager({ persistence_dir: dir });
      const { a, b } = chain(first, "camp1");
      settle(first, "camp1", a, "op-a", { verified: true });

      const second = new CampaignManager({ persistence_dir: dir });
      const campaign = second.getCampaignSnapshot("camp1")!;
      expect(campaign.nodes.find((entry) => entry.id === a)!.state).toBe("verified");
      expect(campaign.nodes.find((entry) => entry.id === b)!.state).toBe("pending");
      expect(second.getActiveCampaignId()).toBe("camp1");
    });
  });

  it("waiver-outcome folding SURVIVES a restart -- derived live from durable ledger records", () => {
    withTmpDir("arbor-restart-waiver-", (dir) => {
      const first = new CampaignManager({ persistence_dir: dir });
      const { a } = chain(first, "camp1");
      settle(first, "camp1", a, "op-a", { waived: { by: "operator", reason: "low risk" } });
      const waiverRecordId = first.getWaiverOutcomes("camp1")[0]!.record.id;
      first.recordWaiverOutcomeFollowUp({
        campaign_id: "camp1", node_id: a, waiver_record_id: waiverRecordId,
        later_failed: false, recorded_by: "operator", reason: "held up in review",
      });
      const before = first.getWaiverOutcomes("camp1");
      expect(before).toHaveLength(1);
      expect(before[0]!.later_failed).toBe(false);

      const second = new CampaignManager({ persistence_dir: dir });
      const after = second.getWaiverOutcomes("camp1");
      expect(after).toHaveLength(1);
      expect(after[0]!.record.id).toBe(waiverRecordId);
      expect(after[0]!.later_failed).toBe(false);
      expect(after[0]!.adopted).toBe(before[0]!.adopted);
    });
  });

  it("scope-observation folding and lineage precedent SURVIVE a restart -- derived live, not cached", () => {
    withTmpDir("arbor-restart-scope-obs-", (dir) => {
      const first = new CampaignManager({ persistence_dir: dir });
      const { a, b } = chain(first, "camp1");
      settle(first, "camp1", a, "op-a", { scope: { declared: [], observed_out_of_scope: ["lib/x.js"], enforcement: "audit" } });
      // A second, covered observation in the same lineage folds rather than duplicating.
      settle(first, "camp1", b, "op-b", { scope: { declared: [], observed_out_of_scope: ["lib/x.js"], enforcement: "audit" } });
      const beforeFolded = first.getFoldedScopeObservations("camp1");
      const beforeCount = beforeFolded.length;
      const beforeFoldCount = beforeFolded.reduce((sum, entry) => sum + entry.folded_count, 0);
      expect(beforeFoldCount).toBeGreaterThan(beforeCount); // at least one real fold happened

      const second = new CampaignManager({ persistence_dir: dir });
      const afterFolded = second.getFoldedScopeObservations("camp1");
      expect(afterFolded.length).toBe(beforeCount);
      expect(afterFolded.reduce((sum, entry) => sum + entry.folded_count, 0)).toBe(beforeFoldCount);
    });
  });

  it("scope-decision signing generation DOES NOT survive a restart -- fresh genesis, not a reused key", () => {
    withTmpDir("arbor-restart-scopedec-", (dir) => {
      const first = new CampaignManager({ persistence_dir: dir });
      const { a } = chain(first, "camp1");
      const genesisId = first.approveScopeWidening("camp1", a, ["lib/a.js"], "operator");
      const genesisKey = first.getScopeDecisions("camp1").find((r) => r.id === genesisId)!.decision.public_key;

      const second = new CampaignManager({ persistence_dir: dir });
      // The prior decision is still durably readable -- evidence itself is
      // never lost -- but the SIGNING capacity for its generation is.
      expect(second.getScopeDecisions("camp1").some((r) => r.id === genesisId)).toBe(true);

      const secondId = second.approveScopeWidening("camp1", a, ["lib/b.js"], "operator");
      const secondRecord = second.getScopeDecisions("camp1").find((r) => r.id === secondId)!;
      expect(secondRecord.decision.parent_decision_id).toBeNull();
      expect(secondRecord.decision.public_key).not.toBe(genesisKey);
    });
  });

  it("scope-decision restart amnesia FAILS LOUDLY, never silently, when asked to act on a lost generation", () => {
    withTmpDir("arbor-restart-scopedec-loud-", (dir) => {
      const first = new CampaignManager({ persistence_dir: dir });
      const { a } = chain(first, "camp1");
      const genesisId = first.approveScopeWidening("camp1", a, ["lib/a.js"], "operator");

      const second = new CampaignManager({ persistence_dir: dir });
      // Revoking a decision minted before the restart requires signing with
      // the OLD generation's key, which this process never held. The manager
      // must refuse -- not silently succeed with a signature that would fail
      // downstream verification, and not silently no-op leaving the caller
      // to believe the revoke went through.
      let threw = false;
      try {
        second.revokeScopeWidening("camp1", genesisId, "operator");
      } catch {
        threw = true;
      }
      expect(threw).toBe(true);

      // The precedent this decision established is therefore unchanged --
      // no half-applied revoke silently weakened it.
      expect(second.hasApprovedWideningPrecedent("camp1", a, ["lib/a.js"])).toBe(true);
    });
  });
});
