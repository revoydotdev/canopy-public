import { describe, expect, it } from "vitest";
import { ArborRuntime } from "../src/runtime.js";
import { CampaignManager } from "../src/manager.js";
import { RUNTIME_CATALOG, RuntimeCatalogRouter } from "../src/runtime-catalog.js";

const query = (query_id = "capability-query") => ({ schema_version: 1, query_id, query: { kind: "capability.introspect" } });

describe("capability.introspect", () => {
  it("reports the enforced catalog-derived action class, mutability, tier, and every tier entitlement", async () => {
    const manager = new CampaignManager();
    manager.startCampaign("probe-campaign", "plan.md", { description: "probe", estimated_gain: 1, estimated_cost: 1, category: "probe", delegate_to: "crown" });
    const router = new RuntimeCatalogRouter(new ArborRuntime({ manager }), { granted_capabilities: new Set(["capability.read"]), caller_tier: "junior" });
    // Exercise the same enforcement boundary before reading its projection:
    // a caller without campaign.write is denied, and introspection below must
    // describe campaign.start as the mutating senior-class action enforced.
    expect(await router.dispatchCommand({ schema_version: 1, metadata: { operation_id: "probe-op", idempotency_key: "probe-key", correlation_id: "probe-correlation", actor_id: "probe", requested_at: "2026-08-08T00:00:00.000Z" }, command: { kind: "tree.prune", campaign_id: "probe-campaign", node_id: "root" } })).toMatchObject({ ok: true, value: { accepted: false, error: { code: "permission" } } });
    const result = router.executeQuery(query());
    expect(result).toMatchObject({ ok: true, capability: "capability.read" });
    if (!result.ok) return;
    const value = result.value as { action_classes: string[]; catalog: Array<Record<string, unknown>>; tiers: Array<Record<string, unknown>> };
    expect(value.action_classes).toEqual(["read", "plan", "preview-confirm", "forbidden"]);
    expect(value.catalog).toHaveLength(RUNTIME_CATALOG.length);
    expect(value.catalog.find((entry) => entry.kind === "campaign.halt")).toMatchObject({ action_class: "preview-confirm", mutating: true, minimum_tier: "senior", supported: true });
    expect(value.catalog.find((entry) => entry.kind === "campaign.list")).toMatchObject({ action_class: "read", mutating: false, minimum_tier: "junior" });
    expect(value.tiers).toEqual([
      { tier: "junior", entitled_action_classes: ["read", "plan"] },
      { tier: "senior", entitled_action_classes: ["read", "plan", "preview-confirm"] },
    ]);
  });

  it("fails closed on absent capability and malformed query identity", async () => {
    const denied = new RuntimeCatalogRouter(new ArborRuntime({ manager: new CampaignManager() }), { granted_capabilities: new Set() });
    expect(denied.executeQuery(query())).toMatchObject({ ok: false, error: { code: "permission" }, capability: "capability.read" });
    const allowed = new RuntimeCatalogRouter(new ArborRuntime({ manager: new CampaignManager() }), { granted_capabilities: new Set(["capability.read"]) });
    expect(allowed.executeQuery(query("  "))).toMatchObject({ ok: false, error: { code: "validation" }, capability: "capability.read" });
  });
});
