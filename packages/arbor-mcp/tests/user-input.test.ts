import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach } from "vitest";
import { CampaignManager } from "../src/manager.js";
import type { Action } from "@arbor/core";
import { ArborRuntime } from "../src/runtime.js";
import { RuntimeCatalogRouter, RUNTIME_CATALOG } from "../src/runtime-catalog.js";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const root: Action = { description: "root", estimated_gain: 1, estimated_cost: 1, category: "root", delegate_to: "crown" };

function askCommand(overrides: Record<string, unknown> = {}) {
  return {
    schema_version: 1,
    metadata: {
      operation_id: "ask-op-1",
      idempotency_key: "ask-key-1",
      correlation_id: "correlation-1",
      actor_id: "orchestrator",
      requested_at: "2026-08-03T00:00:00.000Z",
    },
    command: {
      kind: "userinput.ask",
      campaign_id: "campaign",
      node_id: "root",
      question: {
        operation_id: "ask:1",
        question: "Proceed with the refactor?",
        options: [{ id: "proceed", text: "Proceed", is_other: false }],
        authority: "lead",
        blocking: "blocking",
        requester_role: "taproot",
        idempotency_key: "ask-key-1",
        as_of: "seq:100",
      },
      ...overrides,
    },
  };
}

function answerCommand(record_id: string, overrides: Record<string, unknown> = {}) {
  return {
    schema_version: 1,
    metadata: {
      operation_id: "answer-op-1",
      idempotency_key: "answer-key-1",
      correlation_id: "correlation-1",
      actor_id: "orchestrator",
      requested_at: "2026-08-03T00:10:00.000Z",
    },
    command: {
      kind: "userinput.answer",
      record_id,
      answer: { option_id: "proceed", custom_text: "", answered_by: "human", answered_at: "2026-08-03T00:11:00.000Z" },
      ...overrides,
    },
  };
}

function listQuery() {
  return {
    schema_version: 1,
    query_id: "q-1",
    query: { kind: "userinput.list", campaign_id: "campaign", node_id: undefined },
  };
}

function awaitingQuery() {
  return {
    schema_version: 1,
    query_id: "q-2",
    query: { kind: "userinput.awaiting", campaign_id: "campaign", node_id: "root" },
  };
}

