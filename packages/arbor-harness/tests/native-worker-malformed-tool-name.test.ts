import { describe, expect, it } from "vitest";

import type { CapabilitySupport } from "../src/capabilities.js";
import { NativeSessionEngine } from "../src/native-session.js";
import { NativeHarnessWorker, isNativeEvidenceToolName, nativeEvidenceToolName, type NativeModelRequest, type NativeToolCall, type NativeToolPort } from "../src/native-worker.js";
import type { SessionStartRequest } from "../src/protocol.js";

/**
 * D6 (UCT Stage 0 pilot 4): a model wrote its chat-template tool-call syntax
 * as a tool name. The worker recorded the raw name as canonical tool-result
 * evidence, the session journal refused it, and the CLI threw out of the
 * whole campaign. A malformed model-chosen name is now refused as a
 * recoverable preflight, and evidence only ever carries a bounded label.
 */

const capabilities: readonly CapabilitySupport[] = ["streaming", "interruption", "ephemeral_sessions", "tool_policy", "usage_reporting"].map((capability) => ({
  capability,
  grade: "native",
  evidence: { implementation_id: "native-worker-malformed-tool-name", observed_at: "2026-10-07T00:00:00.000Z", detail: "fixture" },
})) as readonly CapabilitySupport[];

function start(sessionId: string): SessionStartRequest {
  return {
    session_id: sessionId,
    policy: {
      filesystem: "read_only", approvals: "never", tool_allow: ["file.read"], tool_deny: [], workspace_roots: ["/workspace"],
      max_wall_clock_ms: 1_000, max_events: 200, network_allowed: false, ambient_plugins_allowed: false,
      user_configuration_allowed: false, inherited_credentials_allowed: false,
    },
    required_capabilities: [], lineage: { kind: "new" }, ephemeral: false,
  };
}

const read: NativeToolPort = {
  tool: "file.read",
  async execute() { return { result_summary: "read", model_output: "contents", evidence: { outcome: "succeeded", stage: "execution", code: "ok", effect: "observed", action_scope: { status: "not_required" } } }; },
};

/** Proposes `call` on the first turn, then finishes; keeps every request it saw. */
function scripted(call: NativeToolCall): { model: { run(request: NativeModelRequest): Promise<{ text: readonly never[]; tool_calls: readonly NativeToolCall[]; final_message: string | null }> }; requests: NativeModelRequest[] } {
  const requests: NativeModelRequest[] = [];
  return {
    requests,
    model: {
      async run(request) {
        requests.push(request);
        return requests.length === 1 ? { text: [], tool_calls: [call], final_message: null } : { text: [], tool_calls: [], final_message: "done after the refusal" };
      },
    },
  };
}

const LABEL = /^malformed_tool_name\.[a-f0-9]{16}$/;

describe("NativeHarnessWorker malformed tool names (D6)", () => {
  it("labels only names that are not evidence atoms, deterministically", () => {
    for (const name of ["shell", "functions.shell", "shell.execute", "mcp__srv__tool", "x".repeat(128)]) expect(nativeEvidenceToolName(name)).toBe(name);
    for (const name of ["run shell", "bash<arg_key>", "x".repeat(129), "", "shell\n"]) {
      expect(isNativeEvidenceToolName(name)).toBe(false);
      expect(nativeEvidenceToolName(name)).toMatch(LABEL);
      expect(nativeEvidenceToolName(name)).toBe(nativeEvidenceToolName(name));
    }
    expect(nativeEvidenceToolName("run shell")).not.toBe(nativeEvidenceToolName("bash<arg_key>"));
  });

  it("refuses a malformed name from any adapter as recoverable: the turn continues and the session completes", async () => {
    const engine = new NativeSessionEngine({ clock: { now: () => 1_700_000_000_000 }, capabilities });
    const malformed = "shell<arg_key>cmd</arg_key><arg_value>cat -n more.py</arg_value>";
    // No `uncomposed` marker: the adapter did not classify it (unlike the
    // OpenAI-compatible one), so the worker's own preflight must.
    const { model, requests } = scripted({ call_id: "c1", tool: malformed, input: null, input_summary: "text-form tool call", risk: "low" });
    const result = await new NativeHarnessWorker({ session_engine: engine, model, tools: [read] }).run({ start: start("malformed"), prompt: "inspect", max_turns: 5 });

    expect(result.session.state).toBe("completed");
    expect(requests).toHaveLength(2);
    const refusal = requests[1]!.history.find((entry) => entry.kind === "tool_result");
    // The model sees what it asked for and what it can call instead.
    expect(refusal).toMatchObject({ kind: "tool_result", text: expect.stringContaining("Available tools: file.read") });
    expect((refusal as { text: string }).text).toContain("never write tool-call syntax as text");
    const toolResults = engine.observe("malformed").flatMap((event) => event.kind === "tool_result" ? [event.payload] : []);
    expect(toolResults).toEqual([expect.objectContaining({ tool: expect.stringMatching(LABEL), success: false, evidence: expect.objectContaining({ outcome: "refused", code: "tool_not_composed" }) })]);
    expect(JSON.stringify(engine.observe("malformed"))).not.toContain("arg_key");
  });

  it("labels a malformed name the adapter already marked uncomposed, and keeps a well-formed one verbatim", async () => {
    for (const [tool, expected] of [["bash<arg_key>", LABEL], ["repository_read", /^repository_read$/]] as const) {
      const engine = new NativeSessionEngine({ clock: { now: () => 1_700_000_000_000 }, capabilities });
      const { model } = scripted({ call_id: "c1", tool, input: null, input_summary: "uncomposed", risk: "low", context_refs: [], uncomposed: { available_tools: ["file.read"] } });
      const result = await new NativeHarnessWorker({ session_engine: engine, model, tools: [read] }).run({ start: start(`uncomposed-${tool.length}`), prompt: "inspect", max_turns: 5 });
      expect(result.session.state).toBe("completed");
      const toolResult = engine.observe(`uncomposed-${tool.length}`).find((event) => event.kind === "tool_result");
      expect(toolResult?.payload).toMatchObject({ tool: expect.stringMatching(expected) });
    }
  });
});
