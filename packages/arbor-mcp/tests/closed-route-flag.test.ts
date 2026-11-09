/**
 * The closed frontier route is selected by `native.closed_route`, never
 * inferred from `provider_id === "openrouter"`. Before this, any OpenRouter
 * configuration was forced into the closed shape (mode native, fixed
 * endpoint, bridge child, no connector), so OpenRouter could not be used as
 * an ordinary provider at all.
 */
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "@arbor/config";
import { resolveNativeProviderSelection } from "@arbor/config";
import { resolveClosedProviderRoute } from "../src/cli.js";

const openrouter = (overrides: Record<string, unknown> = {}) => ({
  ...DEFAULT_CONFIG,
  native: { ...DEFAULT_CONFIG.native, adapter_id: "openai-compatible" as const, provider_id: "openrouter", base_url: "https://openrouter.ai/api/v1", model: "anthropic/claude-haiku-4.5", ...overrides },
});

describe("native.closed_route", () => {
  it("an OpenRouter config without the flag is an ordinary native provider (no closed route, mode auto allowed)", () => {
    const config = openrouter({ mode: "auto" as const });
    expect(resolveClosedProviderRoute(config, resolveNativeProviderSelection(config.native))).toBeNull();
  });

  it("with the flag, the closed-route admission rules apply", () => {
    const auto = openrouter({ mode: "auto" as const, closed_route: true });
    expect(() => resolveClosedProviderRoute(auto, resolveNativeProviderSelection(auto.native))).toThrow(/native\.mode="native"/u);
    const native = { ...openrouter({ mode: "native" as const, closed_route: true }), agents: { ...DEFAULT_CONFIG.agents, lenticel: { ...DEFAULT_CONFIG.agents.lenticel, model: "claude-haiku-4-5" } } };
    expect(resolveClosedProviderRoute(native, resolveNativeProviderSelection(native.native))).toEqual({ non_tool_model_id: "claude-haiku-4-5" });
  });

  it("the flag on a non-OpenRouter provider is refused rather than silently ignored", () => {
    const config = { ...DEFAULT_CONFIG, native: { ...DEFAULT_CONFIG.native, closed_route: true } };
    expect(() => resolveClosedProviderRoute(config, resolveNativeProviderSelection(config.native))).toThrow(/requires provider_id "openrouter"/u);
  });
});
