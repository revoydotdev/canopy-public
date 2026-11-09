import { describe, expect, it } from "vitest";

import { createVertexMessagesModelPort, VertexMessagesAdapterError } from "../src/vertex-messages.js";
import type { NativeModelRequest } from "../src/native-worker.js";

const request: NativeModelRequest = {
  session_id: "session-1",
  turn: 1,
  prompt: "summarize the bounded task",
  history: [],
  profile: { role_id: "seed" },
  governed_context: { instructions: [], artifacts: [] },
  context: null,
  structured_output: null,
};

function sse(events: readonly Record<string, unknown>[]): Response {
  const body = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

describe("vertex messages adapter", () => {
  it("builds the documented streamRawPredict URL and sends a bearer token", async () => {
    let capturedUrl: string | null = null;
    let capturedHeaders: Headers | null = null;
    let capturedBody: string | null = null;
    const port = createVertexMessagesModelPort({
      fetch: async (url, init) => {
        capturedUrl = url.toString();
        capturedHeaders = new Headers(init?.headers);
        capturedBody = String(init?.body);
        return sse([
          { type: "message_start", message: { model: "claude-opus-5", usage: { input_tokens: 12, output_tokens: 0 } } },
          { type: "content_block_start", index: 0, content_block: { type: "text" } },
          { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hello from vertex" } },
          { type: "content_block_stop", index: 0 },
          { type: "message_delta", usage: { output_tokens: 3 } },
          { type: "message_stop" },
        ]);
      },
      project_id: "my-project",
      provider_id: "gcp-vertex",
      model_id: "claude-opus-5",
      observed_at: "2026-08-26T00:00:00.000Z",
    });

    const response = await port.run(request, "gcp-oauth-access-token", new AbortController().signal);
    expect(response.final_message).toBe("hello from vertex");
    expect(response.usage_and_cost?.tokens).toEqual({ kind: "measured", input_tokens: 12, output_tokens: 3, cache_read_tokens: 0, cache_write_tokens: 0 });

    expect(capturedUrl).toBe("https://aiplatform.googleapis.com/v1/projects/my-project/locations/global/publishers/anthropic/models/claude-opus-5:streamRawPredict");
    expect(capturedHeaders!.get("authorization")).toBe("Bearer gcp-oauth-access-token");

    const body = JSON.parse(capturedBody!);
    expect(body.anthropic_version).toBe("vertex-2023-10-16");
    expect(body.model).toBeUndefined();
    expect(body.stream).toBeUndefined();
  });

  it("routes a specific region to the {location}-aiplatform.googleapis.com host", async () => {
    let capturedUrl: string | null = null;
    const port = createVertexMessagesModelPort({
      fetch: async (url) => { capturedUrl = url.toString(); return sse([{ type: "message_start", message: { model: "claude-sonnet-4-6", usage: {} } }, { type: "message_stop" }]); },
      project_id: "my-project",
      location: "us-east5",
      provider_id: "gcp-vertex",
      model_id: "claude-sonnet-4-6",
      observed_at: "2026-08-26T00:00:00.000Z",
    });
    await port.run(request, "token", new AbortController().signal);
    expect(capturedUrl).toBe("https://us-east5-aiplatform.googleapis.com/v1/projects/my-project/locations/us-east5/publishers/anthropic/models/claude-sonnet-4-6:streamRawPredict");
  });

  it("classifies a Vertex stream-level error and maps it to a retryable HTTP status", async () => {
    const port = createVertexMessagesModelPort({
      fetch: async () => sse([{ type: "error", error: { type: "overloaded_error" } }]),
      project_id: "my-project",
      provider_id: "gcp-vertex",
      model_id: "claude-opus-5",
      observed_at: "2026-08-26T00:00:00.000Z",
    });
    await expect(port.run(request, "token", new AbortController().signal)).rejects.toMatchObject({ status: 529 });
  });

  it("requires a credential when credential_required is not disabled", async () => {
    const port = createVertexMessagesModelPort({
      fetch: async () => { throw new Error("must not be called"); },
      project_id: "my-project",
      provider_id: "gcp-vertex",
      model_id: "claude-opus-5",
      observed_at: "2026-08-26T00:00:00.000Z",
    });
    await expect(port.run(request, null, new AbortController().signal)).rejects.toThrow(VertexMessagesAdapterError);
  });
});
