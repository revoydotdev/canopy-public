import { describe, expect, it } from "vitest";

import type { NativeModelIdentity } from "../src/inference.js";
import type { NativeInferenceDelta } from "../src/inference.js";
import type { NativeModelPort, NativeModelRequest, NativeModelResponse } from "../src/native-worker.js";
import { createRoutedNativeModelPort, selectNativeModelRoute, type NativeModelRouteReceipt } from "../src/routed-model.js";

const request = (overrides: Partial<NativeModelRequest> = {}): NativeModelRequest => ({
  session_id: "route-session",
  turn: 3,
  prompt: "secret prompt must not enter a receipt",
  history: [],
  profile: null,
  governed_context: { instructions: [], artifacts: [] },
  context: null,
  structured_output: null,
  ...overrides,
});

const response = (message: string): NativeModelResponse => Object.freeze({
  text: Object.freeze([]), tool_calls: Object.freeze([]), final_message: message,
});

const identity = (provider: string, model: string): NativeModelIdentity => Object.freeze({
  provider_id: provider,
  model_id: model,
  revision: null,
  capabilities: Object.freeze([]),
});

function port(options: {
  readonly name: string;
  readonly result?: NativeModelResponse;
  readonly failure?: Error;
  readonly stream?: readonly NativeInferenceDelta[];
  readonly onRun?: (request: NativeModelRequest, secret: string | null, signal: AbortSignal) => void;
  readonly onStream?: (request: NativeModelRequest, secret: string | null, signal: AbortSignal) => void;
}): NativeModelPort {
  const streamDeltas = options.stream;
  return {
    identity: identity(`${options.name}-provider`, `${options.name}-model`),
    async run(modelRequest, secret, signal) {
      options.onRun?.(modelRequest, secret, signal);
      if (options.failure !== undefined) throw options.failure;
      return options.result ?? response(options.name);
    },
    ...(streamDeltas === undefined ? {} : {
      async *stream(modelRequest: NativeModelRequest, secret: string | null, signal: AbortSignal): AsyncGenerator<NativeInferenceDelta> {
        options.onStream?.(modelRequest, secret, signal);
        if (options.failure !== undefined) throw options.failure;
        yield* streamDeltas;
      },
    }),
    classify_failure(error) {
      return error === options.failure
        ? { kind: "retryable", reason: `${options.name} retry`, retry_after_ms: null }
        : { kind: "terminal", reason: `${options.name} terminal` };
    },
  };
}

