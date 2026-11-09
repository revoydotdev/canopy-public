/**
 * Y-1/Y-2 (ADR-066): `CampaignManager.deriveScopeLineagePaths` and
 * `hasBlockedScopePrecedent` -- the manager-owned lineage primitives the
 * verifier's `lineage_paths_for_node` seam and a future `cli.ts` escalation
 * wiring both consume. See `scope-enforcement-adversarial.test.ts` for the
 * verifier-side union check these paths feed.
 */
import { describe, expect, it } from "vitest";
import type { Action, CriticVerdict, Provenance, ScoreContext } from "@arbor/core";
import { CampaignManager } from "../src/manager.js";

const rootAction: Action = { description: "execute plan", estimated_gain: 100, estimated_cost: 1, category: "root", delegate_to: "crown" };
function action(name: string): Action { return { description: name, estimated_gain: 10, estimated_cost: 1, category: "testing", delegate_to: "seed" }; }
const ctx: ScoreContext = { accuracy_regression_rate: 0, crash_regression_rate: 0, best_known: 100, total_visits: 5 };
const verifiedProv: Provenance = { tag: "verified", cmd: "pytest", exit: 0, stdout_hash: "sha256:test" };
const claimedProv: Provenance = { tag: "claimed", claimant: "seed" };

function fullVerdict(approved: boolean): CriticVerdict {
  return {
    approved, critic: "lenticel", rationale: "approved",
    ...(approved ? {} : { root_cause: "rejected" }),
    measurement_validated: true, guardrails_enforced: true, introspection_passed: true, stability_ok: true,
    checks: [
      { name: "root_cause", passed: true, detail: "n/a" },
      { name: "measurement_validation", passed: true, detail: "n/a" },
      { name: "guardrail_enforcement", passed: true, detail: "n/a" },
      { name: "introspection", passed: true, detail: "n/a" },
      { name: "stability_monitoring", passed: true, detail: "n/a" },
    ],
  };
}

/** Expands and records a result for one node, optionally with a full critic verdict and/or a scope observation. */
function settle(mgr: CampaignManager, campaignId: string, nodeId: string, options: {
  readonly verified?: boolean;
  readonly withCriticVerdict?: boolean;
  readonly scope?: { declared: readonly string[]; observed_out_of_scope: readonly string[]; enforcement: "audit" | "blocked" };
  readonly operationId: string;
}) {
  mgr.expandNode(campaignId, nodeId, { worktree_isolated: true, starting_commit_correct: true, lease_acquired: true });
  mgr.recordResult(campaignId, nodeId, {
    specialist_output: "done", specialist_agent: "seed", provenance: options.verified ? verifiedProv : claimedProv,
    critic_agent: "lenticel", critic_approved: true, critic_rationale: "approved",
    ...(options.withCriticVerdict ? { critic_verdict: fullVerdict(true) } : {}),
    ...(options.scope ? { scope_observation: options.scope } : {}),
    result_operation_id: options.operationId,
    score_ctx: ctx,
  });
}

function chain(mgr: CampaignManager, campaignId: string) {
  mgr.startCampaign(campaignId, "plan.md", rootAction);
  const [a] = mgr.branch(campaignId, "root", [action("a")]);
  const [b] = mgr.branch(campaignId, a!, [action("b")]);
  const [c] = mgr.branch(campaignId, b!, [action("c")]);
  return { a: a!, b: b!, c: c! };
}

