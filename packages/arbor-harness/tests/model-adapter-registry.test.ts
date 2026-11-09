import { describe, expect, it } from "vitest";

import {
  createReferenceNativeModelAdapterRegistry,
  NativeModelAdapterRegistry,
  type NativeModelAdapter,
} from "../src/model-adapter-registry.js";
import type { NativeModelRequest } from "../src/native-worker.js";

const request: NativeModelRequest = {
  session_id: "session-1",
  turn: 1,
  prompt: "perform the bounded task",
  history: [],
  profile: { role_id: "seed" },
  governed_context: { instructions: [], artifacts: [] },
  context: null,
  structured_output: null,
};

function sse(data: unknown): Response {
  return new Response(`data: ${JSON.stringify(data)}\n\ndata: [DONE]\n\n`, { status: 200, headers: { "content-type": "text/event-stream" } });
}

describe("native model adapter registry", () => {
  it("ships one explicit OpenAI-compatible transport while keeping provider identity separate", async () => {
    let authorization: string | null = null;
    const registry = createReferenceNativeModelAdapterRegistry(async (_url, init) => {
      authorization = new Headers(init?.headers).get("authorization");
      return sse({ choices: [{ delta: { content: "completed" } }] });
    });

    expect(registry.list()).toEqual([
      expect.objectContaining({ adapter_id: "anthropic-messages", credential_delivery: "worker_owned_opaque_lease" }),
      expect.objectContaining({ adapter_id: "aws-bedrock-messages", credential_delivery: "worker_owned_opaque_lease" }),
      expect.objectContaining({ adapter_id: "gcp-vertex-messages", credential_delivery: "worker_owned_opaque_lease" }),
      expect.objectContaining({ adapter_id: "ollama-native", credential_delivery: "worker_owned_opaque_lease" }),
      expect.objectContaining({ adapter_id: "openai-compatible", credential_delivery: "worker_owned_opaque_lease" }),
    ]);
    const model = registry.create({
      adapter_id: "openai-compatible",
      provider_id: "private-gateway",
      base_url: "https://gateway.invalid/v1",
      model_id: "private-model",
      observed_at: "2026-08-09T00:00:00.000Z",
    });
    expect(model.identity).toMatchObject({ provider_id: "private-gateway", model_id: "private-model" });
    const deltas = [];
    for await (const delta of model.stream!(request, "only-worker-receives-this", new AbortController().signal)) deltas.push(delta);
    expect(deltas).toContainEqual({ kind: "final", message: "completed" });
    expect(authorization).toBe("Bearer only-worker-receives-this");
    expect(JSON.stringify(registry.list())).not.toContain("only-worker-receives-this");
  });

  it("reports an unregistered transport as typed absence rather than guessing from provider_id", () => {
    const registry = createReferenceNativeModelAdapterRegistry(async () => new Response("", { status: 500 }));
    expect(registry.resolve("future-transport")).toEqual({ kind: "unavailable", adapter_id: "future-transport", reason: "not_registered" });
    expect(() => registry.create({
      adapter_id: "future-transport", provider_id: "someprovider", base_url: "https://api.someprovider.invalid", model_id: "future-model", observed_at: "2026-08-09T00:00:00.000Z",
    })).toThrow("native model adapter is unavailable");
  });

  it("contains adapter metadata mutation and rejects duplicate registrations", () => {
    const registry = new NativeModelAdapterRegistry();
    const adapter: NativeModelAdapter = {
      descriptor: { adapter_id: "fixture", implementation_id: "fixture-v1", transport: "fixture wire", credential_delivery: "worker_owned_opaque_lease" },
      create() { throw new Error("not invoked"); },
    };
    registry.register(adapter);
    (adapter.descriptor as { transport: string }).transport = "mutated externally";
    expect(registry.inspect("fixture")).toMatchObject({ transport: "fixture wire" });
    expect(() => registry.register(adapter)).toThrow("model adapter already registered");
  });
});
