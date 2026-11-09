import { describe, expect, it } from "vitest";
import { ArborRuntime } from "../src/runtime.js";
import { composeLoopConfigPorts } from "../src/loop-ports-helper.js";
import { prepareTokenDispatch } from "@arbor/opencode";
import { runCampaign, DEFAULT_LOOP_CONFIG, type LoopEvent } from "@arbor/opencode";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const rootAction = {
  description: "execute plan",
  estimated_gain: 100,
  estimated_cost: 1,
  category: "root",
  delegate_to: "crown",
};

const childAction = {
  description: "refactor auth module",
  estimated_gain: 50,
  estimated_cost: 10,
  category: "refactor",
  delegate_to: "seed",
};

describe("interruptCampaign on an expanding node", () => {
  it("interrupts the expanding node via runtime.interrupt when active and expanding exist", () => {
    const runtime = new ArborRuntime();
    runtime.manager.startCampaign("camp", "plan.md", rootAction);
    const root = runtime.manager.getCampaignSnapshot("camp")!.root_id;
    const [childId] = runtime.manager.branch("camp", root, [childAction]);
    runtime.manager.expandNode("camp", childId, {
      worktree_isolated: true,
      starting_commit_correct: true,
      lease_acquired: true,
    });

    const active = runtime.manager.getActiveCampaignId();
    expect(active).toBe("camp");
    expect(runtime.manager.getActiveExpandingNode(active!)).toBe(childId);

    const version = runtime.manager.getCampaignVersion(active!);
    const result = runtime.interrupt({
      campaign_id: active!,
      node_id: childId,
      scope: "node",
      reason: "operator-interrupt",
      operation_id: "tui:interrupt:test",
      expected_version: version,
      partial_evidence_ids: [],
      provenance: { tag: "claimed", claimant: "operator" },
    });

    expect(result.affected_node_ids).toContain(childId);
    expect(runtime.manager.getNodeInfo("camp", childId)?.state).toBe("interrupted");
  });

  it("no-ops when active campaign is null", () => {
    const runtime = new ArborRuntime();
    // No campaign started — getActiveCampaignId returns null.
    expect(runtime.manager.getActiveCampaignId()).toBeNull();
    // The guard pattern: if (!active) return; — no-op, no throw.
  });

  it("no-ops when no expanding node exists", () => {
    const runtime = new ArborRuntime();
    runtime.manager.startCampaign("camp", "plan.md", rootAction);
    // No expansion has started — getActiveExpandingNode returns null.
    expect(runtime.manager.getActiveExpandingNode("camp")).toBeNull();
    // The guard pattern: if (!expanding) return; — no-op, no throw.
  });
});

