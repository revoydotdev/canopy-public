/**
 * Proves the composition-root wiring for the child→parent bus tools, not
 * just the ports in isolation (that is `native-child-bus.test.ts`, which
 * hand-builds `resolve_scope` and would stay green even if no caller ever
 * supplied `bus_thread_for_session`).
 *
 * This test drives `nativeBusThreadForSession` — the exact function
 * `cli.ts`'s `configuredNativeAgentExecutor` passes as
 * `NativeAgentExecutorOptions.bus_thread_for_session` at the real
 * `new NativeAgentExecutor({...})` call site — through a real
 * `NativeAgentExecutor.specialize()` dispatch against a real `ArborRuntime`/
 * `CampaignManager` campaign tree. It asserts the tool names the host
 * actually authorizes for the session (`model_for_role`'s `allowed_tools`,
 * the composed-role output that both the executor's turn loop and cli.ts's
 * own model-tool filter key off of) contain the bus-thread tools for a
 * dispatched child, and contain none of them for a root node (which has no
 * parent to talk back to).
 *
 * `allowed_tools` — not `extension_tools` — is the right signal here:
 * `NativeAgentExecutor`'s generic `advertisedToolDefinitions` only forwards
 * a port that carries a `model_definition` field, which no native tool port
 * (bus or repository) sets; cli.ts instead advertises tool JSON schemas from
 * its own static `NATIVE_REPOSITORY_MODEL_TOOLS`/`NATIVE_BUS_THREAD_MODEL_TOOLS`
 * lists, filtered by `allowed_tools`. `allowed_tools` is therefore both the
 * authorization signal the host actually enforces and the name set cli.ts's
 * `tools:` filter reads — the second test below closes the remaining gap by
 * checking `NATIVE_BUS_THREAD_MODEL_TOOLS` genuinely declares all three.
 */
import { describe, expect, it } from "vitest";
import type { Action } from "@arbor/core";
import type { CapabilitySupport, NativeModelPort } from "@arbor/harness";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { NativeAgentExecutor } from "../src/native-agent-executor.js";
import { nativeBusThreadForSession, NATIVE_BUS_THREAD_MODEL_TOOLS } from "../src/cli.js";
import { ArborRuntime } from "../src/runtime.js";

const capabilities: readonly CapabilitySupport[] = [
  "streaming", "interruption", "ephemeral_sessions", "tool_policy", "usage_reporting",
].map((capability) => ({
  capability,
  grade: "native",
  evidence: { implementation_id: "native-bus-thread-wiring-test", observed_at: "2026-08-19T00:00:00.000Z", detail: "fixture" },
})) as readonly CapabilitySupport[];

function finalModel(message: string): NativeModelPort {
  return { async run() { return { text: [{ text: message, phase: "final" }], tool_calls: [], final_message: message, usage: { input_tokens: 5, output_tokens: 3 } }; } };
}

const rootAction: Action = { description: "root", estimated_gain: 1, estimated_cost: 1, category: "root", delegate_to: "crown" };
const childAction: Action = { description: "child", estimated_gain: 1, estimated_cost: 1, category: "code", delegate_to: "seed" };

/** A real ArborRuntime with a genuine root->child edge, mirroring how the CLI composition root reaches the manager. */
function setup(): { runtime: ArborRuntime; rootId: string; childId: string } {
  const runtime = new ArborRuntime();
  runtime.manager.startCampaign("campaign", "plan.md", rootAction);
  const rootId = runtime.manager.getCampaignSnapshot("campaign")!.root_id;
  const [childId] = runtime.manager.branch("campaign", rootId, [childAction]);
  if (!childId) throw new Error("missing child");
  return { runtime, rootId, childId };
}

/** Constructs the executor exactly the way `cli.ts`'s `configuredNativeAgentExecutor` does for this one option: `bus_thread_for_session` bound to the real runtime via `nativeBusThreadForSession`. */
function buildExecutor(runtime: ArborRuntime, onAllowedTools: (names: readonly string[]) => void, onExtensionTools?: (tools: readonly { readonly name: string }[]) => void): NativeAgentExecutor {
  const runtimeBox: { current: ArborRuntime | null } = { current: runtime };
  return new NativeAgentExecutor({
    workspace_root: "/workspace",
    capabilities,
    bus_thread_for_session: (scope) => nativeBusThreadForSession(runtimeBox, scope),
    model_for_role: (input) => {
      onAllowedTools(input.allowed_tools ?? []);
      onExtensionTools?.(input.extension_tools ?? []);
      return finalModel("done");
    },
  });
}

