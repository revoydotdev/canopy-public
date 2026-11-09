import { describe, expect, it } from "vitest";

import { createBedrockMessagesModelPort, BedrockMessagesAdapterError } from "../src/bedrock-messages.js";
import { encodeEventStreamMessage } from "./helpers/bedrock-eventstream-fixture.js";
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

function base64Json(value: unknown): string { return Buffer.from(JSON.stringify(value)).toString("base64"); }

function chunkFrame(event: Record<string, unknown>): Uint8Array {
  const headers = new Map([[":message-type", "event"], [":event-type", "chunk"], [":content-type", "application/json"]]);
  const payload = new TextEncoder().encode(JSON.stringify({ bytes: base64Json(event) }));
  return encodeEventStreamMessage(headers, payload);
}

function exceptionFrame(exceptionType: string, message: string): Uint8Array {
  const headers = new Map([[":message-type", "exception"], [":exception-type", exceptionType], [":content-type", "application/json"]]);
  const payload = new TextEncoder().encode(JSON.stringify({ message }));
  return encodeEventStreamMessage(headers, payload);
}

function concat(frames: readonly Uint8Array[]): Uint8Array {
  const total = frames.reduce((sum, frame) => sum + frame.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const frame of frames) { out.set(frame, offset); offset += frame.length; }
  return out;
}

function eventStreamResponse(frames: readonly Uint8Array[], status = 200): Response {
  return new Response(concat(frames), { status, headers: { "content-type": "application/vnd.amazon.eventstream" } });
}

const CREDENTIAL = JSON.stringify({ access_key_id: "AKIDEXAMPLE", secret_access_key: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY" });

describe("bedrock messages adapter", () => {
  it("signs the request with SigV4 and parses an eventstream-framed final response", async () => {
    let capturedUrl: string | null = null;
    let capturedHeaders: Headers | null = null;
    let capturedBody: string | null = null;
    const port = createBedrockMessagesModelPort({
      fetch: async (url, init) => {
        capturedUrl = url.toString();
        capturedHeaders = new Headers(init?.headers);
        capturedBody = String(init?.body);
        return eventStreamResponse([
          chunkFrame({ type: "message_start", message: { model: "anthropic.claude-3-5-sonnet-20241022-v2:0", usage: { input_tokens: 10, output_tokens: 0 } } }),
          chunkFrame({ type: "content_block_start", index: 0, content_block: { type: "text" } }),
          chunkFrame({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hello from bedrock" } }),
          chunkFrame({ type: "content_block_stop", index: 0 }),
          chunkFrame({ type: "message_delta", usage: { output_tokens: 4 } }),
          chunkFrame({ type: "message_stop" }),
        ]);
      },
      region: "us-east-1",
      provider_id: "aws-bedrock",
      model_id: "anthropic.claude-3-5-sonnet-20241022-v2:0",
      observed_at: "2026-08-26T00:00:00.000Z",
    });

    const response = await port.run(request, CREDENTIAL, new AbortController().signal);
    expect(response.final_message).toBe("hello from bedrock");
    expect(response.usage_and_cost?.tokens).toEqual({ kind: "measured", input_tokens: 10, output_tokens: 4, cache_read_tokens: 0, cache_write_tokens: 0 });

    expect(capturedUrl).toBe("https://bedrock-runtime.us-east-1.amazonaws.com/model/anthropic.claude-3-5-sonnet-20241022-v2:0/invoke-with-response-stream");
    const authorization = capturedHeaders!.get("authorization")!;
    expect(authorization.startsWith("AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/")).toBe(true);
    expect(authorization).toContain("SignedHeaders=accept;content-type;host;x-amz-date");
    expect(capturedHeaders!.get("x-amz-date")).toMatch(/^\d{8}T\d{6}Z$/);
    // Never composed with an OpenAI/Anthropic-direct bearer header -- SigV4 only.
    expect(capturedHeaders!.has("x-api-key")).toBe(false);

    const body = JSON.parse(capturedBody!);
    expect(body.anthropic_version).toBe("bedrock-2023-05-31");
    expect(body.stream).toBeUndefined();
    expect(body.model).toBeUndefined();
  });

  it("surfaces a Bedrock exception frame as a classified HTTP error", async () => {
    const port = createBedrockMessagesModelPort({
      fetch: async () => eventStreamResponse([exceptionFrame("throttlingException", "Too many requests")]),
      region: "us-east-1",
      provider_id: "aws-bedrock",
      model_id: "anthropic.claude-3-5-sonnet-20241022-v2:0",
      observed_at: "2026-08-26T00:00:00.000Z",
    });
    await expect(port.run(request, CREDENTIAL, new AbortController().signal)).rejects.toMatchObject({ status: 429 });
  });

  it("rejects a malformed injected credential rather than signing with a blank key", async () => {
    const port = createBedrockMessagesModelPort({
      fetch: async () => { throw new Error("must not be called"); },
      region: "us-east-1",
      provider_id: "aws-bedrock",
      model_id: "anthropic.claude-3-5-sonnet-20241022-v2:0",
      observed_at: "2026-08-26T00:00:00.000Z",
    });
    await expect(port.run(request, "not-json", new AbortController().signal)).rejects.toThrow(BedrockMessagesAdapterError);
  });

  it("reports honest capability availability with no images/human-input/documents this tranche", () => {
    const port = createBedrockMessagesModelPort({
      fetch: async () => new Response("", { status: 500 }),
      region: "us-east-1",
      provider_id: "aws-bedrock",
      model_id: "anthropic.claude-3-5-sonnet-20241022-v2:0",
      observed_at: "2026-08-26T00:00:00.000Z",
    });
    const caps = new Map(port.identity!.capabilities.map((c) => [c.capability, c.available]));
    expect(caps.get("streaming")).toBe(true);
    expect(caps.get("human_input")).toBe(false);
    expect(caps.get("image_input")).toBe(false);
    expect(caps.get("document_input")).toBe(false);
  });
});
