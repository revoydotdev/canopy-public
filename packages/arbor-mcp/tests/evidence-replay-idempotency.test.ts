/**
 * evidence-replay-idempotency.test.ts — X-3 (blindspot class 4, index-keyed
 * idempotency).
 *
 * WHY THIS EXISTS. `journalResult` journals each `advisory_evidence` finding
 * under `${operationId}:advisory:${index}` -- positional. The generators
 * that produce these findings (sibling scan, test amplifier, mutation
 * probe) are model-driven and nondeterministic, so a retried journal call
 * for the SAME operation can legitimately carry a DIFFERENT finding count,
 * or the same findings in a DIFFERENT order. This file journals a result
 * carrying N advisory findings, then replays the SAME `result_operation_id`
 * with N-1, N+1, and the same count reordered, and asserts the ledger never
 * ends up with duplicate or silently-overwritten advisory records for that
 * operation.
 *
 * FINDING. The original positional key was fragile exactly as class 4
 * predicts: the same-count REORDERED replay collided two different findings
 * onto the same `${operationId}:advisory:${index}` key, and
 * `recordAdvisoryEvidence`'s idempotency check (byte-identical content
 * required under a reused key) threw a loud `AuditIntegrityError` on what
 * should have been a harmless replay of the same underlying evidence. Not
 * silent corruption -- but a real defect: an honest retry of unchanged work
 * became a hard failure. Fixed in `manager.ts`'s `journalResult` by deriving
 * the key from the finding's own content (`generator` + `activity` +
 * `payload`) instead of its position. See that file's comment for the exact
 * migration consequence for ledgers written under the old scheme.
 */
import { describe, expect, it } from "vitest";
import type { Action, Provenance, ScoreContext } from "@arbor/core";
import type { AdvisoryEvidenceGenerator } from "@arbor/audit";
import { CampaignManager } from "../src/manager.js";

const rootAction: Action = { description: "execute plan", estimated_gain: 100, estimated_cost: 1, category: "root", delegate_to: "crown" };
function action(name: string): Action { return { description: name, estimated_gain: 10, estimated_cost: 1, category: "testing", delegate_to: "seed" }; }
const ctx: ScoreContext = { accuracy_regression_rate: 0, crash_regression_rate: 0, best_known: 100, total_visits: 5 };
const verifiedProv: Provenance = { tag: "verified", cmd: "true", exit: 0, stdout_hash: "hash-1" };

function chain(mgr: CampaignManager, campaignId: string) {
  mgr.startCampaign(campaignId, "plan.md", rootAction);
  const [a] = mgr.branch(campaignId, "root", [action("a")]);
  mgr.expandNode(campaignId, a!, { worktree_isolated: true, starting_commit_correct: true, lease_acquired: true });
  return { a: a! };
}

function finding(generator: AdvisoryEvidenceGenerator, activity: string, payload: string) {
  return { generator, activity, payload };
}

function settle(
  mgr: CampaignManager, campaignId: string, nodeId: string, operationId: string,
  advisoryEvidence: readonly { generator: AdvisoryEvidenceGenerator; activity: string; payload: string }[],
) {
  // Verified provenance: the first call's success_pattern memory fact is what
  // lets `journalResult` recognize a replay of the SAME result_operation_id
  // and reuse the existing trace id (rather than re-appending a governed
  // transition and colliding on accumulated gate records) -- exactly how a
  // real retried harness call behaves.
  return mgr.recordResult(campaignId, nodeId, {
    specialist_output: "done", specialist_agent: "seed", provenance: verifiedProv,
    critic_agent: "lenticel", critic_approved: true, critic_rationale: "approved",
    result_operation_id: operationId, advisory_evidence: advisoryEvidence, score_ctx: ctx,
  });
}

const f0 = finding("sibling_scan", "sibling scan pass", "finding-0");
const f1 = finding("test_amplifier", "amplifier pass", "finding-1");
const f2 = finding("mutation_probe", "mutant sweep", "finding-2");
const f3 = finding("sibling_scan", "second sibling scan", "finding-3");