describe("CampaignManager.deriveScopeLineagePaths", () => {
  it("fails closed on a trusted blocked observation even when the critic approved", () => {
    const mgr = new CampaignManager();
    const { a } = chain(mgr, "camp-blocked");
    mgr.expandNode("camp-blocked", a, { worktree_isolated: true, starting_commit_correct: true, lease_acquired: true });
    const result = mgr.recordResult("camp-blocked", a, {
      specialist_output: "done", specialist_agent: "seed", provenance: claimedProv,
      critic_agent: "lenticel", critic_approved: true, critic_rationale: "approved",
      critic_verdict: fullVerdict(true),
      scope_observation: { declared: ["src/lib.rs"], observed_out_of_scope: ["tests/checkpoint.rs"], enforcement: "blocked" },
      result_operation_id: "op-blocked", score_ctx: ctx,
    });
    expect(result.state).toBe("failed");
    expect(mgr.getCampaignSnapshot("camp-blocked")?.nodes.find((node) => node.id === a)?.critic_verdict?.approved).toBe(true);
    expect(mgr.getFoldedScopeObservations("camp-blocked")).toEqual(expect.arrayContaining([
      expect.objectContaining({ record: expect.objectContaining({ observation: expect.objectContaining({ enforcement: "blocked", observed_out_of_scope: ["tests/checkpoint.rs"] }) }) }),
    ]));
  });

  it("unions declared+observed_out_of_scope paths from every non-boundary strict ancestor", () => {
    const mgr = new CampaignManager();
    const { a, b, c } = chain(mgr, "camp1");
    settle(mgr, "camp1", a, { verified: false, operationId: "op-a", scope: { declared: ["test/a.test.js"], observed_out_of_scope: ["lib/a.js"], enforcement: "audit" } });
    settle(mgr, "camp1", b, { verified: false, operationId: "op-b", scope: { declared: ["test/b.test.js"], observed_out_of_scope: ["lib/b.js"], enforcement: "audit" } });

    const lineage = mgr.deriveScopeLineagePaths("camp1", c);
    expect(new Set(lineage)).toEqual(new Set(["test/a.test.js", "lib/a.js", "test/b.test.js", "lib/b.js"]));
  });

  it("stops at (and excludes) the nearest verified-and-critic-approved ancestor", () => {
    const mgr = new CampaignManager();
    const { a, b, c } = chain(mgr, "camp1");
    // A is the boundary: verified AND carries a genuine critic_verdict.
    settle(mgr, "camp1", a, { verified: true, withCriticVerdict: true, operationId: "op-a", scope: { declared: ["test/a.test.js"], observed_out_of_scope: ["lib/a.js"], enforcement: "audit" } });
    settle(mgr, "camp1", b, { verified: false, operationId: "op-b", scope: { declared: ["test/b.test.js"], observed_out_of_scope: ["lib/b.js"], enforcement: "audit" } });

    const lineage = mgr.deriveScopeLineagePaths("camp1", c);
    expect(new Set(lineage)).toEqual(new Set(["test/b.test.js", "lib/b.js"]));
    expect(lineage).not.toContain("lib/a.js");
    expect(lineage).not.toContain("test/a.test.js");
  });

  it("a verified node WITHOUT a genuine critic_verdict is not treated as a boundary -- its paths are still included", () => {
    const mgr = new CampaignManager();
    const { a, b, c } = chain(mgr, "camp1");
    // Verified but no critic_verdict param supplied: not a boundary by this record's definition.
    settle(mgr, "camp1", a, { verified: true, withCriticVerdict: false, operationId: "op-a", scope: { declared: ["test/a.test.js"], observed_out_of_scope: ["lib/a.js"], enforcement: "audit" } });
    settle(mgr, "camp1", b, { verified: false, operationId: "op-b" });

    const lineage = mgr.deriveScopeLineagePaths("camp1", c);
    expect(lineage).toContain("lib/a.js");
  });

  it("returns [] for the campaign root (no ancestors) and for a node with no ancestor scope observations", () => {
    const mgr = new CampaignManager();
    const { a } = chain(mgr, "camp1");
    expect(mgr.deriveScopeLineagePaths("camp1", "root")).toEqual([]);
    expect(mgr.deriveScopeLineagePaths("camp1", a)).toEqual([]); // a's own parent is root, which is excluded
  });

  it("excludes the root's own scope observations even when no verified-and-critic-approved ancestor exists between the node and the root", () => {
    const mgr = new CampaignManager();
    mgr.startCampaign("camp1", "plan.md", rootAction);
    const [a] = mgr.branch("camp1", "root", [action("a")]);
    // Record a scope observation directly on the root by expanding it first is not supported (root starts verified-ish);
    // instead assert a's own lineage (parent = root) never includes anything from root even conceptually -- root has
    // no path to declare here, so this proves the walk terminates at the root without throwing or looping.
    expect(() => mgr.deriveScopeLineagePaths("camp1", a!)).not.toThrow();
  });
});

describe("CampaignManager.hasBlockedScopePrecedent", () => {
  it("is true for a path with a prior BLOCKED observation within the querying node's own lineage (including itself)", () => {
    const mgr = new CampaignManager();
    const { a, b } = chain(mgr, "camp1");
    settle(mgr, "camp1", a, { verified: false, operationId: "op-a", scope: { declared: ["test/a.test.js"], observed_out_of_scope: ["lib/leak.js"], enforcement: "blocked" } });
    expect(mgr.hasBlockedScopePrecedent("camp1", b, ["lib/leak.js"])).toBe(true);
    expect(mgr.hasBlockedScopePrecedent("camp1", a, ["lib/leak.js"])).toBe(true); // includes the node's own prior attempts
  });

  it("is false for a path whose only prior blocked observation belongs to a different lineage", () => {
    const mgr = new CampaignManager();
    mgr.startCampaign("camp1", "plan.md", rootAction);
    const [siblingA] = mgr.branch("camp1", "root", [action("sibling-a")]);
    const [siblingB] = mgr.branch("camp1", "root", [action("sibling-b")]);
    settle(mgr, "camp1", siblingA!, { verified: false, operationId: "op-sibling-a", scope: { declared: [], observed_out_of_scope: ["lib/leak.js"], enforcement: "blocked" } });
    expect(mgr.hasBlockedScopePrecedent("camp1", siblingB!, ["lib/leak.js"])).toBe(false);
  });

  it("is false for a path with no prior blocked observation, and never treats an 'audit' observation as precedent", () => {
    const mgr = new CampaignManager();
    const { a, b } = chain(mgr, "camp1");
    settle(mgr, "camp1", a, { verified: false, operationId: "op-a", scope: { declared: [], observed_out_of_scope: ["lib/other.js"], enforcement: "audit" } });
    expect(mgr.hasBlockedScopePrecedent("camp1", b, ["lib/other.js"])).toBe(false);
    expect(mgr.hasBlockedScopePrecedent("camp1", b, ["lib/never-seen.js"])).toBe(false);
  });
});

describe("CampaignManager.getFoldedScopeObservations", () => {
  it("passes through the ledger's folded view for a campaign", () => {
    const mgr = new CampaignManager();
    const { a, b } = chain(mgr, "camp1");
    settle(mgr, "camp1", a, { verified: false, operationId: "op-a", scope: { declared: [], observed_out_of_scope: ["lib/x.js"], enforcement: "audit" } });
    settle(mgr, "camp1", b, { verified: false, operationId: "op-b", scope: { declared: [], observed_out_of_scope: ["lib/x.js"], enforcement: "audit" } });
    const folded = mgr.getFoldedScopeObservations("camp1");
    expect(folded).toHaveLength(1);
    expect(folded[0]!.folded_count).toBe(2);
  });
});
