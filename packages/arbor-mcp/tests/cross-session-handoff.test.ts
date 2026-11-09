import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CampaignManager } from "../src/manager.js";
import { projectCrossSessionHandoff } from "../src/cross-session-handoff.js";

describe("cross-session handoff projection", () => {
  it("is bounded, reference-only, and derives selective replan triggers from durable thread state", () => {
    const result = projectCrossSessionHandoff({
      campaign: {
        id: "campaign", plan_path: "plan.md", root_id: "root", started_at: "2026-08-08T00:00:00.000Z",
        iterations_completed: 3, iterations_without_kb_entry: 2, halted: false, halt_reason: null,
        nodes: [
          { id: "root", parent_id: null, state: "pending", action_description: "plan", depth: 0 },
          { id: "child", parent_id: "root", state: "expanding", action_description: "work", depth: 1 },
          { id: "done", parent_id: "root", state: "verified", action_description: "complete", depth: 1 },
        ],
      },
      threads: [{
        campaign_id: "campaign", thread_id: "parent-child:root:child", parent_node_id: "root", child_node_id: "child", version: "m2", as_of: "2026-08-09T00:00:00.000Z",
        needs_attention_message_ids: ["m1"], messages: [
          { id: "m1", delivery: "timed_out", timestamp: "", conversation_id: "parent-child:root:child", parent_communication_id: null, reply_to_communication_id: null, author_node_id: "child", recipient_node_ids: ["root"], kind: "clarify", capability_tier: "specialist", payload_preview: { content: "", provenance_tag: "claimed", evidence_refs: [] }, as_of: "", acknowledges_communication_id: null, retracts_communication_id: null, intent: "needs_attention", ack_required: true, deadline_at: "2026-08-09T00:00:00.000Z", promote_conflict: false, steer_timing: null, remote_attribution: null },
        ],
      }],
      active_overlay_ids: ["fold-1", "harness-1"], as_of: "2026-08-10T00:00:00.000Z", max_nodes: 1,
    });
    expect(result).toMatchObject({
      authority: { campaign_snapshot: true, direct_thread_history: true, overlays_are_references: true },
      active_nodes: [{ id: "root" }], pending_threads: [{ version: "m2", needs_attention_message_ids: ["m1"], timed_out_message_ids: ["m1"] }],
      active_overlay_ids: ["fold-1", "harness-1"], continuation: "replan_required",
    });
    expect(result.replan_triggers).toEqual(["needs_attention", "deadline_expired", "convergence_stalled"]);
    expect(Object.isFrozen(result)).toBe(true);
  });

  it("does not manufacture replanning when durable facts say resume, and preserves halt as a distinct continuation", () => {
    const base = {
      id: "campaign", plan_path: "plan.md", root_id: "root", started_at: "", iterations_completed: 0,
      iterations_without_kb_entry: 0, halted: false, halt_reason: null, nodes: [{ id: "root", parent_id: null, state: "pending", action_description: "plan", depth: 0 }],
    };
    expect(projectCrossSessionHandoff({ campaign: base, threads: [], as_of: "2026-08-10T00:00:00.000Z" }).continuation).toBe("resume_existing_plan");
    expect(projectCrossSessionHandoff({ campaign: { ...base, halted: true, halt_reason: "manual" }, threads: [], as_of: "2026-08-10T00:00:00.000Z" })).toMatchObject({ continuation: "halted", replan_triggers: ["campaign_halted"] });
  });

  it("re-derives a bounded attention/deadline handoff after campaign and ledger restart", () => {
    const dir = mkdtempSync(join(tmpdir(), "arbor-handoff-restart-"));
    try {
      const root = { description: "root", estimated_gain: 1, estimated_cost: 1, category: "root", delegate_to: "crown" };
      const first = new CampaignManager({ persistence_dir: dir });
      first.startCampaign("campaign", "plan.md", root);
      const child = first.branch("campaign", "root", [{ ...root, description: "child", delegate_to: "seed" }])[0]!;
      first.recordParentChildThreadMessage({
        campaign_id: "campaign", node_id: "root", parent_node_id: "root", child_node_id: child, expected_thread_version: "origin",
        author_node_id: "root", recipient_node_id: child, other_recipient_node_ids: [], kind: "delegate", payload: { content: "continue", provenance: { tag: "claimed", claimant: "root" } }, capability_tier: "specialist", trigger_turn: true, as_of: "2026-08-08T00:00:00.000Z", correlation_id: "handoff", idempotency_key: "handoff-1", acknowledges_communication_id: null, retracts_communication_id: null, parent_communication_id: null, intent: "needs_attention", reply_to_communication_id: null, ack_required: true, deadline_at: "2026-08-08T00:01:00.000Z",
      });
      const restored = new CampaignManager({ persistence_dir: dir });
      const campaign = restored.getCampaignSnapshot("campaign");
      if (!campaign) throw new Error("campaign did not restore");
      const thread = restored.getParentChildThread("campaign", "root", child, { as_of: "2026-08-08T00:02:00.000Z" });
      const handoff = projectCrossSessionHandoff({ campaign, threads: [thread], as_of: "2026-08-08T00:02:00.000Z", max_nodes: 2, max_threads: 1 });
      expect(handoff).toMatchObject({ pending_threads: [{ version: expect.any(String), needs_attention_message_ids: [expect.any(String)], timed_out_message_ids: [expect.any(String)] }], continuation: "replan_required" });
      expect(handoff.replan_triggers).toEqual(expect.arrayContaining(["needs_attention", "deadline_expired"]));
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
