import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Action } from "@arbor/core";
import { buildRunReport, formatRunReport } from "../src/run-report.js";
import { ArborRuntime } from "../src/runtime.js";
import { RuntimeCatalogRouter } from "../src/runtime-catalog.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const root: Action = { description: "root", estimated_gain: 1, estimated_cost: 1, category: "root", delegate_to: "crown" };
function temp(): string { const value = mkdtempSync(join(tmpdir(), "arbor-run-report-")); roots.push(value); return value; }

describe("buildRunReport", () => {
  it("exports one bounded local projection from durable tree, ledger, thread, approval and descriptor authorities", async () => {
    const runtime = new ArborRuntime({ persistence_dir: temp() });
    runtime.manager.startCampaign("campaign", "plan.md", root);
    const [child] = runtime.manager.branch("campaign", "root", [{ ...root, description: "child", delegate_to: "seed" }]);
    if (!child) throw new Error("child setup failed");
    const router = new RuntimeCatalogRouter(runtime);
    const version = runtime.manager.getParentChildThread("campaign", "root", child).version;
    expect(await router.dispatchCommand({ schema_version: 1, metadata: { operation_id: "thread", idempotency_key: "thread-key", correlation_id: "corr", actor_id: "root", requested_at: "2026-08-08T00:00:00.000Z" }, command: { kind: "bus.thread.send", campaign_id: "campaign", parent_node_id: "root", child_node_id: child, from_node_id: "root", expected_thread_version: version, message_kind: "delegate", content: "durable work", provenance: { tag: "claimed", claimant: "root" }, capability_tier: "specialist" } })).toMatchObject({ ok: true, value: { accepted: true } });
    runtime.approvals.request({ request_id: "approval", idempotency_key: "approval-key", action: "campaign.halt", subject: "campaign", resource_id: "campaign", proposer: "operator", rationale: "review", expires_at: "2030-01-01T00:00:00.000Z" });
    runtime.outputEvidence!.put({ campaign_id: "campaign", node_id: "root", operation_id: "output", stream: "stdout", media_type: "text/plain", provenance: { tag: "claimed", claimant: "root" } }, "descriptor-only content");

    const report = buildRunReport(runtime, "campaign", { as_of: "2026-08-08T01:00:00.000Z", max_ledger_records: 1 });
    expect(report).toMatchObject({ ok: true, value: { schema: "arbor.run-report/v1", campaign_id: "campaign", ledger: { total_records: expect.any(Number), included_records: 1, truncated: true }, threads: [{ parent_node_id: "root", child_node_id: child, messages: [{ payload_preview: { content: "durable work" } }] }], approvals: [{ request_id: "approval" }], evidence: [{ status: "ok", record: { campaign_id: "campaign" } }] } });
    expect(formatRunReport(report)).toContain("arbor.run-report/v1");
    expect(formatRunReport(report)).not.toContain("descriptor-only content");
  });

  it("fails honestly for missing campaigns and invalid report bounds", async () => {
    const runtime = new ArborRuntime({ persistence_dir: temp() });
    expect(buildRunReport(runtime, "missing")).toMatchObject({ ok: false, error: { code: "not_found" } });
    expect(buildRunReport(runtime, "", { max_ledger_records: 0 })).toMatchObject({ ok: false, error: { code: "validation" } });
  });

  it("projects the latest failed gate with its correcting actor, canonical remediation and typed corrective action", () => {
    const runtime = new ArborRuntime({ persistence_dir: temp() });
    runtime.manager.startCampaign("blocked", "plan.md", root);
    const [child] = runtime.manager.branch("blocked", "root", [{ ...root, description: "child", delegate_to: "seed" }]);
    if (!child) throw new Error("child setup failed");
    runtime.manager.expandNode("blocked", child, { worktree_isolated: false, starting_commit_correct: true, lease_acquired: true });

    expect(buildRunReport(runtime, "blocked")).toMatchObject({ ok: true, value: { gate_refusal: {
      kind: "gate.refusal", state: "refused", gate: "isolation", correcting_actor: "runtime_host", corrective_action: "restore_isolation",
      // A gate that ran and failed carries no bypass evidence deficit; only a bypass records one.
      evidence_deficit: null,
      remediation: expect.any(String),
    } } });
  });

  it("E-8: surfaces waiver-outcome totals — zero when no result was ever waived", () => {
    const runtime = new ArborRuntime({ persistence_dir: temp() });
    runtime.manager.startCampaign("no-waiver", "plan.md", root);
    const report = buildRunReport(runtime, "no-waiver");
    expect(report).toMatchObject({ ok: true, value: { waiver_outcomes: { adopted: 0, unadjudicated: 0, entries: [] } } });
  });

  it("E-8: surfaces waiver-outcome totals reflecting a review-waived result", () => {
    const runtime = new ArborRuntime({ persistence_dir: temp() });
    runtime.manager.startCampaign("waived", "plan.md", root);
    const [child] = runtime.manager.branch("waived", "root", [{ ...root, description: "child", delegate_to: "seed" }]);
    if (!child) throw new Error("child setup failed");
    runtime.manager.expandNode("waived", child, { worktree_isolated: true, starting_commit_correct: true, lease_acquired: true });
    runtime.manager.recordResult("waived", child, {
      specialist_output: "done", specialist_agent: "seed",
      provenance: { tag: "verified", cmd: "pytest", exit: 0, stdout_hash: "sha256:test" },
      critic_agent: "lenticel", critic_approved: true, critic_rationale: "ok",
      review_waived: { by: "arbiter", reason: "low-risk" },
      score_ctx: { accuracy_regression_rate: 0, crash_regression_rate: 0, best_known: 0, total_visits: 1 },
    });

    const report = buildRunReport(runtime, "waived");
    expect(report).toMatchObject({
      ok: true,
      value: { waiver_outcomes: { adopted: 0, unadjudicated: 1 } },
    });
    if (report.ok) expect(report.value.waiver_outcomes.entries).toHaveLength(1);
  });
});