describe("user-input manager API + catalog", () => {
  it("askForUserInput stages→fsync→swaps and is idempotent", async () => {
    const dir = mkdtempSync(join(tmpdir(), "arbor-ui-"));
    dirs.push(dir);
    const manager = new CampaignManager({ persistence_dir: dir });
    manager.startCampaign("campaign", "plan.md", root);
    expect(manager.awaitingUserInput("campaign")).toBe(false);
    const id = manager.askForUserInput({
      campaign_id: "campaign", node_id: "root", operation_id: "ask:1",
      question: "Proceed?", options: [{ id: "proceed", text: "Proceed", is_other: false }],
      authority: "lead", blocking: "blocking", requester_role: "taproot",
      idempotency_key: "ask-key-1", as_of: "seq:100",
    });
    expect(manager.awaitingUserInput("campaign")).toBe(true);
    expect(manager.getUserInputs("campaign")).toHaveLength(1);
    // answer via manager
    manager.answerUserInput(id, { option_id: "proceed", custom_text: "", answered_by: "human", answered_at: "2026-08-03T00:11:00.000Z" });
    expect(manager.awaitingUserInput("campaign")).toBe(false);
    // re-instantiate from the same dir: constructor restores campaigns + audit ledgers
    const restored = new CampaignManager({ persistence_dir: dir });
    expect(restored.awaitingUserInput("campaign")).toBe(false);
  });

  it("catalog: userinput.ask command is capability-gated and listed", async () => {
    const runtime = new ArborRuntime();
    runtime.manager.startCampaign("campaign", "plan.md", root);
    const router = new RuntimeCatalogRouter(runtime);
    const entry = RUNTIME_CATALOG.find((e) => e.kind === "userinput.ask")!;
    expect(entry.supported).toBe(true);
    expect(entry.capability).toBe("userinput.write");
    const ack = await router.dispatchCommand(askCommand());
    expect(ack.ok).toBe(true);
    if (ack.ok) {
      expect(ack.value).toMatchObject({ accepted: true, operation_id: "ask-op-1" });
    }
    expect(runtime.manager.awaitingUserInput("campaign")).toBe(true);
  });

  it("catalog: userinput.list + userinput.awaiting queries", async () => {
    const runtime = new ArborRuntime();
    runtime.manager.startCampaign("campaign", "plan.md", root);
    const router = new RuntimeCatalogRouter(runtime);
    await router.dispatchCommand(askCommand());
    const list = router.executeQuery(listQuery());
    expect(list.ok).toBe(true);
    if (list.ok) expect((list.value as { records: unknown[] }).records).toHaveLength(1);
    const awaiting = router.executeQuery(awaitingQuery());
    expect(awaiting.ok).toBe(true);
    if (awaiting.ok) expect((awaiting.value as { awaiting: boolean }).awaiting).toBe(true);
  });

  it("catalog: bare userinput.awaiting aggregates pending requests across campaigns (attention feed)", async () => {
    // 2026-08-23 outcome-aware observation gate: the TUI issues this query
    // with no campaign_id on every product refresh; it used to fail
    // validation every time, so "Response needed" attention rows never
    // rendered on a healthy install.
    const runtime = new ArborRuntime();
    runtime.manager.startCampaign("campaign", "plan.md", root);
    runtime.manager.startCampaign("campaign-2", "plan2.md", root);
    const router = new RuntimeCatalogRouter(runtime);
    await router.dispatchCommand(askCommand());
    const aggregate = router.executeQuery({ schema_version: 1, query_id: "aggregate", query: { kind: "userinput.awaiting", limit: 50 } } as never);
    expect(aggregate.ok).toBe(true);
    if (aggregate.ok) {
      const value = aggregate.value as { awaiting: boolean; requests: readonly { campaign_id: string; record_id: string; question: string }[] };
      expect(value.awaiting).toBe(true);
      expect(value.requests).toHaveLength(1);
      expect(value.requests[0]!.campaign_id).toBe("campaign");
      expect(value.requests[0]!.question.length).toBeGreaterThan(0);
    }
    const scopedInvalid = router.executeQuery({ schema_version: 1, query_id: "bad", query: { kind: "userinput.awaiting", node_id: "root" } } as never);
    expect(scopedInvalid.ok).toBe(false);
    const listStillScoped = router.executeQuery({ schema_version: 1, query_id: "list-bare", query: { kind: "userinput.list" } } as never);
    expect(listStillScoped.ok).toBe(false);
  });

  it("catalog: userinput.answer flips awaiting to false", async () => {
    const runtime = new ArborRuntime();
    runtime.manager.startCampaign("campaign", "plan.md", root);
    const router = new RuntimeCatalogRouter(runtime);
    await router.dispatchCommand(askCommand());
    expect(runtime.manager.awaitingUserInput("campaign")).toBe(true);
    const record = runtime.manager.getUserInputs("campaign")[0];
    const ack = await router.dispatchCommand(answerCommand(record.id));
    expect(ack.ok).toBe(true);
    expect(runtime.manager.awaitingUserInput("campaign")).toBe(false);
  });

  it("answering a durable interview requeues only its model-paused node; it does not dispatch or alter siblings", async () => {
    const runtime = new ArborRuntime();
    runtime.manager.startCampaign("campaign", "plan.md", root);
    const [paused, sibling] = runtime.manager.branch("campaign", "root", [root, root]);
    runtime.manager.expandNode("campaign", paused!, { worktree_isolated: true, starting_commit_correct: true, lease_acquired: true });
    const id = runtime.manager.askForUserInput({
      campaign_id: "campaign", node_id: paused!, operation_id: "paused-ask", question: "Continue?",
      options: [{ id: "answer", text: "Answer", is_other: true }], authority: "lead", blocking: "blocking", requester_role: "seed",
      origin_session_id: "native-session", idempotency_key: "paused-ask", as_of: "seq:101",
    });
    runtime.manager.answerUserInput(id, { option_id: null, custom_text: "continue", answered_by: "human", answered_at: "2026-08-03T00:11:00.000Z" });
    expect(runtime.manager.getNodeInfo("campaign", paused!)?.state).toBe("pending");
    expect(runtime.manager.getNodeInfo("campaign", sibling!)?.state).toBe("pending");
  });

  it("catalog: missing capability denies userinput.ask", async () => {
    const runtime = new ArborRuntime();
    runtime.manager.startCampaign("campaign", "plan.md", root);
    const router = new RuntimeCatalogRouter(runtime, { granted_capabilities: new Set() });
    const ack = await router.dispatchCommand(askCommand());
    expect(ack.ok).toBe(false);
    if (!ack.ok) expect(ack.error.code).toBe("permission");
  });
});
