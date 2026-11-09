/**
 * A-4 roundtrip (audit/30-hollow-and-traceability.md): proves the generic
 * `arbor_command`/`arbor_query` MCP tools genuinely reach
 * `RuntimeCatalogRouter` through the real, standard MCP surface
 * (`server.listTools()` / `server.callTool()` — the same path `cli.ts`'s
 * `tools/list`/`tools/call` JSON-RPC methods use), not merely that the
 * catalog itself dispatches (already covered by runtime-catalog.test.ts).
 *
 * Before this wave, `job.submit`, `approval.request`, and most other
 * catalog kinds had no MCP tool at all — `server.listTools()` never
 * mentioned them, so a standard MCP client had no way to discover or call
 * them; the ONLY way in was the bespoke `arbor_command`/`arbor_query`
 * JSON-RPC methods in cli.ts (never enumerated by tools/list either) or
 * webui.ts's HTTP routes. These tests drive the tool surface exactly the
 * way a real MCP client would and assert on real projected state.
 */
import { describe, expect, it } from "vitest";
import { ArborMCPServer } from "../src/server.js";
import { ArborRuntime } from "../src/runtime.js";
import type { Action } from "@arbor/core";
import { RUNTIME_CATALOG, runtimeOperationHints } from "../src/runtime-catalog.js";

const rootAction: Action = {
  description: "execute plan",
  estimated_gain: 100,
  estimated_cost: 1,
  category: "root",
  delegate_to: "crown",
};

const childAction: Action = {
  description: "refactor auth",
  estimated_gain: 50,
  estimated_cost: 10,
  category: "refactor",
  delegate_to: "seed",
};

describe("arbor_command / arbor_query — discoverable via tools/list", () => {
  it("classifies every built-in arbor tool with explicit advisory MCP operation hints", () => {
    const tools = new ArborMCPServer().listTools().filter((tool) => tool.name.startsWith("arbor_"));
    const annotations = Object.fromEntries(tools.map((tool) => [tool.name, tool.annotations]));
    const read = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
    const write = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
    const destructive = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false };
    // MCP requires a human-readable `title`; every built-in names itself.
    const titled = (name: string, hints: object) => ({ title: name, ...hints });

    expect(tools).toHaveLength(16);
    expect(annotations).toEqual({
      arbor_start_campaign: titled("arbor_start_campaign", write),
      arbor_select_node: titled("arbor_select_node", write),
      arbor_expand_node: titled("arbor_expand_node", write),
      arbor_record_result: titled("arbor_record_result", write),
      arbor_branch: titled("arbor_branch", write),
      arbor_prune: titled("arbor_prune", destructive),
      arbor_halt_check: titled("arbor_halt_check", read),
      arbor_gate_status: titled("arbor_gate_status", read),
      arbor_kb_read: titled("arbor_kb_read", read),
      arbor_kb_query: titled("arbor_kb_query", read),
      arbor_kb_inject: titled("arbor_kb_inject", read),
      arbor_interrupt_campaign: titled("arbor_interrupt_campaign", destructive),
      arbor_get_state: titled("arbor_get_state", read),
      arbor_catalog_search: titled("arbor_catalog_search", read),
      // These dispatch over heterogeneous catalog kinds. Hints summarize the
      // widest available effect; callers still need per-kind catalog checks.
      arbor_command: titled("arbor_command", { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }),
      arbor_query: titled("arbor_query", { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }),
    });
  });

  it("both tools appear in listTools with catalog-derived kind enums", () => {
    const server = new ArborMCPServer();
    const tools = server.listTools();
    const command = tools.find((t) => t.name === "arbor_command");
    const query = tools.find((t) => t.name === "arbor_query");
    expect(command).toBeDefined();
    expect(query).toBeDefined();

    const commandSchema = command!.inputSchema as { properties: { kind: { enum: string[] } } };
    const querySchema = query!.inputSchema as { properties: { kind: { enum: string[] } } };
    // Previously unreachable kinds (no tool at all) are now advertised.
    expect(commandSchema.properties.kind.enum).toContain("job.submit");
    expect(commandSchema.properties.kind.enum).toContain("approval.request");
    expect(commandSchema.properties.kind.enum).toContain("recovery.retry");
    expect(querySchema.properties.kind.enum).toContain("job.list");
    expect(querySchema.properties.kind.enum).toContain("approval.list");
  });

  it("exposes an intent-scoped search derived from the complete runtime catalog", async () => {
    const server = new ArborMCPServer();
    const tools = server.listTools();
    const search = tools.find((tool) => tool.name === "arbor_catalog_search");
    expect(search).toBeDefined();
    const command = tools.find((tool) => tool.name === "arbor_command")!;
    const query = tools.find((tool) => tool.name === "arbor_query")!;
    expect(search).toMatchObject({ annotations: { readOnlyHint: true } });
    expect(query).toMatchObject({ annotations: { readOnlyHint: true } });
    // The generic command accepts mutating kinds, so it must not claim to be read-only.
    expect(command).not.toHaveProperty("annotations.readOnlyHint", true);
    expect(command.description).toContain("arbor_catalog_search");
    expect(query.description).toContain("arbor_catalog_search");
    expect(command.description).not.toContain("job.submit (");
    expect(query.description).not.toContain("campaign.list (");

    const result = await server.callTool("arbor_catalog_search", { query: "campaign", direction: "query" }) as {
      ok: boolean; matches: (typeof RUNTIME_CATALOG[number] & { operation_hints: ReturnType<typeof runtimeOperationHints> })[]; total: number;
    };
    const expected = RUNTIME_CATALOG.filter((entry) => entry.direction === "query" && [entry.kind, entry.capability, entry.idempotency, entry.supported ? "supported" : "unsupported", entry.supported ? "" : ((entry as { unavailable_reason?: string }).unavailable_reason ?? "")].join(" ").toLowerCase().includes("campaign"));
    expect(result).toEqual({ ok: true, matches: expected.map((entry) => ({ ...entry, operation_hints: runtimeOperationHints(entry) })), total: expected.length });
    expect(result.matches).toContainEqual({ kind: "campaign.list", direction: "query", capability: "campaign.read", idempotency: "not_applicable", supported: true, operation_hints: { read_only: true, repeatable: true, mutating: false, destructive: false, open_world: false } });
  });

  it("classifies each selected operation conservatively for tool choice", async () => {
    const server = new ArborMCPServer();
    const read = await server.callTool("arbor_catalog_search", { query: "campaign.tree", direction: "query" }) as { matches: { operation_hints: unknown }[] };
    const halt = await server.callTool("arbor_catalog_search", { query: "campaign.halt", direction: "command" }) as { matches: { operation_hints: unknown }[] };
    const prune = await server.callTool("arbor_catalog_search", { query: "tree.prune", direction: "command" }) as { matches: { operation_hints: unknown }[] };
    const remote = await server.callTool("arbor_catalog_search", { query: "remote.control", direction: "command" }) as { matches: { operation_hints: unknown }[] };
    expect(read.matches[0]?.operation_hints).toEqual({ read_only: true, repeatable: true, mutating: false, destructive: false, open_world: false });
    expect(halt.matches[0]?.operation_hints).toEqual({ read_only: false, repeatable: false, mutating: true, destructive: true, open_world: false });
    expect(prune.matches[0]?.operation_hints).toEqual({ read_only: false, repeatable: false, mutating: true, destructive: true, open_world: false });
    expect(remote.matches[0]?.operation_hints).toEqual({ read_only: false, repeatable: false, mutating: true, destructive: false, open_world: true });
  });
});

