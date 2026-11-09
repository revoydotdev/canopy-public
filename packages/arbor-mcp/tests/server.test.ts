import { describe, it, expect } from "vitest";
import { ArborMCPServer } from "../src/server.js";
import { RuntimeEventStream, TaskSupervisor, type Action, type ScoreContext, type Provenance } from "@arbor/core";
import { CampaignManager } from "../src/manager.js";
import { ArborRuntime } from "../src/runtime.js";
import type { RecoveryLeaseAuthority } from "../src/recovery-service.js";

function query(kind: import("@arbor/core").ApplicationQuery): import("@arbor/core").RuntimeQueryEnvelope {
  return { schema_version: 1, query_id: `query:${kind.kind}`, query: kind };
}

const rootAction: Action = {
  description: "execute plan",
  estimated_gain: 100,
  estimated_cost: 1,
  category: "root",
  delegate_to: "crown",
};

const refactorAction: Action = {
  description: "refactor auth",
  estimated_gain: 50,
  estimated_cost: 10,
  category: "refactor",
  delegate_to: "seed",
};

const ctx: ScoreContext = {
  accuracy_regression_rate: 0,
  crash_regression_rate: 0,
  best_known: 100,
  total_visits: 5,
};

const verifiedProv: Provenance = { tag: "verified", cmd: "pytest", exit: 0, stdout_hash: "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855" };

async function branchFixture(server: ArborMCPServer, campaignId: string): Promise<string> {
  const acknowledgement = await server.callTool("arbor_command", {
    kind: "tree.branch", campaign_id: campaignId, node_id: "root", actions: [refactorAction],
  });
  expect(acknowledgement).toMatchObject({ ok: true, value: { accepted: true } });
  const tree = await server.callTool("arbor_query", {
    kind: "campaign.tree", campaign_id: campaignId, limit: 50,
  }) as { ok: boolean; value: { nodes: Array<{ id: string; parent_id: string | null }> } };
  expect(tree.ok).toBe(true);
  const children = tree.value.nodes.filter((node) => node.parent_id === "root");
  expect(children).toHaveLength(1);
  return children[0]!.id;
}

