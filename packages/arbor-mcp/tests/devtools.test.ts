import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArborMCPServer } from "../src/server.js";
import { ArborRuntime } from "../src/runtime.js";
import type { Action } from "@arbor/core";

const rootAction: Action = {
  description: "execute plan",
  estimated_gain: 100,
  estimated_cost: 1,
  category: "root",
  delegate_to: "crown",
};

const refactorAction: Action = {
  description: "refactor auth module",
  estimated_gain: 50,
  estimated_cost: 10,
  category: "refactor",
  delegate_to: "seed",
};

function newServer(dir?: string): ArborMCPServer {
  const runtime = new ArborRuntime(dir ? { persistence_dir: dir, devtools_logger: { persistence_dir: dir, disable_fsync: true } } : {});
  return new ArborMCPServer(runtime);
}

describe("devtools_* MCP tools", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "devtools-tools-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("devtools_open_campaign starts a fresh campaign and returns a cursor-stamped snapshot", async () => {
    const server = newServer(dir);
    const result = await server.callTool("devtools_open_campaign", {
      campaign_id: "c1",
      plan_path: "/tmp/plan.md",
      root_action: rootAction,
    }) as { ok: boolean; campaign_id: string; snapshot: { cursor: { stream_id: string; sequence: number } } };
    expect(result.ok).toBe(true);
    expect(result.campaign_id).toBe("c1");
    expect(result.snapshot.cursor.stream_id).toBe("arbor-runtime");
    expect(result.snapshot.cursor.sequence).toBeGreaterThanOrEqual(0);
  });

  it("devtools_snapshot lifecycle returns runtime health + cursor", async () => {
    const server = newServer(dir);
    await server.callTool("devtools_open_campaign", {
      campaign_id: "c1",
      plan_path: "/tmp/plan.md",
      root_action: rootAction,
    });
    const result = await server.callTool("devtools_snapshot", { view: "lifecycle" }) as { ok: boolean; snapshot: { value: { lifecycle: { state: string; healthy: boolean } } } };
    expect(result.ok).toBe(true);
    expect(result.snapshot.value.lifecycle.state).toBe("new");
  });

  it("devtools_snapshot campaigns lists active campaigns", async () => {
    const server = newServer(dir);
    await server.callTool("devtools_open_campaign", {
      campaign_id: "alpha",
      plan_path: "/tmp/plan.md",
      root_action: rootAction,
    });
    const result = await server.callTool("devtools_snapshot", { view: "campaigns" }) as { ok: boolean; campaigns: { id: string }[] };
    expect(result.ok).toBe(true);
    expect(result.campaigns.map((c) => c.id)).toContain("alpha");
  });

  it("devtools_snapshot tree requires campaign_id", async () => {
    const server = newServer(dir);
    const result = await server.callTool("devtools_snapshot", { view: "tree" }) as { ok: boolean; error: string };
    expect(result.ok).toBe(false);
    expect(result.error).toContain("campaign_id");
  });

  it("devtools_snapshot tree returns the campaign record", async () => {
    const server = newServer(dir);
    await server.callTool("devtools_open_campaign", {
      campaign_id: "c1",
      plan_path: "/tmp/plan.md",
      root_action: rootAction,
    });
    const result = await server.callTool("devtools_snapshot", { view: "tree", campaign_id: "c1" }) as { ok: boolean; campaign: { id: string } };
    expect(result.ok).toBe(true);
    expect(result.campaign.id).toBe("c1");
  });

  it("devtools_snapshot ledger returns audit records", async () => {
    const server = newServer(dir);
    await server.callTool("devtools_open_campaign", {
      campaign_id: "c1",
      plan_path: "/tmp/plan.md",
      root_action: rootAction,
    });
    const manager = server.manager;
    const [nodeId] = manager.branch("c1", "root", [refactorAction]);
    manager.expandNode("c1", nodeId, { worktree_isolated: true, starting_commit_correct: true, lease_acquired: true });
    manager.recordResult("c1", nodeId, {
      specialist_output: "done",
      specialist_agent: "seed",
      provenance: { tag: "verified", cmd: "pytest", exit: 0, stdout_hash: "sha256:test"},
      critic_agent: "lenticel",
      critic_approved: true,
      critic_rationale: "ok",
      score_ctx: { accuracy_regression_rate: 0, crash_regression_rate: 0, best_known: 100, total_visits: 5 },
    });
    const result = await server.callTool("devtools_snapshot", { view: "ledger", campaign_id: "c1" }) as { ok: boolean; records: { kind?: string }[] };
    expect(result.ok).toBe(true);
    expect(result.records.length).toBeGreaterThan(0);
  });

  it("devtools_probe routes a query through the catalog router", async () => {
    const server = newServer(dir);
    await server.callTool("devtools_open_campaign", {
      campaign_id: "c1",
      plan_path: "/tmp/plan.md",
      root_action: rootAction,
    });
    const result = await server.callTool("devtools_probe", {
      query: { kind: "campaign.list", limit: 10 },
    }) as { ok: boolean; value?: unknown };
    expect(result.ok).toBe(true);
  });

  it("devtools_trace_tail returns a snapshot kind on first call (no cursor)", async () => {
    const server = newServer(dir);
    await server.callTool("devtools_open_campaign", {
      campaign_id: "c1",
      plan_path: "/tmp/plan.md",
      root_action: rootAction,
    });
    const result = await server.callTool("devtools_trace_tail", {}) as { ok: boolean; kind: string };
    expect(result.ok).toBe(true);
    expect(result.kind).toBe("snapshot");
  });

  it("devtools_trace_tail returns events kind after cursor when new events exist", async () => {
    const server = newServer(dir);
    await server.callTool("devtools_open_campaign", {
      campaign_id: "c1",
      plan_path: "/tmp/plan.md",
      root_action: rootAction,
    });
    const first = await server.callTool("devtools_trace_tail", {}) as { ok: boolean; snapshot: { cursor: { stream_id: string; sequence: number } } };
    server.manager.startCampaign("c2", "/tmp/plan.md", rootAction);
    const result = await server.callTool("devtools_trace_tail", { cursor: first.snapshot.cursor }) as { ok: boolean; kind: string; events: unknown[]; cursor: { sequence: number } };
    expect(result.ok).toBe(true);
    expect(result.kind).toBe("events");
    expect(result.events.length).toBeGreaterThan(0);
    expect(result.cursor.sequence).toBeGreaterThan(first.snapshot.cursor.sequence);
  });

  it("devtools_step returns stepped=true on a fresh campaign with expandable nodes", async () => {
    const server = newServer(dir);
    await server.callTool("devtools_open_campaign", {
      campaign_id: "c1",
      plan_path: "/tmp/plan.md",
      root_action: rootAction,
    });
    server.manager.branch("c1", "root", [refactorAction]);
    const result = await server.callTool("devtools_step", { campaign_id: "c1" }) as { ok: boolean; stepped: boolean; selected_node_id: string };
    expect(result.ok).toBe(true);
    expect(result.stepped).toBe(true);
    expect(result.selected_node_id).toBeDefined();
  });

  it("devtools_step returns stepped=false when no node is selectable", async () => {
    const server = newServer(dir);
    await server.callTool("devtools_open_campaign", {
      campaign_id: "c1",
      plan_path: "/tmp/plan.md",
      root_action: rootAction,
    });
    const result = await server.callTool("devtools_step", { campaign_id: "c1" }) as { ok: boolean; stepped: boolean };
    expect(result.ok).toBe(true);
    expect(result.stepped).toBe(false);
  });

  it("listTools includes the devtools_* family", () => {
    const server = newServer(dir);
    const names = server.listTools().map((t) => t.name);
    expect(names).toContain("devtools_open_campaign");
    expect(names).toContain("devtools_snapshot");
    expect(names).toContain("devtools_probe");
    expect(names).toContain("devtools_trace_tail");
    expect(names).toContain("devtools_step");
    expect(names).toContain("devtools_break_on");
    expect(names).toContain("devtools_clear");
  });

  it("callTool returns Unknown tool for a nonexistent devtools tool", async () => {
    const server = newServer(dir);
    const result = await server.callTool("devtools_nonexistent", {}) as { ok: boolean; error: string };
    expect(result.ok).toBe(false);
    expect(result.error).toContain("Unknown tool");
  });

  it("devtools_open_campaign activates the streaming log when persistence is set", async () => {
    const server = newServer(dir);
    await server.callTool("devtools_open_campaign", {
      campaign_id: "c1",
      plan_path: "/tmp/plan.md",
      root_action: rootAction,
    });
    // The runtime owns the logger; starting the runtime starts the logger.
    await server.runtime.start();
    try {
      server.manager.startCampaign("c2", "/tmp/plan.md", rootAction);
      const logPath = join(dir, "devtools", "devtools.log");
      expect(existsSync(logPath)).toBe(true);
      const lines = readFileSync(logPath, "utf8").split("\n").filter((l) => l.trim());
      expect(lines.length).toBeGreaterThan(0);
    } finally {
      await server.runtime.close();
    }
  });

  it("devtools_snapshot unknown view returns an error", async () => {
    const server = newServer(dir);
    const result = await server.callTool("devtools_snapshot", { view: "nonexistent" }) as { ok: boolean; error: string };
    expect(result.ok).toBe(false);
    expect(result.error).toContain("unknown view");
  });

  it("devtools_clear returns cleared count (no-op until breakpoints land)", async () => {
    const server = newServer(dir);
    const result = await server.callTool("devtools_clear", { campaign_id: "c1" }) as { ok: boolean; cleared: number };
    expect(result.ok).toBe(true);
    expect(result.cleared).toBe(0);
  });

  it("devtools_break_on parks and resolves when a matching event fires", async () => {
    const server = newServer(dir);
    await server.callTool("devtools_open_campaign", {
      campaign_id: "c1",
      plan_path: "/tmp/plan.md",
      root_action: rootAction,
    });
    const breakPromise = server.callTool("devtools_break_on", {
      kind: "any",
      campaign_id: "c1",
      timeout_ms: 1000,
    }) as Promise<{ ok: boolean; registration: { id: string }; match: { event: { kind: string } } }>;
    server.manager.branch("c1", "root", [refactorAction]);
    const result = await breakPromise;
    expect(result.ok).toBe(true);
    expect(result.registration.id).toMatch(/^bp_/);
    expect(result.match.event.kind).toBe("tree.node_changed");
  });

  it("WA-11: devtools_break_on rejects a malformed kind immediately instead of parking it", async () => {
    const server = newServer(dir);
    const result = await server.callTool("devtools_break_on", {
      kind: "not_a_real_kind",
    }) as { ok: boolean; error: string };
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/kind/i);
    // Nothing was registered — this must not be the wedged-forever shape.
    expect(server.breakpoints.pending()).toHaveLength(0);
  });

  it("devtools_break_on rejects with timeout when no match fires", async () => {
    const server = newServer(dir);
    const result = await server.callTool("devtools_break_on", {
      kind: "node_failed",
      timeout_ms: 10,
    }) as { ok: boolean; error: { kind: string } };
    expect(result.ok).toBe(false);
    expect(result.error.kind).toBe("timeout");
  });

  it("devtools_clear evicts parked breakpoints and rejects them", async () => {
    const server = newServer(dir);
    const breakPromise = server.callTool("devtools_break_on", {
      kind: "node_failed",
      timeout_ms: 5000,
    });
    const cleared = await server.callTool("devtools_clear", {}) as { ok: boolean; cleared: number };
    expect(cleared.cleared).toBe(1);
    const result = await breakPromise as { ok: boolean; error: { kind: string } };
    expect(result.ok).toBe(false);
    expect(result.error.kind).toBe("cleared");
  });

  it("E2E: full chrome-devtools narrative through the real runtime is externally observable", async () => {
    const server = newServer(dir);
    await server.runtime.start();
    try {
    // open_page
    const open = await server.callTool("devtools_open_campaign", {
      campaign_id: "e2e", plan_path: "/tmp/plan.md", root_action: rootAction,
    }) as { ok: boolean };
    expect(open.ok).toBe(true);

    // snapshot(dom)
    const snap = await server.callTool("devtools_snapshot", { view: "campaigns" }) as { ok: boolean; campaigns: { id: string }[] };
    expect(snap.ok).toBe(true);
    expect(snap.campaigns.map((c) => c.id)).toContain("e2e");

    // drive one tree-search iteration through the canonical manager
    const [nodeId] = server.manager.branch("e2e", "root", [refactorAction]);
    server.manager.expandNode("e2e", nodeId, { worktree_isolated: true, starting_commit_correct: true, lease_acquired: true });
    server.manager.recordResult("e2e", nodeId, {
      specialist_output: "done", specialist_agent: "seed",
      provenance: { tag: "verified", cmd: "pytest", exit: 0, stdout_hash: "sha256:test"},
      critic_agent: "lenticel", critic_approved: true, critic_rationale: "ok",
      score_ctx: { accuracy_regression_rate: 0, crash_regression_rate: 0, best_known: 100, total_visits: 5 },
    });

    // externally observable streaming log: one ND-JSON line per event, jq-compatible
    const logPath = join(dir, "devtools", "devtools.log");
    expect(existsSync(logPath)).toBe(true);
    const lines = readFileSync(logPath, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.every((l) => l.schema === "arbor.devtools/v1")).toBe(true);
    const evidenceLine = lines.find((l) => l.event_kind === "audit.evidence_recorded");
    expect(evidenceLine).toBeDefined();
    expect(evidenceLine.source_record_id).toMatch(/^trace_/);

    // cursor-resume (chrome-devtools navigation)
    const first = await server.callTool("devtools_trace_tail", {}) as { kind: string; snapshot: { cursor: { sequence: number } } };
    expect(first.kind).toBe("snapshot");
    server.manager.startCampaign("e2e-2", "/tmp/plan.md", rootAction);
    const resumed = await server.callTool("devtools_trace_tail", { cursor: first.snapshot.cursor }) as { kind: string; events: unknown[] };
    expect(resumed.kind).toBe("events");
    expect(resumed.events.length).toBeGreaterThan(0);

    // breakpoint park/resume
    const bp = server.callTool("devtools_break_on", { kind: "any", campaign_id: "e2e", timeout_ms: 1000 });
    server.manager.branch("e2e", "root", [refactorAction]);
    const bpRes = await bp as { ok: boolean; match: { event: { kind: string } } };
    expect(bpRes.ok).toBe(true);
    expect(bpRes.match.event.kind).toBe("tree.node_changed");

    // step
    server.manager.startCampaign("e2e-3", "/tmp/plan.md", rootAction);
    server.manager.branch("e2e-3", "root", [refactorAction]);
    const stepRes = await server.callTool("devtools_step", { campaign_id: "e2e-3" }) as { ok: boolean; stepped: boolean; selected_node_id: string };
    expect(stepRes.ok).toBe(true);
    expect(stepRes.stepped).toBe(true);
    expect(stepRes.selected_node_id).toBeDefined();
    } finally {
      await server.runtime.close();
    }
  });
});
