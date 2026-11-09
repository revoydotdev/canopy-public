import { describe, expect, it } from "vitest";
import { NativeSessionEngine } from "../src/native-session.js";
import { NativeHarnessWorker } from "../src/native-worker.js";
import { createOpenAICompatibleModelPort, OpenAICompatibleAdapterError } from "../src/openai-compatible.js";
import type { SessionStartRequest } from "../src/protocol.js";
import type { CapabilitySupport } from "../src/capabilities.js";

const capabilities: readonly CapabilitySupport[] = [
  "streaming", "interruption", "resumption", "forking", "ephemeral_sessions", "structured_output", "tool_policy", "workspace_isolation", "approval_mediation", "usage_reporting", "artifact_capture", "remote_transport",
].map((capability) => ({
  capability, grade: "native",
  evidence: { implementation_id: "native-reference", observed_at: "2026-08-09T00:00:00.000Z", detail: "native worker retry fixture" },
})) as readonly CapabilitySupport[];

const start: SessionStartRequest = {
  session_id: "openrouter-retry-proof", required_capabilities: [], lineage: { kind: "new" }, ephemeral: true,
  policy: { filesystem: "read_only", approvals: "always", tool_allow: [], tool_deny: [], workspace_roots: ["/workspace"], max_wall_clock_ms: 60_000, max_events: 100, network_allowed: false, ambient_plugins_allowed: false, user_configuration_allowed: false, inherited_credentials_allowed: false },
};
function success() {
  return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: "recovered" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
}
function fixture(reply: (attempt: number) => Response | Promise<Response>, abortOnWait = false) {
  let attempts = 0;
  const waits: number[] = [];
  const controller = new AbortController();
  const engine = new NativeSessionEngine({ clock: { now: () => 1_700_000_000_000 }, capabilities });
  const model = createOpenAICompatibleModelPort({
    fetch: async (_url, init) => {
      expect(JSON.parse(String(init?.body)).model).toBe("minimax/minimax-m3:free");
      return reply(++attempts);
    },
    base_url: "https://openrouter.ai/api/v1", provider_id: "openrouter", model_id: "minimax/minimax-m3:free",
    observed_at: "2026-09-05T00:00:00Z", credential_required: false, timeout_ms: 1000,
  });
  const worker = new NativeHarnessWorker({ session_engine: engine, model,
    retry_delay: { async wait(ms) { waits.push(ms); if (abortOnWait) { controller.abort(); return "aborted"; } return "elapsed"; } },
  });
  return { engine, waits, attempts: () => attempts,
    run: (maxAttempts = 3) => worker.run({ start, prompt: "safe reference question", max_turns: 1, signal: controller.signal, retry_policy: { max_model_attempts_per_turn: maxAttempts, initial_delay_ms: 10, max_delay_ms: 50 } }),
  };
}

describe("OpenRouter failures through the native worker", () => {
  it.each([408, 409, 429, 500, 502, 503, 504])("recovers from HTTP %s on the same model with bounded backoff", async (status) => {
    const f = fixture((attempt) => attempt === 1 ? new Response(null, { status }) : success());
    const result = await f.run();
    expect(result.session.terminal).toMatchObject({ result: "claimed", message: "recovered" });
    expect(f.attempts()).toBe(2);
    expect(f.waits).toEqual([10]);
  });
  it.each([400, 401, 402, 403, 404, 422])("does not retry terminal HTTP %s", async (status) => {
    const f = fixture(() => new Response(null, { status }));
    await f.run();
    expect(f.attempts()).toBe(1);
    expect(f.waits).toEqual([]);
  });
  it("exhausts exactly the configured attempts", async () => {
    const f = fixture(() => new Response(null, { status: 429 }));
    await f.run();
    expect(f.attempts()).toBe(3);
    expect(f.waits).toEqual([10, 20]);
    expect(JSON.stringify(f.engine.observe(start.session_id))).toContain("model_retry_exhausted");
  });
  it("honors a bounded Retry-After without retrying early", async () => {
    const f = fixture((attempt) => attempt === 1 ? new Response(null, { status: 429, headers: { "retry-after": "0.025" } }) : success());
    await f.run();
    expect(f.waits).toEqual([25]);
  });
  it.each(["120", "999999999999999999999", "Fri, 01 Jan 2100 00:00:00 GMT"])("stops rather than shortening excessive cooldown %s", async (hint) => {
    const f = fixture(() => new Response(null, { status: 429, headers: { "retry-after": hint } }));
    await f.run();
    expect(f.attempts()).toBe(1);
    expect(f.waits).toEqual([]);
    expect(JSON.stringify(f.engine.observe(start.session_id))).toContain("model_retry_deferred");
  });
  it("cancels during backoff without making another request", async () => {
    const f = fixture(() => new Response(null, { status: 503 }), true);
    const result = await f.run();
    expect(f.attempts()).toBe(1);
    expect(result.session.terminal).toMatchObject({ state: "interrupted" });
  });
  it.each(["transport", "timeout"] as const)("bounds %s retries", async (kind) => {
    const f = fixture(() => { throw new OpenAICompatibleAdapterError(kind, "fixture"); });
    await f.run();
    expect(f.attempts()).toBe(3);
    expect(f.waits).toEqual([10, 20]);
  });
  it("does not retry malformed protocol output", async () => {
    const f = fixture(() => new Response("data: not-json\n\n"));
    await f.run();
    expect(f.attempts()).toBe(1);
  });
  it("retries an SSE overload without committing the failed partial answer", async () => {
    const f = fixture((attempt) => attempt === 1
      ? new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: "failed-partial" } }] })}\n\ndata: ${JSON.stringify({ error: { code: 503, message: "overloaded" } })}\n\n`)
      : success());
    const result = await f.run();
    expect(result.session.terminal).toMatchObject({ message: "recovered" });
    expect(f.attempts()).toBe(2);
    expect(JSON.stringify(f.engine.observe(start.session_id))).not.toContain("failed-partial");
  });
  it("rejects excessive configured attempts before contacting a provider", async () => {
    const f = fixture(success);
    await expect(f.run(11)).rejects.toThrow("1 to 10");
    expect(f.attempts()).toBe(0);
  });
});
