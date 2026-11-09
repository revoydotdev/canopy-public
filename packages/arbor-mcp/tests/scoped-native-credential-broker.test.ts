import { describe, expect, it } from "vitest";
import { resolveNativeCredentialOverlay } from "@arbor/config";
import { ScopedCredentialLeaseError, ScopedNativeCredentialBroker } from "../src/scoped-native-credential-broker.js";

class Clock {
  current = new Date("2026-08-09T00:00:00.000Z");
  now(): Date { return new Date(this.current); }
  advance(milliseconds: number): void { this.current = new Date(this.current.getTime() + milliseconds); }
}

describe("ScopedNativeCredentialBroker", () => {
  it("issues an opaque model-only lease scoped to one native session", async () => {
    const clock = new Clock();
    const broker = new ScopedNativeCredentialBroker({ provider_id: "provider", account_id: "account", read_secret: () => "not-in-events", clock, lease_ttl_ms: 60_000 });
    const lease = broker.modelCredentialForSession({ session_id: "session-a", operation: "specialize", campaign_id: "campaign", node_id: "node" });

    expect(lease).toBeDefined();
    expect(lease).toMatchObject({ lease_id: expect.stringContaining("credential-lease-") });
    expect(JSON.stringify(lease)).not.toContain("not-in-events");
    await expect(lease!.inject(async (secret) => `received:${secret}`)).resolves.toBe("received:not-in-events");
    expect(broker.context_redactor.redact("echo not-in-events")).toBe("echo [REDACTED]");
    expect(JSON.stringify(broker.context_redactor)).not.toContain("not-in-events");
  });

  it("fails closed when the bounded lease has expired", async () => {
    const clock = new Clock();
    const broker = new ScopedNativeCredentialBroker({ provider_id: "provider", account_id: "account", read_secret: () => "secret", clock, lease_ttl_ms: 10 });
    const lease = broker.modelCredentialForSession({ session_id: "session-a", operation: "review", campaign_id: "campaign", node_id: "node" });
    clock.advance(11);
    await expect(lease!.inject(async () => "must not run")).rejects.toBeInstanceOf(ScopedCredentialLeaseError);
  });

  it("rechecks source expiry before each lease injection", async () => {
    let available = true;
    let recipientCalls = 0;
    const broker = new ScopedNativeCredentialBroker({
      provider_id: "provider", account_id: "account", read_secret: () => "short-lived-token",
      credential_available: () => available,
    });
    const lease = broker.modelCredentialForSession({ session_id: "session-a", operation: "specialize", campaign_id: "campaign", node_id: "node" });
    await expect(lease!.inject(async () => { recipientCalls++; return "ok"; })).resolves.toBe("ok");
    available = false;
    await expect(lease!.inject(async () => { recipientCalls++; return "should not run"; })).rejects.toBeInstanceOf(ScopedCredentialLeaseError);
    expect(recipientCalls).toBe(1);
  });

  it("blocks a primary native session lease when its OpenAI WIF token expires", async () => {
    const clock = new Clock();
    const expiresAt = Math.floor(clock.now().getTime() / 1000) + 3600;
    const credential = resolveNativeCredentialOverlay({
      credential_source: "openai_wif", provider_id: "openai", adapter_id: "openai-compatible", base_url: "https://api.openai.com/v1",
      env: { OPENAI_WIF_ACCESS_TOKEN: "short-lived-token", OPENAI_WIF_EXPIRES_AT: String(expiresAt) }, clock,
    }).overlay;
    const broker = credential.inject((secret) => new ScopedNativeCredentialBroker({
      provider_id: "openai", account_id: "default", read_secret: () => secret,
      credential_available: () => credential.inject(() => true) === true,
    }));
    const lease = broker!.modelCredentialForSession({ session_id: "session-a", operation: "specialize", campaign_id: "campaign", node_id: "node" });
    await expect(lease!.inject(async (secret) => secret)).resolves.toBe("short-lived-token");
    clock.advance(3_600_000);
    await expect(lease!.inject(async (secret) => secret)).rejects.toBeInstanceOf(ScopedCredentialLeaseError);
  });

  it("rejects invalid scope, identity, and unbounded lease configuration at composition time", () => {
    expect(() => new ScopedNativeCredentialBroker({ provider_id: "", account_id: "account", read_secret: () => "secret" })).toThrow("provider_id");
    expect(() => new ScopedNativeCredentialBroker({ provider_id: "provider", account_id: "account", read_secret: () => "secret", scopes: [] })).toThrow("credential scopes");
    expect(() => new ScopedNativeCredentialBroker({ provider_id: "provider", account_id: "account", read_secret: () => "secret", lease_ttl_ms: 3_600_001 })).toThrow("lease_ttl_ms");
  });

});
