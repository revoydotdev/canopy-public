import { describe, expect, it } from "vitest";
import { HarnessIntegrationRegistry, type ConnectorDescriptor } from "../src/index.js";

const descriptor = (id: string): ConnectorDescriptor => ({
  connector_id: id,
  implementation_version: "1",
  supported_upstream_range: "test",
  health: "healthy",
  capabilities: [{
    capability: "interruption",
    grade: "governed",
    evidence: { implementation_id: id, observed_at: "2026-08-13T00:00:00.000Z", detail: "fixture" },
  }],
});

describe("HarnessIntegrationRegistry", () => {
  it("returns only the implementation paired with the capability-selected descriptor", () => {
    const registry = new HarnessIntegrationRegistry<{ run(): string }>();
    registry.register(descriptor("plugin-b"), { run: () => "b" });
    registry.register(descriptor("plugin-a"), { run: () => "a" });
    const selected = registry.select([{ capability: "interruption", minimum_grade: "governed" }]);
    expect(selected.kind).toBe("selected");
    if (selected.kind !== "selected") throw new Error("unreachable");
    expect(selected.connector.connector_id).toBe("plugin-a");
    expect(selected.integration.run()).toBe("a");
  });

  it("isolates a degraded adapter from dispatch while keeping it inspectable", () => {
    const registry = new HarnessIntegrationRegistry<object>();
    registry.register(descriptor("plugin"), {});
    registry.connectors.setHealth("plugin", "degraded", "upstream drift");
    expect(registry.inspect("plugin")?.connector.diagnostic).toBe("upstream drift");
    expect(registry.select([{ capability: "interruption", minimum_grade: "governed" }])).toMatchObject({ kind: "unavailable", reason: "no_healthy_connector" });
  });
});
