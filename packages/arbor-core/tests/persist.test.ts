import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { combineReward, createCampaign, createChild, abandonInterruptedNode, backpropagate, saveCampaign, loadCampaignResult, listCampaigns } from "../src/index.js";
import { writeBoulder, readBoulderResult, HALT_REASONS, type BoulderState } from "../src/index.js";

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "arbor-test-"));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe("saveCampaign + loadCampaign", () => {
  it("round-trips a campaign with root + 2 children", () => {
    const campaign = createCampaign("camp1", "plan.md", {
      description: "root",
      estimated_gain: 100,
      estimated_cost: 1,
      category: "root",
      delegate_to: "crown",
    });
    createChild(campaign.tree, "root", {
      description: "child A",
      estimated_gain: 50,
      estimated_cost: 10,
      category: "refactor",
      delegate_to: "seed",
    });
    createChild(campaign.tree, "root", {
      description: "child B",
      estimated_gain: 30,
      estimated_cost: 5,
      category: "testing",
      delegate_to: "seed",
    });

    saveCampaign(campaign, tempDir);
    const loaded = loadCampaignResult("camp1", tempDir).value;

    expect(loaded).not.toBeNull();
    expect(loaded!.id).toBe("camp1");
    expect(loaded!.tree.size).toBe(3);
    expect(loaded!.root_id).toBe("root");

    const root = loaded!.tree.get("root")!;
    expect(root.children_ids).toHaveLength(2);
  });

  it("round-trips a closed execution-role request without turning it into authority", () => {
    const campaign = createCampaign("camp-role", "plan.md", {
      description: "document the public API", estimated_gain: 2, estimated_cost: 1,
      category: "documentation", delegate_to: "seed", execution_role: "documentation-writer",
    });
    saveCampaign(campaign, tempDir);
    expect(loadCampaignResult("camp-role", tempDir).value!.tree.get("root")!.action).toMatchObject({
      delegate_to: "seed", execution_role: "documentation-writer",
    });
  });

  it("round-trips an exact immutable skill selection", () => {
    const campaign = createCampaign("skill-roundtrip", "plan.md", { description: "write an ADR", estimated_gain: 1, estimated_cost: 1, category: "documentation", delegate_to: "seed", skill_id: "write-adr", skill_version: "1.2.0" });
    saveCampaign(campaign, tempDir); const restored = loadCampaignResult("skill-roundtrip", tempDir).value!;
    expect(restored.tree.get(restored.root_id)?.action).toMatchObject({ skill_id: "write-adr", skill_version: "1.2.0" });
  });

  it("quarantines a persisted action with an unrecognized execution role", () => {
    const campaign = createCampaign("camp-bad-role", "plan.md", {
      description: "root", estimated_gain: 1, estimated_cost: 1, category: "root", delegate_to: "seed",
    });
    saveCampaign(campaign, tempDir);
    const path = join(tempDir, "tree", "camp-bad-role.json");
    const snapshot = JSON.parse(readFileSync(path, "utf-8"));
    snapshot.nodes[0].action.execution_role = "unbounded";
    writeFileSync(path, JSON.stringify(snapshot));
    expect(loadCampaignResult("camp-bad-role", tempDir).value).toBeNull();
  });

  it("quarantines a persisted action scope containing traversal or executable injection", () => {
    const campaign = createCampaign("camp-bad-scope", "plan.md", {
      description: "root", estimated_gain: 1, estimated_cost: 1, category: "root", delegate_to: "seed",
      high_risk_tool_scope: { write_paths: ["docs/guide.md"], command_argv: [] },
    });
    saveCampaign(campaign, tempDir);
    const path = join(tempDir, "tree", "camp-bad-scope.json");
    const snapshot = JSON.parse(readFileSync(path, "utf-8"));
    snapshot.nodes[0].action.high_risk_tool_scope.write_paths = ["docs/../escape.md"];
    expect(() => writeFileSync(path, JSON.stringify(snapshot))).not.toThrow();
    expect(loadCampaignResult("camp-bad-scope", tempDir).value).toBeNull();
  });

  it("returns null for non-existent campaign", () => {
    const loaded = loadCampaignResult("nonexistent", tempDir).value;
    expect(loaded).toBeNull();
  });

  it("preserves node states and scores", () => {
    const campaign = createCampaign("camp1", "plan.md", {
      description: "root",
      estimated_gain: 100,
      estimated_cost: 1,
      category: "root",
      delegate_to: "crown",
    });
    campaign.best_score = 42.5;
    campaign.iterations_completed = 3;

    saveCampaign(campaign, tempDir);
    const loaded = loadCampaignResult("camp1", tempDir).value;

    expect(loaded!.best_score).toBe(42.5);
    expect(loaded!.iterations_completed).toBe(3);
  });

  // Every member of the union, not a hand-kept sample: a hand-kept list here
  // and in the validator both omitted `stranded_work`, so the loop's halt
  // quarantined its own snapshot (UCT Stage 0, 2026-10-07).
  it("covers stranded_work, the reason the hand-kept list once missed", () => {
    expect(HALT_REASONS).toContain("stranded_work");
  });

  it.each(HALT_REASONS)("round-trips the %s halt reason", (reason) => {
    const campaign = createCampaign(`camp-${reason}`, "plan.md", {
      description: "root", estimated_gain: 1, estimated_cost: 1, category: "root", delegate_to: "crown",
    });
    campaign.halted = true;
    campaign.halt_reason = reason;
    saveCampaign(campaign, tempDir);
    expect(loadCampaignResult(campaign.id, tempDir).value).toMatchObject({ halted: true, halt_reason: reason });
  });

  it("quarantines a snapshot whose halt reason is not a HaltReason", () => {
    const campaign = createCampaign("camp-bad-halt", "plan.md", {
      description: "root", estimated_gain: 1, estimated_cost: 1, category: "root", delegate_to: "crown",
    });
    campaign.halted = true;
    saveCampaign(campaign, tempDir);
    const file = join(tempDir, "tree", "camp-bad-halt.json");
    writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), halt_reason: "not_a_reason" }));
    const result = loadCampaignResult("camp-bad-halt", tempDir);
    expect(result.value).toBeNull();
    expect(result.diagnostics[0]).toMatchObject({ artifact: "campaign_snapshot", code: "invalid_shape" });
  });

  it("round-trips per-node memory mode and version", () => {
    const campaign = createCampaign("camp1", "plan.md", {
      description: "root", estimated_gain: 1, estimated_cost: 1, category: "root", delegate_to: "crown",
    });
    const childId = createChild(campaign.tree, "root", {
      description: "child", estimated_gain: 1, estimated_cost: 1, category: "work", delegate_to: "seed",
    });
    saveCampaign(campaign, tempDir);
    const loaded = loadCampaignResult("camp1", tempDir).value!;
    expect(loaded.tree.get("root")).toMatchObject({ memory_mode: "accumulate", memory_mode_version: 1 });
    expect(loaded.tree.get(childId)).toMatchObject({ memory_mode: "accumulate", memory_mode_version: 1 });
  });

  it("migrates legacy nodes to accumulate version one", () => {
    const campaign = createCampaign("camp1", "plan.md", {
      description: "root", estimated_gain: 1, estimated_cost: 1, category: "root", delegate_to: "crown",
    });
    saveCampaign(campaign, tempDir);
    const path = join(tempDir, "tree", "camp1.json");
    const snapshot = JSON.parse(readFileSync(path, "utf-8"));
    delete snapshot.nodes[0].memory_mode;
    delete snapshot.nodes[0].memory_mode_version;
    writeFileSync(path, JSON.stringify(snapshot));
    expect(loadCampaignResult("camp1", tempDir).value!.tree.get("root")).toMatchObject({ memory_mode: "accumulate", memory_mode_version: 1 });
  });

  it("quarantines invalid or partially migrated memory modes", () => {
    const campaign = createCampaign("camp1", "plan.md", {
      description: "root", estimated_gain: 1, estimated_cost: 1, category: "root", delegate_to: "crown",
    });
    saveCampaign(campaign, tempDir);
    const path = join(tempDir, "tree", "camp1.json");
    const snapshot = JSON.parse(readFileSync(path, "utf-8"));
    snapshot.nodes[0].memory_mode = "summarize";
    writeFileSync(path, JSON.stringify(snapshot));
    const result = loadCampaignResult("camp1", tempDir);
    expect(result.value).toBeNull();
    expect(result.diagnostics[0]).toMatchObject({ code: "invalid_shape" });
    expect(result.diagnostics[0].message).toContain("invalid memory mode");
  });

  // ADR-106/ADR-133: a node carrying real backpropagated
  // edge_visit_count/value_estimate survives save/load — the exact defect
  // class this repo has hit repeatedly (a typed value that survives routing
  // but not persistence). ADR-133 replaced the running-average aggregator
  // with min-form (weakest-link): a 1 then a 0 leaves value_estimate at 0,
  // not the running average's 0.5.
  it("round-trips a node's backpropagated edge_visit_count and value_estimate", () => {
    const campaign = createCampaign("camp1", "plan.md", {
      description: "root", estimated_gain: 1, estimated_cost: 1, category: "root", delegate_to: "crown",
    });
    const childId = createChild(campaign.tree, "root", {
      description: "child", estimated_gain: 1, estimated_cost: 1, category: "work", delegate_to: "seed",
    });
    backpropagate(campaign.tree, childId, 1);
    backpropagate(campaign.tree, childId, 0);

    saveCampaign(campaign, tempDir);
    const loaded = loadCampaignResult("camp1", tempDir).value!;

    expect(loaded.tree.get(childId)).toMatchObject({ edge_visit_count: 2, value_estimate: 0 });
    // The ancestor (root) accumulated the same two backpropagations along the path.
    expect(loaded.tree.get("root")).toMatchObject({ edge_visit_count: 2, value_estimate: 0 });
  });

  it("migrates legacy nodes without edge_visit_count/value_estimate to zero", () => {
    const campaign = createCampaign("camp1", "plan.md", {
      description: "root", estimated_gain: 1, estimated_cost: 1, category: "root", delegate_to: "crown",
    });
    saveCampaign(campaign, tempDir);
    const path = join(tempDir, "tree", "camp1.json");
    const snapshot = JSON.parse(readFileSync(path, "utf-8"));
    delete snapshot.nodes[0].edge_visit_count;
    delete snapshot.nodes[0].value_estimate;
    writeFileSync(path, JSON.stringify(snapshot));
    expect(loadCampaignResult("camp1", tempDir).value!.tree.get("root")).toMatchObject({ edge_visit_count: 0, value_estimate: 0 });
  });

  // ADR-185: the full BackedUpReward is the durable "why" behind value_estimate.
  it("round-trips a node's BackedUpReward record", () => {
    const campaign = createCampaign("camp1", "plan.md", {
      description: "root", estimated_gain: 1, estimated_cost: 1, category: "root", delegate_to: "crown",
    });
    const reward = combineReward([{ channel: "graded", source: "verification_stage_fraction", stages_passed: 2, stages_total: 3 }]);
    campaign.tree.get("root")!.reward = reward;
    saveCampaign(campaign, tempDir);
    const loaded = loadCampaignResult("camp1", tempDir).value!;
    expect(loaded.tree.get("root")!.reward).toEqual(reward);
    expect(loaded.tree.get("root")!.reward).toMatchObject({ source: "measured_partial", measured: true, provenance_tag: "generated" });
  });

  it("loads a pre-ADR-185 snapshot that has no reward field", () => {
    const campaign = createCampaign("camp1", "plan.md", {
      description: "root", estimated_gain: 1, estimated_cost: 1, category: "root", delegate_to: "crown",
    });
    saveCampaign(campaign, tempDir);
    const snapshot = JSON.parse(readFileSync(join(tempDir, "tree", "camp1.json"), "utf-8"));
    expect("reward" in snapshot.nodes[0]).toBe(false);
    const loaded = loadCampaignResult("camp1", tempDir);
    expect(loaded.value).not.toBeNull();
    expect(loaded.value!.tree.get("root")!.reward).toBeUndefined();
  });

  it("quarantines a malformed reward record", () => {
    const campaign = createCampaign("camp1", "plan.md", {
      description: "root", estimated_gain: 1, estimated_cost: 1, category: "root", delegate_to: "crown",
    });
    const path = join(tempDir, "tree", "camp1.json");
    for (const bad of [{ value: 2, source: "unmeasured", measured: false, provenance_tag: null, components: [] },
      { value: 0, source: "invented", measured: false, provenance_tag: null, components: [] },
      { value: 0.5, source: "measured_partial", measured: true, provenance_tag: "generated", components: [{ channel: "graded" }] },
      "0.6"]) {
      saveCampaign(campaign, tempDir); // a rejected snapshot is quarantined, so re-save each round
      const snapshot = JSON.parse(readFileSync(path, "utf-8"));
      snapshot.nodes[0].reward = bad;
      writeFileSync(path, JSON.stringify(snapshot));
      const result = loadCampaignResult("camp1", tempDir);
      expect(result.value).toBeNull();
      expect(result.diagnostics[0].message).toContain("reward");
    }
  });

  it("quarantines a negative edge_visit_count", () => {
    const campaign = createCampaign("camp1", "plan.md", {
      description: "root", estimated_gain: 1, estimated_cost: 1, category: "root", delegate_to: "crown",
    });
    saveCampaign(campaign, tempDir);
    const path = join(tempDir, "tree", "camp1.json");

    const negativeSnapshot = JSON.parse(readFileSync(path, "utf-8"));
    negativeSnapshot.nodes[0].edge_visit_count = -1;
    writeFileSync(path, JSON.stringify(negativeSnapshot));
    const negativeResult = loadCampaignResult("camp1", tempDir);
    expect(negativeResult.value).toBeNull();
    expect(negativeResult.diagnostics[0]).toMatchObject({ code: "invalid_shape" });
    expect(negativeResult.diagnostics[0].message).toContain("edge_visit_count");
  });

  it("quarantines a non-finite value_estimate", () => {
    const campaign = createCampaign("camp1", "plan.md", {
      description: "root", estimated_gain: 1, estimated_cost: 1, category: "root", delegate_to: "crown",
    });
    saveCampaign(campaign, tempDir);
    const path = join(tempDir, "tree", "camp1.json");

    const nanSnapshot = JSON.parse(readFileSync(path, "utf-8"));
    nanSnapshot.nodes[0].value_estimate = "NaN";
    writeFileSync(path, JSON.stringify(nanSnapshot));
    const nanResult = loadCampaignResult("camp1", tempDir);
    expect(nanResult.value).toBeNull();
    expect(nanResult.diagnostics[0]).toMatchObject({ code: "invalid_shape" });
    expect(nanResult.diagnostics[0].message).toContain("value_estimate");
  });

  it("round-trips abandoned recovery linkage without converting it to failure or prune", () => {
    const campaign = createCampaign("camp1", "plan.md", {
      description: "root", estimated_gain: 1, estimated_cost: 1, category: "root", delegate_to: "crown",
    });
    const nodeId = createChild(campaign.tree, "root", {
      description: "interrupted", estimated_gain: 1, estimated_cost: 1, category: "work", delegate_to: "seed",
    });
    abandonInterruptedNode(campaign.tree, nodeId, {
      action: "abandon", operation_id: "recovery-2", prior_operation_id: "recovery-1", actor_id: "operator",
      actor_role: "operator", reason: "ambiguous lease", expected_version: "v1", recorded_at: "2026-08-01T12:00:00.000Z",
    });
    saveCampaign(campaign, tempDir);
    const loaded = loadCampaignResult("camp1", tempDir).value!;
    expect(loaded.tree.get(nodeId)).toMatchObject({ state: "abandoned", recovery_attempts: [expect.objectContaining({ operation_id: "recovery-2" })] });
  });

  it("quarantines malformed snapshots and returns a typed diagnostic", () => {
    const treeDir = join(tempDir, "tree");
    mkdirSync(treeDir, { recursive: true });
    writeFileSync(join(treeDir, "camp1.json"), '{"id":', "utf-8");

    const result = loadCampaignResult("camp1", tempDir);

    expect(result.value).toBeNull();
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]).toMatchObject({ artifact: "campaign_snapshot", code: "invalid_json" });
    expect(result.diagnostics[0].quarantined_path).toBeDefined();
    expect(existsSync(join(treeDir, "camp1.json"))).toBe(false);
    expect(existsSync(result.diagnostics[0].quarantined_path!)).toBe(true);
  });

  it("reports quarantine_failed with no quarantined_path when a corrupt snapshot cannot even be quarantined", () => {
    const treeDir = join(tempDir, "tree");
    mkdirSync(treeDir, { recursive: true });
    writeFileSync(join(treeDir, "camp1.json"), '{"id":', "utf-8");
    // Occupy the quarantine directory's path with a file so mkdirSync fails,
    // forcing quarantinePersistenceFile's catch branch (no quarantined_path).
    writeFileSync(join(tempDir, "quarantine"), "blocking file", "utf-8");

    const result = loadCampaignResult("camp1", tempDir);
    expect(result.diagnostics[0]).toMatchObject({ artifact: "campaign_snapshot", code: "quarantine_failed" });
    expect(result.diagnostics[0].quarantined_path).toBeUndefined();
    // A failed quarantine must still refuse to hand back a half-trusted value.
    expect(result.value).toBeNull();
  });

  it("quarantines invalid or state-inconsistent node outcomes", () => {
    const campaign = createCampaign("camp1", "plan.md", {
      description: "root", estimated_gain: 1, estimated_cost: 1, category: "root", delegate_to: "crown",
    });
    saveCampaign(campaign, tempDir);
    const path = join(tempDir, "tree", "camp1.json");
    const snapshot = JSON.parse(readFileSync(path, "utf-8"));
    snapshot.nodes[0].state = "interrupted";
    snapshot.nodes[0].outcome = {
      kind: "error",
      error: {
        kind: "timeout", message: "x", provenance: { tag: "claimed", claimant: "test" },
        elapsed_ms: 5_000, partial_output: null,
        usage: { kind: "unavailable", reason: "process killed before reporting usage" },
      },
    };
    writeFileSync(path, JSON.stringify(snapshot));
    const result = loadCampaignResult("camp1", tempDir);
    expect(result.value).toBeNull();
    expect(result.diagnostics[0]?.message).toContain("interrupted without an interrupted outcome");
  });

  it("quarantines a timeout node error missing elapsed_ms/partial_output/usage rather than trusting it", () => {
    const campaign = createCampaign("camp1", "plan.md", {
      description: "root", estimated_gain: 1, estimated_cost: 1, category: "root", delegate_to: "crown",
    });
    saveCampaign(campaign, tempDir);
    const path = join(tempDir, "tree", "camp1.json");
    const snapshot = JSON.parse(readFileSync(path, "utf-8"));
    // NodeError's "timeout" branch requires real elapsed_ms/partial_output/usage
    // (types.ts); a snapshot record missing them must not be treated as a
    // fully typed NodeOutcome — downstream readers (e.g. loop.ts) dereference
    // `error.elapsed_ms` directly on this branch.
    snapshot.nodes[0].outcome = {
      kind: "error",
      error: { kind: "timeout", message: "x", provenance: { tag: "claimed", claimant: "test" } },
    };
    writeFileSync(path, JSON.stringify(snapshot));
    const result = loadCampaignResult("camp1", tempDir);
    expect(result.value).toBeNull();
    expect(result.diagnostics[0]).toMatchObject({ code: "invalid_shape" });
  });

  it("quarantines a node whose verified provenance is missing stdout_hash rather than trusting it (G-26)", () => {
    const campaign = createCampaign("camp1", "plan.md", {
      description: "root", estimated_gain: 1, estimated_cost: 1, category: "root", delegate_to: "crown",
    });
    saveCampaign(campaign, tempDir);
    const path = join(tempDir, "tree", "camp1.json");
    const snapshot = JSON.parse(readFileSync(path, "utf-8"));
    // A hand-tampered (or pre-G-26) disk record claiming verified provenance
    // without the required stdout_hash must not pass validation and then be
    // treated as a fully typed TreeNode.
    snapshot.nodes[0].provenance = { tag: "verified", cmd: "pytest", exit: 0 };
    writeFileSync(path, JSON.stringify(snapshot));
    const result = loadCampaignResult("camp1", tempDir);
    expect(result.value).toBeNull();
    expect(result.diagnostics[0]).toMatchObject({ code: "invalid_shape" });
    expect(result.diagnostics[0].message).toContain("invalid provenance");
  });

  it.each([
    ["rejected verdict without root cause", { approved: false, root_cause: undefined }],
    ["non-string root cause", { approved: true, root_cause: 42 }],
    ["incomplete mandate checks", { approved: true, checks: [] }],
  ])("quarantines %s", (_label, override) => {
    const campaign = createCampaign("camp1", "plan.md", {
      description: "root", estimated_gain: 1, estimated_cost: 1, category: "root", delegate_to: "crown",
    });
    saveCampaign(campaign, tempDir);
    const path = join(tempDir, "tree", "camp1.json");
    const snapshot = JSON.parse(readFileSync(path, "utf-8"));
    const checks = ["root_cause", "measurement_validation", "guardrail_enforcement", "introspection", "stability_monitoring"]
      .map((name) => ({ name, passed: true, detail: "checked" }));
    snapshot.nodes[0].critic_verdict = Object.assign({
      approved: true, critic: "lenticel", rationale: "complete", measurement_validated: true,
      guardrails_enforced: true, introspection_passed: true, stability_ok: true, checks,
    }, override);
    writeFileSync(path, JSON.stringify(snapshot));
    const result = loadCampaignResult("camp1", tempDir);
    expect(result.value).toBeNull();
    expect(result.diagnostics[0]).toMatchObject({ code: "invalid_shape" });
    expect(result.diagnostics[0].message).toContain("invalid critic verdict");
  });

  it("quarantines snapshots with a conflicting identity rather than loading them", () => {
    const campaign = createCampaign("camp1", "plan.md", {
      description: "root", estimated_gain: 1, estimated_cost: 1, category: "root", delegate_to: "crown",
    });
    saveCampaign(campaign, tempDir);
    const treeDir = join(tempDir, "tree");
    writeFileSync(join(treeDir, "camp1.json"), JSON.stringify({ id: "other", nodes: [] }));

    const result = loadCampaignResult("camp1", tempDir);

    expect(result.value).toBeNull();
    expect(result.diagnostics[0]).toMatchObject({ code: "identity_mismatch" });
    expect(existsSync(result.diagnostics[0].quarantined_path!)).toBe(true);
  });

  it("round-trips a captured candidate artifact and the awaiting_review state", () => {
    const campaign = createCampaign("camp-candidate", "plan.md", {
      description: "root", estimated_gain: 1, estimated_cost: 1, category: "root", delegate_to: "crown",
    });
    const nodeId = createChild(campaign.tree, "root", {
      description: "specialist work", estimated_gain: 1, estimated_cost: 1, category: "work", delegate_to: "seed",
    });
    const original = campaign.tree.get(nodeId)!;
    const candidate = {
      specialist_output: "diff applied",
      specialist_agent: "seed",
      provenance: { tag: "claimed" as const, claimant: "seed" },
      captured_at: "2026-08-14T00:00:00.000Z",
      review_status: "awaiting_review" as const,
    };
    campaign.tree.set(nodeId, { ...original, state: "awaiting_review", candidate });
    saveCampaign(campaign, tempDir);

    const loaded = loadCampaignResult("camp-candidate", tempDir).value!;
    const restored = loaded.tree.get(nodeId)!;
    expect(restored.state).toBe("awaiting_review");
    expect(restored.candidate).toEqual(candidate);
  });

  it("round-trips Q4's optional token_usage on a captured candidate artifact", () => {
    const campaign = createCampaign("camp-candidate-usage", "plan.md", {
      description: "root", estimated_gain: 1, estimated_cost: 1, category: "root", delegate_to: "crown",
    });
    const nodeId = createChild(campaign.tree, "root", {
      description: "specialist work", estimated_gain: 1, estimated_cost: 1, category: "work", delegate_to: "seed",
    });
    const original = campaign.tree.get(nodeId)!;
    const candidate = {
      specialist_output: "diff applied",
      specialist_agent: "seed",
      provenance: { tag: "claimed" as const, claimant: "seed" },
      captured_at: "2026-08-14T00:00:00.000Z",
      review_status: "awaiting_review" as const,
      token_usage: { input_tokens: 100, output_tokens: 20, cached_input_tokens: 0, cache_write_input_tokens: 0, counter_source: "provider_counter" as const },
    };
    campaign.tree.set(nodeId, { ...original, state: "awaiting_review", candidate });
    saveCampaign(campaign, tempDir);

    const loaded = loadCampaignResult("camp-candidate-usage", tempDir).value!;
    expect(loaded.tree.get(nodeId)!.candidate).toEqual(candidate);
  });

  it("quarantines a captured candidate artifact whose token_usage is malformed rather than trusting it", () => {
    const campaign = createCampaign("camp-bad-candidate-usage", "plan.md", {
      description: "root", estimated_gain: 1, estimated_cost: 1, category: "root", delegate_to: "crown",
    });
    saveCampaign(campaign, tempDir);
    const path = join(tempDir, "tree", "camp-bad-candidate-usage.json");
    const snapshot = JSON.parse(readFileSync(path, "utf-8"));
    snapshot.nodes[0].candidate = {
      specialist_output: "output",
      specialist_agent: "seed",
      provenance: { tag: "claimed", claimant: "seed" },
      captured_at: "2026-08-14T00:00:00.000Z",
      review_status: "resolved",
      token_usage: { input_tokens: "a lot" },
    };
    writeFileSync(path, JSON.stringify(snapshot));
    const result = loadCampaignResult("camp-bad-candidate-usage", tempDir);
    expect(result.value).toBeNull();
    expect(result.diagnostics[0]).toMatchObject({ code: "invalid_shape" });
  });

  it("omits candidate entirely (not null) when a node never captured one", () => {
    const campaign = createCampaign("camp-no-candidate", "plan.md", {
      description: "root", estimated_gain: 1, estimated_cost: 1, category: "root", delegate_to: "crown",
    });
    saveCampaign(campaign, tempDir);
    const path = join(tempDir, "tree", "camp-no-candidate.json");
    const raw = JSON.parse(readFileSync(path, "utf-8"));
    expect("candidate" in raw.nodes[0]).toBe(false);

    const loaded = loadCampaignResult("camp-no-candidate", tempDir).value!;
    expect(loaded.tree.get(loaded.root_id)!.candidate).toBeUndefined();
  });

  it("quarantines an invalid candidate artifact rather than trusting it", () => {
    const campaign = createCampaign("camp-bad-candidate", "plan.md", {
      description: "root", estimated_gain: 1, estimated_cost: 1, category: "root", delegate_to: "crown",
    });
    saveCampaign(campaign, tempDir);
    const path = join(tempDir, "tree", "camp-bad-candidate.json");
    const snapshot = JSON.parse(readFileSync(path, "utf-8"));
    snapshot.nodes[0].candidate = {
      specialist_output: "output",
      specialist_agent: "seed",
      provenance: { tag: "claimed", claimant: "seed" },
      captured_at: "2026-08-14T00:00:00.000Z",
      review_status: "not_a_real_status",
    };
    writeFileSync(path, JSON.stringify(snapshot));
    const result = loadCampaignResult("camp-bad-candidate", tempDir);
    expect(result.value).toBeNull();
    expect(result.diagnostics[0]).toMatchObject({ code: "invalid_shape" });
    expect(result.diagnostics[0].message).toContain("invalid candidate artifact");
  });

  it("quarantines abandoned campaign temp files without deleting their contents", () => {
    const treeDir = join(tempDir, "tree");
    mkdirSync(treeDir, { recursive: true });
    const temporary = join(treeDir, ".camp1.123.tmp");
    writeFileSync(temporary, "interrupted write", "utf-8");

    const result = loadCampaignResult("camp1", tempDir);

    expect(result.value).toBeNull();
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]).toMatchObject({ artifact: "temporary_file" });
    expect(existsSync(temporary)).toBe(false);
    expect(existsSync(result.diagnostics[0].quarantined_path!)).toBe(true);
  });
});

