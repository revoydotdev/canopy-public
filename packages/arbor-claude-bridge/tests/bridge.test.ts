import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { createFetchHandler } from "../src/server.js";
import { execFileSync } from "node:child_process";
import { buildClaudeArgs } from "../src/claude-backend.js";
import { composePrompt, toOpenAIUsage, validateRequest, resolveModel, toolDecisionSchema, toolProtocolInstructions } from "../src/translate.js";
import { BridgeRequestError, type ClaudeUsage } from "../src/protocol.js";

const FAKE_CLAUDE = fileURLToPath(new URL("./fixtures/fake-claude.mjs", import.meta.url));
const API_KEY = "test-secret";

/** fake-claude's init frame is dropped by the parser, so re-read it from a raw spawn. */
function initFrame(): any {
  const out = execFileSync(
    FAKE_CLAUDE,
    buildClaudeArgs({ model: "claude-haiku-4-5", prompt: "Grade this.", systemPrompt: "You grade things." }),
    { input: "Grade this.", encoding: "utf8" },
  );
  return JSON.parse(out.split("\n")[0]!);
}

function handler() {
  return createFetchHandler({ apiKey: API_KEY, port: 0, executable: FAKE_CLAUDE });
}

function post(body: unknown, auth: string = `Bearer ${API_KEY}`): Request {
  return new Request("http://127.0.0.1/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: auth },
    body: JSON.stringify(body),
  });
}

/** Read an SSE body into its decoded frames, exactly as arbor's adapter does. */
async function readFrames(response: Response): Promise<{ raw: string; events: any[]; done: boolean }> {
  const raw = await response.text();
  const events: any[] = [];
  let done = false;
  for (const block of raw.split("\n\n")) {
    const line = block.trim();
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (payload === "[DONE]") { done = true; continue; }
    events.push(JSON.parse(payload));
  }
  return { raw, events, done };
}

const REQUEST = {
  model: "claude-haiku-4-5",
  stream: true,
  stream_options: { include_usage: true },
  messages: [
    { role: "system", content: "You grade things." },
    { role: "user", content: "Grade this." },
  ],
};

describe("chat completions over the real SSE surface", () => {
  it("streams assistant text and terminates with the [DONE] sentinel", async () => {
    const response = await handler()(post(REQUEST));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");

    const { events, done } = await readFrames(response);
    expect(done).toBe(true);

    const text = events
      .flatMap((e) => e.choices ?? [])
      .map((c: any) => c.delta?.content ?? "")
      .join("");
    expect(text).toBe("Hello, world");
  });

  it("never leaks reasoning tokens into assistant content", async () => {
    const { raw } = await readFrames(await handler()(post(REQUEST)));
    expect(raw).not.toContain("SHOULD-NOT-LEAK");
  });

  it("reports usage under OpenAI names with cache detail arbor can invert", async () => {
    const { events } = await readFrames(await handler()(post(REQUEST)));
    const usage = events.find((e) => e.usage)?.usage;
    expect(usage).toBeDefined();
    // arbor recovers true input tokens as
    // prompt_tokens - cached_tokens - cache_creation_tokens.
    expect(usage.prompt_tokens - usage.prompt_tokens_details.cached_tokens - usage.prompt_tokens_details.cache_creation_tokens).toBe(9);
    expect(usage.completion_tokens).toBe(41);
    expect(usage.prompt_tokens_details.cache_creation_tokens).toBe(803);
    expect(usage).not.toHaveProperty("input_tokens");
  });

  it("holds the model identity constant across every chunk", async () => {
    const { events } = await readFrames(await handler()(post(REQUEST)));
    const models = new Set(events.filter((e) => e.model).map((e) => e.model));
    expect([...models]).toEqual(["claude-haiku-4-5"]);
  });

  it("passes a system message as --system-prompt and the turn on stdin", async () => {
    // fake-claude echoes argv and stdin back in its init frame, so drive the
    // backend directly to prove the composed command line.
    const init = initFrame();
    expect(init.argv).toContain("--system-prompt");
    expect(init.argv[init.argv.indexOf("--system-prompt") + 1]).toBe("You grade things.");
    expect(init.stdin).toBe("Grade this.");
    // A model endpoint must not inherit the agent's tools, hooks, or MCP servers.
    expect(init.argv).toContain("--strict-mcp-config");
    expect(init.argv).toContain("--disable-slash-commands");
    expect(init.argv[init.argv.indexOf("--disallowedTools") + 1]).toContain("Bash");
  });

  it("surfaces a backend failure as an in-stream error, still closing with [DONE]", async () => {
    process.env["FAKE_CLAUDE_MODE"] = "error";
    try {
      const { events, done } = await readFrames(await handler()(post(REQUEST)));
      expect(done).toBe(true);
      const failure = events.find((e) => e.error);
      expect(failure.error.message).toContain("boom");
    } finally {
      delete process.env["FAKE_CLAUDE_MODE"];
    }
  });

  it("reports a CLI that dies without a result frame", async () => {
    process.env["FAKE_CLAUDE_MODE"] = "crash";
    try {
      const { events, done } = await readFrames(await handler()(post(REQUEST)));
      expect(done).toBe(true);
      expect(events.find((e) => e.error).error.message).toMatch(/without a result frame/);
    } finally {
      delete process.env["FAKE_CLAUDE_MODE"];
    }
  });
});

