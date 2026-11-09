import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CampaignManager } from "../src/manager.js";
import type { Action } from "@arbor/core";
import { ArborRuntime } from "../src/runtime.js";
import { RuntimeCatalogRouter, RUNTIME_CATALOG } from "../src/runtime-catalog.js";

const root: Action = { description: "root", estimated_gain: 1, estimated_cost: 1, category: "root", delegate_to: "crown" };

function compactionCommand(overrides: Record<string, unknown> = {}) {
  return {
    schema_version: 1,
    metadata: {
      operation_id: "compact-op-1",
      idempotency_key: "compact-key-1",
      correlation_id: "correlation-1",
      actor_id: "orchestrator",
      requested_at: "2026-08-01T00:00:00.000Z",
    },
    command: {
      kind: "compaction.record",
      campaign_id: "campaign",
      node_id: "node-a",
      lifecycle: {
        operation_id: "compact:1",
        trigger: "auto",
        strategy: "local_model",
        status: "completed",
        pre_evidence_id: "trace_abc",
        post_evidence_id: "trace_def",
        anchor_summary_id: "trace_xyz",
        reason: "token budget threshold exceeded",
        partial_evidence_ids: [],
        idempotency_key: "compact-key-1",
        as_of: "seq:100",
      },
      ...overrides,
    },
  };
}

function compactionListQuery(overrides: Record<string, unknown> = {}) {
  return {
    schema_version: 1,
    query_id: "query-1",
    query: {
      kind: "compaction.list",
      campaign_id: "campaign",
      node_id: undefined,
      ...overrides,
    },
  };
}

function compactionGuardQuery(overrides: Record<string, unknown> = {}) {
  return {
    schema_version: 1,
    query_id: "query-2",
    query: {
      kind: "compaction.guard",
      campaign_id: "campaign",
      node_id: "node-a",
      ...overrides,
    },
  };
}