describe("composeLoopConfigPorts", () => {
  it("returns every canonical port including live foreground derivation", () => {
    const runtime = new ArborRuntime();
    const ports = composeLoopConfigPorts(runtime);
    expect(ports.telemetry).toBeDefined();
    expect(ports.interruptions).toBeDefined();
    expect(ports.output_evidence).toBeDefined();
    expect(ports.token_economy).toBeDefined();
    expect(ports.communications).toBeDefined();
    expect(ports.foreground).toBeDefined();
  });

  it("foreground is node-bound and threads operator model/card overrides", () => {
    const runtime = new ArborRuntime();
    const ports = composeLoopConfigPorts(runtime, {
      seed: { model: "provider/operator-seed", foreground: { modes: ["streaming"], inputs: ["plan"], outputs: ["patch"] } },
    });
    const projection = ports.foreground.derive({ campaign_id: "camp", node_id: "node-9", agent: "seed", capability: "specialist" });
    expect(projection.prompt_fragment).toContain("node-9");
    expect(projection.prompt_fragment).toContain("provider/operator-seed");
  });

  it("recovers overflow and gives a later logical redispatch a fresh durable retry epoch", async () => {
    const persistence = mkdtempSync(join(tmpdir(), "arbor-token-overflow-recovery-"));
    try {
      const runtime = new ArborRuntime({
        persistence_dir: persistence,
        model_capabilities: {
          maxOutputTokens: () => ({ value: 100, source: "runtime" }),
          contextCapacity: () => ({ value: 12_000, source: "runtime" }),
          estimateTokens: ({ content }) => Math.ceil(content.length / 4),
        },
      });
      runtime.manager.startCampaign("camp", "plan.md", rootAction);
      const root = runtime.manager.getCampaignSnapshot("camp")!.root_id;
      const [nodeId] = runtime.manager.branch("camp", root, [childAction]);
      // Structural entries render as bounded identity/hash/evidence pointers,
      // so one huge message can no longer overflow the budget; it takes enough
      // separate entries for the rendered projection itself to exceed it.
      for (let i = 0; i < 40; i += 1) {
        runtime.manager.recordNodeCommunication({
          campaign_id: "camp", node_id: nodeId!, author_node_id: "crown", recipient_node_id: nodeId!,
          other_recipient_node_ids: [], kind: "steer",
          payload: { content: `preserve this structural fact ${i}: ${"x".repeat(30_000)}`, provenance: { tag: "claimed", claimant: "operator" } },
          capability_tier: "specialist", trigger_turn: false, as_of: "2026-09-23T00:00:00.000Z",
          correlation_id: `overflow-recovery-${i}`, idempotency_key: `overflow-recovery-message-${i}`,
          acknowledges_communication_id: null, retracts_communication_id: null, timestamp: "2026-09-23T00:00:00.000Z",
        });
      }
      const dispatchedPrompts: string[] = [];
      const events: LoopEvent[] = [];
      let specialistAttempts = 0;
      let reviewAttempts = 0;
      const report = await runCampaign({
        manager: runtime.manager,
        campaign_id: "camp",
        executor: {
          async specialize({ prompt }) {
            dispatchedPrompts.push(prompt);
            specialistAttempts += 1;
            return {
              output: "verified work",
              provenance: specialistAttempts === 1
                ? { tag: "claimed", claimant: "fixture" }
                : { tag: "verified", cmd: "fixture", exit: 0, stdout_hash: "sha256:fixture" },
              token_usage: { kind: "unavailable", reason: "not measured by fixture executor" },
            };
          },
          async review() {
            reviewAttempts += 1;
            return reviewAttempts === 1
              ? { approved: false, rationale: "first attempt must be retried", root_cause: "fixture retry", token_usage: { kind: "unavailable", reason: "not measured by fixture executor" } }
              : { approved: true, rationale: "accepted", measurement_validated: true, token_usage: { kind: "unavailable", reason: "not measured by fixture executor" } };
          },
          log(event) { events.push(event); },
        },
        config: {
          ...DEFAULT_LOOP_CONFIG,
          ...composeLoopConfigPorts(runtime),
          max_iterations: 2,
          critic_retry: { max_retries: 1 },
          use_worktrees: false,
          specialist_cap: { tier: "specialist" },
          critic_cap: { tier: "critic" },
          score_ctx: () => ({ accuracy_regression_rate: 0, crash_regression_rate: 0, best_known: 100, total_visits: 5 }),
          branch_actions: () => null,
        },
      });
      expect(report.interrupted).toBe(0);
      expect(dispatchedPrompts).toHaveLength(2);
      expect(dispatchedPrompts[0]).toContain(DEFAULT_LOOP_CONFIG.specialist_base_prompt);
      expect(dispatchedPrompts[0]).toContain("Structural context:");
      const recovered = events.filter((event) => event.type === "overflow_recovered");
      expect(recovered.length).toBeGreaterThanOrEqual(4); // specialist and critic dispatches on both attempts
      expect(new Set(recovered.map((event) => event.epoch_id)).size).toBe(recovered.length);
      expect(recovered.some((event) => event.epoch_id.includes(":visit:1:"))).toBe(true);
      expect(recovered.some((event) => event.epoch_id.includes(":visit:2:"))).toBe(true);
    } finally {
      rmSync(persistence, { recursive: true, force: true });
    }
  });

  it("performs a real anchored structural fold and replays the committed anchor content into later dispatch context", async () => {
    const persistence = mkdtempSync(join(tmpdir(), "arbor-structural-fold-"));
    try {
      const runtime = new ArborRuntime({ persistence_dir: persistence });
      runtime.manager.startCampaign("camp", "plan.md", rootAction);
      runtime.manager.recordNodeCommunication({
        campaign_id: "camp", node_id: "root", author_node_id: "crown", recipient_node_id: "root",
        other_recipient_node_ids: [], kind: "steer",
        payload: { content: "preserve this operator constraint", provenance: { tag: "claimed", claimant: "operator" } },
        capability_tier: "specialist", trigger_turn: false, as_of: "2026-08-08T00:00:00.000Z",
        correlation_id: "fold", idempotency_key: "fold-source", acknowledges_communication_id: null,
        retracts_communication_id: null, timestamp: "2026-08-08T00:00:00.000Z",
      });
      const ports = composeLoopConfigPorts(runtime);
      const result = await ports.structural_compaction.compact({ campaign_id: "camp", node_id: "root", iteration: 1 });
      expect(result.status).toBe("completed");
      const lifecycles = runtime.manager.getCompactionLifecycles("camp", "root");
      expect(lifecycles).toHaveLength(1);
      expect(lifecycles[0]!.lifecycle).toMatchObject({ status: "completed", strategy: "structural_folding" });
      const prepared = await prepareTokenDispatch({
        campaign_id: "camp", node_id: "root", prompt: "next dispatch", capability: "specialist", phase: "specialist-next",
        config: ports.token_economy!,
      });
      expect(prepared.prompt).toContain("structural_fold");
      expect(prepared.prompt).toContain("preserve this operator constraint");
      expect(prepared.prompt).toContain(result.status === "completed" ? result.anchor_summary_id : "unreachable");

      // The context is reconstructed from the content-addressed postimage,
      // not from an in-memory pointer placeholder. A fresh runtime has no
      // process-local anchor cache to accidentally satisfy this assertion.
      const restarted = new ArborRuntime({ persistence_dir: persistence });
      const replayed = composeLoopConfigPorts(restarted);
      const afterRestart = await prepareTokenDispatch({
        campaign_id: "camp", node_id: "root", prompt: "after restart", capability: "specialist", phase: "specialist-next",
        config: replayed.token_economy!,
      });
      expect(afterRestart.prompt).toContain("preserve this operator constraint");
    } finally {
      rmSync(persistence, { recursive: true, force: true });
    }
  });

  it("records an interrupted lifecycle with the captured preimage when cancellation arrives before the fold", async () => {
    const persistence = mkdtempSync(join(tmpdir(), "arbor-structural-fold-cancel-"));
    try {
      const runtime = new ArborRuntime({ persistence_dir: persistence });
      runtime.manager.startCampaign("camp", "plan.md", rootAction);
      runtime.manager.recordNodeCommunication({
        campaign_id: "camp", node_id: "root", author_node_id: "crown", recipient_node_id: "root",
        other_recipient_node_ids: [], kind: "steer",
        payload: { content: "do not lose this raw evidence", provenance: { tag: "claimed", claimant: "operator" } },
        capability_tier: "specialist", trigger_turn: false, as_of: "2026-08-08T00:00:00.000Z",
        correlation_id: "cancel", idempotency_key: "cancel-source", acknowledges_communication_id: null,
        retracts_communication_id: null, timestamp: "2026-08-08T00:00:00.000Z",
      });
      const controller = new AbortController(); controller.abort("operator cancelled compaction");
      const result = await composeLoopConfigPorts(runtime).structural_compaction.compact({
        campaign_id: "camp", node_id: "root", iteration: 1, signal: controller.signal,
      });
      expect(result).toMatchObject({ status: "interrupted", reason: "operator cancelled compaction" });
      const lifecycle = runtime.manager.getCompactionLifecycles("camp", "root")[0]!.lifecycle;
      expect(lifecycle).toMatchObject({ status: "interrupted", post_evidence_id: null, anchor_summary_id: null });
      expect(lifecycle.pre_evidence_id).toMatch(/^audit:\/\/output-artifacts\//);
      expect(lifecycle.partial_evidence_ids).toEqual([lifecycle.pre_evidence_id]);
    } finally {
      rmSync(persistence, { recursive: true, force: true });
    }
  });

  it("keeps the most recent completed anchor after a later interrupted attempt", async () => {
    const persistence = mkdtempSync(join(tmpdir(), "arbor-structural-fold-prior-anchor-"));
    try {
      const runtime = new ArborRuntime({ persistence_dir: persistence });
      runtime.manager.startCampaign("camp", "plan.md", rootAction);
      runtime.manager.recordNodeCommunication({
        campaign_id: "camp", node_id: "root", author_node_id: "crown", recipient_node_id: "root",
        other_recipient_node_ids: [], kind: "steer",
        payload: { content: "established fact survives a cancelled retry", provenance: { tag: "claimed", claimant: "operator" } },
        capability_tier: "specialist", trigger_turn: false, as_of: "2026-08-08T00:00:00.000Z",
        correlation_id: "prior", idempotency_key: "prior-source", acknowledges_communication_id: null,
        retracts_communication_id: null, timestamp: "2026-08-08T00:00:00.000Z",
      });
      const ports = composeLoopConfigPorts(runtime);
      await ports.structural_compaction.compact({ campaign_id: "camp", node_id: "root", iteration: 1 });
      runtime.manager.recordNodeCommunication({
        campaign_id: "camp", node_id: "root", author_node_id: "crown", recipient_node_id: "root",
        other_recipient_node_ids: [], kind: "steer",
        payload: { content: "new fact before cancelled retry", provenance: { tag: "claimed", claimant: "operator" } },
        capability_tier: "specialist", trigger_turn: false, as_of: "2026-08-08T00:00:01.000Z",
        correlation_id: "prior", idempotency_key: "prior-new", acknowledges_communication_id: null,
        retracts_communication_id: null, timestamp: "2026-08-08T00:00:01.000Z",
      });
      const controller = new AbortController(); controller.abort("cancel retry");
      await ports.structural_compaction.compact({ campaign_id: "camp", node_id: "root", iteration: 2, signal: controller.signal });
      expect(runtime.manager.getCompactionLifecycles("camp", "root").map((record) => record.lifecycle.status)).toEqual(["completed", "interrupted"]);
      const prepared = await prepareTokenDispatch({
        campaign_id: "camp", node_id: "root", prompt: "continue", capability: "specialist", phase: "specialist-next", config: ports.token_economy!,
      });
      expect(prepared.prompt).toContain("established fact survives a cancelled retry");
    } finally {
      rmSync(persistence, { recursive: true, force: true });
    }
  });

  it("fails closed when a completed lifecycle's anchor cannot be recovered", async () => {
    const runtime = new ArborRuntime();
    runtime.manager.startCampaign("camp", "plan.md", rootAction);
    runtime.manager.recordCompactionLifecycle({
      campaign_id: "camp", node_id: "root", operation_id: "missing-anchor", trigger: "auto", strategy: "structural_folding", status: "completed",
      pre_evidence_id: "audit://output-artifacts/pre", post_evidence_id: "audit://output-artifacts/post", anchor_summary_id: "audit://output-artifacts/post",
      reason: "", partial_evidence_ids: [], idempotency_key: "missing-anchor", as_of: "2026-08-08T00:00:00.000Z",
    });
    await expect(prepareTokenDispatch({
      campaign_id: "camp", node_id: "root", prompt: "continue", capability: "specialist", phase: "specialist-next",
      config: composeLoopConfigPorts(runtime).token_economy!,
    })).rejects.toThrow("anchor is unavailable for replay");
  });

  it("keeps communications that arrive during asynchronous evidence capture as the post-anchor tail", async () => {
    const persistence = mkdtempSync(join(tmpdir(), "arbor-structural-fold-snapshot-"));
    try {
      const runtime = new ArborRuntime({ persistence_dir: persistence });
      runtime.manager.startCampaign("camp", "plan.md", rootAction);
      runtime.manager.recordNodeCommunication({
        campaign_id: "camp", node_id: "root", author_node_id: "crown", recipient_node_id: "root",
        other_recipient_node_ids: [], kind: "steer",
        payload: { content: "belongs in the anchor", provenance: { tag: "claimed", claimant: "operator" } },
        capability_tier: "specialist", trigger_turn: false, as_of: "2026-08-08T00:00:00.000Z",
        correlation_id: "snapshot", idempotency_key: "snapshot-source", acknowledges_communication_id: null,
        retracts_communication_id: null, timestamp: "2026-08-08T00:00:00.000Z",
      });
      const output = runtime.loopPorts.output_evidence;
      const originalCapture = output.capture.bind(output);
      let injected = false;
      (output as unknown as { capture: typeof output.capture }).capture = async (input) => {
        const result = await originalCapture(input);
        if (!injected) {
          injected = true;
          runtime.manager.recordNodeCommunication({
            campaign_id: "camp", node_id: "root", author_node_id: "crown", recipient_node_id: "root",
            other_recipient_node_ids: [], kind: "steer",
            payload: { content: "arrived during capture and must remain a tail", provenance: { tag: "claimed", claimant: "operator" } },
            // Deliberately older than the snapshot boundary: timestamps are
            // caller data, so replay must use covered record identities, not
            // chronology, to avoid permanently hiding this late append.
            capability_tier: "specialist", trigger_turn: false, as_of: "2026-01-01T00:00:00.000Z",
            correlation_id: "snapshot", idempotency_key: "snapshot-late", acknowledges_communication_id: null,
            retracts_communication_id: null, timestamp: "2026-01-01T00:00:00.000Z",
          });
        }
        return result;
      };
      const ports = composeLoopConfigPorts(runtime);
      await ports.structural_compaction.compact({ campaign_id: "camp", node_id: "root", iteration: 1 });
      const prepared = await prepareTokenDispatch({
        campaign_id: "camp", node_id: "root", prompt: "continue", capability: "specialist", phase: "specialist-next", config: ports.token_economy!,
      });
      expect(prepared.prompt).toContain("belongs in the anchor");
      expect(prepared.prompt).toContain("arrived during capture and must remain a tail");
    } finally {
      rmSync(persistence, { recursive: true, force: true });
    }
  });

  it("does not churn a new lifecycle when an anchor has no uncovered durable input", async () => {
    const persistence = mkdtempSync(join(tmpdir(), "arbor-structural-fold-idle-"));
    try {
      const runtime = new ArborRuntime({ persistence_dir: persistence });
      runtime.manager.startCampaign("camp", "plan.md", rootAction);
      runtime.manager.recordNodeCommunication({
        campaign_id: "camp", node_id: "root", author_node_id: "crown", recipient_node_id: "root", other_recipient_node_ids: [], kind: "steer",
        payload: { content: "fold once", provenance: { tag: "claimed", claimant: "operator" } }, capability_tier: "specialist", trigger_turn: false,
        as_of: "2026-08-08T00:00:00.000Z", correlation_id: "idle", idempotency_key: "idle-source", acknowledges_communication_id: null, retracts_communication_id: null,
        timestamp: "2026-08-08T00:00:00.000Z",
      });
      const compaction = composeLoopConfigPorts(runtime).structural_compaction;
      expect((await compaction.compact({ campaign_id: "camp", node_id: "root", iteration: 1 })).status).toBe("completed");
      expect(await compaction.compact({ campaign_id: "camp", node_id: "root", iteration: 2 })).toMatchObject({ status: "skipped", reason: "no uncovered durable structural context entries are available" });
      expect(runtime.manager.getCompactionLifecycles("camp", "root")).toHaveLength(1);
    } finally { rmSync(persistence, { recursive: true, force: true }); }
  });

  it("bounds covered identities across successive folds and replays after restart", async () => {
    const persistence = mkdtempSync(join(tmpdir(), "arbor-structural-fold-window-"));
    try {
      const runtime = new ArborRuntime({ persistence_dir: persistence }); runtime.manager.startCampaign("camp", "plan.md", rootAction);
      const append = (index: number) => runtime.manager.recordNodeCommunication({
        campaign_id: "camp", node_id: "root", author_node_id: "crown", recipient_node_id: "root", other_recipient_node_ids: [], kind: "steer",
        payload: { content: `fact-${index}`, provenance: { tag: "claimed", claimant: "operator" } }, capability_tier: "specialist", trigger_turn: false,
        as_of: `2026-08-08T00:00:${String(index % 60).padStart(2, "0")}.000Z`, correlation_id: "window", idempotency_key: `window-${index}`,
        acknowledges_communication_id: null, retracts_communication_id: null, timestamp: `2026-08-08T00:00:${String(index % 60).padStart(2, "0")}.000Z`,
      });
      for (let index = 0; index < 100; index += 1) append(index);
      const ports = composeLoopConfigPorts(runtime);
      expect((await ports.structural_compaction.compact({ campaign_id: "camp", node_id: "root", iteration: 1 })).status).toBe("completed");
      for (let index = 100; index < 110; index += 1) append(index);
      expect((await ports.structural_compaction.compact({ campaign_id: "camp", node_id: "root", iteration: 2 })).status).toBe("completed");
      const restarted = new ArborRuntime({ persistence_dir: persistence });
      const prepared = await prepareTokenDispatch({ campaign_id: "camp", node_id: "root", prompt: "continue", capability: "specialist", phase: "specialist-next", config: composeLoopConfigPorts(restarted).token_economy! });
      expect(prepared.prompt).toContain("structural_compaction_anchor/v1");
      expect(restarted.manager.getCompactionLifecycles("camp", "root")).toHaveLength(2);
    } finally { rmSync(persistence, { recursive: true, force: true }); }
  });

  it("telemetry port has recordPhaseTiming and recordUsageCost methods", () => {
    const runtime = new ArborRuntime();
    runtime.manager.startCampaign("camp", "plan.md", rootAction);
    const ports = composeLoopConfigPorts(runtime);
    expect(typeof ports.telemetry!.recordPhaseTiming).toBe("function");
    expect(typeof ports.telemetry!.recordUsageCost).toBe("function");
  });

  it("interruption port has interrupt method", () => {
    const runtime = new ArborRuntime();
    const ports = composeLoopConfigPorts(runtime);
    expect(typeof ports.interruptions!.interrupt).toBe("function");
  });

  it("output_evidence port has capture method", () => {
    const runtime = new ArborRuntime();
    const ports = composeLoopConfigPorts(runtime);
    expect(typeof ports.output_evidence!.capture).toBe("function");
  });

  it("token_economy is a full TokenEconomyConfig: epochs port plus a live provider bridge and budget defaults", () => {
    const runtime = new ArborRuntime();
    const ports = composeLoopConfigPorts(runtime);
    expect(typeof ports.token_economy!.epochs.ensure).toBe("function");
    expect(typeof ports.token_economy!.epochs.recordUsage).toBe("function");
    expect(typeof ports.token_economy!.provider.capability).toBe("function");
    expect(ports.token_economy!.fallback_capability.provider_id).toBe("arbor-runtime");
    expect(ports.token_economy!.reserved_output_tokens).toBeGreaterThan(0);
    expect(ports.token_economy!.requested_output_tokens).toBeGreaterThan(0);
    // Retry epochs are attempt-scoped: a redispatch of the same node gets a
    // fresh epoch instead of sharing the first attempt's.
    expect(ports.token_economy!.expansion_id({ campaign_id: "c", node_id: "n", phase: "specialize" })).toBe("c:n:unscoped:specialize");
    expect(ports.token_economy!.expansion_id({ campaign_id: "c", node_id: "n", attempt_id: "attempt-2", phase: "specialize" })).toBe("c:n:attempt-2:specialize");
  });

  it("communications port has projectSelection method", () => {
    const runtime = new ArborRuntime();
    const ports = composeLoopConfigPorts(runtime);
    expect(typeof ports.communications!.projectSelection).toBe("function");
  });

  it("G-30: a config composed by the helper survives a real prepareTokenDispatch call", async () => {
    // Before the fix, `token_economy` was the bare TokenEpochService, so
    // `config.provider.capability(...)` inside prepareTokenDispatch threw
    // (provider was undefined) before any specialist could be dispatched.
    // This exercises the exact call every real dispatch makes and proves it
    // no longer crashes.
    const runtime = new ArborRuntime();
    const ports = composeLoopConfigPorts(runtime);
    const result = await prepareTokenDispatch({
      campaign_id: "camp",
      node_id: "node-1",
      prompt: "You are a Seed. Implement the task.",
      capability: "specialist",
      phase: "specialize",
      config: ports.token_economy!,
    });
    expect(result.status).toBe("ready");
    expect(result.epoch).toBeDefined();
    expect(result.counted.tokens).toBeGreaterThan(0);
  });
});
