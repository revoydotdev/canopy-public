import { describe, expect, it } from "vitest";
import type { CapabilitySupport, NativeModelPort } from "@arbor/harness";
import { NativeAgentExecutor } from "../src/native-agent-executor.js";
import { HookBus } from "../src/hooks/bus.js";
import { HookCatalog } from "../src/hooks/catalog.js";
import type { HookHandlerRegistry } from "../src/hooks/contracts.js";

const capabilities: readonly CapabilitySupport[] = [
  "streaming", "interruption", "ephemeral_sessions", "tool_policy", "usage_reporting",
].map((capability) => ({
  capability,
  grade: "native",
  evidence: { implementation_id: "native-agent-executor-hook-wrap-test", observed_at: "2026-08-23T00:00:00.000Z", detail: "fixture" },
})) as readonly CapabilitySupport[];

/** WA-54: `specialistTools()`'s early-return path (no `repository_tools`/empty `worktree_path`) must still wrap every port with `hook_bus.wrapToolPort`, exactly like its normal-return path already does. */
describe("NativeAgentExecutor.specialistTools early return (WA-54)", () => {
  it("denies an mcp.* tool via a veto hook even when worktree_path is empty and repository_tools is unset", async () => {
    const handlers: HookHandlerRegistry = {
      "veto.deny-mcp": { kind: "veto", handler: (context) => context.tool.startsWith("mcp.") ? { allow: false, reason: "mcp.* denied for this test" } : { allow: true } },
    };
    const catalog = new HookCatalog({ handlers });
    catalog.register(JSON.stringify({ schema_version: 1, hook_id: "deny-mcp", version: "1.0.0", kind: "veto", event: "tool_preflight", handler_ref: "veto.deny-mcp", why: "test fixture" }));
    const hookBus = new HookBus({ catalog, handlers });

    let toolExecuted = false;
    const model_for_role = (): NativeModelPort => {
      let turn = 0;
      return {
        async run() {
          turn += 1;
          if (turn === 1) return { text: [], tool_calls: [{ call_id: "call-1", tool: "mcp.probe", input: {}, input_summary: "probe", risk: "low" }], final_message: null };
          return { text: [], tool_calls: [], final_message: "done" };
        },
      };
    };

    const executor = new NativeAgentExecutor({
      workspace_root: "/workspace",
      capabilities,
      hook_bus: hookBus,
      model_for_role,
      // No `repository_tools` and an empty `worktree_path` below force
      // `specialistTools()`'s early-return branch (native-agent-executor.ts
      // ~line 566: `if (!this.options.repository_tools || !worktreePath) return ...`).
      specialist_tools: () => [Object.freeze({
        tool: "mcp.probe",
        model_definition: { name: "mcp.probe", description: "probe", parameters: { type: "object" }, risk: "low" as const },
        async execute() { toolExecuted = true; return { result_summary: "ok", model_output: "ok", evidence: { outcome: "succeeded" as const, stage: "execution" as const, code: "ok", effect: "observed" as const, action_scope: { status: "not_required" as const } } }; },
      })],
    });

    const result = await executor.specialize({ campaign_id: "c", node_id: "n", action: {}, prompt: "work", worktree_path: "", specialist_agent: "seed" });

    expect(toolExecuted).toBe(false);
    // The veto reaches the model as a recoverable tool result, so the session
    // continues to its own final answer rather than failing on the refusal.
    expect(result.error).toBeUndefined();
    expect(result.output).toBe("done");
    expect(hookBus.ledger()).toMatchObject([{ hook_id: "deny-mcp", decision: "deny" }]);
  });
});
