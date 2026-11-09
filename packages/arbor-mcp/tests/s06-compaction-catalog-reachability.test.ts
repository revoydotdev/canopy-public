import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Action } from "@arbor/core";
import { ArborRuntime } from "../src/runtime.js";
import { ArborMCPServer } from "../src/server.js";
import { composeLoopConfigPorts } from "../src/loop-ports-helper.js";

/**
 * audit/2026-09-06-remediation/manifest.md, Declared capability gaps / Compaction:
 * "Real compaction producer -> nonempty evidence witness -> ledger ->
 * substantively changed projection."
 *
 * `compaction-lifecycle.test.ts` already proves the ledger/catalog wiring
 * against a HAND-WRITTEN lifecycle payload (fabricated evidence ids like
 * "trace_abc") dispatched straight at `RuntimeCatalogRouter`. That is a real
 * test of the router and ledger, but it is not a test of the declared
 * capability: nothing there ties the actual production producer (the
 * `structural_compaction` authority `loop-ports-helper.ts` composes, the one
 * `arbor-opencode`'s campaign loop calls at `compaction_every_iterations`
 * boundaries) to the client-facing catalog surface
 * (`ArborMCPServer.callTool("arbor_query"/"arbor_command", ...)`, the same
 * entry point `cli.ts`'s JSON-RPC methods and `webui.ts`'s HTTP routes use).
 *
 * This file closes that gap: it drives the REAL producer, then asserts the
 * SAME catalog query surface a client uses projects its real, non-fabricated
 * evidence witness, that the projection is empty before and non-empty after
 * (a substantive change, not a pre-seeded fixture), and that the lineage
 * survives a process restart.
 */

const root: Action = { description: "root", estimated_gain: 1, estimated_cost: 1, category: "root", delegate_to: "crown" };

function withServer(persistence: string): ArborMCPServer {
  return new ArborMCPServer(new ArborRuntime({ persistence_dir: persistence }));
}

function recordSteer(server: ArborMCPServer, content: string, key: string, asOf: string): void {
  server.manager.recordNodeCommunication({
    campaign_id: "camp", node_id: "root", author_node_id: "crown", recipient_node_id: "root",
    other_recipient_node_ids: [], kind: "steer",
    payload: { content, provenance: { tag: "claimed", claimant: "operator" } },
    capability_tier: "specialist", trigger_turn: false, as_of: asOf,
    correlation_id: key, idempotency_key: key, acknowledges_communication_id: null,
    retracts_communication_id: null, timestamp: asOf,
  });
}

