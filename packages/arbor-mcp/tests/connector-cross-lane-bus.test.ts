import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { Action } from "@arbor/core";
import { ArborRuntime } from "../src/runtime.js";
import { RuntimeCatalogRouter } from "../src/runtime-catalog.js";
import { createClaudeCodeCampaignIntegration, createClaudeCodeHarnessConnectorDescriptor } from "../src/integrations/claude-code-campaign.js";
import { createOpenCodeCampaignIntegration, createOpenCodeHarnessConnectorDescriptor } from "../src/integrations/opencode-campaign.js";

const root: Action = { description: "root", estimated_gain: 1, estimated_cost: 1, category: "root", delegate_to: "crown" };
const opencodeFixture = join(dirname(fileURLToPath(import.meta.url)), "fixtures/fake-opencode.mjs");

/**
 * A real ArborRuntime with a mixed-lane campaign tree: a native root and two
 * connector-hosted children (`child`, `otherChild`) under it. Mirrors
 * native-child-bus.test.ts's `setup`, so the two suites prove the same
 * ADR-083 invariants from opposite lanes of the same edge.
 */
function setup(): { runtime: ArborRuntime; child: string; otherChild: string } {
  const runtime = new ArborRuntime();
  runtime.manager.startCampaign("campaign", "plan.md", root);
  const [child] = runtime.manager.branch("campaign", "root", [{ ...root, description: "child", delegate_to: "seed" }]);
  const [otherChild] = runtime.manager.branch("campaign", "root", [{ ...root, description: "other-child", delegate_to: "seed" }]);
  if (!child || !otherChild) throw new Error("missing child");
  return { runtime, child, otherChild };
}

/** Reads the thread exactly the way a real MCP-driven caller would: through the catalog's own `bus.thread.history` query kind, not a manager-internal field. */
function readThreadHistory(runtime: ArborRuntime, parentNodeId: string, childNodeId: string) {
  const router = new RuntimeCatalogRouter(runtime);
  const result = router.executeQuery({
    schema_version: 1,
    query_id: `test-history:${childNodeId}`,
    query: { kind: "bus.thread.history", campaign_id: "campaign", parent_node_id: parentNodeId, child_node_id: childNodeId },
  });
  if (!result.ok) throw new Error(result.error.summary);
  return result.value as { messages: readonly { author_node_id: string; recipient_node_ids: readonly string[]; kind: string; payload_preview?: { content?: string } }[] };
}

