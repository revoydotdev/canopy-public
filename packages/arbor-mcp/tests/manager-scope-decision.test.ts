/**
 * Y (ADR-070, PM-3): `CampaignManager.approveScopeWidening`/
 * `revokeScopeWidening`/`hasApprovedWideningPrecedent` -- signed
 * scope-decision hops, campaign-local ephemeral keys, and the
 * evidence-vs-enforcement decoupling (an approved widening never suppresses
 * `recordScopeObservation` journaling). See `manager-scope-lineage.test.ts`
 * for the sibling `hasBlockedScopePrecedent`/lineage primitives this mirrors.
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Action, Provenance, ScoreContext } from "@arbor/core";
import { CampaignManager } from "../src/manager.js";

const rootAction: Action = { description: "execute plan", estimated_gain: 100, estimated_cost: 1, category: "root", delegate_to: "crown" };
function action(name: string): Action { return { description: name, estimated_gain: 10, estimated_cost: 1, category: "testing", delegate_to: "seed" }; }
const ctx: ScoreContext = { accuracy_regression_rate: 0, crash_regression_rate: 0, best_known: 100, total_visits: 5 };
const claimedProv: Provenance = { tag: "claimed", claimant: "seed" };
const verifiedProv: Provenance = { tag: "verified", cmd: "pytest", exit: 0, stdout_hash: "sha256:test" };

function chain(mgr: CampaignManager, campaignId: string) {
  mgr.startCampaign(campaignId, "plan.md", rootAction);
  const [a] = mgr.branch(campaignId, "root", [action("a")]);
  const [b] = mgr.branch(campaignId, a!, [action("b")]);
  return { a: a!, b: b! };
}

function settle(mgr: CampaignManager, campaignId: string, nodeId: string, operationId: string, scope?: { declared: readonly string[]; observed_out_of_scope: readonly string[]; enforcement: "audit" | "blocked" }) {
  mgr.expandNode(campaignId, nodeId, { worktree_isolated: true, starting_commit_correct: true, lease_acquired: true });
  mgr.recordResult(campaignId, nodeId, {
    specialist_output: "done", specialist_agent: "seed", provenance: claimedProv,
    critic_agent: "lenticel", critic_approved: true, critic_rationale: "approved",
    ...(scope ? { scope_observation: scope } : {}),
    result_operation_id: operationId,
    score_ctx: ctx,
  });
}

describe("CampaignManager scope decisions (Y, ADR-070)", () => {
  it("settles verified audit-scope work as scope_unadoptable and surfaces every violating path", () => {
    const mgr = new CampaignManager();
    const { a } = chain(mgr, "d51");
    mgr.expandNode("d51", a, { worktree_isolated: true, starting_commit_correct: true, lease_acquired: true });
    expect(mgr.recordResult("d51", a, {
      specialist_output: "done", specialist_agent: "seed", provenance: verifiedProv,
      critic_agent: "lenticel", critic_approved: true, critic_rationale: "approved",
      scope_observation: { declared: ["tests/a.test.ts"], observed_out_of_scope: ["src/a.ts"], enforcement: "audit" },
      result_operation_id: "d51-result", score_ctx: ctx,
    }).state).toBe("verified");
    mgr.completeAutoHalt("d51", "verified_result");
    expect(mgr.isHalted("d51")).toEqual({ halted: true, reason: "scope_unadoptable" });
    expect(mgr.listCampaigns().find((campaign) => campaign.id === "d51")).toMatchObject({
      terminal_outcome: "partial",
      unadoptable_scope_violations: [{ node_id: a, declared: ["tests/a.test.ts"], observed_out_of_scope: ["src/a.ts"] }],
    });
  });

  it("approveScopeWidening journals a signed approved_widening hop readable via getScopeDecisions", () => {
    const mgr = new CampaignManager();
    const { a } = chain(mgr, "camp1");
    const id = mgr.approveScopeWidening("camp1", a, ["lib/a.js"], "operator");
    expect(id).toMatch(/^scopedec_/);
    const decisions = mgr.getScopeDecisions("camp1");
    expect(decisions).toHaveLength(1);
    expect(decisions[0]!.decision.decision).toBe("approved_widening");
    expect(decisions[0]!.decision.decided_by).toBe("operator");
    expect(decisions[0]!.decision.parent_decision_id).toBeNull();
  });

  it("hasApprovedWideningPrecedent is true in a descendant's lineage when ALL given paths are covered", () => {
    const mgr = new CampaignManager();
    const { a, b } = chain(mgr, "camp1");
    mgr.approveScopeWidening("camp1", a, ["lib/a.js", "lib/b.js"], "operator");
    expect(mgr.hasApprovedWideningPrecedent("camp1", b, ["lib/a.js"])).toBe(true);
    expect(mgr.hasApprovedWideningPrecedent("camp1", b, ["lib/a.js", "lib/b.js"])).toBe(true);
  });

  it("hasApprovedWideningPrecedent is false unless ALL given paths are covered", () => {
    const mgr = new CampaignManager();
    const { a, b } = chain(mgr, "camp1");
    mgr.approveScopeWidening("camp1", a, ["lib/a.js"], "operator");
    expect(mgr.hasApprovedWideningPrecedent("camp1", b, ["lib/a.js", "lib/other.js"])).toBe(false);
  });

  it("hasApprovedWideningPrecedent is false for an unrelated node outside the lineage", () => {
    const mgr = new CampaignManager();
    mgr.startCampaign("camp1", "plan.md", rootAction);
    const [a] = mgr.branch("camp1", "root", [action("a")]);
    const [x] = mgr.branch("camp1", "root", [action("x")]);
    mgr.approveScopeWidening("camp1", a!, ["lib/a.js"], "operator");
    expect(mgr.hasApprovedWideningPrecedent("camp1", x!, ["lib/a.js"])).toBe(false);
  });

  it("revokeScopeWidening flips an approved widening's precedent back to false", () => {
    const mgr = new CampaignManager();
    const { a, b } = chain(mgr, "camp1");
    const decisionId = mgr.approveScopeWidening("camp1", a, ["lib/a.js"], "operator");
    expect(mgr.hasApprovedWideningPrecedent("camp1", b, ["lib/a.js"])).toBe(true);
    mgr.revokeScopeWidening("camp1", decisionId, "operator");
    expect(mgr.hasApprovedWideningPrecedent("camp1", b, ["lib/a.js"])).toBe(false);
  });

  it("revokeScopeWidening chains onto the decision it revokes with real parent linkage", () => {
    const mgr = new CampaignManager();
    const { a } = chain(mgr, "camp1");
    const decisionId = mgr.approveScopeWidening("camp1", a, ["lib/a.js"], "operator");
    const revokeId = mgr.revokeScopeWidening("camp1", decisionId, "operator");
    const revokeRecord = mgr.getScopeDecisions("camp1").find((r) => r.id === revokeId);
    expect(revokeRecord!.decision.parent_decision_id).toBe(decisionId);
    expect(revokeRecord!.decision.decision).toBe("revoked");
  });

  it("evidence-vs-enforcement: an approved widening does NOT suppress scope_observation journaling", () => {
    const mgr = new CampaignManager();
    const { a, b } = chain(mgr, "camp1");
    mgr.approveScopeWidening("camp1", a, ["lib/a.js"], "operator");
    // The node itself still records a raw scope observation for the same path -- evidence keeps flowing.
    settle(mgr, "camp1", b, "op-b", { declared: [], observed_out_of_scope: ["lib/a.js"], enforcement: "audit" });
    const observations = mgr.getScopeObservations("camp1");
    expect(observations).toHaveLength(1);
    expect(observations[0]!.observation.observed_out_of_scope).toContain("lib/a.js");
    // The precedent still resolves true -- it's the (future) enforcement decision point's job to consult it, not this method's.
    expect(mgr.hasApprovedWideningPrecedent("camp1", b, ["lib/a.js"])).toBe(true);
  });

  it("approveScopeWidening is idempotent on identical (node, paths, decider) content", () => {
    const mgr = new CampaignManager();
    const { a } = chain(mgr, "camp1");
    const first = mgr.approveScopeWidening("camp1", a, ["lib/a.js"], "operator");
    const second = mgr.approveScopeWidening("camp1", a, ["lib/a.js"], "operator");
    expect(second).toBe(first);
    expect(mgr.getScopeDecisions("camp1")).toHaveLength(1);
  });

  it("no private key material is ever persisted to disk", () => {
    const dir = mkdtempSync(join(tmpdir(), "arbor-scope-decision-"));
    try {
      const mgr = new CampaignManager({ persistence_dir: dir });
      const { a } = chain(mgr, "camp1");
      const decisionId = mgr.approveScopeWidening("camp1", a, ["lib/a.js"], "operator");
      mgr.revokeScopeWidening("camp1", decisionId, "operator");

      // Scan EVERY file this run wrote for private-key material.
      const files: string[] = [];
      const walk = (dirPath: string) => {
        for (const entry of readdirSync(dirPath, { withFileTypes: true })) {
          const full = join(dirPath, entry.name);
          if (entry.isDirectory()) walk(full);
          else files.push(full);
        }
      };
      walk(dir);
      expect(files.length).toBeGreaterThan(0);
      for (const file of files) {
        const content = readFileSync(file, "utf8");
        expect(content).not.toMatch(/PRIVATE KEY/);
        expect(content).not.toMatch(/"privateKey"/i);
        expect(content).not.toMatch(/"private_key"/i);
      }

      // The persisted record itself only ever carries the PUBLIC key + signature.
      const decision = mgr.getScopeDecisions("camp1")[0]!;
      expect(decision.decision.public_key).toBeTruthy();
      expect(Object.keys(decision.decision)).not.toContain("private_key");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a process restart starts a NEW generation (fresh key, genesis hop) rather than reusing a lost key", () => {
    const dir = mkdtempSync(join(tmpdir(), "arbor-scope-decision-restart-"));
    try {
      const first = new CampaignManager({ persistence_dir: dir });
      const { a } = chain(first, "camp1");
      const genesisId = first.approveScopeWidening("camp1", a, ["lib/a.js"], "operator");
      const genesisKey = first.getScopeDecisions("camp1").find((r) => r.id === genesisId)!.decision.public_key;

      // Simulate a restart: a fresh CampaignManager, reloading persisted state, holds no private key for camp1.
      const second = new CampaignManager({ persistence_dir: dir });
      const secondId = second.approveScopeWidening("camp1", a, ["lib/b.js"], "operator");
      const secondRecord = second.getScopeDecisions("camp1").find((r) => r.id === secondId)!;

      expect(secondRecord.decision.parent_decision_id).toBeNull(); // fresh genesis, not chained onto the old generation
      expect(secondRecord.decision.public_key).not.toBe(genesisKey); // a fresh, different key

      // Both generations' hops are still independently valid and readable.
      expect(second.getScopeDecisions("camp1")).toHaveLength(2);

      // The old generation's decision cannot be revoked post-restart -- the new process holds no key for it.
      expect(() => second.revokeScopeWidening("camp1", genesisId, "operator")).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("revokeScopeWidening throws for an unknown decision id", () => {
    const mgr = new CampaignManager();
    chain(mgr, "camp1");
    expect(() => mgr.revokeScopeWidening("camp1", "scopedec_nonexistent", "operator")).toThrow(/unknown scope decision/);
  });
});