describe("authentication and routing", () => {
  it("rejects a missing bearer token", async () => {
    const response = await handler()(post(REQUEST, ""));
    expect(response.status).toBe(401);
  });

  it("rejects a wrong bearer token", async () => {
    const response = await handler()(post(REQUEST, "Bearer nope"));
    expect(response.status).toBe(401);
  });

  it("serves /health without authentication", async () => {
    const response = await handler()(new Request("http://127.0.0.1/health"));
    expect(response.status).toBe(200);
  });

  it("404s an unknown route", async () => {
    const response = await handler()(
      new Request("http://127.0.0.1/v1/embeddings", { headers: { authorization: `Bearer ${API_KEY}` } }),
    );
    expect(response.status).toBe(404);
  });
});

const TOOLS = [
  { type: "function", function: { name: "read_file", description: "Read a file", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } } },
  { type: "function", function: { name: "write_file", parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } } } } },
];

function withFake(mode: string, structured?: unknown, run?: () => Promise<void>): Promise<void> {
  const previous = { mode: process.env.FAKE_CLAUDE_MODE, structured: process.env.FAKE_CLAUDE_STRUCTURED };
  process.env.FAKE_CLAUDE_MODE = mode;
  if (structured !== undefined) process.env.FAKE_CLAUDE_STRUCTURED = JSON.stringify(structured);
  return (run ?? (async () => {}))().finally(() => {
    if (previous.mode === undefined) delete process.env.FAKE_CLAUDE_MODE; else process.env.FAKE_CLAUDE_MODE = previous.mode;
    if (previous.structured === undefined) delete process.env.FAKE_CLAUDE_STRUCTURED; else process.env.FAKE_CLAUDE_STRUCTURED = previous.structured;
  });
}

