import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, validateConfig } from "@arbor/config";
import { OpenAICompatibleAdapterError, type NativeModelPort, type NativeModelRequest, type NativeModelRouteReceipt } from "@arbor/harness";
import { createOpenRouterBridgeFallback } from "../src/openrouter-bridge-fallback.js";

const request: NativeModelRequest = { session_id: "fallback-session", turn: 1, tools_allowed: true,
  prompt: "Read a governed file", history: [], profile: null, governed_context: { instructions: [], artifacts: [] }, context: null, structured_output: null };
const identity = { provider_id: "openrouter", model_id: "primary", revision: null, capabilities: [] };
const selection = { adapter_id: "openai-compatible", provider_id: "openrouter", model_id: "primary", observed_at: "2026-09-04T23:10:00Z",
  tools: [{ name: "file.read", description: "Read", parameters: { type: "object" }, risk: "low" as const }] };
const billing = () => new OpenAICompatibleAdapterError("http", "HTTP 402", 402);
const answer = () => new Response(`data: ${JSON.stringify({ model: "claude-haiku-4-5", choices: [{ delta: { content: "bridge answer" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });

describe("OpenRouter to Claude bridge failover", () => {
  it("ships an inspectable Haiku fallback default", () => {
    expect(DEFAULT_CONFIG.native.openrouter_fallback).toEqual({ enabled: true, model: "claude-haiku-4-5" });
    expect(validateConfig(DEFAULT_CONFIG).valid).toBe(true);
  });

  it("fails over on billing before output, preserves tools, isolates credentials, and records the actual route", async () => {
    let primaryCalls = 0; const calls: Request[] = []; const receipts: NativeModelRouteReceipt[] = [];
    const primary: NativeModelPort = { identity, async run(_request, secret) { expect(secret).toBe("openrouter-secret"); primaryCalls++; throw billing(); } };
    const model = createOpenRouterBridgeFallback({ primary, request: selection, cwd: "/tmp", model: "claude-haiku-4-5", on_route_selected: (receipt) => receipts.push(receipt),
      bridge_fetch: async (url, init) => { calls.push(new Request(url.toString(), init)); return answer(); } });
    expect((await model.run(request, "openrouter-secret", new AbortController().signal)).final_message).toBe("bridge answer");
    await model.run({ ...request, turn: 2 }, "openrouter-secret", new AbortController().signal);
    expect(primaryCalls).toBe(1);
    expect(calls).toHaveLength(2);
    expect(calls[0]!.headers.get("authorization")).not.toContain("openrouter-secret");
    expect(await calls[0]!.json()).toMatchObject({ model: "claude-haiku-4-5", tools: [{ function: { name: "file_read" } }] });
    expect(receipts.map((receipt) => receipt.child_identity?.provider_id)).toEqual(["openrouter", "claude-bridge", "claude-bridge"]);
    expect(model.identity?.provider_id).toBe("claude-bridge");
  });

  it("never replays a partially emitted stream", async () => {
    let bridgeCalls = 0;
    const primary: NativeModelPort = { identity, async run() { throw billing(); }, async *stream() { yield { kind: "text", text: "partial", phase: "commentary" }; throw billing(); } };
    const model = createOpenRouterBridgeFallback({ primary, request: selection, cwd: "/tmp", model: "claude-haiku-4-5", bridge_fetch: async () => { bridgeCalls++; return answer(); } });
    const seen: string[] = [];
    await expect((async () => { for await (const delta of model.stream!(request, "secret", new AbortController().signal)) seen.push(delta.kind); })()).rejects.toThrow("402");
    expect(seen).toEqual(["text"]);
    expect(bridgeCalls).toBe(0);
  });

  it.each([400, 401, 403])("does not treat HTTP %i as permission to use a different provider", async (status) => {
    let bridgeCalls = 0;
    const model = createOpenRouterBridgeFallback({ primary: { identity, async run() { throw new OpenAICompatibleAdapterError("http", "denied", status); } }, request: selection, cwd: "/tmp", model: "claude-haiku-4-5", bridge_fetch: async () => { bridgeCalls++; return answer(); } });
    await expect(model.run(request, "secret", new AbortController().signal)).rejects.toThrow("denied");
    expect(bridgeCalls).toBe(0);
  });

  it("never fails over a cancelled request", async () => {
    const controller = new AbortController(); controller.abort(); let bridgeCalls = 0;
    const model = createOpenRouterBridgeFallback({ primary: { identity, async run() { throw billing(); } }, request: selection, cwd: "/tmp", model: "claude-haiku-4-5", bridge_fetch: async () => { bridgeCalls++; return answer(); } });
    await expect(model.run(request, "secret", controller.signal)).rejects.toThrow("402");
    expect(bridgeCalls).toBe(0);
  });
});