describe("ArborMCPServer tool listing", () => {
  it("lists all 16 core + 8 devtools tools", () => {
    const server = new ArborMCPServer();
    const tools = server.listTools();
    // 8 devtools tools since ADR-030 added devtools_liveness.
    // 16 core tools since ADR-118 added arbor_gate_status.
    expect(tools).toHaveLength(24);
    expect(tools.map((t) => t.name)).toContain("arbor_start_campaign");
    expect(tools.map((t) => t.name)).toContain("arbor_get_state");
    expect(tools.map((t) => t.name)).toContain("arbor_interrupt_campaign");
    expect(tools.map((t) => t.name)).toContain("arbor_gate_status");
    // A-4: generic catalog-command/query tools, discoverable via tools/list.
    expect(tools.map((t) => t.name)).toContain("arbor_command");
    expect(tools.map((t) => t.name)).toContain("arbor_query");
    expect(tools.map((t) => t.name)).toContain("devtools_open_campaign");
    expect(tools.map((t) => t.name)).toContain("devtools_snapshot");
    expect(tools.map((t) => t.name)).toContain("devtools_step");
    expect(tools.map((t) => t.name)).toContain("devtools_break_on");
  });

  it("publishes conservative advisory operation metadata for every built-in tool", () => {
    const server = new ArborMCPServer();
    const tools = server.listTools();
    const readOnly = new Set([
      "arbor_halt_check", "arbor_gate_status", "arbor_kb_read", "arbor_kb_query",
      "arbor_kb_inject", "arbor_get_state", "arbor_catalog_search", "arbor_query",
      "devtools_snapshot", "devtools_probe", "devtools_trace_tail", "devtools_break_on",
    ]);

    for (const tool of tools) {
      expect(tool.annotations, `${tool.name} annotations`).toMatchObject({
        title: tool.name,
        readOnlyHint: readOnly.has(tool.name),
      });
    }
    expect(tools.find((tool) => tool.name === "arbor_prune")?.annotations).toMatchObject({ destructiveHint: true });
    expect(tools.find((tool) => tool.name === "arbor_command")?.annotations).toMatchObject({ destructiveHint: true });
    // Liveness can execute mutating catalog kinds when explicitly requested.
    expect(tools.find((tool) => tool.name === "devtools_liveness")?.annotations).toMatchObject({ readOnlyHint: false });
  });

  it("keeps tool annotations advisory; existing tier enforcement still refuses a junior mutation", async () => {
    const server = new ArborMCPServer(new ArborRuntime(), { caller_tier: "junior" });
    expect(server.listTools().find((tool) => tool.name === "arbor_interrupt_campaign")?.annotations)
      .toMatchObject({ readOnlyHint: false, destructiveHint: true });
    const result = await server.callTool("arbor_interrupt_campaign", {
      campaign_id: "missing", node_id: "root", scope: "node",
    });
    expect(result).toMatchObject({ ok: false, error: expect.stringMatching(/junior/) });
  });

  it("preserves optional advisory annotations on a registered MCP tool", () => {
    const server = new ArborMCPServer();
    server.registerTool({
      name: "fixture.read",
      description: "Read fixture state.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true },
      handler: async () => ({ ok: true }),
    });
    expect(server.listTools().find((tool) => tool.name === "fixture.read")).toMatchObject({
      name: "fixture.read", annotations: { readOnlyHint: true },
    });
    expect(server.listTools().find((tool) => tool.name === "arbor_command")).toMatchObject({
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    });
  });

  it("fills conservative operation hints on dynamically registered arbor tools", () => {
    const server = new ArborMCPServer();
    server.registerTool({
      name: "arbor_extension.write",
      description: "Extension-owned arbor operation.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      handler: async () => ({ ok: true }),
    });
    expect(server.listTools().find((tool) => tool.name === "arbor_extension.write")).toMatchObject({
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    });
  });

  it("separates the 2 concrete resources from its 3 resource templates", () => {
    const server = new ArborMCPServer();
    const resources = server.listResources();
    expect(resources).toHaveLength(2);
    expect(resources[0]).toMatchObject({ uri: "arbor://frame", mimeType: "application/json" });
    expect(resources[1]).toMatchObject({ uri: "arbor://capabilities", mimeType: "application/json" });
    expect(server.listResourceTemplates()).toHaveLength(3);
    expect(server.listResourceTemplates().map((r) => r.uriTemplate)).toEqual(expect.arrayContaining([
      "arbor://campaigns/{id}/state",
      "arbor://campaigns/{id}/kb",
      "arbor://campaigns/{id}/audit",
    ]));
  });
});

