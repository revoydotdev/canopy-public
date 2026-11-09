import { describe, expect, it } from "vitest";

import {
  createOpenAICompatibleModelPort,
  OPENROUTER_ATTRIBUTION_HEADERS,
  openRouterAttributionHeaders,
} from "../src/openai-compatible.js";
import type { NativeModelRequest } from "../src/native-worker.js";

const request: NativeModelRequest = {
  session_id: "session-1",
  turn: 1,
  prompt: "make the requested change",
  history: [],
  profile: { role_id: "seed" },
  governed_context: { instructions: [], artifacts: [] },
  context: null,
  structured_output: null,
};

function sse(...events: string[]): Response {
  return new Response(events.map((event) => `data: ${event}\n\n`).join(""), { status: 200, headers: { "content-type": "text/event-stream" } });
}

/** Drives one turn through a fake fetch and returns the headers the adapter actually sent. */
async function sentHeaders(baseUrl: string): Promise<{ url: string; headers: Record<string, string> }> {
  let seen: { url: string; headers: Record<string, string> } | null = null;
  const model = createOpenAICompatibleModelPort({
    fetch: async (url, init) => {
      seen = { url: String(url), headers: { ...(init?.headers as Record<string, string>) } };
      return sse(JSON.stringify({ choices: [{ delta: { content: "done" }, finish_reason: "stop" }] }), "[DONE]");
    },
    base_url: baseUrl,
    provider_id: "fixture",
    model_id: "fixture-model",
    observed_at: "2026-10-07T00:00:00.000Z",
    timeout_ms: null,
    max_response_bytes: null,
  });
  await model.run(request, "test-only-secret", new AbortController().signal);
  if (seen === null) throw new Error("fake fetch was never called");
  return seen;
}

describe("OpenRouter app attribution headers", () => {
  it("sends HTTP-Referer, X-OpenRouter-Title and X-Title on every OpenRouter request", async () => {
    const { url, headers } = await sentHeaders("https://openrouter.ai/api/v1");
    expect(url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(headers["HTTP-Referer"]).toBe("https://github.com/revoydotdev/canopy-public");
    expect(headers["X-OpenRouter-Title"]).toBe("Canopy (revoy2)");
    expect(headers["X-Title"]).toBe("Canopy (revoy2)");
    expect(headers.authorization).toBe("Bearer test-only-secret");
  });

  it("never sends attribution to a non-OpenRouter endpoint", async () => {
    for (const base of ["https://api.openai.com/v1", "https://openrouter.ai.evil.invalid/api/v1", "http://openrouter.ai/api/v1", "http://127.0.0.1:8080/v1"]) {
      const { headers } = await sentHeaders(base);
      expect(Object.keys(headers).map((key) => key.toLowerCase())).not.toEqual(expect.arrayContaining(["http-referer"]));
      expect(headers).not.toHaveProperty("X-Title");
      expect(headers).not.toHaveProperty("X-OpenRouter-Title");
    }
  });

  it("carries only fixed, non-secret constants", () => {
    // The credential is the only secret this adapter ever holds; it must not
    // be reachable from the attribution set, which is built before any secret exists.
    expect(Object.isFrozen(OPENROUTER_ATTRIBUTION_HEADERS)).toBe(true);
    for (const value of Object.values(OPENROUTER_ATTRIBUTION_HEADERS)) expect(value).not.toMatch(/secret|key|token|sk-/i);
    expect(openRouterAttributionHeaders(new URL("https://OpenRouter.ai/api/v1/chat/completions"))).toBe(OPENROUTER_ATTRIBUTION_HEADERS);
  });
});