describe("tool-call emulation over the CLI's structured output", () => {
  it("turns a tool_calls decision into indexed OpenAI tool_calls deltas and finish_reason tool_calls", () => withFake("structured",
    { action: "tool_calls", text: "Reading first.", tool_calls: [{ name: "read_file", arguments: { path: "src/a.ts" } }, { name: "write_file", arguments: { path: "b", content: "x" } }] },
    async () => {
      const response = await handler()(post({ ...REQUEST, tools: TOOLS, tool_choice: "auto" }));
      expect(response.status).toBe(200);
      const { events, done } = await readFrames(response);
      expect(done).toBe(true);
      const calls = events.flatMap((event) => event.choices?.[0]?.delta?.tool_calls ?? []);
      expect(calls.map((call: any) => [call.index, call.type, call.function.name, JSON.parse(call.function.arguments)])).toEqual([
        [0, "function", "read_file", { path: "src/a.ts" }],
        [1, "function", "write_file", { path: "b", content: "x" }],
      ]);
      expect(calls.every((call: any) => typeof call.id === "string" && call.id.startsWith("call_"))).toBe(true);
      expect(events.map((event) => event.choices?.[0]?.finish_reason).filter(Boolean)).toEqual(["tool_calls"]);
      const text = events.map((event) => event.choices?.[0]?.delta?.content ?? "").join("");
      expect(text).toBe("Reading first.");
      expect(events.at(-1).usage.completion_tokens).toBe(7);
    }));

  it("turns a final decision into plain content with finish_reason stop", () => withFake("structured",
    { action: "final", text: "All done.", tool_calls: [] },
    async () => {
      const { events } = await readFrames(await handler()(post({ ...REQUEST, tools: TOOLS })));
      expect(events.map((event) => event.choices?.[0]?.delta?.content ?? "").join("")).toBe("All done.");
      expect(events.map((event) => event.choices?.[0]?.finish_reason).filter(Boolean)).toEqual(["stop"]);
      expect(events.flatMap((event) => event.choices?.[0]?.delta?.tool_calls ?? [])).toEqual([]);
    }));

  it("reports a decision naming an unknown tool as an in-stream provider error, still closing with [DONE]", () => withFake("structured",
    { action: "tool_calls", text: "", tool_calls: [{ name: "rm_rf", arguments: {} }] },
    async () => {
      const { events, done } = await readFrames(await handler()(post({ ...REQUEST, tools: TOOLS })));
      expect(done).toBe(true);
      expect(events.some((event) => event.error?.code === 502 && String(event.error.message).includes("unknown tool"))).toBe(true);
      expect(events.flatMap((event) => event.choices?.[0]?.delta?.tool_calls ?? [])).toEqual([]);
    }));

  it("forwards structured output without tools from the result frame, which the CLI never streams as text", () => withFake("structured",
    { verdict: "pass", n: 4 },
    async () => {
      const request = { ...REQUEST, response_format: { type: "json_schema", json_schema: { name: "v", schema: { type: "object" } } } };
      const { events } = await readFrames(await handler()(post(request)));
      expect(JSON.parse(events.map((event) => event.choices?.[0]?.delta?.content ?? "").join(""))).toEqual({ verdict: "pass", n: 4 });
    }));

  it("never forwards the model's narration under a schema, in either mode", () => withFake("structured",
    { action: "final", text: "done", tool_calls: [] },
    async () => {
      const withTools = await readFrames(await handler()(post({ ...REQUEST, tools: TOOLS })));
      expect(withTools.events.map((event) => event.choices?.[0]?.delta?.content ?? "").join("")).toBe("done");
      const schemaOnly = await readFrames(await handler()(post({ ...REQUEST, response_format: { type: "json_schema", json_schema: { name: "v", schema: { type: "object" } } } })));
      expect(schemaOnly.events.map((event) => event.choices?.[0]?.delta?.content ?? "").join("")).not.toContain("NARRATION");
    }));

  it("tool_choice none serves the request toolless", () => withFake("structured", { verdict: "x" }, async () => {
    const { events } = await readFrames(await handler()(post({ ...REQUEST, tools: TOOLS, tool_choice: "none", response_format: { type: "json_schema", json_schema: { name: "v", schema: { type: "object" } } } })));
    expect(events.map((event) => event.choices?.[0]?.delta?.content ?? "").join("")).toBe(JSON.stringify({ verdict: "x" }));
  }));

  it("builds a closed decision schema and a text catalogue for the system prompt", () => {
    const schema = toolDecisionSchema(TOOLS as any);
    expect((schema.properties as any).tool_calls.items.properties.name.enum).toEqual(["read_file", "write_file"]);
    const instructions = toolProtocolInstructions(TOOLS as any, undefined);
    expect(instructions).toContain("\"name\":\"read_file\"");
    expect(instructions).toContain("Read a file");
    expect(toolProtocolInstructions(TOOLS as any, { type: "object", properties: { verdict: { type: "string" } } })).toContain("conforming to this schema");
  });

  it("rejects a forced named tool_choice and a malformed tool", async () => {
    expect((await handler()(post({ ...REQUEST, tools: TOOLS, tool_choice: { type: "function", function: { name: "read_file" } } }))).status).toBe(400);
    expect((await handler()(post({ ...REQUEST, tools: [{ type: "function", function: { name: "" } }] }))).status).toBe(400);
  });
});

describe("refusing what a CLI-backed bridge cannot honestly serve", () => {

  it("rejects image parts", () => {
    expect(() =>
      composePrompt([{ role: "user", content: [{ type: "image_url" } as any] }]),
    ).toThrow(BridgeRequestError);
  });
});

