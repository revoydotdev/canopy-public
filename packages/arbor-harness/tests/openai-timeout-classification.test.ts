import { describe, expect, it } from "vitest";
import { createOpenAICompatibleModelPort } from "../src/openai-compatible.js";
import type { NativeModelRequest } from "../src/native-worker.js";

const request: NativeModelRequest = {
  session_id: "deadline-proof", turn: 1, prompt: "bounded timeout proof",
  history: [], profile: { role_id: "seed" },
  governed_context: { instructions: [], artifacts: [] }, context: null,
  structured_output: null,
};

function stalledModel(timeout_ms: number) {
  return createOpenAICompatibleModelPort({
    base_url: "https://model.invalid", provider_id: "test", model_id: "test",
    observed_at: "2026-09-05T00:00:00.000Z", timeout_ms,
    fetch: async () => new Response(new ReadableStream<Uint8Array>(), {
      headers: { "content-type": "text/event-stream" },
    }),
  });
}

describe("OpenAI-compatible stream abort classification", () => {
  it("reports its own deadline as timeout even when the reader throws a typed transport abort", async () => {
    const model = stalledModel(20);
    await expect(model.run(request, "fixture-secret", new AbortController().signal))
      .rejects.toMatchObject({ kind: "timeout", message: "OpenAI-compatible stream exceeded its configured timeout" });
  });

  it("does not turn caller cancellation into a provider deadline", async () => {
    const model = stalledModel(1000);
    const controller = new AbortController();
    const result = model.run(request, "fixture-secret", controller.signal);
    controller.abort();
    await expect(result).rejects.toMatchObject({ kind: "transport", message: "OpenAI-compatible stream was aborted" });
  });
});