describe("saveCampaign + loadCampaign — E-2/E-3/E-4 additive round trip", () => {
  it("round-trips E-4 verification strength on a verified node's provenance (both values, and absent)", () => {
    for (const strength of ["command_executed", "outputs_check", undefined] as const) {
      const campaign = createCampaign(`camp-strength-${strength ?? "absent"}`, "plan.md", {
        description: "root", estimated_gain: 1, estimated_cost: 1, category: "root", delegate_to: "crown",
      });
      campaign.tree.get("root")!.provenance = {
        tag: "verified", cmd: "npm test", exit: 0, stdout_hash: "sha256:x",
        ...(strength === undefined ? {} : { strength }),
      };
      saveCampaign(campaign, tempDir);
      const loaded = loadCampaignResult(campaign.id, tempDir).value!;
      expect(loaded.tree.get("root")!.provenance).toMatchObject(strength === undefined ? { tag: "verified" } : { strength });
    }
  });

  it("quarantines an invalid E-4 strength value rather than trusting it", () => {
    const campaign = createCampaign("camp-bad-strength", "plan.md", {
      description: "root", estimated_gain: 1, estimated_cost: 1, category: "root", delegate_to: "crown",
    });
    saveCampaign(campaign, tempDir);
    const path = join(tempDir, "tree", "camp-bad-strength.json");
    const snapshot = JSON.parse(readFileSync(path, "utf-8"));
    snapshot.nodes[0].provenance = { tag: "verified", cmd: "npm test", exit: 0, stdout_hash: "sha256:x", strength: "eyeballed" };
    writeFileSync(path, JSON.stringify(snapshot));
    const result = loadCampaignResult("camp-bad-strength", tempDir);
    expect(result.value).toBeNull();
    expect(result.diagnostics[0].message).toContain("invalid provenance");
  });

  it("round-trips X-2's optional sixth 'completeness' check on a critic verdict", () => {
    const checks = (["root_cause", "measurement_validation", "guardrail_enforcement", "introspection", "stability_monitoring", "completeness"] as const)
      .map((name) => ({ name, passed: true, detail: "checked" }));
    const campaign = createCampaign("camp-completeness", "plan.md", {
      description: "root", estimated_gain: 1, estimated_cost: 1, category: "root", delegate_to: "crown",
    });
    campaign.tree.get("root")!.critic_verdict = {
      approved: true, critic: "lenticel", rationale: "complete", measurement_validated: true,
      guardrails_enforced: true, introspection_passed: true, stability_ok: true, checks,
    };
    saveCampaign(campaign, tempDir);
    const loaded = loadCampaignResult("camp-completeness", tempDir);
    expect(loaded.value).not.toBeNull();
    expect(loaded.value!.tree.get("root")!.critic_verdict!.checks).toHaveLength(6);
  });

  it("round-trips E-3 critic confidence + confidence_source on a critic verdict (present and absent)", () => {
    const checks = (["root_cause", "measurement_validation", "guardrail_enforcement", "introspection", "stability_monitoring"] as const)
      .map((name) => ({ name, passed: true, detail: "checked" }));
    const baseVerdict = {
      approved: true, critic: "lenticel", rationale: "complete", measurement_validated: true,
      guardrails_enforced: true, introspection_passed: true, stability_ok: true, checks,
    };
    const campaign = createCampaign("camp-confidence", "plan.md", {
      description: "root", estimated_gain: 1, estimated_cost: 1, category: "root", delegate_to: "crown",
    });
    campaign.tree.get("root")!.critic_verdict = { ...baseVerdict, confidence: 0.73, confidence_source: "self_report" };
    saveCampaign(campaign, tempDir);
    const loaded = loadCampaignResult("camp-confidence", tempDir).value!;
    expect(loaded.tree.get("root")!.critic_verdict).toMatchObject({ confidence: 0.73, confidence_source: "self_report" });

    // Absent confidence (an older verdict) round-trips unchanged, with no field fabricated.
    const legacyCampaign = createCampaign("camp-no-confidence", "plan.md", {
      description: "root", estimated_gain: 1, estimated_cost: 1, category: "root", delegate_to: "crown",
    });
    legacyCampaign.tree.get("root")!.critic_verdict = baseVerdict;
    saveCampaign(legacyCampaign, tempDir);
    const loadedLegacy = loadCampaignResult("camp-no-confidence", tempDir).value!;
    expect(loadedLegacy.tree.get("root")!.critic_verdict?.confidence).toBeUndefined();
  });

  it.each([
    ["out-of-range confidence", { confidence: 1.5, confidence_source: "self_report" }],
    ["non-numeric confidence", { confidence: "high", confidence_source: "self_report" }],
    ["an invalid confidence_source", { confidence: 0.5, confidence_source: "vibes" }],
    ["confidence without confidence_source", { confidence: 0.5 }],
    ["confidence_source without confidence", { confidence_source: "self_report" }],
  ])("quarantines a critic verdict with %s rather than trusting it", (_label, override) => {
    const checks = ["root_cause", "measurement_validation", "guardrail_enforcement", "introspection", "stability_monitoring"]
      .map((name) => ({ name, passed: true, detail: "checked" }));
    const campaign = createCampaign("camp-bad-confidence", "plan.md", {
      description: "root", estimated_gain: 1, estimated_cost: 1, category: "root", delegate_to: "crown",
    });
    saveCampaign(campaign, tempDir);
    const path = join(tempDir, "tree", "camp-bad-confidence.json");
    const snapshot = JSON.parse(readFileSync(path, "utf-8"));
    snapshot.nodes[0].critic_verdict = {
      approved: true, critic: "lenticel", rationale: "complete", measurement_validated: true,
      guardrails_enforced: true, introspection_passed: true, stability_ok: true, checks,
      ...override,
    };
    writeFileSync(path, JSON.stringify(snapshot));
    const result = loadCampaignResult("camp-bad-confidence", tempDir);
    expect(result.value).toBeNull();
    expect(result.diagnostics[0]).toMatchObject({ code: "invalid_shape" });
  });

  it("round-trips E-2 turn_budget_estimate on the campaign's governance decision", () => {
    const campaign = createCampaign("camp-budget", "plan.md", {
      description: "root", estimated_gain: 1, estimated_cost: 1, category: "root", delegate_to: "crown",
    });
    campaign.governance = {
      tier: "direct", rationale: "narrow fix", blast_radius: { reversibility: "reversible" },
      source: "arbiter", decided_at: "2026-08-15T00:00:00.000Z", turn_budget_estimate: 12,
    };
    saveCampaign(campaign, tempDir);
    const loaded = loadCampaignResult("camp-budget", tempDir).value!;
    expect(loaded.governance).toMatchObject({ tier: "direct", turn_budget_estimate: 12 });
  });

  it("quarantines an invalid E-2 turn_budget_estimate on the governance decision", () => {
    const campaign = createCampaign("camp-bad-budget", "plan.md", {
      description: "root", estimated_gain: 1, estimated_cost: 1, category: "root", delegate_to: "crown",
    });
    saveCampaign(campaign, tempDir);
    const path = join(tempDir, "tree", "camp-bad-budget.json");
    const snapshot = JSON.parse(readFileSync(path, "utf-8"));
    snapshot.governance = {
      tier: "direct", rationale: "narrow fix", blast_radius: { reversibility: "reversible" },
      source: "arbiter", decided_at: "2026-08-15T00:00:00.000Z", turn_budget_estimate: -5,
    };
    writeFileSync(path, JSON.stringify(snapshot));
    const result = loadCampaignResult("camp-bad-budget", tempDir);
    expect(result.value).toBeNull();
    expect(result.diagnostics[0].message).toContain("invalid governance decision");
  });
});