describe("advisory-evidence replay idempotency (X-3, class 4 index-keyed idempotency)", () => {
  it("replay with N-1 findings (one dropped) never duplicates or overwrites the survivors", () => {
    const mgr = new CampaignManager();
    const { a } = chain(mgr, "camp1");
    settle(mgr, "camp1", a, "op-1", [f0, f1, f2]);
    expect(mgr.getAdvisoryEvidence("camp1")).toHaveLength(3);

    settle(mgr, "camp1", a, "op-1", [f0, f1]);
    const records = mgr.getAdvisoryEvidence("camp1");
    // No duplicates: still exactly 3 durable findings (f2 is not erased --
    // append-only evidence is never retracted by a shorter replay).
    expect(records).toHaveLength(3);
    const payloads = records.map((r) => r.evidence.payload).sort();
    expect(payloads).toEqual(["finding-0", "finding-1", "finding-2"]);
    // No silent overwrite: f0/f1's content is byte-identical across both calls.
    expect(records.find((r) => r.evidence.payload === "finding-0")?.evidence.activity).toBe("sibling scan pass");
  });

  it("replay with N+1 findings (one added) appends exactly the new one, never duplicating the originals", () => {
    const mgr = new CampaignManager();
    const { a } = chain(mgr, "camp1");
    settle(mgr, "camp1", a, "op-2", [f0, f1]);
    expect(mgr.getAdvisoryEvidence("camp1")).toHaveLength(2);

    settle(mgr, "camp1", a, "op-2", [f0, f1, f3]);
    const records = mgr.getAdvisoryEvidence("camp1");
    expect(records).toHaveLength(3);
    const payloads = records.map((r) => r.evidence.payload).sort();
    expect(payloads).toEqual(["finding-0", "finding-1", "finding-3"]);
    // Each payload appears exactly once.
    for (const payload of payloads) {
      expect(records.filter((r) => r.evidence.payload === payload)).toHaveLength(1);
    }
  });

  it("replay with the same count REORDERED never throws a false conflict and never duplicates", () => {
    const mgr = new CampaignManager();
    const { a } = chain(mgr, "camp1");
    settle(mgr, "camp1", a, "op-3", [f0, f1, f2]);
    expect(mgr.getAdvisoryEvidence("camp1")).toHaveLength(3);

    // Same three findings, different order -- exactly what a nondeterministic
    // generator can legitimately produce on a retry of the same operation.
    expect(() => settle(mgr, "camp1", a, "op-3", [f2, f0, f1])).not.toThrow();
    const records = mgr.getAdvisoryEvidence("camp1");
    expect(records).toHaveLength(3);
    const payloads = records.map((r) => r.evidence.payload).sort();
    expect(payloads).toEqual(["finding-0", "finding-1", "finding-2"]);
  });

  it("every advisory record for one operation carries a distinct idempotency key witnessing the same trace", () => {
    const mgr = new CampaignManager();
    const { a } = chain(mgr, "camp1");
    settle(mgr, "camp1", a, "op-4", [f0, f1, f2]);
    settle(mgr, "camp1", a, "op-4", [f2, f1, f0, f3]);
    const records = mgr.getAdvisoryEvidence("camp1");
    expect(records).toHaveLength(4);
    const keys = records.map((r) => r.evidence.idempotency_key);
    expect(new Set(keys).size).toBe(keys.length);
    const traceIds = new Set(records.map((r) => r.evidence.source_evidence_id));
    expect(traceIds.size).toBe(1);
  });

  it("two DIFFERENT findings never collide onto the same idempotency key", () => {
    const mgr = new CampaignManager();
    const { a } = chain(mgr, "camp1");
    settle(mgr, "camp1", a, "op-5", [f0, f1, f2, f3]);
    const keys = mgr.getAdvisoryEvidence("camp1").map((r) => r.evidence.idempotency_key);
    expect(new Set(keys).size).toBe(4);
  });
});