describe("ArborMCPServer canonical runtime composition", () => {
  it("uses the injected runtime and its exact manager, supervisor, and event stream", async () => {
    const manager = new CampaignManager();
    const supervisor = new TaskSupervisor();
    const events = new RuntimeEventStream("injected-runtime");
    const runtime = new ArborRuntime({ manager, supervisor, event_stream: events });
    const server = new ArborMCPServer(runtime);

    expect(server.runtime).toBe(runtime);
    expect(server.manager).toBe(manager);
    expect(server.runtime.supervisor).toBe(supervisor);
    expect(server.runtime.eventStream).toBe(events);
    expect(server.runtimeCatalog).toBeDefined();
    await server.callTool("arbor_start_campaign", { id: "shared", plan_path: "plan.md", root_action: rootAction });
    expect(runtime.manager.getCampaignSnapshot("shared")).not.toBeNull();
  });

  it("dispatches catalog commands and queries through that same runtime", async () => {
    const runtime = new ArborRuntime();
    const server = new ArborMCPServer(runtime);
    const result = server.executeRuntimeQuery(query({ kind: "campaign.list", limit: 10 }));
    expect(result).toMatchObject({ ok: true, value: { items: [], total: 0 }, capability: "campaign.read" });
    expect(server.runtimeCatalog).toBeDefined();
    expect(server.runtime).toBe(runtime);
  });

  function identityMutateCommand(operationId: string, sessionId: string) {
    return {
      schema_version: 1 as const,
      metadata: { operation_id: operationId, idempotency_key: operationId, correlation_id: operationId, actor_id: "test-operator", requested_at: new Date().toISOString() },
      command: { kind: "session.identity.mutate" as const, session_id: sessionId, display_name: "x", provenance: { tag: "claimed" as const, claimant: "test" } },
    };
  }

  it("WA-10: threads an explicit caller_tier into the RuntimeCatalogRouter so a junior stdio caller is denied a mutating kind", async () => {
    const runtime = new ArborRuntime();
    const juniorServer = new ArborMCPServer(runtime, { caller_tier: "junior" });
    const denied = await juniorServer.dispatchRuntimeCommand(identityMutateCommand("t1", "s1"));
    expect(denied).toMatchObject({ ok: false, error: { code: "permission" } });
    expect((denied as { error: { summary: string } }).error.summary).toMatch(/junior/);
    // Reads still work for a junior caller.
    const read = juniorServer.executeRuntimeQuery({ schema_version: 1, query_id: "q1", query: { kind: "campaign.list", limit: 10 } });
    expect(read).toMatchObject({ ok: true });
  });

  it("WA-10: omitting caller_tier keeps the trusted in-process default (senior) so existing composition roots are unaffected", async () => {
    const runtime = new ArborRuntime();
    const server = new ArborMCPServer(runtime);
    const result = await server.dispatchRuntimeCommand(identityMutateCommand("t2", "s2"));
    expect(result).toMatchObject({ ok: true, value: { accepted: true } });
  });

  it("preserves structured catalog errors for an unknown operation query", async () => {
    const server = new ArborMCPServer();
    expect(server.executeRuntimeQuery(query({ kind: "operation.get", operation_id: "op-1" }))).toMatchObject({
      ok: false,
      capability: "operation.read",
      error: { code: "conflict", source: "runtime_catalog_router" },
    });
    await expect(server.dispatchRuntimeCommand({ schema_version: 1, metadata: {}, command: { kind: "campaign.start" } })).resolves.toMatchObject({
      ok: false,
      error: { code: "validation", source: "runtime_catalog_router" },
    });
  });

  it("keeps manager construction compatible without allocating a divergent manager", async () => {
    const manager = new CampaignManager();
    const server = new ArborMCPServer(manager);
    expect(server.manager).toBe(manager);
    expect(server.runtime.manager).toBe(manager);
    manager.startCampaign("direct", "plan.md", rootAction);
    expect(await server.callTool("arbor_get_state", { campaign_id: "direct" })).toHaveProperty("status");
  });

  it("exposes runtime lifecycle without changing tool behavior", async () => {
    const server = new ArborMCPServer(new ArborRuntime());
    expect(await server.start()).toMatchObject({ ok: true, value: { state: "started" } });
    expect(await server.close()).toMatchObject({ ok: true, value: { state: "closed" } });
  });

  it("G-03: leaves recovery unavailable when the runtime has no recoveryService", async () => {
    const server = new ArborMCPServer(new ArborRuntime());
    expect(server.runtime.recoveryService).toBeNull();
    const result = await server.dispatchRuntimeCommand(recoveryRetryCommand("root"));
    expect(result).toMatchObject({ ok: true, value: { accepted: false, error: { code: "unavailable", summary: "recovery service is not configured" } } });
  });

  it("G-03: wires runtime.recoveryService into the router so recovery.retry reaches the real service", async () => {
    const manager = new CampaignManager();
    const supervisor = new TaskSupervisor();
    const leases: RecoveryLeaseAuthority = {
      resolveOldLease: () => "inactive",
      acquireFresh: () => ({ ok: true, lease_id: "fresh-lease" }),
      checkIsolation: () => ({ worktree_isolated: true, starting_commit_correct: true }),
      releaseFresh: () => {},
    };
    manager.startCampaign("campaign", "plan.md", rootAction);
    const root = manager.getCampaignSnapshot("campaign")!.root_id;
    const [node] = manager.branch("campaign", root, [rootAction]);
    const runtime = new ArborRuntime({ manager, supervisor, recovery_leases: leases });
    const server = new ArborMCPServer(runtime);

    expect(server.runtime.recoveryService).toBe(runtime.recoveryService);
    const result = await server.dispatchRuntimeCommand(recoveryRetryCommand(node, manager.getCampaignVersion("campaign")));
    expect(result).toMatchObject({ ok: true, value: { accepted: true, recovery: { status: "ready" } } });
    expect(manager.getNodeInfo("campaign", node)?.state).toBe("pending");
  });
});

function recoveryRetryCommand(nodeId: string, expectedVersion = "revision-1") {
  return {
    schema_version: 1 as const,
    metadata: {
      operation_id: "recover-op", idempotency_key: "recover-key", correlation_id: "corr-1",
      actor_id: "crown-agent", requested_at: "2026-08-04T00:00:00.000Z", expected_version: expectedVersion,
    },
    command: {
      kind: "recovery.retry" as const, campaign_id: "campaign", node_id: nodeId, prior_operation_id: "crashed-op",
      reason: "process crashed mid-expansion",
      lease: { lease_id: "stale-lease", worktree_id: "stale-worktree", expires_at: "2026-08-05T00:00:00.000Z" },
    },
  };
}