describe("saveCampaign + loadCampaign — deferredActions (DAG durability)", () => {
  it("round-trips deferred DAG actions and omits the field for a campaign that never used depends_on", () => {
    const campaign = createCampaign("camp-deferred", "plan.md", {
      description: "root", estimated_gain: 1, estimated_cost: 1, category: "root", delegate_to: "crown",
    });
    createChild(campaign.tree, "root", {
      description: "investigate A", estimated_gain: 1, estimated_cost: 1, category: "investigation", delegate_to: "seed",
    });
    campaign.deferredActions = [
      {
        action: {
          description: "synthesize", estimated_gain: 1, estimated_cost: 1, category: "synthesis", delegate_to: "seed",
          depends_on: ["investigate A"],
        },
        depends_on: ["investigate A"],
      },
    ];
    saveCampaign(campaign, tempDir);

    const path = join(tempDir, "tree", "camp-deferred.json");
    const raw = JSON.parse(readFileSync(path, "utf-8"));
    expect(raw.deferred_actions).toHaveLength(1);

    const loaded = loadCampaignResult("camp-deferred", tempDir).value!;
    expect(loaded.deferredActions).toEqual(campaign.deferredActions);

    // A campaign with no deferred entries never writes the key at all —
    // schema version 1, not a spurious empty version-2 array.
    const plain = createCampaign("camp-no-deferred", "plan.md", {
      description: "root", estimated_gain: 1, estimated_cost: 1, category: "root", delegate_to: "crown",
    });
    saveCampaign(plain, tempDir);
    const plainRaw = JSON.parse(readFileSync(join(tempDir, "tree", "camp-no-deferred.json"), "utf-8"));
    expect(plainRaw.deferred_actions).toBeUndefined();
    expect(loadCampaignResult("camp-no-deferred", tempDir).value!.deferredActions).toBeUndefined();
  });

  it("loads a legacy snapshot written before deferredActions existed without data loss", () => {
    const campaign = createCampaign("camp-legacy", "plan.md", {
      description: "root", estimated_gain: 1, estimated_cost: 1, category: "root", delegate_to: "crown",
    });
    saveCampaign(campaign, tempDir);
    const path = join(tempDir, "tree", "camp-legacy.json");
    const snapshot = JSON.parse(readFileSync(path, "utf-8"));
    expect("deferred_actions" in snapshot).toBe(false);

    const loaded = loadCampaignResult("camp-legacy", tempDir);
    expect(loaded.diagnostics).toHaveLength(0);
    expect(loaded.value).not.toBeNull();
    expect(loaded.value!.deferredActions).toBeUndefined();
    expect(loaded.value!.tree.size).toBe(1);
  });

  it("fails closed on a malformed deferred action entry", () => {
    const campaign = createCampaign("camp-bad-deferred", "plan.md", {
      description: "root", estimated_gain: 1, estimated_cost: 1, category: "root", delegate_to: "crown",
    });
    saveCampaign(campaign, tempDir);
    const path = join(tempDir, "tree", "camp-bad-deferred.json");
    const snapshot = JSON.parse(readFileSync(path, "utf-8"));
    snapshot.deferred_actions = [{ action: { description: "x" } }];
    writeFileSync(path, JSON.stringify(snapshot));
    const result = loadCampaignResult("camp-bad-deferred", tempDir);
    expect(result.value).toBeNull();
    expect(result.diagnostics[0]).toMatchObject({ code: "invalid_shape" });
    expect(result.diagnostics[0].message).toContain("malformed deferred action entry");
  });

  it("fails closed on a duplicate deferred action description", () => {
    const campaign = createCampaign("camp-dup-deferred", "plan.md", {
      description: "root", estimated_gain: 1, estimated_cost: 1, category: "root", delegate_to: "crown",
    });
    saveCampaign(campaign, tempDir);
    const path = join(tempDir, "tree", "camp-dup-deferred.json");
    const snapshot = JSON.parse(readFileSync(path, "utf-8"));
    const entry = {
      action: { description: "synthesize", estimated_gain: 1, estimated_cost: 1, category: "synthesis", delegate_to: "seed" },
      depends_on: ["root"],
    };
    snapshot.deferred_actions = [entry, entry];
    writeFileSync(path, JSON.stringify(snapshot));
    const result = loadCampaignResult("camp-dup-deferred", tempDir);
    expect(result.value).toBeNull();
    expect(result.diagnostics[0].message).toContain("duplicate deferred action description");
  });

  it("fails closed on a dangling dependency reference", () => {
    const campaign = createCampaign("camp-dangling-deferred", "plan.md", {
      description: "root", estimated_gain: 1, estimated_cost: 1, category: "root", delegate_to: "crown",
    });
    saveCampaign(campaign, tempDir);
    const path = join(tempDir, "tree", "camp-dangling-deferred.json");
    const snapshot = JSON.parse(readFileSync(path, "utf-8"));
    snapshot.deferred_actions = [{
      action: { description: "synthesize", estimated_gain: 1, estimated_cost: 1, category: "synthesis", delegate_to: "seed" },
      depends_on: ["a description nothing admits"],
    }];
    writeFileSync(path, JSON.stringify(snapshot));
    const result = loadCampaignResult("camp-dangling-deferred", tempDir);
    expect(result.value).toBeNull();
    expect(result.diagnostics[0].message).toContain("unknown or dangling description");
  });

  it("fails closed on a deferred action whose description overlaps an already-admitted tree node (inconsistent deferred/tree overlap)", () => {
    const campaign = createCampaign("camp-overlap-deferred", "plan.md", {
      description: "root", estimated_gain: 1, estimated_cost: 1, category: "root", delegate_to: "crown",
    });
    createChild(campaign.tree, "root", {
      description: "investigate A", estimated_gain: 1, estimated_cost: 1, category: "investigation", delegate_to: "seed",
    });
    saveCampaign(campaign, tempDir);
    const path = join(tempDir, "tree", "camp-overlap-deferred.json");
    const snapshot = JSON.parse(readFileSync(path, "utf-8"));
    snapshot.deferred_actions = [{
      // "investigate A" is already a real, admitted tree node — a snapshot
      // claiming it is SIMULTANEOUSLY still deferred is an inconsistent
      // deferred/tree overlap, not a legitimate independent entry.
      action: { description: "investigate A", estimated_gain: 1, estimated_cost: 1, category: "investigation", delegate_to: "seed" },
      depends_on: ["root"],
    }];
    writeFileSync(path, JSON.stringify(snapshot));
    const result = loadCampaignResult("camp-overlap-deferred", tempDir);
    expect(result.value).toBeNull();
    expect(result.diagnostics[0].message).toContain("inconsistent with an already-admitted tree node");
  });

  it("fails closed when deferred_actions is not an array", () => {
    const campaign = createCampaign("camp-shape-deferred", "plan.md", {
      description: "root", estimated_gain: 1, estimated_cost: 1, category: "root", delegate_to: "crown",
    });
    saveCampaign(campaign, tempDir);
    const path = join(tempDir, "tree", "camp-shape-deferred.json");
    const snapshot = JSON.parse(readFileSync(path, "utf-8"));
    snapshot.deferred_actions = { not: "an array" };
    writeFileSync(path, JSON.stringify(snapshot));
    const result = loadCampaignResult("camp-shape-deferred", tempDir);
    expect(result.value).toBeNull();
    expect(result.diagnostics[0].message).toContain("invalid deferred actions list");
  });
});

