import { describe, expect, it } from "vitest";

import {
  type CapabilityClock,
  type CapabilityRequirement,
  type CapabilitySupport,
  negotiateCapabilities,
} from "../src/capabilities.js";
import { ConnectorRegistry } from "../src/connector-registry.js";
import { InMemoryCredentialLeaseBroker, type CredentialClock } from "../src/credential-broker.js";

class FixedClock implements CapabilityClock, CredentialClock {
  constructor(private value: Date) {}
  now(): Date { return new Date(this.value); }
  set(value: string): void { this.value = new Date(value); }
}

const observedAt = "2026-08-09T12:00:00.000Z";
const support = (capability: CapabilitySupport["capability"], grade: CapabilitySupport["grade"] = "governed"): CapabilitySupport => ({
  capability,
  grade,
  evidence: { implementation_id: "synthetic-v1", observed_at: observedAt, detail: "synthetic conformance evidence" },
});

describe("capability negotiation", () => {
  it("uses the closed grades, evidence freshness, and enforcement threshold", () => {
    const clock = new FixedClock(new Date("2026-08-09T12:00:30.000Z"));
    const requirements: CapabilityRequirement[] = [
      { capability: "interruption", minimum_grade: "governed", max_evidence_age_ms: 60_000 },
      { capability: "structured_output", minimum_grade: "native" },
    ];
    const result = negotiateCapabilities(requirements, [support("interruption"), support("structured_output", "observed")], clock);
    expect(result.admitted).toBe(false);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0]).toMatchObject({ reason: "insufficient_grade", requirement: { capability: "structured_output" } });
  });

  it("rejects stale and absent evidence explicitly", () => {
    const clock = new FixedClock(new Date("2026-08-09T12:02:00.000Z"));
    const result = negotiateCapabilities([
      { capability: "streaming", minimum_grade: "observed", max_evidence_age_ms: 1_000 },
      { capability: "forking", minimum_grade: "observed" },
    ], [support("streaming", "native")], clock);
    expect(result.admitted).toBe(false);
    expect(result.rejected.map((entry) => entry.reason)).toEqual(["stale_evidence", "missing_capability"]);
  });

  it("does not admit a connector that explicitly reports a capability unsupported", () => {
    const result = negotiateCapabilities(
      [{ capability: "streaming", minimum_grade: "observed" }],
      [support("streaming", "unsupported")],
    );
    expect(result).toMatchObject({ admitted: false, rejected: [{ reason: "insufficient_grade" }] });
  });
});

describe("connector registry", () => {
  it("selects a healthy connector and contains drift to the affected connector", () => {
    const clock = new FixedClock(new Date("2026-08-09T12:00:30.000Z"));
    const registry = new ConnectorRegistry(clock);
    registry.register({ connector_id: "native", implementation_version: "0.1.0", supported_upstream_range: "revoy-owned", health: "healthy", capabilities: [support("streaming", "native"), support("interruption", "native")] });
    registry.register({ connector_id: "drifting", implementation_version: "1.0.0", supported_upstream_range: "^9", health: "healthy", capabilities: [support("streaming")] });
    registry.setHealth("drifting", "degraded", "upstream contract changed");

    const selected = registry.select([{ capability: "interruption", minimum_grade: "native" }]);
    expect(selected).toMatchObject({ kind: "selected", connector: { connector_id: "native" } });
    expect(registry.inspect("drifting")).toMatchObject({ health: "degraded", diagnostic: "upstream contract changed" });
  });

  it("does not dispatch when health or requirements are not satisfied", () => {
    const registry = new ConnectorRegistry(new FixedClock(new Date("2026-08-09T12:00:30.000Z")));
    registry.register({ connector_id: "opaque", implementation_version: "1", supported_upstream_range: "*", health: "unavailable", capabilities: [support("streaming")] });
    expect(registry.select([{ capability: "streaming", minimum_grade: "observed" }])).toMatchObject({ kind: "unavailable", reason: "no_healthy_connector" });
    registry.setHealth("opaque", "healthy");
    expect(registry.select([{ capability: "interruption", minimum_grade: "governed" }])).toMatchObject({ kind: "unavailable", reason: "requirements_unsatisfied" });
  });

  it("prefers the strongest satisfying connector instead of connector-name order", () => {
    const registry = new ConnectorRegistry(new FixedClock(new Date("2026-08-09T12:00:30.000Z")));
    registry.register({ connector_id: "a-observer", implementation_version: "1", supported_upstream_range: "*", health: "healthy", capabilities: [support("streaming", "observed")] });
    registry.register({ connector_id: "z-native", implementation_version: "1", supported_upstream_range: "revoy-owned", health: "healthy", capabilities: [support("streaming", "native")] });
    expect(registry.select([{ capability: "streaming", minimum_grade: "observed" }])).toMatchObject({
      kind: "selected", connector: { connector_id: "z-native" },
    });
  });

  it("copies published data and refuses duplicate capability declarations", () => {
    const registry = new ConnectorRegistry(new FixedClock(new Date("2026-08-09T12:00:30.000Z")));
    const capability = support("artifact_capture");
    registry.register({ connector_id: "copy", implementation_version: "1", supported_upstream_range: "*", health: "healthy", capabilities: [capability] });
    (capability.evidence as { detail: string }).detail = "mutated outside";
    expect(registry.inspect("copy")!.capabilities[0]!.evidence.detail).toBe("synthetic conformance evidence");
    expect(() => registry.register({ connector_id: "bad", implementation_version: "1", supported_upstream_range: "*", health: "healthy", capabilities: [support("streaming"), support("streaming")] })).toThrow(/more than once/);
  });
});

