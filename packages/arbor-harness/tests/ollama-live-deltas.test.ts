import { describe, expect, it } from "vitest";
import { createOllamaNativeModelPort } from "../src/ollama-native.js";
import type { NativeModelRequest } from "../src/native-worker.js";

const request: NativeModelRequest = {
  session_id: "delta-proof", turn: 1, prompt: "Answer the question",
  history: [], profile: null, governed_context: { instructions: [], artifacts: [] },
  context: null, structured_output: null, tools_allowed: false,
};
const encode = (value: unknown) => new TextEncoder().encode(`${JSON.stringify(value)}\n`);
const chunk = (text: string, done = false) => ({ model: "test-model", message: { content: text }, done });

describe("Ollama plain-answer incremental delivery", () => {
  it("yields text while the provider stream is still open, without duplicating the final text", async () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({ start(value) { controller = value; } });
    const port = createOllamaNativeModelPort({
      fetch: async () => new Response(body), provider_id: "ollama", model_id: "test-model",
      observed_at: "2026-09-05T00:00:00Z",
    });
    const iterator = port.stream!(request, null, new AbortController().signal)[Symbol.asyncIterator]();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      controller.enqueue(encode(chunk("first ")));
      const first = await Promise.race([
        iterator.next(),
        new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("text buffered until completion")), 1000); }),
      ]);
      expect(first).toEqual({ done: false, value: { kind: "text", phase: "final", text: "first " } });
      controller.enqueue(encode(chunk("second", true)));
      controller.close();
      const remaining = [];
      for (;;) { const next = await iterator.next(); if (next.done) break; remaining.push(next.value); }
      expect(remaining).toEqual([
        { kind: "text", phase: "final", text: "second" },
        { kind: "stop", reason: "completed" },
        { kind: "final", message: "first second" },
      ]);
    } finally {
      clearTimeout(timer);
      try { controller.close(); } catch { /* already closed */ }
      await iterator.return?.();
    }
  });

  it.each([
    ["wrong model", { model: "other-model", message: { content: "must not leak" }, done: true }],
    ["forbidden tool call", { model: "test-model", message: { content: "must not leak", tool_calls: [{ function: { name: "shell", arguments: {} } }] }, done: true }],
  ])("rejects %s before yielding that chunk's text", async (_label, value) => {
    const port = createOllamaNativeModelPort({
      fetch: async () => new Response(encode(value)), provider_id: "ollama", model_id: "test-model",
      observed_at: "2026-09-05T00:00:00Z",
    });
    const iterator = port.stream!(request, null, new AbortController().signal)[Symbol.asyncIterator]();
    await expect(iterator.next()).rejects.toThrow();
  });
});