describe("saveCampaign + loadCampaign — closed-union replay strictness", () => {
  it("fails closed when a node's gate_records is missing", () => {
    const campaign = createCampaign("camp-gate-missing", "plan.md", {
      description: "root", estimated_gain: 1, estimated_cost: 1, category: "root", delegate_to: "crown",
    });
    saveCampaign(campaign, tempDir);
    const path = join(tempDir, "tree", "camp-gate-missing.json");
    const snapshot = JSON.parse(readFileSync(path, "utf-8"));
    delete snapshot.nodes[0].gate_records;
    writeFileSync(path, JSON.stringify(snapshot));
    const result = loadCampaignResult("camp-gate-missing", tempDir);
    expect(result.value).toBeNull();
  });

  it("fails closed when a gate_records entry has an unknown gate discriminant", () => {
    const campaign = createCampaign("camp-gate-unknown", "plan.md", {
      description: "root", estimated_gain: 1, estimated_cost: 1, category: "root", delegate_to: "crown",
    });
    saveCampaign(campaign, tempDir);
    const path = join(tempDir, "tree", "camp-gate-unknown.json");
    const snapshot = JSON.parse(readFileSync(path, "utf-8"));
    snapshot.nodes[0].gate_records = [
      { gate: "not_a_real_gate", result: "pass", checked_at: new Date().toISOString(), detail: "x" },
    ];
    writeFileSync(path, JSON.stringify(snapshot));
    const result = loadCampaignResult("camp-gate-unknown", tempDir);
    expect(result.value).toBeNull();
  });

  it("fails closed when a gate_records entry has an unknown result discriminant", () => {
    const campaign = createCampaign("camp-gate-result", "plan.md", {
      description: "root", estimated_gain: 1, estimated_cost: 1, category: "root", delegate_to: "crown",
    });
    saveCampaign(campaign, tempDir);
    const path = join(tempDir, "tree", "camp-gate-result.json");
    const snapshot = JSON.parse(readFileSync(path, "utf-8"));
    snapshot.nodes[0].gate_records = [
      { gate: "admission", result: "maybe", checked_at: new Date().toISOString(), detail: "x" },
    ];
    writeFileSync(path, JSON.stringify(snapshot));
    const result = loadCampaignResult("camp-gate-result", tempDir);
    expect(result.value).toBeNull();
  });

  it("fails closed when a timeout NodeError is missing its own fields (elapsed_ms/partial_output/usage)", () => {
    const campaign = createCampaign("camp-timeout-shape", "plan.md", {
      description: "root", estimated_gain: 1, estimated_cost: 1, category: "root", delegate_to: "crown",
    });
    saveCampaign(campaign, tempDir);
    const path = join(tempDir, "tree", "camp-timeout-shape.json");
    const snapshot = JSON.parse(readFileSync(path, "utf-8"));
    snapshot.nodes[0].outcome = {
      kind: "error",
      error: { kind: "timeout", message: "x", provenance: { tag: "claimed", claimant: "test" } },
    };
    writeFileSync(path, JSON.stringify(snapshot));
    const result = loadCampaignResult("camp-timeout-shape", tempDir);
    expect(result.value).toBeNull();
  });

  it("fails closed when a CandidateArtifact's token_usage is a malformed shape", () => {
    const campaign = createCampaign("camp-candidate-usage", "plan.md", {
      description: "root", estimated_gain: 1, estimated_cost: 1, category: "root", delegate_to: "crown",
    });
    saveCampaign(campaign, tempDir);
    const path = join(tempDir, "tree", "camp-candidate-usage.json");
    const snapshot = JSON.parse(readFileSync(path, "utf-8"));
    snapshot.nodes[0].candidate = {
      specialist_output: "out", specialist_agent: "seed", captured_at: new Date().toISOString(),
      review_status: "resolved", provenance: { tag: "claimed", claimant: "test" },
      token_usage: { kind: "not_a_real_variant" },
    };
    writeFileSync(path, JSON.stringify(snapshot));
    const result = loadCampaignResult("camp-candidate-usage", tempDir);
    expect(result.value).toBeNull();
  });
});

