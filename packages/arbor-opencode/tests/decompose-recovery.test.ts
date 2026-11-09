import { describe, it, expect } from "vitest";
import { CampaignManager } from "@arbor/mcp";
import { runCampaign, type LoopExecutor, type CampaignLoopConfig, type LoopEvent } from "../src/loop.js";
import { MAX_DECOMPOSITION_DEPTH } from "@arbor/campaign-support";
import type { Action, ScoreContext, CapabilityContext, DecomposerPort, DecompositionRequest, DecompositionResult } from "@arbor/core";

/**
 * G-08 decompose recovery — integration tests against the real
 * `CampaignManager` (not a fake), matching loop.test.ts's own convention for
 * this fault-matrix family of tests. A stub `DecomposerPort` stands in for
 * the LLM half (Lane B): that boundary is exactly what `DecomposerPort`
 * exists to make substitutable in tests.
 */

const epicAction: Action = {
  description: "Bring repo-wide branch coverage to >=85%",
  estimated_gain: 90,
  estimated_cost: 60,
  category: "testing",
  delegate_to: "seed",
};

const ctx: ScoreContext = { accuracy_regression_rate: 0, crash_regression_rate: 0, best_known: 100, total_visits: 5 };
const specialistCap: CapabilityContext = { tier: "specialist" };
const criticCap: CapabilityContext = { tier: "critic" };
const noUsage = { kind: "unavailable" as const, reason: "test fixture" };

function makeConfig(overrides: Partial<CampaignLoopConfig> = {}): CampaignLoopConfig {
  return {
    max_iterations: overrides.max_iterations ?? 3,
    specialist_base_prompt: "specialist",
    critic_base_prompt: "critic",
    specialist_cap: specialistCap,
    critic_cap: criticCap,
    score_ctx: () => ctx,
    use_worktrees: false,
    branch_actions: overrides.branch_actions ?? (() => null),
    decomposer: overrides.decomposer,
  };
}

/** A timeout on the first specialize() call; approves on every subsequent call (used so a decomposed child can be dispatched and verified in the same run). */
function timeoutThenApproveExecutor(): LoopExecutor & { specializeCalls: number } {
  const state = { specializeCalls: 0 };
  return {
    specializeCalls: 0,
    async specialize() {
      state.specializeCalls++;
      this.specializeCalls = state.specializeCalls;
      if (state.specializeCalls === 1) {
        return {
          output: "",
          provenance: { tag: "claimed" as const, claimant: "seed" },
          token_usage: noUsage,
          error: {
            kind: "timeout" as const, provenance: { tag: "claimed" as const, claimant: "opencode-executor" },
            message: "opencode run timed out after 900000ms", elapsed_ms: 900_000, partial_output: null,
            usage: noUsage,
          },
        };
      }
      return { output: "work complete, tests pass", provenance: { tag: "verified" as const, cmd: "npx vitest run", exit: 0, stdout_hash: "sha256:test" }, token_usage: noUsage };
    },
    async review() {
      return { approved: true, rationale: "approved", measurement_validated: true, token_usage: noUsage };
    },
    log() {},
  };
}

function alwaysTimesOutExecutor(): LoopExecutor {
  return {
    async specialize() {
      return {
        output: "",
        provenance: { tag: "claimed" as const, claimant: "seed" },
        token_usage: noUsage,
        error: {
          kind: "timeout" as const, provenance: { tag: "claimed" as const, claimant: "opencode-executor" },
          message: "opencode run timed out after 900000ms", elapsed_ms: 900_000, partial_output: null,
          usage: noUsage,
        },
      };
    },
    async review() {
      throw new Error("critic must not be dispatched on a classified specialist error");
    },
    log() {},
  };
}

/** Stub DecomposerPort — the LLM half stands in for Lane B's real implementation. */
function stubDecomposer(handler: (req: DecompositionRequest) => DecompositionResult): DecomposerPort & { calls: DecompositionRequest[] } {
  const calls: DecompositionRequest[] = [];
  return {
    calls,
    async decompose(request) {
      calls.push(request);
      return handler(request);
    },
  };
}

function twoChildren(): Action[] {
  return [
    { description: "write coverage tests for module A", estimated_gain: 30, estimated_cost: 10, category: "testing", delegate_to: "seed" },
    { description: "write coverage tests for module B", estimated_gain: 30, estimated_cost: 10, category: "testing", delegate_to: "seed" },
  ];
}