describe("bus_thread_for_session composition-root wiring", () => {
  it("a dispatched child's authorized tool list genuinely contains bus.thread.send/ack and sibling.status", async () => {
    const { runtime, childId } = setup();
    let names: readonly string[] = [];
    const executor = buildExecutor(runtime, (n) => { names = n; });

    await executor.specialize({ campaign_id: "campaign", node_id: childId, action: {}, prompt: "work", worktree_path: "", specialist_agent: "seed" });

    expect(names).toEqual(expect.arrayContaining(["bus.thread.send", "bus.thread.ack", "sibling.status"]));
  });

  it("bus.thread.clarify is ADVERTISED (extension tool definition) and authorized for a dispatched child, never for a root", async () => {
    const { runtime, rootId, childId } = setup();
    let allowed: readonly string[] = [];
    let advertised: readonly { readonly name: string }[] = [];
    await buildExecutor(runtime, (n) => { allowed = n; }, (t) => { advertised = t; })
      .specialize({ campaign_id: "campaign", node_id: childId, action: {}, prompt: "work", worktree_path: "", specialist_agent: "seed" });
    expect(allowed).toContain("bus.thread.clarify");
    const clarify = advertised.find((tool) => tool.name === "bus.thread.clarify") as { parameters?: { properties?: Record<string, unknown>; required?: string[] }; risk?: string } | undefined;
    expect(clarify, "a composed clarify port that is not advertised is hollow").toBeDefined();
    expect(clarify!.parameters!.required).toEqual(["question"]);
    expect(Object.keys(clarify!.parameters!.properties!)).not.toContain("expected_thread_version");

    allowed = []; advertised = [];
    await buildExecutor(runtime, (n) => { allowed = n; }, (t) => { advertised = t; })
      .specialize({ campaign_id: "campaign", node_id: rootId, action: {}, prompt: "work", worktree_path: "", specialist_agent: "seed" });
    expect(allowed).not.toContain("bus.thread.clarify");
    expect(advertised.map((tool) => tool.name)).not.toContain("bus.thread.clarify");
  });

  it("a root node (no parent edge) gets no bus tools at all", async () => {
    const { runtime, rootId } = setup();
    let names: readonly string[] = [];
    const executor = buildExecutor(runtime, (n) => { names = n; });

    await executor.specialize({ campaign_id: "campaign", node_id: rootId, action: {}, prompt: "work", worktree_path: "", specialist_agent: "seed" });

    expect(names).not.toEqual(expect.arrayContaining(["bus.thread.send"]));
    expect(names).not.toEqual(expect.arrayContaining(["bus.thread.ack"]));
    expect(names).not.toEqual(expect.arrayContaining(["sibling.status"]));
  });

  it("cli.ts's static model-tool declarations genuinely advertise all three bus-thread tool names to the provider", () => {
    const declared = NATIVE_BUS_THREAD_MODEL_TOOLS.map((tool) => tool.name).sort();
    // Inclusion, not exclusivity: the catalog legitimately grew non-bus
    // entries under ADR-087 (subagent.execute, userinput.ask, skill.load,
    // skill.list), which have their own advertisement tests. This test's
    // claim is only that the three bus-thread names all reach the provider.
    expect(declared).toEqual(expect.arrayContaining(["bus.thread.ack", "bus.thread.send", "sibling.status"]));
  });
});

/**
 * The half the behavioural tests above cannot cover.
 *
 * They import `nativeBusThreadForSession` and build their own
 * `NativeAgentExecutor`, so they prove the RESOLVER works — not that `cli.ts`
 * hands it over. Deleting the `bus_thread_for_session:` line from the real
 * composition root leaves every one of them green, which is precisely how the
 * original defect survived: `native-child-bus.test.ts` drove the ports with a
 * hand-built scope while no caller supplied one, and the capability was dead
 * in production for as long as it existed.
 *
 * So this reads the composition root's source. That is weaker than executing
 * it and is treated as such — it proves the option is PASSED, not that the
 * value is correct, which is what the tests above are for. Weak and honest
 * beats strong-looking and vacuous.
 */
describe("the composition root actually passes the resolver", () => {
  it("cli.ts's NativeAgentExecutor construction supplies bus_thread_for_session", () => {
    const source = readFileSync(new URL("../src/cli.ts", import.meta.url), "utf8");
    const sourceFile = ts.createSourceFile("cli.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    let construction: string | null = null;
    const visit = (node: ts.Node): void => {
      if (construction !== null) return;
      if (ts.isNewExpression(node) && node.expression.getText(sourceFile) === "NativeAgentExecutor") {
        construction = node.getText(sourceFile);
        return;
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
    expect(construction, "cli.ts no longer constructs a NativeAgentExecutor — this test needs updating").not.toBeNull();
    // Inspect the parsed construction expression rather than a fixed byte
    // window: adding an earlier option must not make live wiring look absent.
    expect(construction).toContain("bus_thread_for_session:");
    expect(construction).toContain("nativeBusThreadForSession");
  });
});