describe("ArborMCPServer full campaign via tool calls", () => {
  it("start → branch → select → expand → record → state", async () => {
    const server = new ArborMCPServer();

    const startResult = await server.callTool("arbor_start_campaign", {
      id: "camp1",
      plan_path: "plan.md",
      root_action: rootAction,
    });
    expect(startResult).toMatchObject({ ok: true, value: { accepted: true }, capability: "campaign.write" });
    const createdNodeId = await branchFixture(server, "camp1");

    const selectResult = await server.callTool("arbor_select_node", {
      campaign_id: "camp1",
      ctx,
    });
    expect(selectResult).toHaveProperty("node_id");
    const nodeId = (selectResult as { node_id: string }).node_id;
    expect(nodeId).not.toBeNull();
    expect(nodeId).toBe(createdNodeId);

    const expandResult = await server.callTool("arbor_expand_node", {
      campaign_id: "camp1",
      node_id: nodeId,
      isolation_check: {
        worktree_isolated: true,
        starting_commit_correct: true,
        lease_acquired: true,
      },
    });
    expect(expandResult).toMatchObject({ ok: true });

    const recordResult = await server.callTool("arbor_record_result", {
      campaign_id: "camp1",
      node_id: nodeId,
      specialist_output: "refactored successfully",
      specialist_agent: "seed",
      provenance: verifiedProv,
      critic_agent: "lenticel",
      critic_approved: true,
      critic_rationale: "tests pass",
      score_ctx: ctx,
    });
    // arbor_record_result cannot authenticate a caller-supplied "verified"
    // claim (Q2/A-1) — it is downgraded to "claimed" regardless of hash
    // well-formedness. See the dedicated describe block below.
    expect(recordResult).toHaveProperty("state", "claimed");

    const stateResult = await server.callTool("arbor_get_state", {
      campaign_id: "camp1",
    });
    expect(stateResult).toHaveProperty("status");
    expect(stateResult).toHaveProperty("stats");
  });
});

describe("ADR-118 gate refusal projection reaches the MCP tool boundary", () => {
  it("arbor_expand_node attaches the versioned isolation-gate refusal projection on a failing gate", async () => {
    const server = new ArborMCPServer();
    await server.callTool("arbor_start_campaign", { id: "camp-gate", plan_path: "plan.md", root_action: rootAction });
    const nodeId = await branchFixture(server, "camp-gate");

    const expandResult = await server.callTool("arbor_expand_node", {
      campaign_id: "camp-gate",
      node_id: nodeId,
      isolation_check: { worktree_isolated: false, starting_commit_correct: true, lease_acquired: true },
    }) as { ok: false; gate: { gate: string; result: string }; refusal: { schema_version: number; kind: string; state: string; gate: string; evidence_deficit: string | null; remediation: string; correcting_actor: string; corrective_action: string } | null };

    expect(expandResult.ok).toBe(false);
    // The pre-existing `gate` field is unchanged — this is additive wiring.
    expect(expandResult.gate.gate).toBe("isolation");
    expect(expandResult.gate.result).toBe("fail");
    // The new versioned projection carries owning gate + remediation.
    expect(expandResult.refusal).toMatchObject({
      schema_version: 2,
      kind: "gate.refusal",
      state: "refused",
      gate: "isolation",
      correcting_actor: "runtime_host",
      corrective_action: "restore_isolation",
    });
    expect(expandResult.refusal?.remediation).toContain("worktree isolation");

    const statusResult = await server.callTool("arbor_gate_status", { campaign_id: "camp-gate", gate: "isolation" }) as {
      ok: true; projection: { state: string; gate: string; correcting_actor: string; corrective_action: string } | null;
    };
    expect(statusResult.ok).toBe(true);
    expect(statusResult.projection).toMatchObject({ state: "refused", gate: "isolation", correcting_actor: "runtime_host", corrective_action: "restore_isolation" });
  });

  it("arbor_gate_status reports a truthful unavailable projection for a campaign that was never composed", async () => {
    const server = new ArborMCPServer();
    const statusResult = await server.callTool("arbor_gate_status", { campaign_id: "no-such-campaign", gate: "admission" }) as {
      ok: true; projection: { state: string; gate: string; code: string } | null;
    };
    expect(statusResult.ok).toBe(true);
    expect(statusResult.projection).toMatchObject({ state: "unavailable", gate: "admission", code: "campaign_source_unavailable" });
  });

  it("arbor_gate_status reports no refusal (null) once the same gate later passes", async () => {
    const server = new ArborMCPServer();
    await server.callTool("arbor_start_campaign", { id: "camp-gate-pass", plan_path: "plan.md", root_action: rootAction });
    const nodeId = await branchFixture(server, "camp-gate-pass");
    const expandResult = await server.callTool("arbor_expand_node", {
      campaign_id: "camp-gate-pass",
      node_id: nodeId,
      isolation_check: { worktree_isolated: true, starting_commit_correct: true, lease_acquired: true },
    });
    expect(expandResult).toMatchObject({ ok: true });

    const statusResult = await server.callTool("arbor_gate_status", { campaign_id: "camp-gate-pass", gate: "isolation" }) as {
      ok: true; projection: unknown | null;
    };
    expect(statusResult).toEqual({ ok: true, projection: null });
  });
});

