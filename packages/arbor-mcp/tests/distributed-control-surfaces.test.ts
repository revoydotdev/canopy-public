import { describe, expect, it } from "vitest";
import { ArborRuntime } from "../src/runtime.js";
import { RUNTIME_CATALOG, RuntimeCatalogRouter } from "../src/runtime-catalog.js";
import { ArborWebUIServer } from "../src/webui.js";

describe("distributed control operator surfaces", () => {
  it("publishes three capability-gated catalog queries and actionable disabled projections", () => {
    expect(RUNTIME_CATALOG.filter((entry) => entry.kind.startsWith("control."))).toEqual([
      expect.objectContaining({ kind: "control.status", capability: "control.read", supported: true }),
      expect.objectContaining({ kind: "control.discover", capability: "control.read", supported: true }),
      expect.objectContaining({ kind: "control.inbox", capability: "control.read", supported: true }),
    ]);
    const router = new RuntimeCatalogRouter(new ArborRuntime());
    for (const kind of ["control.status", "control.discover", "control.inbox"] as const) expect(router.executeQuery({ schema_version: 1, query_id: kind, query: { kind, ...(kind === "control.status" ? {} : { limit: 20 }) } })).toMatchObject({ ok: true, capability: "control.read", value: { availability: "disabled", kind, remediation: expect.stringContaining("ARBOR_DISTRIBUTED_CONTROL_CONFIG") } });
    expect(router.executeQuery({ schema_version: 1, query_id: "bad", query: { kind: "control.inbox", limit: 101 } })).toMatchObject({ ok: false, error: { code: "validation" } });
    const denied = new RuntimeCatalogRouter(new ArborRuntime(), { granted_capabilities: new Set(["campaign.read"]) }); expect(denied.executeQuery({ schema_version: 1, query_id: "denied", query: { kind: "control.status" } })).toMatchObject({ ok: false, error: { code: "permission" } });
  });

  it("serves a real Web panel with status, discovery, inbox actions and disabled guidance", async () => {
    const server = new ArborWebUIServer(new ArborRuntime()); await new Promise<void>((resolve) => server.start(0, resolve));
    try { const html = await (await fetch(`http://127.0.0.1:${server.getPort()}/`)).text(); expect(html).toContain('id="flight-control"'); expect(html).toContain("refreshFlightControl(\\'control.status\\')"); expect(html).toContain("refreshFlightControl(\\'control.discover\\')"); expect(html).toContain("refreshFlightControl(\\'control.inbox\\')"); expect(html).toContain("ARBOR_DISTRIBUTED_CONTROL_CONFIG"); }
    finally { await server.stop(); }
  });
});
