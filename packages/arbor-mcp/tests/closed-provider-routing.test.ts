import { describe, expect, it } from "vitest";
import type { NativeModelAdapterRequest, NativeModelPort, NativeModelRequest, OpenAICompatibleFetch } from "@arbor/harness";
import { createClosedProviderRoutedModel } from "../src/closed-provider-routing.js";

const request = (tools_allowed: boolean): NativeModelRequest => ({
  session_id: "closed-route-session", turn: 1, tools_allowed, prompt: "bounded fixture prompt", history: [], profile: null,
  governed_context: { instructions: [], artifacts: [] }, context: null, structured_output: null,
});

function sse(...events: string[]): Response {
  return new Response(events.map((event) => `data: ${event}\n\n`).join(""), { status: 200, headers: { "content-type": "text/event-stream" } });
}

function toolPort(onRun: (secret: string | null) => void): NativeModelPort {
  return {
    identity: { provider_id: "openrouter", model_id: "operator-model", configured_revision: "r1", revision: null, capabilities: [] },
    async run(_request, secret) {
      onRun(secret);
      return { text: [], tool_calls: [], final_message: "tool result" };
    },
  };
}

function compose(input: {
  readonly bridge_fetch: OpenAICompatibleFetch;
  readonly on_tool_run: (secret: string | null) => void;
  readonly requests: NativeModelAdapterRequest[];
  readonly tool_model_id?: string;
  readonly non_tool_model_id?: string;
}): NativeModelPort {
  return createClosedProviderRoutedModel({
    adapters: { create: (modelRequest) => { input.requests.push(modelRequest); return toolPort(input.on_tool_run); } },
    cwd: "/workspace", observed_at: "2026-08-30T00:00:00.000Z",
    selection: { tool_model_id: input.tool_model_id ?? "operator-model", tool_revision: "r1", non_tool_model_id: input.non_tool_model_id ?? "claude-sonnet-4-6" },
    tool_request: {
      tools: [{ name: "file.read", description: "read", parameters: { type: "object" }, risk: "low" }],
      credential_required: true,
    },
    non_tool_structured_schemas: [],
    bridge_fetch: input.bridge_fetch,
  });
}

describe("closed provider routing composition", () => {
  it("pins tool-capable dispatch to the OpenRouter child and never visits the bridge", async () => {
    const requests: NativeModelAdapterRequest[] = []; const bridgeCalls: Request[] = []; const secrets: Array<string | null> = [];
    const model = compose({
      requests, on_tool_run: (secret) => secrets.push(secret),
      bridge_fetch: async (url, init) => { bridgeCalls.push(new Request(typeof url === "string" ? url : url.toString(), init)); return sse("[DONE]"); },
    });

    await model.run(request(true), "openrouter-lease", new AbortController().signal);

    expect(secrets).toEqual(["openrouter-lease"]);
    expect(bridgeCalls).toEqual([]);
    expect(requests).toEqual([expect.objectContaining({
      adapter_id: "openai-compatible", provider_id: "openrouter", base_url: "https://openrouter.ai/api/v1", model_id: "operator-model", revision: "r1",
    })]);
  });

  it("sends an explicit no-tool request only to the bridge child without the OpenRouter lease", async () => {
    const requests: NativeModelAdapterRequest[] = []; const bridgeCalls: Request[] = []; let toolRuns = 0;
    const model = compose({
      requests, on_tool_run: () => { toolRuns += 1; },
      bridge_fetch: async (url, init) => {
        bridgeCalls.push(new Request(typeof url === "string" ? url : url.toString(), init));
        return sse(JSON.stringify({ choices: [{ delta: { content: "bridge result" }, finish_reason: "stop" }] }), "[DONE]");
      },
    });

    await expect(model.run(request(false), "openrouter-lease", new AbortController().signal)).resolves.toMatchObject({ final_message: "bridge result" });

    expect(toolRuns).toBe(0);
    expect(bridgeCalls).toHaveLength(1);
    expect(bridgeCalls[0]!.headers.get("authorization")).not.toBe("Bearer openrouter-lease");
    expect(JSON.parse(await bridgeCalls[0]!.text())).not.toHaveProperty("tools");
    expect(requests).toHaveLength(1); // construction only; no alternate tool dispatch
  });

  it("propagates bridge failure without falling back to the OpenRouter child", async () => {
    const requests: NativeModelAdapterRequest[] = []; let toolRuns = 0;
    const model = compose({
      requests, on_tool_run: () => { toolRuns += 1; },
      bridge_fetch: async () => new Response("bridge unavailable", { status: 503 }),
    });

    await expect(model.run(request(false), "openrouter-lease", new AbortController().signal)).rejects.toThrow(/503/);
    expect(toolRuns).toBe(0);
    expect(requests).toHaveLength(1);
  });

  it("rejects every DeepSeek production selection before either child can dispatch", () => {
    const requests: NativeModelAdapterRequest[] = []; let bridgeCalls = 0; let toolRuns = 0;
    expect(() => compose({
      requests, on_tool_run: () => { toolRuns += 1; }, tool_model_id: "deepseek/deepseek-v4-flash",
      bridge_fetch: async () => { bridgeCalls += 1; return sse("[DONE]"); },
    })).toThrow(/DeepSeek/);
    expect(() => compose({
      requests, on_tool_run: () => { toolRuns += 1; }, non_tool_model_id: "deepseek/deepseek-v4-pro",
      bridge_fetch: async () => { bridgeCalls += 1; return sse("[DONE]"); },
    })).toThrow(/DeepSeek/);
    expect(requests).toEqual([]);
    expect(toolRuns).toBe(0);
    expect(bridgeCalls).toBe(0);
  });
});
