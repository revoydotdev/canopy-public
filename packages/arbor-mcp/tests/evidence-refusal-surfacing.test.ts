/**
 * evidence-refusal-surfacing.test.ts — X-2(a) (blindspot class 2, swallowed
 * refusals).
 *
 * WHY THIS EXISTS. 243 `catch {}` sites were measured across every package's src tree,
 * 44 empty or comment-only. Two of today's real bugs hid there: the empty
 * `source_evidence_id` refusal and the fractional-p50 refusal, both eaten by
 * a bare catch upstream of the ledger. This file targets the manager's own
 * writes into the ledger -- every evidence-writing path `journalResult`
 * owns (trace / memory-fact / waiver / scope-observation / advisory) -- and
 * proves that when the ledger genuinely refuses (throws
 * `AuditIntegrityError`), the manager surfaces it rather than silently
 * dropping the write and returning as if nothing happened. A caller that
 * gets back a normal, successful `recordResult()` return value while the
 * evidence it asked to journal silently vanished is exactly the defect
 * shape class 2 describes.
 *
 * TECHNIQUE. `CampaignManager` has no constructor-level ledger injection
 * seam (`CampaignManagerOptions` does not accept one), so this file reaches
 * into the manager's own real `EvidenceLedger` instance and replaces one
 * `record*` method at a time with a stub that throws
 * `AuditIntegrityError` -- the manager's real, load-bearing evidence type,
 * not a fabricated failure mode. Each case then calls `recordResult` (or
 * triggers `recordFailure`'s path through the same `journalResult`) in a
 * way that must reach exactly that write, and asserts the manager does NOT
 * return normally with the refusal swallowed.
 */
import { describe, expect, it } from "vitest";
import type { Action, Provenance, ScoreContext } from "@arbor/core";
import { AuditIntegrityError, EvidenceLedger } from "@arbor/audit";
import { CampaignManager } from "../src/manager.js";

const rootAction: Action = { description: "execute plan", estimated_gain: 100, estimated_cost: 1, category: "root", delegate_to: "crown" };
function action(name: string): Action { return { description: name, estimated_gain: 10, estimated_cost: 1, category: "testing", delegate_to: "seed" }; }
const ctx: ScoreContext = { accuracy_regression_rate: 0, crash_regression_rate: 0, best_known: 100, total_visits: 5 };
const claimedProv: Provenance = { tag: "claimed", claimant: "seed" };

function chain(mgr: CampaignManager, campaignId: string) {
  mgr.startCampaign(campaignId, "plan.md", rootAction);
  const [a] = mgr.branch(campaignId, "root", [action("a")]);
  mgr.expandNode(campaignId, a!, { worktree_isolated: true, starting_commit_correct: true, lease_acquired: true });
  return { a: a! };
}

/** The manager's own real ledger instance -- no persistence_dir, so `journalResult`'s `target` IS this object. */
function realLedgerOf(mgr: CampaignManager): EvidenceLedger {
  return (mgr as unknown as { ledger: EvidenceLedger }).ledger;
}

/** Replace one ledger method with a stub that refuses -- the real evidence-refusal shape, not a fabricated error type. */
function makeRefuse<T extends object, K extends keyof T>(target: T, method: K, reason: string): void {
  (target as Record<K, unknown>)[method] = () => {
    throw new AuditIntegrityError(reason);
  };
}

