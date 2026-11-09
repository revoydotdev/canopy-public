import { describe, it, expect } from "vitest";
import { CanopyLaneUnavailableError, parseCampaignExecutorRequest, resolveCampaignExecutorLane } from "../src/campaign-executor-lane.js";
import { DeprecatedHarnessRefusal } from "../src/canopy-lane-policy.js";

const noOptIn = { config: {} } as const;
const optedIn = { config: { connectors: { allow_deprecated: true, reason: "comparing opencode against Canopy" } } } as const;

describe("campaign executor lane (ADR-142, Canopy-only amendment to ADR-061)", () => {
  it("defaults to the native harness when it is available", () => {
    const resolved = resolveCampaignExecutorLane({ native_available: true, ...noOptIn });
    expect(resolved.lane).toBe("native");
    expect(resolved.requested).toBe("default");
    expect(resolved.deprecated_admission).toBeUndefined();
  });

  it("never falls back to a connector when the native lane is unavailable, and says why", () => {
    const resolve = () => resolveCampaignExecutorLane({
      native_available: false,
      native_unavailable_reason: "no credential for the configured provider",
      ...noOptIn,
    });
    expect(resolve).toThrow(CanopyLaneUnavailableError);
    expect(resolve).toThrow(/no credential for the configured provider.*no connector fallback/s);
  });

  it("does not fall back even when the deprecated-lane opt-in is set: the opt-in admits an explicit choice, not a default", () => {
    expect(() => resolveCampaignExecutorLane({ native_available: false, ...optedIn })).toThrow(CanopyLaneUnavailableError);
  });

  it("still names a reason when the composition root supplies none", () => {
    expect(() => resolveCampaignExecutorLane({ native_available: false, ...noOptIn })).toThrow(/no reason was supplied/);
  });

  it("refuses an explicit opencode request without the opt-in, with the typed ADR-179 remedy", () => {
    let caught: unknown;
    try { resolveCampaignExecutorLane({ requested: "opencode", native_available: true, ...noOptIn }); } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(DeprecatedHarnessRefusal);
    const refusal = (caught as DeprecatedHarnessRefusal).refusal;
    expect(refusal).toMatchObject({
      schema_version: 2, kind: "gate.refusal", state: "refused", gate: "capability",
      code: "deprecated_harness_lane", correcting_actor: "operator", corrective_action: "grant_capability",
    });
    expect(refusal.summary).toContain("--executor opencode");
    expect(refusal.remediation).toContain("connectors.allow_deprecated: true");
  });

  it("admits an explicit opencode request with the opt-in and carries the reason forward as evidence", () => {
    const resolved = resolveCampaignExecutorLane({ requested: "opencode", native_available: true, ...optedIn });
    expect(resolved.lane).toBe("opencode");
    expect(resolved.deprecated_admission).toEqual({ lane: "opencode", site: "--executor opencode", reason: "comparing opencode against Canopy" });
    expect(resolved.reason).toContain("comparing opencode against Canopy");
  });

  it("honours an explicit deterministic request", () => {
    const resolved = resolveCampaignExecutorLane({ requested: "deterministic", native_available: false, ...noOptIn });
    expect(resolved.lane).toBe("deterministic");
  });

  it("treats the deprecated `real` alias as the default, not as opencode", () => {
    const resolved = resolveCampaignExecutorLane({ requested: "real", native_available: true, ...noOptIn });
    expect(resolved.lane).toBe("native");
    expect(resolved.requested).toBe("default");
  });

  it("rejects an unknown lane rather than silently defaulting", () => {
    expect(() => parseCampaignExecutorRequest("openocde")).toThrow(/unknown --executor/);
    expect(parseCampaignExecutorRequest(undefined)).toBeUndefined();
    expect(parseCampaignExecutorRequest("native")).toBe("native");
  });
});
