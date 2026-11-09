import { describe, expect, it } from "vitest";
import { ArborRuntime } from "../src/runtime.js";
import { composeLoopConfigPorts } from "../src/loop-ports-helper.js";

/**
 * The token economy's provider/model identity used to be the literals
 * "arbor-runtime"/"default" in both the capability bridge lookup and
 * `fallback_capability`. Because `resolveProviderTokenCapability` resolves by
 * provider and model, that lookup could only ever miss, `fallback_capability`
 * always answered, and every epoch was indistinguishable from every other.
 * Observed on a verified campaign: a `claude-sonnet-4-6` turn recorded
 * `provider_id: "arbor-runtime", model_id: "default"`.
 */
describe("token economy model identity", () => {
  it("plans against the composed provider and model", () => {
    const ports = composeLoopConfigPorts(new ArborRuntime(), {}, { provider_id: "anthropic", model_id: "claude-sonnet-4-6" });
    expect(ports.token_economy?.fallback_capability).toMatchObject({
      provider_id: "anthropic",
      model_id: "claude-sonnet-4-6",
    });
  });

  it("does not stamp the generic literals when an identity is supplied", () => {
    const ports = composeLoopConfigPorts(new ArborRuntime(), {}, { provider_id: "openrouter", model_id: "anthropic/claude-sonnet-4.6" });
    const capability = ports.token_economy?.fallback_capability;
    expect(capability?.provider_id).not.toBe("arbor-runtime");
    expect(capability?.model_id).not.toBe("default");
  });

  it("keeps distinct models distinguishable instead of collapsing them", () => {
    const sonnet = composeLoopConfigPorts(new ArborRuntime(), {}, { provider_id: "anthropic", model_id: "claude-sonnet-4-6" });
    const haiku = composeLoopConfigPorts(new ArborRuntime(), {}, { provider_id: "anthropic", model_id: "claude-haiku-4-5" });
    expect(sonnet.token_economy?.fallback_capability?.model_id).not.toBe(haiku.token_economy?.fallback_capability?.model_id);
  });

  it("falls back to the historical literals when no identity is composed", () => {
    const ports = composeLoopConfigPorts(new ArborRuntime());
    expect(ports.token_economy?.fallback_capability).toMatchObject({
      provider_id: "arbor-runtime",
      model_id: "default",
    });
  });
});