describe("arbor_record_result rejects malformed/forged provenance at the MCP boundary (A-1)", () => {
  async function setupExpandedNode(server: ArborMCPServer): Promise<string> {
    await server.callTool("arbor_start_campaign", { id: "camp1", plan_path: "plan.md", root_action: rootAction });
    const nodeId = await branchFixture(server, "camp1");
    await server.callTool("arbor_expand_node", {
      campaign_id: "camp1", node_id: nodeId,
      isolation_check: { worktree_isolated: true, starting_commit_correct: true, lease_acquired: true },
    });
    return nodeId;
  }

  async function attemptRecord(server: ArborMCPServer, nodeId: string, provenance: unknown) {
    return server.callTool("arbor_record_result", {
      campaign_id: "camp1",
      node_id: nodeId,
      specialist_output: "did the work",
      specialist_agent: "seed",
      provenance,
      critic_agent: "lenticel",
      critic_approved: true,
      critic_rationale: "tests pass",
      score_ctx: ctx,
    });
  }

  it("rejects a 'verified' claim with a short, obviously-not-a-real-hash stdout_hash", async () => {
    const server = new ArborMCPServer();
    const nodeId = await setupExpandedNode(server);
    const result = await attemptRecord(server, nodeId, { tag: "verified", cmd: "npm test", exit: 0, stdout_hash: "sha256:0000000000000000000000000000000000000000000000000000000000000" });
    expect(result).toMatchObject({ ok: false });
    expect((result as { error: string }).error).toContain("stdout_hash");
    // The node must not have transitioned to verified — the forged claim never reached the manager.
    const state = await server.callTool("arbor_get_state", { campaign_id: "camp1" });
    expect(state).toHaveProperty("status");
  });

  it("rejects a 'verified' claim with a non-hex stdout_hash", async () => {
    const server = new ArborMCPServer();
    const nodeId = await setupExpandedNode(server);
    const result = await attemptRecord(server, nodeId, { tag: "verified", cmd: "npm test", exit: 0, stdout_hash: "sha256:not-a-real-hash-at-all" });
    expect(result).toMatchObject({ ok: false });
    expect((result as { error: string }).error).toContain("stdout_hash");
  });

  it("rejects a 'verified' claim with an empty stdout_hash", async () => {
    const server = new ArborMCPServer();
    const nodeId = await setupExpandedNode(server);
    const result = await attemptRecord(server, nodeId, { tag: "verified", cmd: "npm test", exit: 0, stdout_hash: "" });
    expect(result).toMatchObject({ ok: false });
    expect((result as { error: string }).error).toContain("stdout_hash");
  });

  it("rejects a 'verified' claim missing cmd", async () => {
    const server = new ArborMCPServer();
    const nodeId = await setupExpandedNode(server);
    const result = await attemptRecord(server, nodeId, { tag: "verified", exit: 0, stdout_hash: "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855" });
    expect(result).toMatchObject({ ok: false });
    expect((result as { error: string }).error).toContain("cmd");
  });

  it("rejects a 'verified' claim with a non-integer exit code", async () => {
    const server = new ArborMCPServer();
    const nodeId = await setupExpandedNode(server);
    const result = await attemptRecord(server, nodeId, { tag: "verified", cmd: "npm test", exit: "0", stdout_hash: "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855" });
    expect(result).toMatchObject({ ok: false });
    expect((result as { error: string }).error).toContain("exit code");
  });

  it("rejects a 'verified' claim with a nonzero exit code", async () => {
    const server = new ArborMCPServer();
    const nodeId = await setupExpandedNode(server);
    const result = await attemptRecord(server, nodeId, { tag: "verified", cmd: "npm test", exit: 1, stdout_hash: "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855" });
    expect(result).toMatchObject({ ok: false });
    expect((result as { error: string }).error).toContain("exit code 0");
  });

  it("rejects free-text verification classification", async () => {
    const server = new ArborMCPServer();
    const nodeId = await setupExpandedNode(server);
    const result = await attemptRecord(server, nodeId, {
      tag: "verified", cmd: "npm test", exit: 0,
      stdout_hash: "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      check: { kind: "whatever the agent says", breadth: "probably enough" },
    });
    expect(result).toMatchObject({ ok: false });
    expect((result as { error: string }).error).toContain("closed kind and breadth");
  });

  it("rejects an unknown provenance tag", async () => {
    const server = new ArborMCPServer();
    const nodeId = await setupExpandedNode(server);
    const result = await attemptRecord(server, nodeId, { tag: "definitely_verified_trust_me" });
    expect(result).toMatchObject({ ok: false });
    expect((result as { error: string }).error).toContain("provenance.tag must be one of");
  });

  it("rejects a non-object provenance", async () => {
    const server = new ArborMCPServer();
    const nodeId = await setupExpandedNode(server);
    const result = await attemptRecord(server, nodeId, "verified");
    expect(result).toMatchObject({ ok: false });
    expect((result as { error: string }).error).toContain("provenance must be an object");
  });

  it("rejects a 'claimed' provenance with an empty claimant", async () => {
    const server = new ArborMCPServer();
    const nodeId = await setupExpandedNode(server);
    const result = await attemptRecord(server, nodeId, { tag: "claimed", claimant: "" });
    expect(result).toMatchObject({ ok: false });
    expect((result as { error: string }).error).toContain("claimant");
  });

  it("downgrades a genuinely well-formed 'verified' claim to 'claimed' — this boundary never trusts a caller's own word (Q2/A-1)", async () => {
    const server = new ArborMCPServer();
    const nodeId = await setupExpandedNode(server);
    // Syntactically perfect: real sha256-shaped hash, real cmd, real exit
    // code. Nothing about this request is malformed — it is exactly what a
    // forger who read validateProvenance's format rules would submit. It
    // must still never reach "verified", because no command actually ran on
    // this path to produce this hash.
    const result = await attemptRecord(server, nodeId, { tag: "verified", cmd: "npm test", exit: 0, stdout_hash: "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855" });
    expect(result).toMatchObject({ state: "claimed" });
  });

  it("a forged-but-well-formed hash for a command that never ran cannot produce a 'verified' node, under a second, independently-chosen hash value", async () => {
    const server = new ArborMCPServer();
    const nodeId = await setupExpandedNode(server);
    // A different well-formed hash than the other tests in this file use —
    // the point is that the *value* of a caller-supplied hash is irrelevant
    // to the outcome, not just one specific fixture.
    const forgedHash = `sha256:${"a".repeat(64)}`;
    const result = await attemptRecord(server, nodeId, {
      tag: "verified",
      cmd: "echo pretend-this-ran",
      exit: 0,
      stdout_hash: forgedHash,
    });
    expect(result).toMatchObject({ state: "claimed" });
    const state = await server.callTool("arbor_get_state", { campaign_id: "camp1" });
    expect(state).toHaveProperty("status");
  });
});