describe("opaque credential lease broker", () => {
  it("rejects zero-scope credentials and lease requirements", () => {
    const broker = new InMemoryCredentialLeaseBroker();
    expect(() => broker.register({ provider_id: "provider", account_id: "account", scopes: [], secret: "secret" })).toThrow(/non-empty/);
    broker.register({ provider_id: "provider", account_id: "account", scopes: ["chat"], secret: "secret" });
    expect(() => broker.issue({ provider_id: "provider", account_id: "account", scopes: [], session_id: "session", expires_at: "2099-01-01T00:00:00.000Z" })).toThrow(/non-empty/);
  });
  it("issues session-scoped, secret-free leases and injects only to the owner", () => {
    const clock = new FixedClock(new Date("2026-08-09T12:00:00.000Z"));
    const broker = new InMemoryCredentialLeaseBroker(clock);
    broker.register({ provider_id: "provider", account_id: "account", scopes: ["chat", "files"], secret: "do-not-log" });
    const issued = broker.issue({ provider_id: "provider", account_id: "account", scopes: ["chat"], session_id: "session-a", expires_at: "2026-08-09T13:00:00.000Z", spend_ceiling: { currency: "USD", minor_units: 12 } });
    if (!issued.issued) throw new Error("expected a test lease");
    expect(JSON.stringify(issued.lease)).not.toContain("do-not-log");
    expect(broker.inject(issued.lease.lease_id, "session-b", () => { throw new Error("must not inject"); })).toMatchObject({ available: false, absence: "session_mismatch" });
    let injected = "";
    expect(broker.inject(issued.lease.lease_id, "session-a", (secret) => { injected = secret; })).toMatchObject({ available: true });
    expect(injected).toBe("do-not-log");
  });

  it("reports missing scopes, expiry, revocation, and spend ceiling as explicit absence", () => {
    const clock = new FixedClock(new Date("2026-08-09T12:00:00.000Z"));
    const broker = new InMemoryCredentialLeaseBroker(clock);
    broker.register({ provider_id: "provider", account_id: "account", scopes: ["chat"], secret: "secret" });
    expect(broker.issue({ provider_id: "provider", account_id: "account", scopes: ["admin"], session_id: "s", expires_at: "2026-08-09T13:00:00.000Z" })).toMatchObject({ issued: false, absence: "scope_denied" });
    const issued = broker.issue({ provider_id: "provider", account_id: "account", scopes: ["chat"], session_id: "s", expires_at: "2026-08-09T12:01:00.000Z", spend_ceiling: { currency: "USD", minor_units: 2 } });
    if (!issued.issued) throw new Error("expected a test lease");
    expect(broker.reserveSpend(issued.lease.lease_id, { currency: "USD", minor_units: 3 }, "s")).toMatchObject({ available: false, absence: "spend_ceiling_exceeded" });
    expect(broker.revoke(issued.lease.lease_id)).toMatchObject({ available: false, absence: "revoked" });
    clock.set("2026-08-09T12:02:00.000Z");
    expect(broker.inspect(issued.lease.lease_id, "s")).toMatchObject({ available: false, absence: "revoked" });
  });
});
