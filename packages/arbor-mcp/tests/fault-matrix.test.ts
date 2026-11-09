import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Action } from "@arbor/core";
import { ArborRuntime, CampaignManager, RuntimeCatalogRouter, mapRuntimeBoundaryError } from "../src/index.js";

const metadata = {
  operation_id: "operation-fault", idempotency_key: "fault-key", correlation_id: "correlation-fault",
  actor_id: "operator", requested_at: "2026-08-01T00:00:00.000Z",
};
const root: Action = { description: "root", estimated_gain: 1, estimated_cost: 1, category: "root", delegate_to: "crown" };

describe("runtime structured-error fault matrix", () => {
  it.each([
    [Object.assign(new Error("specialist timed out"), { code: "ETIMEDOUT" }), "timeout", true],
    [Object.assign(new Error("transport disconnected"), { code: "ECONNRESET" }), "transport", true],
    [new Error("audit hash chain mismatch"), "corrupt_data", true],
    [new Error("critic service unavailable"), "unavailable", true],
    [new Error("duplicate idempotency key"), "conflict", true],
    [new Error("unexpected invariant failure"), "internal", false],
  ] as const)("maps %s to %s with truthful retryability", (failure, code, recoverable) => {
    expect(mapRuntimeBoundaryError(failure, metadata)).toMatchObject({
      code, recoverable, operation_id: metadata.operation_id, correlation_id: metadata.correlation_id,
      source: "runtime_catalog_router", summary: failure.message,
    });
  });

  it("never throws when a command dependency times out and preserves operation correlation", async () => {
    const manager = new CampaignManager();
    manager.startCampaign("campaign", "plan.md", root);
    manager.prune = (() => { throw Object.assign(new Error("specialist timed out"), { code: "ETIMEDOUT" }); }) as typeof manager.prune;
    const router = new RuntimeCatalogRouter(new ArborRuntime({ manager }));
    const result = await router.dispatchCommand({
      schema_version: 1, metadata,
      command: { kind: "tree.prune", campaign_id: "campaign", node_id: "root" },
    });
    expect(result).toMatchObject({ ok: true, value: { accepted: false, error: {
      code: "timeout", recoverable: true, operation_id: "operation-fault", correlation_id: "correlation-fault",
    } } });
  });

  it("does not let a secondary operation-registry failure escape the command boundary", async () => {
    const manager = new CampaignManager();
    manager.startCampaign("campaign", "plan.md", root);
    const runtime = new ArborRuntime({ manager });
    const originalReject = runtime.operations.reject.bind(runtime.operations);
    runtime.operations.reject = (() => { throw new Error("requires reconciliation"); }) as typeof runtime.operations.reject;
    manager.prune = (() => { throw Object.assign(new Error("connection reset"), { code: "ECONNRESET" }); }) as typeof manager.prune;
    const router = new RuntimeCatalogRouter(runtime);
    await expect(router.dispatchCommand({ schema_version: 1, metadata, command: { kind: "tree.prune", campaign_id: "campaign", node_id: "root" } })).resolves.toBeDefined();
    await expect(router.dispatchCommand({ schema_version: 1, metadata: { ...metadata, operation_id: "second", idempotency_key: "second" }, command: { kind: "tree.prune", campaign_id: "campaign", node_id: "root" } }))
      .resolves.toMatchObject({ ok: true, value: { accepted: false, error: { code: "transport" } } });
    runtime.operations.reject = originalReject;
  });

  it("reports duplicate-operation conflicts without invoking the domain mutation twice", async () => {
    const manager = new CampaignManager();
    manager.startCampaign("campaign", "plan.md", root);
    const child = manager.branch("campaign", "root", [{ ...root, description: "child" }])[0]!;
    const router = new RuntimeCatalogRouter(new ArborRuntime({ manager }));
    const first = { schema_version: 1 as const, metadata, command: { kind: "tree.prune" as const, campaign_id: "campaign", node_id: child } };
    await expect(router.dispatchCommand(first)).resolves.toMatchObject({ ok: true, value: { accepted: true } });
    await expect(router.dispatchCommand({ ...first, command: { ...first.command, node_id: "root" } })).resolves.toMatchObject({
      ok: false, error: { code: "conflict", recoverable: true, operation_id: "operation-fault", correlation_id: "correlation-fault" },
    });
  });

  it("surfaces corrupt persistence and partial lifecycle failure as structured health diagnostics", async () => {
    const dir = mkdtempSync(join(tmpdir(), "arbor-fault-matrix-"));
    try {
      mkdirSync(join(dir, "operations"), { recursive: true });
      writeFileSync(join(dir, "operations", "registry.json"), "{");
      const runtime = new ArborRuntime({
        persistence_dir: dir,
        lifecycle: [
          { name: "healthy", start: () => undefined, close: () => undefined },
          { name: "transport", start: () => { throw new Error("offline"); } },
        ],
      });
      const start = await runtime.start();
      expect(start).toMatchObject({ ok: false, value: { state: "failed", healthy: false } });
      expect(start.failures).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: "corrupt_data", source: "operation_persistence", recoverable: true }),
        expect.objectContaining({ code: "unavailable", source: "transport", recoverable: true }),
      ]));
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
