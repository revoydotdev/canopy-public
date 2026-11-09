import { describe, expect, it, vi } from "vitest";
import { ProductIntegrationControlPlane, builtinProductIntegrations } from "../src/product-integrations.js";
import { ArborRuntime } from "../src/runtime.js";
import { RuntimeCatalogRouter } from "../src/runtime-catalog.js";
import { ConnectorRegistry } from "@arbor/harness";

describe("product integration control plane", () => {
  it("never manufactures a browser and admits only enabled composed capabilities", () => {
    const plane = new ProductIntegrationControlPlane();
    for (const descriptor of builtinProductIntegrations({ remote_ready: false, scheduler_ready: false })) plane.register(descriptor);
    expect(plane.admit("browser.uncomposed", ["browser.observe"])).toMatchObject({ admitted: false, reason: expect.stringContaining("not enabled") });
    plane.register({ id: "browser.fixture", kind: "browser", version: "1.0.0", capabilities: ["browser.observe", "web.research"], permissions: ["network"], dependencies: [], handoff: { kind: "none", value: null }, health: { status: "ready", detail: "fixture host" } });
    expect(() => plane.setState("browser.fixture", "enabled")).toThrow("acknowledgement");
    plane.setState("browser.fixture", "enabled", true);
    expect(plane.admit("browser.fixture", ["browser.observe", "web.research"])).toMatchObject({ admitted: true });
    expect(plane.admit("browser.fixture", ["computer.use"])).toMatchObject({ admitted: false, reason: expect.stringContaining("not declared") });
  });

  it("requires an acknowledgement before OAuth/publish integrations activate or update", () => {
    const plane = new ProductIntegrationControlPlane();
    plane.register({ id: "github.fixture", kind: "github", version: "1.0.0", capabilities: ["pull_request_handoff"], permissions: ["oauth", "external_publish"], dependencies: [], handoff: { kind: "command", value: "handoff" }, health: { status: "ready", detail: "fixture" } });
    expect(() => plane.setState("github.fixture", "enabled")).toThrow("acknowledgement");
    expect(plane.setState("github.fixture", "enabled", true)).toMatchObject({ state: "enabled" });
    expect(() => plane.update("github.fixture", "1.0.1")).toThrow("acknowledgement");
    expect(plane.update("github.fixture", "1.0.1", true)).toMatchObject({ version: "1.0.1" });
    expect(plane.rollback("github.fixture", true)).toMatchObject({ version: "1.0.0", state: "enabled" });
  });

  it("rolls in-memory state back when durable integration persistence fails", () => {
    const plane = new ProductIntegrationControlPlane();
    plane.register({ id: "ide.fixture", kind: "ide", version: "1.0.0", capabilities: ["handoff"], permissions: [], dependencies: [], handoff: { kind: "none", value: null }, health: { status: "ready", detail: "fixture" } });
    vi.spyOn(plane as never as { persist(): void }, "persist").mockImplementation(() => { throw new Error("disk unavailable"); });
    expect(() => plane.setState("ide.fixture", "enabled")).toThrow("disk unavailable");
    expect(plane.inspect("ide.fixture")).toMatchObject({ state: "discovered" });
  });

  it("routes remote and scheduler mutations to their composed authorities", async () => {
    const remote = { list: () => [{ session_id: "remote-1", actor_id: "operator" }], revokeSession: vi.fn() };
    const scheduler = { list: () => [{ schedule_id: "schedule-1" }], runHistory: () => [], suspendForHuman: vi.fn(), resume: vi.fn() };
    const runtime = new ArborRuntime({ remote_session_authority: remote as never, long_horizon_scheduler: scheduler as never });
    const router = new RuntimeCatalogRouter(runtime);
    const metadata = { operation_id: "control-op", idempotency_key: "control-key", correlation_id: "control", actor_id: "operator", requested_at: "2026-08-20T00:00:00.000Z" };
    expect(router.executeQuery({ schema_version: 1, query_id: "remote-control", query: { kind: "remote.inspect" } } as never)).toMatchObject({ ok: true, value: { sessions: [{ session_id: "remote-1" }] } });
    await expect(router.dispatchCommand({ schema_version: 1, metadata, command: { kind: "remote.control", action: "revoke", session_id: "remote-1", acknowledge_risk: false, provenance: { tag: "claimed", claimant: "operator" } } } as never)).resolves.toMatchObject({ ok: true });
    await expect(router.dispatchCommand({ schema_version: 1, metadata: { ...metadata, operation_id: "schedule-op", idempotency_key: "schedule-key" }, command: { kind: "scheduler.control", action: "suspend", schedule_id: "schedule-1", reason: "operator review", acknowledge_risk: false, provenance: { tag: "claimed", claimant: "operator" } } } as never)).resolves.toMatchObject({ ok: true });
    expect(remote.revokeSession).toHaveBeenCalledWith("remote-1"); expect(scheduler.suspendForHuman).toHaveBeenCalledWith("schedule-1", "operator review");
  });

  it("discovers only declared browser capabilities from the composed connector registry", async () => {
    const connectors = new ConnectorRegistry();
    connectors.register({ connector_id: "browser-fixture", implementation_version: "1.0.0", supported_upstream_range: "fixture", health: "healthy", capabilities: [
      { capability: "browser_observe", grade: "governed", evidence: { implementation_id: "browser-fixture", observed_at: "2026-08-20T00:00:00.000Z", detail: "explicit browser port" } },
      { capability: "web_research", grade: "governed", evidence: { implementation_id: "browser-fixture", observed_at: "2026-08-20T00:00:00.000Z", detail: "explicit research port" } },
    ] });
    const runtime = new ArborRuntime({ harness_connector_registry: connectors }); const router = new RuntimeCatalogRouter(runtime);
    const listed = router.executeQuery({ schema_version: 1, query_id: "browser-list", query: { kind: "integration.list", category: "browser" } } as never);
    expect(listed).toMatchObject({ ok: true, value: { integrations: expect.arrayContaining([expect.objectContaining({ capabilities: ["browser_observe", "web_research"], state: "discovered" })]) } });
    if (!listed.ok) throw new Error("integration.list failed"); const browserId = (listed.value as { integrations: readonly { id: string }[] }).integrations.find((item) => item.id !== "browser.uncomposed")!.id;
    const metadata = { operation_id: "browser-enable", idempotency_key: "browser-enable", correlation_id: "browser", actor_id: "operator", requested_at: "2026-08-20T00:00:00.000Z" };
    await expect(router.dispatchCommand({ schema_version: 1, metadata, command: { kind: "integration.enable", integration_id: browserId, acknowledge_risk: true, provenance: { tag: "claimed", claimant: "operator" } } } as never)).resolves.toMatchObject({ ok: true });
    expect(router.executeQuery({ schema_version: 1, query_id: "browser-admit", query: { kind: "integration.admit", integration_id: browserId, capabilities: ["browser_observe", "web_research"] } } as never)).toMatchObject({ ok: true, value: { admitted: true } });
  });
});
