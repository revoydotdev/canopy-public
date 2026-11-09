import { describe, expect, it } from "vitest";
import { loadConfigFromString } from "../src/index.js";

/**
 * A native session must not outlive its own credential grant.
 *
 * `ScopedNativeCredentialBroker` re-checks the lease on every dispatch and
 * issues no renewal, so a lease shorter than the session wall clock fails the
 * campaign mid-flight with
 * `ScopedCredentialLeaseError: credential lease unavailable: expired` — not at
 * a reviewable boundary.
 *
 * That combination was invisible while the only transport was a
 * subscription-auth CLI bridge: at ~2.5s per turn no session reached the 600s
 * lease. On a direct HTTP provider at ~0.6s per turn a single-function fix
 * legitimately runs past it, and the first campaign to do so failed. Neither
 * ceiling was operator-settable: composition passed neither `lease_ttl_ms`
 * nor `max_wall_clock_ms`.
 */
describe("native.credential_lease_ttl_ms", () => {
  it("is accepted within the broker's own 1h cap", () => {
    const config = loadConfigFromString('{ "native": { "credential_lease_ttl_ms": 1800000 } }');
    expect(config.native.credential_lease_ttl_ms).toBe(1_800_000);
  });

  it("stays absent unless an operator sets it, preserving the broker default", () => {
    expect(loadConfigFromString("{}").native.credential_lease_ttl_ms).toBeUndefined();
  });

  it("rejects a value outside 1000..3600000", () => {
    expect(() => loadConfigFromString('{ "native": { "credential_lease_ttl_ms": 999 } }')).toThrow();
    expect(() => loadConfigFromString('{ "native": { "credential_lease_ttl_ms": 3600001 } }')).toThrow();
    expect(() => loadConfigFromString('{ "native": { "credential_lease_ttl_ms": 0 } }')).toThrow();
    expect(() => loadConfigFromString('{ "native": { "credential_lease_ttl_ms": 1.5 } }')).toThrow();
  });

  it("refuses a lease shorter than the session it must cover", () => {
    expect(() => loadConfigFromString(
      '{ "native": { "credential_lease_ttl_ms": 600000, "max_session_wall_clock_ms": 1800000 } }',
    )).toThrow(/cannot outlive its credential lease/);
  });

  it("accepts a lease equal to the session ceiling", () => {
    const config = loadConfigFromString(
      '{ "native": { "credential_lease_ttl_ms": 1800000, "max_session_wall_clock_ms": 1800000 } }',
    );
    expect(config.native.credential_lease_ttl_ms).toBe(1_800_000);
    expect(config.native.max_session_wall_clock_ms).toBe(1_800_000);
  });

  it("does not constrain a session ceiling when no lease is configured", () => {
    // The broker default (600s) applies; the validator must not invent a
    // cross-field error for an operator who never touched the lease key.
    const config = loadConfigFromString('{ "native": { "max_session_wall_clock_ms": 1800000 } }');
    expect(config.native.max_session_wall_clock_ms).toBe(1_800_000);
    expect(config.native.credential_lease_ttl_ms).toBeUndefined();
  });
});