describe("cross-lane bus relay (ADR-083, extended across lanes)", () => {
  it("a claude-code connector child's completion report reaches its real parent edge and is readable via bus.thread.history", async () => {
    const { runtime, child } = setup();
    const devtoolsLines: unknown[] = [];
    const integration = createClaudeCodeCampaignIntegration({
      run: async () => ({ ok: true, text: "specialist made the change", usage: { kind: "unavailable", reason: "fixture" } }),
    });
    const executor = integration.createExecutor({
      runtime,
      adapter: { pushDevtoolsLine: (line: unknown) => devtoolsLines.push(line) } as never,
      campaign_id: "campaign",
      cwd: "/repo",
      connector: createClaudeCodeHarnessConnectorDescriptor(),
    });

    expect(readThreadHistory(runtime, "root", child).messages).toHaveLength(0);

    const result = await executor.specialize({
      campaign_id: "campaign",
      node_id: child,
      action: { ...root, description: "change", delegate_to: "seed" },
      prompt: "make the change",
      worktree_path: "/repo/worktree",
      specialist_agent: "seed",
    });
    expect(result.output).toBe("specialist made the change");

    // Real ledger round trip through the same catalog kind a native
    // participant (or an MCP-driven caller) would use -- not a mock, not an
    // in-memory echo on the executor's own return value.
    const history = readThreadHistory(runtime, "root", child);
    expect(history.messages).toHaveLength(1);
    expect(history.messages[0]).toMatchObject({ author_node_id: child, recipient_node_ids: ["root"], kind: "report" });
    expect(history.messages[0]?.payload_preview?.content).toContain("specialist made the change");
    expect(devtoolsLines.some((line) => (line as { event_kind?: string }).event_kind === "loop.bus_thread_report_failed")).toBe(false);
  });

  it("does not leak a connector child's report onto an unrelated node's thread -- cross-lane is not cross-scope", async () => {
    const { runtime, child, otherChild } = setup();
    const integration = createClaudeCodeCampaignIntegration({
      run: async () => ({ ok: true, text: "specialist output", usage: { kind: "unavailable", reason: "fixture" } }),
    });
    const executor = integration.createExecutor({
      runtime,
      adapter: { pushDevtoolsLine: () => {} } as never,
      campaign_id: "campaign",
      cwd: "/repo",
      connector: createClaudeCodeHarnessConnectorDescriptor(),
    });

    await executor.specialize({
      campaign_id: "campaign",
      node_id: child,
      action: { ...root, description: "change", delegate_to: "seed" },
      prompt: "make the change",
      worktree_path: "/repo/worktree",
      specialist_agent: "seed",
    });

    // The relay resolves its edge only from the real campaign tree
    // (`manager.getNodeInfo(campaign_id, node_id).parent_id`); it has no
    // facility to name a different edge, so `otherChild`'s thread must stay
    // untouched -- the same "never silently redirected, never leaked to a
    // foreign edge" guarantee ADR-083's O2 states for the native direction,
    // now demonstrated for a connector-hosted author.
    expect(readThreadHistory(runtime, "root", otherChild).messages).toHaveLength(0);
    expect(readThreadHistory(runtime, "root", child).messages).toHaveLength(1);
  });

  it("reports a specialist failure too, so the parent can observe a connector child's failure mid-campaign, not only its terminal success", async () => {
    const { runtime, child } = setup();
    const integration = createClaudeCodeCampaignIntegration({
      run: async () => ({ ok: false, error: "process exited nonzero" }),
    });
    const executor = integration.createExecutor({
      runtime,
      adapter: { pushDevtoolsLine: () => {} } as never,
      campaign_id: "campaign",
      cwd: "/repo",
      connector: createClaudeCodeHarnessConnectorDescriptor(),
    });

    await executor.specialize({
      campaign_id: "campaign",
      node_id: child,
      action: { ...root, description: "change", delegate_to: "seed" },
      prompt: "make the change",
      worktree_path: "/repo/worktree",
      specialist_agent: "seed",
    });

    const history = readThreadHistory(runtime, "root", child);
    expect(history.messages).toHaveLength(1);
    expect(history.messages[0]?.payload_preview?.content).toContain("process exited nonzero");
  });

  it("a root node (no parent) has nobody to report to -- no message is posted and nothing throws", async () => {
    const runtime = new ArborRuntime();
    runtime.manager.startCampaign("campaign", "plan.md", root);
    const integration = createClaudeCodeCampaignIntegration({
      run: async () => ({ ok: true, text: "root work", usage: { kind: "unavailable", reason: "fixture" } }),
    });
    const executor = integration.createExecutor({
      runtime,
      adapter: { pushDevtoolsLine: () => {} } as never,
      campaign_id: "campaign",
      cwd: "/repo",
      connector: createClaudeCodeHarnessConnectorDescriptor(),
    });

    const result = await executor.specialize({
      campaign_id: "campaign",
      node_id: "root",
      action: { ...root, description: "change", delegate_to: "seed" },
      prompt: "do the root work",
      worktree_path: "/repo/worktree",
      specialist_agent: "seed",
    });
    expect(result.output).toBe("root work");
  });

  it("an opencode connector child's report also reaches its real parent edge (same relay, opencode's own dispatch boundary)", async () => {
    const { runtime, child } = setup();
    const savedStdout = process.env.FAKE_OPENCODE_STDOUT;
    process.env.FAKE_OPENCODE_STDOUT = "opencode specialist finished";
    try {
      const integration = createOpenCodeCampaignIntegration({ executor_options: { opencodeBin: opencodeFixture, specialistModel: "provider/model", timeoutMs: 5_000 } });
      const executor = integration.createExecutor({
        runtime,
        adapter: { pushDevtoolsLine: () => {} } as never,
        campaign_id: "campaign",
        cwd: "/repo",
        connector: createOpenCodeHarnessConnectorDescriptor(),
      });

      expect(readThreadHistory(runtime, "root", child).messages).toHaveLength(0);

      await executor.specialize({
        campaign_id: "campaign",
        node_id: child,
        action: { ...root, description: "change", delegate_to: "seed" },
        prompt: "make the change",
        worktree_path: "/repo/worktree",
        specialist_agent: "seed",
      });

      const history = readThreadHistory(runtime, "root", child);
      expect(history.messages).toHaveLength(1);
      expect(history.messages[0]).toMatchObject({ author_node_id: child, recipient_node_ids: ["root"], kind: "report" });
      expect(history.messages[0]?.payload_preview?.content).toContain("opencode specialist finished");
    } finally {
      if (savedStdout === undefined) delete process.env.FAKE_OPENCODE_STDOUT;
      else process.env.FAKE_OPENCODE_STDOUT = savedStdout;
    }
  });
});