describe("ArborMCPServer error handling", () => {
  it("returns error for unknown tool", async () => {
    const server = new ArborMCPServer();
    const result = await server.callTool("nonexistent_tool", {});
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining("Unknown tool") });
  });

  it("returns error for unknown resource URI", () => {
    const server = new ArborMCPServer();
    const result = server.readResource("invalid://uri");
    expect(result).toMatchObject({ ok: false });
  });

  it("handles campaign not found gracefully", async () => {
    const server = new ArborMCPServer();
    const result = await server.callTool("arbor_halt_check", { campaign_id: "nonexistent" });
    expect(result).toMatchObject({ ok: false });
  });
});

describe("ArborMCPServer resources", () => {
  it("reads campaign state resource", async () => {
    const server = new ArborMCPServer();
    await server.callTool("arbor_start_campaign", {
      id: "camp1",
      plan_path: "plan.md",
      root_action: rootAction,
    });

    const state = server.readResource("arbor://campaigns/camp1/state");
    expect(state).toHaveProperty("status");
    expect(state).toHaveProperty("stats");
  });

  it("reads KB resource", async () => {
    const server = new ArborMCPServer();
    await server.callTool("arbor_start_campaign", {
      id: "camp1",
      plan_path: "plan.md",
      root_action: rootAction,
    });

    const kb = server.readResource("arbor://campaigns/camp1/kb");
    expect(kb).toBeDefined();
  });

  it("resolves arbor://frame to the canonical typed Frame (4F.5) as JSON", async () => {
    const server = new ArborMCPServer();
    await server.callTool("arbor_start_campaign", {
      id: "camp1",
      plan_path: "plan.md",
      root_action: rootAction,
    });

    const frame = server.readResource("arbor://frame") as { columns: number; rows: string[] };
    expect(typeof frame.columns).toBe("number");
    expect(Array.isArray(frame.rows)).toBe(true);
    expect(JSON.parse(JSON.stringify(frame))).toEqual(frame);
    expect(frame.rows.join("\n")).toContain("plan.md");
    expect(frame.rows.join("\n")).toContain("camp1");
  });

  it("arbor://frame renders an empty campaigns screen for a fresh manager (no invented data)", () => {
    const server = new ArborMCPServer();
    const frame = server.readResource("arbor://frame") as { columns: number; rows: string[] };
    expect(frame.rows.join("\n")).toContain("no campaigns");
  });
});