describe("arbor_command / arbor_query — roundtrip through the real ArborMCPServer.callTool path", () => {
  it("preserves core query diagnostics so a client can repair and retry its request", async () => {
    const server = new ArborMCPServer(new ArborRuntime());
    const invalid = await server.callTool("arbor_query", { kind: "campaign.list" });
    expect(invalid).toMatchObject({
      ok: false,
      capability: "campaign.read",
      error: { code: "validation", diagnostic: "query: campaign.list requires positive limit and optional cursor" },
    });
    const repaired = await server.callTool("arbor_query", { kind: "campaign.list", limit: 10 });
    expect(repaired).toMatchObject({ ok: true, capability: "campaign.read", value: { items: [], total: 0 } });
  });

  it("preserves extension-specific query diagnostics rather than applying a core-only contract", async () => {
    const server = new ArborMCPServer(new ArborRuntime());
    const invalid = await server.callTool("arbor_query", { kind: "a2a.cards" });
    expect(invalid).toMatchObject({
      ok: false,
      capability: "a2a.read",
      error: { code: "validation", diagnostic: "campaign_id must be non-empty" },
    });
    const supported = await server.callTool("arbor_query", { kind: "job.list" });
    expect(supported).toMatchObject({ ok: true, value: { jobs: [] } });
  });

  it("tree.branch (bare shorthand, no metadata supplied) then campaign.tree prove the child node exists", async () => {
    const server = new ArborMCPServer(new ArborRuntime());
    const start = (await server.callTool("arbor_start_campaign", {
      id: "camp-a4", plan_path: "plan.md", root_action: rootAction,
    })) as { ok: boolean; campaign_id: string };
    expect(start.ok).toBe(true);
    const rootId = server.manager.getCampaignSnapshot("camp-a4")!.root_id;

    // No metadata field at all — proves the tool synthesizes a complete,
    // validatable OperationMetadata rather than requiring the caller to
    // invent operation_id/idempotency_key/correlation_id/actor_id/requested_at.
    const branchResult = (await server.callTool("arbor_command", {
      kind: "tree.branch",
      campaign_id: "camp-a4",
      node_id: rootId,
      actions: [childAction],
    })) as { ok: boolean; value: { accepted: boolean } };
    expect(branchResult).toMatchObject({ ok: true, value: { accepted: true } });

    const treeResult = (await server.callTool("arbor_query", {
      kind: "campaign.tree",
      campaign_id: "camp-a4",
      limit: 50,
    })) as { ok: boolean; value: { nodes: { id: string; action_description: string }[] } };
    expect(treeResult.ok).toBe(true);
    expect(treeResult.value.nodes.map((n) => n.action_description)).toContain(childAction.description);
  });

  it("job.submit then job.list roundtrip a kind that previously had no MCP tool at all", async () => {
    const server = new ArborMCPServer(new ArborRuntime());
    const submitResult = (await server.callTool("arbor_command", {
      kind: "job.submit",
      id: "job-a4",
      operation_id: "job-a4-op",
      job_kind: "specialist.expand",
      owner_scope_id: "camp-a4-jobs",
      idempotency_key: "job-a4-key",
    })) as { ok: boolean; value: { accepted: boolean; job?: { id: string } } };
    expect(submitResult).toMatchObject({ ok: true, value: { accepted: true, job: { id: "job-a4" } } });

    const listResult = (await server.callTool("arbor_query", { kind: "job.list" })) as {
      ok: boolean;
      value: { jobs: { id: string; kind: string }[] };
    };
    expect(listResult.ok).toBe(true);
    expect(listResult.value.jobs.map((j) => j.id)).toContain("job-a4");
  });

  it("refuses approval.request through the unauthenticated MCP tool while preserving the read projection", async () => {
    const server = new ArborMCPServer(new ArborRuntime());
    const requestResult = (await server.callTool("arbor_command", {
      kind: "approval.request",
      request_id: "appr-a4",
      idempotency_key: "appr-a4-key",
      action: "campaign.halt",
      subject: "campaign:camp-a4",
      resource_id: "camp-a4",
      proposer: "operator-1",
      rationale: "operator requested halt",
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    })) as { ok: boolean; value: { accepted: boolean; error?: { code: string; summary: string } } };
    expect(requestResult).toMatchObject({ ok: true, value: { accepted: false, error: { code: "permission", summary: "approval commands require an authenticated identity" } } });

    const listResult = (await server.callTool("arbor_query", { kind: "approval.list" })) as {
      ok: boolean;
      value: { records: { request_id: string }[] };
    };
    expect(listResult.ok).toBe(true);
    expect(listResult.value.records.map((r) => r.request_id)).not.toContain("appr-a4");
  });

  it("dispatches through the identical single command authority as a direct dispatchRuntimeCommand call (never a second authority)", async () => {
    const server = new ArborMCPServer(new ArborRuntime());
    const viaTool = (await server.callTool("arbor_query", { kind: "campaign.list", limit: 10 })) as unknown;
    const viaDirect = server.executeRuntimeQuery({ schema_version: 1, query_id: "direct", query: { kind: "campaign.list", limit: 10 } });
    expect(viaTool).toMatchObject({ ok: true, value: { items: [], total: 0 }, capability: "campaign.read" });
    expect(viaDirect).toMatchObject({ ok: true, value: { items: [], total: 0 }, capability: "campaign.read" });
  });

  it("routes live node-card queries through the same tool authority", async () => {
    const runtime = new ArborRuntime();
    runtime.manager.startCampaign("camp-a4", "plan.md", { description: "root", estimated_gain: 1, estimated_cost: 1, category: "root", delegate_to: "crown" });
    const server = new ArborMCPServer(runtime);
    const result = (await server.callTool("arbor_query", {
      kind: "nodecard.resolve",
      campaign_id: "camp-a4",
      node_id: "root",
    })) as { ok: boolean; value?: { card: { node_id: string } } };
    expect(result).toMatchObject({ ok: true, value: { card: { node_id: "root" } } });
  });

  it("recovery.retry is genuinely reachable through the tool (not 'Unknown tool') even though its lease field is inert", async () => {
    // No recovery service configured on a bare ArborRuntime() — proves this
    // reaches the real router (a structured "unavailable", the router's own
    // documented behavior in G-03's server.test.ts) rather than the tool
    // itself being missing.
    const server = new ArborMCPServer(new ArborRuntime());
    const result = (await server.callTool("arbor_command", {
      kind: "recovery.retry",
      campaign_id: "camp-a4",
      node_id: "n1",
      prior_operation_id: "crashed-op",
      reason: "process crashed",
      lease: { lease_id: "whatever", worktree_id: "whatever", expires_at: new Date().toISOString() },
      metadata: { expected_version: "v1" },
    })) as { ok: boolean; value: { accepted: boolean; error?: { code: string; summary: string } } };
    expect(result).toMatchObject({ ok: true, value: { accepted: false, error: { code: "unavailable", summary: "recovery service is not configured" } } });
  });
});