describe("compaction.* is reachable from a real MCP client and reflects the real structural-compaction producer", () => {
  it("arbor_query projects the real producer's nonempty evidence witness, differs before/after, and survives restart", async () => {
    const persistence = mkdtempSync(join(tmpdir(), "arbor-s06-compaction-"));
    try {
      const server = withServer(persistence);
      server.manager.startCampaign("camp", "plan.md", root);
      recordSteer(server, "preserve this operator constraint", "fold-source", "2026-08-08T00:00:00.000Z");

      // Before: the client-facing catalog query surface shows nothing yet —
      // this is the "empty" half of the required before/after contrast.
      const before = (await server.callTool("arbor_query", { kind: "compaction.list", campaign_id: "camp", node_id: "root" })) as
        { ok: true; value: { records: unknown[] } };
      expect(before.ok).toBe(true);
      expect(before.value.records).toEqual([]);
      const guardBefore = (await server.callTool("arbor_query", { kind: "compaction.guard", campaign_id: "camp", node_id: "root" })) as
        { ok: true; value: { active: boolean; since: string | null } };
      expect(guardBefore.value).toMatchObject({ active: false, since: null });

      // The real producer: the exact `structural_compaction` authority
      // `arbor-opencode`'s campaign loop calls, not a fabricated payload.
      const ports = composeLoopConfigPorts(server.runtime);
      const result = await ports.structural_compaction.compact({ campaign_id: "camp", node_id: "root", iteration: 1 });
      expect(result.status).toBe("completed");
      if (result.status !== "completed") throw new Error("unreachable: asserted above");
      expect(result.pre_evidence_id).toMatch(/^audit:\/\/output-artifacts\/.+/);
      expect(result.post_evidence_id).toMatch(/^audit:\/\/output-artifacts\/.+/);
      expect(result.anchor_summary_id).toMatch(/^audit:\/\/output-artifacts\/.+/);

      // After: the identical catalog query surface now projects the real
      // record — same evidence ids the producer actually captured, not a
      // re-derived or coincidental value.
      const after = (await server.callTool("arbor_query", { kind: "compaction.list", campaign_id: "camp", node_id: "root" })) as
        { ok: true; value: { records: { id: string; lifecycle: Record<string, unknown> }[] } };
      expect(after.value.records).toHaveLength(1);
      const projected = after.value.records[0]!.lifecycle;
      expect(projected).toMatchObject({
        strategy: "structural_folding",
        status: "completed",
        pre_evidence_id: result.pre_evidence_id,
        post_evidence_id: result.post_evidence_id,
        anchor_summary_id: result.anchor_summary_id,
      });

      // Persisted lineage: a freshly constructed server (simulating a
      // restart) reconnecting through the same client surface sees the
      // identical record, not a process-local artifact.
      const restarted = withServer(persistence);
      const afterRestart = (await restarted.callTool("arbor_query", { kind: "compaction.list", campaign_id: "camp", node_id: "root" })) as
        { ok: true; value: { records: { lifecycle: Record<string, unknown> }[] } };
      expect(afterRestart.value.records).toHaveLength(1);
      expect(afterRestart.value.records[0]!.lifecycle).toMatchObject({
        idempotency_key: projected.idempotency_key,
        pre_evidence_id: result.pre_evidence_id,
        post_evidence_id: result.post_evidence_id,
      });
    } finally {
      rmSync(persistence, { recursive: true, force: true });
    }
  });

  it("arbor_query compaction.guard flips active on a real interrupted attempt, then clears once a real completed attempt lands", async () => {
    const persistence = mkdtempSync(join(tmpdir(), "arbor-s06-compaction-guard-"));
    try {
      const server = withServer(persistence);
      server.manager.startCampaign("camp", "plan.md", root);
      recordSteer(server, "do not lose this raw evidence", "cancel-source", "2026-08-08T00:00:00.000Z");

      const ports = composeLoopConfigPorts(server.runtime);
      const controller = new AbortController();
      controller.abort("operator cancelled compaction");
      const interrupted = await ports.structural_compaction.compact({ campaign_id: "camp", node_id: "root", iteration: 1, signal: controller.signal });
      expect(interrupted).toMatchObject({ status: "interrupted", reason: "operator cancelled compaction" });

      const guardActive = (await server.callTool("arbor_query", { kind: "compaction.guard", campaign_id: "camp", node_id: "root" })) as
        { ok: true; value: { active: boolean; since: string | null } };
      expect(guardActive.value.active).toBe(true);
      expect(guardActive.value.since).not.toBeNull();

      // A real completed attempt (same producer, no cancellation this time)
      // clears the guard — the catalog projection changes again, driven
      // purely by real producer outcomes.
      const completed = await ports.structural_compaction.compact({ campaign_id: "camp", node_id: "root", iteration: 2 });
      expect(completed.status).toBe("completed");
      const guardCleared = (await server.callTool("arbor_query", { kind: "compaction.guard", campaign_id: "camp", node_id: "root" })) as
        { ok: true; value: { active: boolean; since: string | null } };
      expect(guardCleared.value.active).toBe(false);
    } finally {
      rmSync(persistence, { recursive: true, force: true });
    }
  });

  it("arbor_command dispatches compaction.record — the manual operator path the TUI Compaction screen's '/' action submits", async () => {
    const persistence = mkdtempSync(join(tmpdir(), "arbor-s06-compaction-manual-"));
    try {
      const server = withServer(persistence);
      server.manager.startCampaign("camp", "plan.md", root);

      const response = (await server.callTool("arbor_command", {
        kind: "compaction.record",
        campaign_id: "camp",
        node_id: "root",
        lifecycle: {
          operation_id: "manual-compact:1",
          trigger: "manual",
          strategy: "local_model",
          status: "completed",
          pre_evidence_id: "audit://output-artifacts/manual-pre",
          post_evidence_id: "audit://output-artifacts/manual-post",
          anchor_summary_id: "audit://output-artifacts/manual-post",
          reason: "operator-triggered compaction via Compaction screen",
          partial_evidence_ids: [],
          idempotency_key: "manual-compact-key-1",
          as_of: "2026-08-08T00:00:00.000Z",
        },
      })) as { ok: true; value: { accepted: boolean } };
      expect(response.ok).toBe(true);
      expect(response.value.accepted).toBe(true);

      const list = (await server.callTool("arbor_query", { kind: "compaction.list", campaign_id: "camp", node_id: "root" })) as
        { ok: true; value: { records: { lifecycle: Record<string, unknown> }[] } };
      expect(list.value.records).toHaveLength(1);
      expect(list.value.records[0]!.lifecycle).toMatchObject({ trigger: "manual", idempotency_key: "manual-compact-key-1" });
    } finally {
      rmSync(persistence, { recursive: true, force: true });
    }
  });
});