describe("routed native model port", () => {
  it("selects the tool-capable child when tools_allowed is omitted or true", async () => {
    const calls: string[] = [];
    const routed = createRoutedNativeModelPort({
      tool_capable: port({ name: "tool", onRun: () => calls.push("tool") }),
      non_tool: port({ name: "non", onRun: () => calls.push("non") }),
    });

    await routed.run(request(), "model-secret", new AbortController().signal);
    await routed.run(request({ tools_allowed: true }), "model-secret", new AbortController().signal);

    expect(calls).toEqual(["tool", "tool"]);
    expect(selectNativeModelRoute(request())).toBe("tool_capable");
    expect(selectNativeModelRoute(request({ tools_allowed: true }))).toBe("tool_capable");
  });

  it("keeps an explicitly tool-capable empty-tool role on the tool child", async () => {
    const calls: string[] = [];
    const routed = createRoutedNativeModelPort({
      tool_capable: port({ name: "tool", onRun: () => calls.push("tool") }),
      non_tool: port({ name: "non", onRun: () => calls.push("non") }),
    });

    // NativeModelRequest carries the capability predicate, not a tool list.
    // An empty role tool list must therefore remain explicitly true here.
    await routed.run(request({ tools_allowed: true }), null, new AbortController().signal);

    expect(calls).toEqual(["tool"]);
  });

  it("selects only the non-tool child for an explicit false predicate", async () => {
    const calls: string[] = [];
    const secrets: Array<string | null> = [];
    const routed = createRoutedNativeModelPort({
      tool_capable: port({ name: "tool", onRun: () => calls.push("tool") }),
      non_tool: port({ name: "non", onRun: (_request, secret) => { calls.push("non"); secrets.push(secret); } }),
    });

    await routed.run(request({ tools_allowed: false }), "model-secret", new AbortController().signal);

    expect(calls).toEqual(["non"]);
    expect(secrets).toEqual([null]);
    expect(selectNativeModelRoute(request({ tools_allowed: false }))).toBe("non_tool");
  });

  it("preserves selected-child run and stream semantics", async () => {
    const toolRun: Array<{ secret: string | null; signal: AbortSignal }> = [];
    const nonStream: Array<{ secret: string | null; signal: AbortSignal }> = [];
    const signal = new AbortController().signal;
    const routed = createRoutedNativeModelPort({
      tool_capable: port({ name: "tool", onRun: (_request, secret, childSignal) => toolRun.push({ secret, signal: childSignal }), stream: [{ kind: "final", message: "tool stream" }] }),
      non_tool: port({ name: "non", onStream: (_request, secret, childSignal) => nonStream.push({ secret, signal: childSignal }), stream: [{ kind: "text", text: "partial", phase: "commentary" }, { kind: "final", message: "non stream" }] }),
    });

    expect(await routed.run(request({ tools_allowed: true }), "tool-secret", signal)).toEqual(response("tool"));
    const deltas: NativeInferenceDelta[] = [];
    for await (const delta of routed.stream!(request({ tools_allowed: false }), "bridge-secret", signal)) deltas.push(delta);

    expect(toolRun).toEqual([{ secret: "tool-secret", signal }]);
    expect(nonStream).toEqual([{ secret: null, signal }]);
    expect(deltas).toEqual([{ kind: "text", text: "partial", phase: "commentary" }, { kind: "final", message: "non stream" }]);
  });

  it("emits immutable, content-free selected-route receipts", async () => {
    const receipts: NativeModelRouteReceipt[] = [];
    const sourceIdentity = {
      provider_id: "tool-provider",
      model_id: "tool-model",
      revision: null,
      capabilities: [{ capability: "streaming" as const, available: true, observed_at: "2026-08-30T00:00:00Z", detail: "fixture" }],
    } satisfies NativeModelIdentity;
    const tool = port({ name: "tool" });
    (tool as { identity?: NativeModelIdentity }).identity = sourceIdentity;
    const routed = createRoutedNativeModelPort({
      tool_capable: tool,
      non_tool: port({ name: "non" }),
      on_route_selected: (receipt) => receipts.push(receipt),
    });

    await routed.run(request({ tools_allowed: true }), "model-secret", new AbortController().signal);
    sourceIdentity.capabilities[0]!.detail = "mutated";

    expect(receipts).toEqual([expect.objectContaining({ route: "tool_capable", session_id: "route-session", turn: 3, child_identity: expect.objectContaining({ provider_id: "tool-provider", model_id: "tool-model", capabilities: [expect.objectContaining({ detail: "fixture" })] }) })]);
    expect(JSON.stringify(receipts)).not.toContain("model-secret");
    expect(JSON.stringify(receipts)).not.toContain("secret prompt");
    expect(Object.isFrozen(receipts[0]!)).toBe(true);
    expect(Object.isFrozen(receipts[0]!.child_identity)).toBe(true);
    expect(Object.isFrozen(receipts[0]!.child_identity!.capabilities)).toBe(true);
    expect(Object.isFrozen(receipts[0]!.child_identity!.capabilities[0]!)).toBe(true);
  });

  it("propagates a selected-child failure and only that child supplies retry classification", async () => {
    const failure = new Error("tool failed");
    let toolCalls = 0;
    let nonCalls = 0;
    const routed = createRoutedNativeModelPort({
      tool_capable: port({ name: "tool", failure, onRun: () => { toolCalls += 1; } }),
      non_tool: port({ name: "non", onRun: () => { nonCalls += 1; } }),
    });

    await expect(routed.run(request({ tools_allowed: true }), null, new AbortController().signal)).rejects.toThrow("tool failed");

    expect(toolCalls).toBe(1);
    expect(nonCalls).toBe(0);
    expect(routed.classify_failure!(failure)).toEqual({ kind: "retryable", reason: "tool retry", retry_after_ms: null });
  });

  it("fails closed when route observation cannot be recorded", async () => {
    let toolCalls = 0;
    let nonCalls = 0;
    const routed = createRoutedNativeModelPort({
      tool_capable: port({ name: "tool", onRun: () => { toolCalls += 1; } }),
      non_tool: port({ name: "non", onRun: () => { nonCalls += 1; } }),
      on_route_selected: () => { throw new Error("route audit unavailable"); },
    });

    await expect(routed.run(request({ tools_allowed: true }), "tool-secret", new AbortController().signal)).rejects.toThrow("route audit unavailable");

    expect(toolCalls).toBe(0);
    expect(nonCalls).toBe(0);
  });

  it("propagates an aborted selected-child stream without visiting the other child", async () => {
    const abort = new DOMException("operator stopped", "AbortError");
    let toolStreams = 0;
    let nonStreams = 0;
    const routed = createRoutedNativeModelPort({
      tool_capable: port({ name: "tool", onStream: () => { toolStreams += 1; }, stream: [{ kind: "final", message: "unused" }] }),
      non_tool: port({ name: "non", failure: abort, onStream: () => { nonStreams += 1; }, stream: [] }),
    });

    const controller = new AbortController();
    controller.abort();
    const consume = async (): Promise<void> => {
      for await (const _delta of routed.stream!(request({ tools_allowed: false }), null, controller.signal)) { /* consume */ }
    };
    await expect(consume()).rejects.toThrow("operator stopped");

    expect(toolStreams).toBe(0);
    expect(nonStreams).toBe(1);
    expect(routed.classify_failure!(abort)).toEqual({ kind: "retryable", reason: "non retry", retry_after_ms: null });
  });

  it("omits stream when either child is run-only, preserving run fallback without changing children", async () => {
    const calls: string[] = [];
    const routed = createRoutedNativeModelPort({
      tool_capable: port({ name: "tool", onRun: () => calls.push("tool") }),
      non_tool: port({ name: "non", onRun: () => calls.push("non"), stream: [{ kind: "final", message: "unused" }] }),
    });

    expect(routed.stream).toBeUndefined();
    await routed.run(request({ tools_allowed: false }), null, new AbortController().signal);
    expect(calls).toEqual(["non"]);
  });
});