function startCampaign(mgr: CampaignManager, id = "camp1"): string {
  mgr.startCampaign(id, "plan.md", { description: "execute plan", estimated_gain: 100, estimated_cost: 1, category: "root", delegate_to: "crown" });
  const [childId] = mgr.branch(id, "root", [epicAction]);
  return childId!;
}

describe("runCampaign — decompose recovery (G-08 timeout -> decompose)", () => {
  it("splits a timed-out node into validated children instead of a terminal failure", async () => {
    const mgr = new CampaignManager();
    const nodeId = startCampaign(mgr);
    const events: LoopEvent[] = [];
    const decomposer = stubDecomposer(() => ({ ok: true, children: twoChildren() }));
    const executor: LoopExecutor = { ...alwaysTimesOutExecutor(), log: (e) => events.push(e) };

    const report = await runCampaign({
      manager: mgr,
      campaign_id: "camp1",
      executor,
      config: makeConfig({ max_iterations: 1, decomposer }),
    });

    expect(decomposer.calls).toHaveLength(1);
    expect(decomposer.calls[0]!.depth).toBe(0);
    expect(decomposer.calls[0]!.reason).toBe("timeout");
    expect(report.decomposed).toBe(1);
    expect(report.failed).toBe(0);

    const node = mgr.getNodeInfo("camp1", nodeId);
    // The timed-out node itself is never recorded as failed/verified — it
    // stays mid-flight, replaced by its children (same as an in-progress
    // "expanding" node the failNode ancestor walk already treats as valid).
    expect(node?.state).toBe("expanding");
    expect(node?.children_ids).toHaveLength(2);

    const decomposedEvent = events.find((e): e is Extract<LoopEvent, { type: "decomposed" }> => e.type === "decomposed");
    expect(decomposedEvent).toBeDefined();
    expect(decomposedEvent?.children).toBe(2);
    expect(decomposedEvent?.depth).toBe(1);
    // Decomposition children are model-proposed: provenance is always
    // generated, never claimed or verified.
    expect(decomposedEvent?.provenance.tag).toBe("generated");

    for (const childId of node!.children_ids) {
      const child = mgr.getNodeInfo("camp1", childId);
      expect(child?.state).toBe("pending");
      expect(child?.action.decomposition_depth).toBe(1);
    }
  });

  it("a decomposed child is itself selectable and can proceed to verification", async () => {
    const mgr = new CampaignManager();
    startCampaign(mgr);
    const decomposer = stubDecomposer(() => ({ ok: true, children: twoChildren() }));
    const executor = timeoutThenApproveExecutor();

    const report = await runCampaign({
      manager: mgr,
      campaign_id: "camp1",
      executor,
      config: makeConfig({ max_iterations: 3, decomposer }),
    });

    expect(report.decomposed).toBe(1);
    expect(report.verified).toBeGreaterThan(0);
  });

  it("without a decomposer configured, a timeout fails exactly as before this recovery path existed", async () => {
    const mgr = new CampaignManager();
    const nodeId = startCampaign(mgr);
    const events: LoopEvent[] = [];
    const executor: LoopExecutor = { ...alwaysTimesOutExecutor(), log: (e) => events.push(e) };

    const report = await runCampaign({
      manager: mgr,
      campaign_id: "camp1",
      executor,
      config: makeConfig({ max_iterations: 1 }), // no decomposer
    });

    expect(report.failed).toBe(1);
    expect(report.decomposed).toBe(0);
    expect(mgr.getNodeInfo("camp1", nodeId)?.state).toBe("failed");
    const failedEvent = events.find((e): e is Extract<LoopEvent, { type: "node_failed" }> => e.type === "node_failed");
    // U3: root_cause now carries the observed message alongside the kind,
    // not just the bare "timeout" literal.
    expect(failedEvent?.root_cause).toBe("timeout: opencode run timed out after 900000ms");
  });

  it("rejects an invalid decomposition (fanout below bound) and falls back to a typed failure carrying the reason", async () => {
    const mgr = new CampaignManager();
    const nodeId = startCampaign(mgr);
    const events: LoopEvent[] = [];
    const decomposer = stubDecomposer(() => ({
      ok: true,
      children: [{ description: "only one child", estimated_gain: 10, estimated_cost: 5, category: "testing", delegate_to: "seed" }],
    }));
    const executor: LoopExecutor = { ...alwaysTimesOutExecutor(), log: (e) => events.push(e) };

    const report = await runCampaign({
      manager: mgr,
      campaign_id: "camp1",
      executor,
      config: makeConfig({ max_iterations: 1, decomposer }),
    });

    expect(report.decomposed).toBe(0);
    expect(report.failed).toBe(1);
    expect(mgr.getNodeInfo("camp1", nodeId)?.state).toBe("failed");
    expect(mgr.getNodeInfo("camp1", nodeId)?.children_ids).toHaveLength(0);
    const failedEvent = events.find((e): e is Extract<LoopEvent, { type: "node_failed" }> => e.type === "node_failed");
    // The node fails "as it does today" (root_cause keeps the NodeErrorKind
    // prefix); the decompose-specific reason is folded into the recorded
    // message, not silently dropped — and (U3) root_cause carries that full
    // message too, not just the bare kind.
    expect(failedEvent?.root_cause).toBe(
      "timeout: opencode run timed out after 900000ms (decomposition rejected: invalid decomposition: fanout 1 outside bound [2, 6])",
    );
  });

  it("rejects when the decomposer itself declines (ok: false)", async () => {
    const mgr = new CampaignManager();
    startCampaign(mgr);
    const decomposer = stubDecomposer(() => ({ ok: false, reason: "no obvious sub-decomposition" }));
    const executor = alwaysTimesOutExecutor();

    const report = await runCampaign({
      manager: mgr,
      campaign_id: "camp1",
      executor,
      config: makeConfig({ max_iterations: 1, decomposer }),
    });

    expect(report.decomposed).toBe(0);
    expect(report.failed).toBe(1);
  });

  it("G-08 bounded operational retry: a decomposer decline ('may already be atomic') gets exactly ONE bounded re-dispatch before terminal failure — never more", async () => {
    // Reproduces the real production dead end: a specialist exhausts the
    // 900s timeout ceiling; FAULT_MATRIX routes timeout -> decompose; the
    // decomposer declines because the action "may already be atomic". Both
    // facts cannot be true at once, so the node gets one bounded retry of
    // its own persisted retry-context capsule instead of dying on the
    // contradiction with no floor.
    const mgr = new CampaignManager();
    const nodeId = startCampaign(mgr);
    const events: LoopEvent[] = [];
    const decomposer = stubDecomposer(() => ({
      ok: false,
      reason: "decomposer returned zero children — action may already be atomic, or the model declined to decompose it",
    }));
    const executor: LoopExecutor = { ...alwaysTimesOutExecutor(), log: (e) => events.push(e) };

    // Two iterations: the bounded retry consumes the first, the second
    // proves the cap actually holds (no infinite loop).
    const report = await runCampaign({
      manager: mgr,
      campaign_id: "camp1",
      executor,
      config: makeConfig({ max_iterations: 2, decomposer }),
    });

    expect(decomposer.calls).toHaveLength(2);
    // Both attempts recorded a real, evidence-backed failure (matching the
    // existing critic-retry precedent of counting every attempt) — retry
    // does not erase or skip the durable failure evidence.
    expect(report.failed).toBe(2);
    expect(report.operational_retried).toBe(1);
    expect(report.decomposed).toBe(0);
    // Bounded: exhausted after one retry, the node stays terminally failed —
    // it is not revived a second time.
    expect(mgr.getNodeInfo("camp1", nodeId)?.state).toBe("failed");

    const retryEvent = events.find((e): e is Extract<LoopEvent, { type: "operational_retry" }> => e.type === "operational_retry");
    expect(retryEvent).toMatchObject({ node_id: nodeId, attempt: 1, max_retries: 1, kind: "timeout" });
    expect(events.filter((e) => e.type === "operational_retry")).toHaveLength(1);
  });

  it("G-08 bounded operational retry does not apply to an invalid decomposition (fanout below bound) — only a decomposer decline is a contradiction worth retrying", async () => {
    const mgr = new CampaignManager();
    const nodeId = startCampaign(mgr);
    const decomposer = stubDecomposer(() => ({
      ok: true,
      children: [{ description: "only one child", estimated_gain: 10, estimated_cost: 5, category: "testing", delegate_to: "seed" }],
    }));
    const executor = alwaysTimesOutExecutor();

    const report = await runCampaign({
      manager: mgr,
      campaign_id: "camp1",
      executor,
      config: makeConfig({ max_iterations: 2, decomposer }),
    });

    // A validation rejection (fanout out of bound) is a different failure
    // shape than "decomposer declined as atomic" — it never routes through
    // the bounded operational retry.
    expect(report.operational_retried).toBe(0);
    expect(report.failed).toBe(1);
    expect(mgr.getNodeInfo("camp1", nodeId)?.state).toBe("failed");
  });

  it("never calls the decomposer once the depth bound is already reached — termination without an LLM round-trip", async () => {
    const mgr = new CampaignManager();
    mgr.startCampaign("camp1", "plan.md", { description: "execute plan", estimated_gain: 100, estimated_cost: 1, category: "root", delegate_to: "crown" });
    const exhaustedAction: Action = { ...epicAction, decomposition_depth: MAX_DECOMPOSITION_DEPTH };
    const [nodeId] = mgr.branch("camp1", "root", [exhaustedAction]);
    const decomposer = stubDecomposer(() => ({ ok: true, children: twoChildren() }));
    const executor = alwaysTimesOutExecutor();

    const report = await runCampaign({
      manager: mgr,
      campaign_id: "camp1",
      executor,
      config: makeConfig({ max_iterations: 1, decomposer }),
    });

    expect(decomposer.calls).toHaveLength(0);
    expect(report.decomposed).toBe(0);
    expect(report.failed).toBe(1);
    expect(mgr.getNodeInfo("camp1", nodeId!)?.state).toBe("failed");
  });

  it("idempotency: a node that already has children cannot be decomposed again", async () => {
    const mgr = new CampaignManager();
    const nodeId = startCampaign(mgr);
    // Simulate "already decomposed once" directly at the tree level — the
    // only way children_ids is non-empty on a node the loop is about to
    // dispatch for the first time in THIS run (e.g. resumed after an
    // operator-authorized retry moved a previously-decomposed "expanding"
    // node back to "pending").
    mgr.branch("camp1", nodeId, twoChildren());
    const decomposer = stubDecomposer(() => ({ ok: true, children: twoChildren() }));
    const executor = alwaysTimesOutExecutor();

    const report = await runCampaign({
      manager: mgr,
      campaign_id: "camp1",
      executor,
      config: makeConfig({ max_iterations: 1, decomposer }),
    });

    expect(decomposer.calls).toHaveLength(0);
    expect(report.decomposed).toBe(0);
    expect(report.failed).toBe(1);
    // The pre-existing children are untouched — no fabricated second branch.
    expect(mgr.getNodeInfo("camp1", nodeId)?.children_ids).toHaveLength(2);
  });

  it("a repeated decompose chain is bounded to MAX_DECOMPOSITION_DEPTH consecutive hops", async () => {
    const mgr = new CampaignManager();
    mgr.startCampaign("camp1", "plan.md", { description: "execute plan", estimated_gain: 100, estimated_cost: 1, category: "root", delegate_to: "crown" });
    const [nodeId] = mgr.branch("camp1", "root", [epicAction]);
    // Every decomposition proposes 2 children that are themselves still
    // "epic"-shaped (same shape as the parent minus the description), so
    // every one of them times out too — the worst-case chain.
    let decomposeCalls = 0;
    const decomposer = stubDecomposer((req) => {
      decomposeCalls++;
      return {
        ok: true,
        children: [
          { description: `sub-epic A at depth ${req.depth}`, estimated_gain: 40, estimated_cost: 20, category: "testing", delegate_to: "seed" },
          { description: `sub-epic B at depth ${req.depth}`, estimated_gain: 40, estimated_cost: 20, category: "testing", delegate_to: "seed" },
        ],
      };
    });
    const executor = alwaysTimesOutExecutor();

    const report = await runCampaign({
      manager: mgr,
      campaign_id: "camp1",
      executor,
      // Generous iteration budget: every dispatched node times out, so the
      // run either decomposes (bounded by depth) or fails every node it
      // touches. If depth weren't bounded this would run away.
      config: makeConfig({ max_iterations: 40, decomposer }),
    });

    // Exactly MAX_DECOMPOSITION_DEPTH consecutive decompose hops are possible
    // along the seeded node's lineage before the bound blocks further calls.
    expect(decomposeCalls).toBeLessThanOrEqual(1 + 2 + 4); // depth0, then 2 depth1 nodes, then 4 depth2 nodes
    expect(report.halted).toBe(true);
    // Root node itself untouched by the fault (sanity: campaign actually ran).
    expect(mgr.getNodeInfo("camp1", nodeId!)).not.toBeNull();
  });
});