describe("listCampaigns", () => {
  it("lists saved campaign IDs", () => {
    const c1 = createCampaign("camp1", "plan.md", {
      description: "root1", estimated_gain: 1, estimated_cost: 1, category: "root", delegate_to: "crown",
    });
    const c2 = createCampaign("camp2", "plan.md", {
      description: "root2", estimated_gain: 1, estimated_cost: 1, category: "root", delegate_to: "crown",
    });
    saveCampaign(c1, tempDir);
    saveCampaign(c2, tempDir);

    const ids = listCampaigns(tempDir);
    expect(ids).toHaveLength(2);
    expect(ids).toContain("camp1");
    expect(ids).toContain("camp2");
  });

  it("returns empty array for non-existent directory", () => {
    expect(listCampaigns(tempDir)).toEqual([]);
  });
});

describe("writeBoulder + readBoulderResult", () => {
  it("round-trips boulder state", () => {
    const boulder: BoulderState = {
      active_plan: ".arbor/plans/auth.md",
      active_campaign: "camp_001",
      session_ids: ["ses_abc"],
      started_at: "2026-07-31T12:00:00Z",
      plan_name: "Auth Refactor",
    };

    writeBoulder(tempDir, boulder);
    const loaded = readBoulderResult(tempDir).value;

    expect(loaded).not.toBeNull();
    expect(loaded!.active_campaign).toBe("camp_001");
    expect(loaded!.plan_name).toBe("Auth Refactor");
    expect(loaded!.session_ids).toEqual(["ses_abc"]);
  });

  it("returns null when no boulder file exists", () => {
    expect(readBoulderResult(tempDir).value).toBeNull();
  });

  it("quarantines truncated boulder data with a diagnostic", () => {
    const path = join(tempDir, "boulder.json");
    writeFileSync(path, '{"active_campaign":', "utf-8");

    const result = readBoulderResult(tempDir);

    expect(result.value).toBeNull();
    expect(result.diagnostics[0]).toMatchObject({ artifact: "boulder", code: "invalid_json" });
    expect(existsSync(path)).toBe(false);
    expect(existsSync(result.diagnostics[0].quarantined_path!)).toBe(true);
  });

  it("quarantines malformed boulder state and abandoned boulder temps", () => {
    const temporary = join(tempDir, ".boulder.123.tmp");
    writeFileSync(temporary, "interrupted pointer write", "utf-8");
    writeFileSync(join(tempDir, "boulder.json"), JSON.stringify({ active_campaign: 1 }), "utf-8");

    const result = readBoulderResult(tempDir);

    expect(result.value).toBeNull();
    expect(result.diagnostics.map((diagnostic) => diagnostic.artifact)).toEqual(["temporary_file", "boulder"]);
    expect(readdirSync(join(tempDir, "quarantine"))).toHaveLength(2);
  });
});