describe("translation invariants", () => {
  // These assert the invariants arbor's `parseUsage` ENFORCES on the far side,
  // not this package's internal consistency. Asserting only the latter is what
  // let a usage mapping ship that every campaign through this route rejected
  // as a protocol violation on its first model call.
  const REAL: ClaudeUsage = { input_tokens: 9, output_tokens: 41, cache_read_input_tokens: 8811, cache_creation_input_tokens: 803 };

  it("keeps cache reads and writes inside prompt_tokens, as the consumer requires", () => {
    const usage = toOpenAIUsage(REAL);
    const { cached_tokens: cacheRead, cache_creation_tokens: cacheWrite } = usage.prompt_tokens_details;
    // arbor throws "protocol: cache read/write tokens exceed reported prompt
    // tokens" unless this holds.
    expect(cacheRead + cacheWrite).toBeLessThanOrEqual(usage.prompt_tokens);
    expect(usage.prompt_tokens).toBe(9623);
  });

  it("makes the consumer's disjoint decomposition recover Claude's input_tokens", () => {
    const usage = toOpenAIUsage(REAL);
    const { cached_tokens: cacheRead, cache_creation_tokens: cacheWrite } = usage.prompt_tokens_details;
    // arbor derives input_tokens exactly this way and needs it non-negative.
    expect(usage.prompt_tokens - cacheRead - cacheWrite).toBe(9);
    expect(usage.total_tokens).toBe(9664);
  });

  it("holds for a first-turn call that only writes cache", () => {
    const usage = toOpenAIUsage({ input_tokens: 3, output_tokens: 6, cache_read_input_tokens: 2385, cache_creation_input_tokens: 4451 });
    const { cached_tokens: cacheRead, cache_creation_tokens: cacheWrite } = usage.prompt_tokens_details;
    expect(cacheRead + cacheWrite).toBeLessThanOrEqual(usage.prompt_tokens);
    expect(usage.prompt_tokens - cacheRead - cacheWrite).toBe(3);
  });

  it("holds when the backend reports no cache activity at all", () => {
    const usage = toOpenAIUsage({ input_tokens: 120, output_tokens: 30 });
    expect(usage.prompt_tokens).toBe(120);
    expect(usage.prompt_tokens_details.cached_tokens + usage.prompt_tokens_details.cache_creation_tokens).toBe(0);
    expect(usage.prompt_tokens - usage.prompt_tokens_details.cached_tokens - usage.prompt_tokens_details.cache_creation_tokens).toBe(120);
  });

  it("defaults usage to zeros when the backend reports none", () => {
    expect(toOpenAIUsage(undefined).total_tokens).toBe(0);
  });

  it("splits system messages out of the turn list", () => {
    const composed = composePrompt([
      { role: "system", content: "S1" },
      { role: "system", content: "S2" },
      { role: "user", content: "U" },
    ]);
    expect(composed.systemPrompt).toBe("S1\n\nS2");
    expect(composed.prompt).toBe("U");
  });

  it("replays a multi-turn history as labelled turns", () => {
    const composed = composePrompt([
      { role: "user", content: "one" },
      { role: "assistant", content: "two" },
      { role: "user", content: "three" },
    ]);
    expect(composed.prompt).toBe("Human: one\n\nAssistant: two\n\nHuman: three");
  });

  it("rejects an empty message list", () => {
    expect(() => composePrompt([])).toThrow(BridgeRequestError);
  });

  it("rejects a system-only message list", () => {
    expect(() => composePrompt([{ role: "system", content: "S" }])).toThrow(BridgeRequestError);
  });

  it("resolves aliases but rejects an empty model", () => {
    expect(resolveModel("haiku")).toBe("claude-haiku-4-5");
    expect(resolveModel("some-future-model")).toBe("some-future-model");
    expect(() => resolveModel("  ")).toThrow(BridgeRequestError);
  });

  it("rejects a non-object body and a non-array messages field", () => {
    expect(() => validateRequest(null)).toThrow(BridgeRequestError);
    expect(() => validateRequest({ model: "m", messages: "no" })).toThrow(BridgeRequestError);
  });
});