describe("Compaction lifecycle manager API", () => {
  it("recordCompactionLifecycle stages→fsync→swaps like recordNodeCommunication; a persistence failure leaves no observable state", async () => {
    const dir = mkdtempSync(join(tmpdir(), "arbor-compaction-"));
    try {
      const manager = new CampaignManager({ persistence_dir: dir });
      manager.startCampaign("campaign", "plan.md", root);
      const id = manager.recordCompactionLifecycle({
        campaign_id: "campaign",
        node_id: "node-a",
        operation_id: "compact:1",
        trigger: "auto",
        strategy: "local_model",
        status: "completed",
        pre_evidence_id: "trace_abc",
        post_evidence_id: "trace_def",
        anchor_summary_id: "trace_xyz",
        reason: "token budget threshold exceeded",
        partial_evidence_ids: [],
        idempotency_key: "compact-key-1",
        as_of: "seq:100",
      });
      expect(id).toMatch(/^compaction_/);

      // Restore from persistence dir — record must survive restart
      const restored = new CampaignManager({ persistence_dir: dir });
      const records = restored.getCompactionLifecycles("campaign");
      expect(records).toHaveLength(1);
      expect(records[0].lifecycle.idempotency_key).toBe("compact-key-1");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("recordCompactionLifecycle is idempotent with same payload and conflicts on different payload", async () => {
    const manager = new CampaignManager();
    manager.startCampaign("campaign", "plan.md", root);
    const base = {
      campaign_id: "campaign",
      node_id: "node-a",
      operation_id: "compact:1",
      trigger: "auto" as const,
      strategy: "local_model" as const,
      status: "completed" as const,
      pre_evidence_id: "trace_abc",
      post_evidence_id: "trace_def",
      anchor_summary_id: "trace_xyz",
      reason: "token budget threshold exceeded",
      partial_evidence_ids: [],
      idempotency_key: "compact-key-1",
      as_of: "seq:100",
    };
    const id1 = manager.recordCompactionLifecycle(base);
    const id2 = manager.recordCompactionLifecycle(base);
    expect(id1).toBe(id2);
    expect(() =>
      manager.recordCompactionLifecycle({ ...base, operation_id: "compact:different" }),
    ).toThrow("idempotency conflict");
  });

  it("getCompactionGuard reconciles from ledger facts", async () => {
    const manager = new CampaignManager();
    manager.startCampaign("campaign", "plan.md", root);

    // No record → not active
    expect(manager.getCompactionGuard("campaign", "node-a")).toEqual({
      active: false,
      since: null,
    });

    // Completed → not active, with since
    manager.recordCompactionLifecycle({
      campaign_id: "campaign",
      node_id: "node-a",
      operation_id: "compact:1",
      trigger: "auto",
      strategy: "local_model",
      status: "completed",
      pre_evidence_id: "trace_abc",
      post_evidence_id: "trace_def",
      anchor_summary_id: null,
      reason: "completed successfully",
      partial_evidence_ids: [],
      idempotency_key: "compact-key-completed",
      as_of: new Date().toISOString(),
    });
    const completedGuard = manager.getCompactionGuard("campaign", "node-a");
    expect(completedGuard.active).toBe(false);
    expect(completedGuard.since).toBeTruthy();

    // Interrupted within window → active
    const recent = new Date().toISOString();
    manager.recordCompactionLifecycle({
      campaign_id: "campaign",
      node_id: "node-b",
      operation_id: "compact:2",
      trigger: "auto",
      strategy: "token_budget_fresh_window",
      status: "interrupted",
      pre_evidence_id: "trace_abc",
      post_evidence_id: null,
      anchor_summary_id: null,
      reason: "compaction interrupted by supervisor",
      partial_evidence_ids: ["trace_partial"],
      idempotency_key: "compact-key-interrupted",
      as_of: recent,
    });
    const interruptedGuard = manager.getCompactionGuard("campaign", "node-b");
    expect(interruptedGuard.active).toBe(true);
    expect(interruptedGuard.since).toBe(recent);

    // Interrupted outside window → not active
    const oldTimestamp = new Date(Date.now() - 600_000).toISOString(); // 10 min ago
    manager.recordCompactionLifecycle({
      campaign_id: "campaign",
      node_id: "node-c",
      operation_id: "compact:3",
      trigger: "manual",
      strategy: "structural_folding",
      status: "interrupted",
      pre_evidence_id: "trace_ghi",
      post_evidence_id: null,
      anchor_summary_id: null,
      reason: "compaction timed out",
      partial_evidence_ids: [],
      idempotency_key: "compact-key-stale",
      as_of: oldTimestamp,
    });
    const staleGuard = manager.getCompactionGuard("campaign", "node-c", 300_000);
    expect(staleGuard.active).toBe(false);
    expect(staleGuard.since).toBe(oldTimestamp);
  });

  it("catalog declares compaction entries", async () => {
    const commandKinds = RUNTIME_CATALOG.filter((e) => e.supported && e.direction === "command").map((e) => e.kind).sort();
    expect(commandKinds).toContain("compaction.record");

    const queryKinds = RUNTIME_CATALOG.filter((e) => e.supported && e.direction === "query").map((e) => e.kind).sort();
    expect(queryKinds).toContain("compaction.list");
    expect(queryKinds).toContain("compaction.guard");
  });

  it("capability gating: specialist-tier can read compaction but critic cannot write", async () => {
    const manager = new CampaignManager();
    manager.startCampaign("campaign", "plan.md", root);
    const runtime = new ArborRuntime({ manager });

    // Reader with compaction.read capability
    const reader = new RuntimeCatalogRouter(runtime, {
      granted_capabilities: new Set(["compaction.read"]),
    });
    expect(reader.executeQuery(compactionListQuery())).toMatchObject({ ok: true });
    expect(reader.executeQuery(compactionGuardQuery())).toMatchObject({ ok: true });

    // Writer with compaction.write capability
    const writer = new RuntimeCatalogRouter(runtime, {
      granted_capabilities: new Set(["compaction.write"]),
    });
    expect(await writer.dispatchCommand(compactionCommand())).toMatchObject({
      ok: true,
      value: { accepted: true },
      capability: "compaction.write",
    });

    // Critic without compaction.write → denied
    const critic = new RuntimeCatalogRouter(runtime, {
      granted_capabilities: new Set(["compaction.read"]),
    });
    expect(await critic.dispatchCommand(compactionCommand())).toMatchObject({
      ok: false,
      error: { code: "permission" },
    });
  });
});
