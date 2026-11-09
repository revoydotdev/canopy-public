import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "@arbor/config";
import { createReferenceNativeModelAdapterRegistry } from "@arbor/harness";
import { resolveNativeHarnessExecutionReadiness } from "../src/native-harness-readiness.js";

const adapters = createReferenceNativeModelAdapterRegistry(fetch);
const absent = { present: false, mechanism: "api_key" as const };
const ollama = { ...DEFAULT_CONFIG.native, mode: "native" as const, adapter_id: "ollama-native" as const, provider_id: "ollama", base_url: "http://127.0.0.1:11434", model: "gemma3:1b" };
const openrouter = { ...ollama, adapter_id: "openai-compatible" as const, provider_id: "openrouter", base_url: "https://openrouter.ai/api/v1", model: "provider/model" };

describe("direct provider routing, without subordinate bridge fallback", () => {
  it("admits credential-free local Ollama on its native protocol", () => {
    expect(resolveNativeHarnessExecutionReadiness(ollama, absent, adapters)).toEqual({ kind: "direct_native", selected_by: "native" });
  });
  it("requires credentials for a remote Ollama endpoint", () => {
    expect(resolveNativeHarnessExecutionReadiness({ ...ollama, base_url: "https://remote.invalid", mode: "auto" }, absent, adapters)).toMatchObject({ kind: "unavailable", reason: "credential_absent" });
  });
  it("admits authenticated OpenRouter directly", () => {
    expect(resolveNativeHarnessExecutionReadiness(openrouter, { present: true }, adapters)).toEqual({ kind: "direct_native", selected_by: "native" });
  });
  it("does not demote credential-less OpenRouter auto mode to a connector", () => {
    expect(resolveNativeHarnessExecutionReadiness({ ...openrouter, mode: "auto" }, absent, adapters)).toMatchObject({ kind: "unavailable", reason: "credential_absent" });
  });
  it.each([ollama, openrouter])("rejects explicit fallback for $provider_id", config => {
    expect(resolveNativeHarnessExecutionReadiness({ ...config, mode: "fallback" }, { present: true }, adapters)).toMatchObject({ kind: "unavailable", reason: "provider_native_route_required" });
  });
  it("rejects a localhost bridge labelled OpenRouter", () => {
    expect(resolveNativeHarnessExecutionReadiness({ ...openrouter, base_url: "http://127.0.0.1:8080/v1" }, { present: true }, adapters)).toMatchObject({ kind: "unavailable", reason: "provider_native_route_required" });
  });
  it("rejects OpenAI-compatible masquerading as native Ollama", () => {
    expect(resolveNativeHarnessExecutionReadiness({ ...ollama, adapter_id: "openai-compatible" }, absent, adapters)).toMatchObject({ kind: "unavailable", reason: "provider_native_route_required" });
  });
  it("does not ignore an explicitly unusable credential source for local inference", () => {
    expect(resolveNativeHarnessExecutionReadiness(ollama, absent, adapters, { reason: "unusable subscriber credential" })).toMatchObject({ kind: "unavailable", reason: "credential_source_unusable" });
  });
});