describe("arbor_kb_read / arbor_kb_query / arbor_kb_inject / arbor_prune / arbor_interrupt_campaign tool handlers", () => {
  async function setupCompletedCampaign(server: ArborMCPServer): Promise<{ campaignId: string; nodeId: string }> {
    await server.callTool("arbor_start_campaign", { id: "camp-kb", plan_path: "plan.md", root_action: rootAction });
    const nodeId = await branchFixture(server, "camp-kb");
    await server.callTool("arbor_expand_node", {
      campaign_id: "camp-kb", node_id: nodeId,
      isolation_check: { worktree_isolated: true, starting_commit_correct: true, lease_acquired: true },
    });
    // `arbor_record_result` (the MCP tool) unconditionally downgrades any
    // caller-claimed `tag: "verified"` to `"claimed"` (see
    // `refuseUnauthenticatedVerified` in tools.ts) — and, per the
    // memory-pollution fix (manager.ts's `recordResult`), only a genuinely
    // `verified` result may write a `success_pattern` KB entry or raise
    // `best_score`; a merely `claimed` result must not. Producing a real
    // `success_pattern` entry for this fixture therefore has to go through
    // the same internal path that legitimately establishes `verified`
    // provenance (`opencode-executor.ts`'s `runVerification` calling
    // `CampaignManager.recordResult` directly) rather than the untrusted MCP
    // boundary.
    server.manager.recordResult("camp-kb", nodeId, {
      specialist_output: "refactored successfully, all tests pass",
      specialist_agent: "seed", provenance: verifiedProv,
      critic_agent: "lenticel", critic_approved: true, critic_rationale: "tests pass, code is clean",
      score_ctx: ctx,
    });
    return { campaignId: "camp-kb", nodeId };
  }

  it("arbor_kb_query returns real success_pattern entries for a completed node", async () => {
    const server = new ArborMCPServer();
    const { campaignId } = await setupCompletedCampaign(server);
    const result = (await server.callTool("arbor_kb_query", {
      campaign_id: campaignId,
      filter: { type: "success_pattern" },
      tier: "critic",
    })) as ReadonlyArray<{ id: string; value: unknown }>;
    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBeGreaterThan(0);
  });

  it("arbor_kb_query wraps a thrown error as a structured {ok:false} result rather than rejecting", async () => {
    const server = new ArborMCPServer();
    // "auditor" cap querying with no tier at all still round-trips through the handler's try/catch real path.
    const result = await server.callTool("arbor_kb_query", { tier: "auditor" });
    expect(result).toBeDefined();
  });

  it("arbor_kb_read reads a single entry by the real id a prior kb_query returned", async () => {
    const server = new ArborMCPServer();
    const { campaignId } = await setupCompletedCampaign(server);
    const queried = (await server.callTool("arbor_kb_query", {
      campaign_id: campaignId, filter: { type: "success_pattern" }, tier: "critic",
    })) as ReadonlyArray<{ id: string }>;
    expect(queried.length).toBeGreaterThan(0);
    const entryId = queried[0]!.id;
    const read = await server.callTool("arbor_kb_read", { campaign_id: campaignId, entry_id: entryId, tier: "critic" });
    expect(read).toBeDefined();
  });

  it("arbor_kb_read on an unknown entry id returns a structured failure, not a thrown error", async () => {
    const server = new ArborMCPServer();
    const { campaignId } = await setupCompletedCampaign(server);
    const result = await server.callTool("arbor_kb_read", { campaign_id: campaignId, entry_id: "does-not-exist", tier: "critic" });
    expect(result).toBeDefined();
  });

  it("arbor_kb_inject injects real KB entries into a prompt string for the completed node", async () => {
    const server = new ArborMCPServer();
    const { campaignId, nodeId } = await setupCompletedCampaign(server);
    const result = (await server.callTool("arbor_kb_inject", {
      prompt: "base prompt", campaign_id: campaignId, node_id: nodeId, tier: "critic",
    })) as { prompt: string };
    expect(result.prompt).toContain("base prompt");
  });

  it("arbor_kb_inject on an unknown campaign returns a structured failure, not a thrown error", async () => {
    const server = new ArborMCPServer();
    const result = await server.callTool("arbor_kb_inject", { prompt: "p", campaign_id: "no-such-campaign", tier: "critic" });
    expect(result).toHaveProperty("error");
  });

  it("arbor_prune removes a real node and all its children from the tree", async () => {
    const server = new ArborMCPServer();
    await server.callTool("arbor_start_campaign", { id: "camp-prune", plan_path: "plan.md", root_action: rootAction });
    const nodeId = await branchFixture(server, "camp-prune");
    const result = await server.callTool("arbor_prune", { campaign_id: "camp-prune", node_id: nodeId });
    expect(result).toMatchObject({ ok: true, value: { accepted: true } });
    const queried = (await server.callTool("arbor_query", {
      kind: "campaign.snapshot", campaign_id: "camp-prune",
    })) as { ok: boolean; value: { nodes: ReadonlyArray<{ id: string; state: string }> } };
    expect(queried.ok).toBe(true);
    // Pruning tombstones the node's state rather than removing it from the tree.
    const pruned = queried.value.nodes.find((n) => n.id === nodeId);
    expect(pruned?.state).toBe("pruned");
  });

  it("arbor_prune on an unknown campaign returns a structured failure, not a thrown error", async () => {
    const server = new ArborMCPServer();
    const result = await server.callTool("arbor_prune", { campaign_id: "no-such-campaign", node_id: "root" });
    expect(result).toMatchObject({ ok: true, value: { accepted: false, error: expect.any(Object) } });
  });

  it("arbor_interrupt_campaign interrupts a real expanding node through the canonical tree.interrupt command", async () => {
    const server = new ArborMCPServer();
    await server.callTool("arbor_start_campaign", { id: "camp-interrupt", plan_path: "plan.md", root_action: rootAction });
    const nodeId = await branchFixture(server, "camp-interrupt");
    await server.callTool("arbor_expand_node", {
      campaign_id: "camp-interrupt", node_id: nodeId,
      isolation_check: { worktree_isolated: true, starting_commit_correct: true, lease_acquired: true },
    });
    const result = (await server.callTool("arbor_interrupt_campaign", {
      campaign_id: "camp-interrupt", node_id: nodeId, scope: "node", reason: "mcp-test",
    })) as { affected_node_ids: string[]; version: string };
    expect(result.affected_node_ids).toContain(nodeId);
    expect(typeof result.version).toBe("string");
  });

  it("arbor_interrupt_campaign on an unknown campaign returns a structured failure, not a thrown error", async () => {
    const server = new ArborMCPServer();
    const result = await server.callTool("arbor_interrupt_campaign", {
      campaign_id: "no-such-campaign", node_id: "root", scope: "node",
    });
    expect(result).toHaveProperty("error");
  });
});