describe("CampaignManager evidence-writing paths surface a real ledger refusal (X-2a, class 2)", () => {
  it("trace write refusal (success path, recordGovernedTransition) is surfaced, not swallowed", () => {
    const mgr = new CampaignManager();
    const { a } = chain(mgr, "camp1");
    makeRefuse(realLedgerOf(mgr), "recordGovernedTransition", "refused: trace write");
    expect(() => mgr.recordResult("camp1", a, {
      specialist_output: "done", specialist_agent: "seed", provenance: claimedProv,
      critic_agent: "lenticel", critic_approved: true, critic_rationale: "approved",
      result_operation_id: "op-a", score_ctx: ctx,
    })).toThrow(AuditIntegrityError);
  });

  it("trace write refusal (failure path, plain record) is surfaced, not swallowed", () => {
    const mgr = new CampaignManager();
    const { a } = chain(mgr, "camp1");
    makeRefuse(realLedgerOf(mgr), "record", "refused: trace write on failure path");
    expect(() => mgr.recordResult("camp1", a, {
      specialist_output: "done", specialist_agent: "seed", provenance: claimedProv,
      critic_agent: "lenticel", critic_approved: false, critic_rationale: "rejected",
      result_operation_id: "op-a", score_ctx: ctx,
    })).toThrow(AuditIntegrityError);
  });

  it("memory-fact write refusal is surfaced, not swallowed", () => {
    const mgr = new CampaignManager();
    const { a } = chain(mgr, "camp1");
    makeRefuse(realLedgerOf(mgr), "recordMemoryFact", "refused: memory fact");
    // The very first verified result for this campaign always learns a
    // success_pattern fact, so this call must reach recordMemoryFact.
    expect(() => mgr.recordResult("camp1", a, {
      specialist_output: "done", specialist_agent: "seed",
      provenance: { tag: "verified", cmd: "true", exit: 0, stdout_hash: "h" },
      critic_agent: "lenticel", critic_approved: true, critic_rationale: "approved",
      result_operation_id: "op-a", score_ctx: ctx,
    })).toThrow(AuditIntegrityError);
  });

  it("waiver-outcome write refusal is surfaced, not swallowed", () => {
    const mgr = new CampaignManager();
    const { a } = chain(mgr, "camp1");
    makeRefuse(realLedgerOf(mgr), "recordWaiverOutcome", "refused: waiver outcome");
    expect(() => mgr.recordResult("camp1", a, {
      specialist_output: "done", specialist_agent: "seed", provenance: claimedProv,
      critic_agent: "lenticel", critic_approved: true, critic_rationale: "approved",
      review_waived: { by: "operator", reason: "low risk" },
      result_operation_id: "op-a", score_ctx: ctx,
    })).toThrow(AuditIntegrityError);
  });

  it("scope-observation write refusal is surfaced, not swallowed", () => {
    const mgr = new CampaignManager();
    const { a } = chain(mgr, "camp1");
    makeRefuse(realLedgerOf(mgr), "recordScopeObservation", "refused: scope observation");
    expect(() => mgr.recordResult("camp1", a, {
      specialist_output: "done", specialist_agent: "seed", provenance: claimedProv,
      critic_agent: "lenticel", critic_approved: true, critic_rationale: "approved",
      scope_observation: { declared: ["lib/a.js"], observed_out_of_scope: ["lib/b.js"], enforcement: "audit" },
      result_operation_id: "op-a", score_ctx: ctx,
    })).toThrow(AuditIntegrityError);
  });

  it("advisory-evidence write refusal is surfaced, not swallowed", () => {
    const mgr = new CampaignManager();
    const { a } = chain(mgr, "camp1");
    makeRefuse(realLedgerOf(mgr), "recordAdvisoryEvidence", "refused: advisory evidence");
    expect(() => mgr.recordResult("camp1", a, {
      specialist_output: "done", specialist_agent: "seed", provenance: claimedProv,
      critic_agent: "lenticel", critic_approved: true, critic_rationale: "approved",
      advisory_evidence: [{ generator: "sibling_scan", activity: "scanned sibling files", payload: "finding 1" }],
      result_operation_id: "op-a", score_ctx: ctx,
    })).toThrow(AuditIntegrityError);
  });

  it("a refused recordResult call does not leave the node silently promoted to verified", () => {
    // The strongest version of "surfaced, not swallowed": not just that an
    // exception is thrown, but that the tree state a caller would read next
    // was never advanced past the refusal -- no half-applied transition
    // masquerading as success.
    const mgr = new CampaignManager();
    const { a } = chain(mgr, "camp1");
    makeRefuse(realLedgerOf(mgr), "recordGovernedTransition", "refused: trace write");
    expect(() => mgr.recordResult("camp1", a, {
      specialist_output: "done", specialist_agent: "seed", provenance: claimedProv,
      critic_agent: "lenticel", critic_approved: true, critic_rationale: "approved",
      result_operation_id: "op-a", score_ctx: ctx,
    })).toThrow(AuditIntegrityError);
    const node = mgr.getCampaignSnapshot("camp1")!.nodes.find((entry) => entry.id === a);
    expect(node?.state).not.toBe("verified");
  });
});
