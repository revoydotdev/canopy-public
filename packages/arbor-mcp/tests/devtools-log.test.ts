import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, existsSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CampaignManager } from "../src/manager.js";
import { DevToolsTraceLogger, devtoolsHookForRuntime, devtoolsLoopHook, type DevToolsLogLine } from "../src/devtools-log.js";
import type { Action, Provenance, ScoreContext } from "@arbor/core";

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

const ctx: ScoreContext = {
  accuracy_regression_rate: 0,
  crash_regression_rate: 0,
  best_known: 100,
  total_visits: 5,
};

const verifiedProv: Provenance = { tag: "verified", cmd: "pytest", exit: 0, stdout_hash: "sha256:test"};

function newManager(dir: string): CampaignManager {
  return new CampaignManager({ persistence_dir: dir });
}

function readLines(path: string): DevToolsLogLine[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as DevToolsLogLine);
}

function startCampaignBranchAndRecord(manager: CampaignManager, id = "c1"): string {
  manager.startCampaign(id, "/tmp/plan.md", rootAction);
  const [nodeId] = manager.branch(id, "root", [refactorAction]);
  manager.expandNode(id, nodeId, { worktree_isolated: true, starting_commit_correct: true, lease_acquired: true });
  manager.recordResult(id, nodeId, {
    specialist_output: "done",
    specialist_agent: "seed",
    provenance: verifiedProv,
    critic_agent: "lenticel",
    critic_approved: true,
    critic_rationale: "looks good",
    score_ctx: ctx,
  });
  return nodeId;
}

describe("DevToolsTraceLogger", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "devtools-log-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("writes one ND-JSON line per runtime event after start", () => {
    const manager = newManager(dir);
    const logger = new DevToolsTraceLogger(manager, { persistence_dir: dir, disable_fsync: true });
    logger.start();
    try {
      startCampaignBranchAndRecord(manager);
      const lines = readLines(join(dir, "devtools", "devtools.log"));
      expect(lines.length).toBeGreaterThan(0);
      expect(lines.every((l) => l.schema === "arbor.devtools/v1")).toBe(true);
      const kinds = new Set(lines.map((l) => l.event_kind));
      expect(kinds.has("campaign.changed")).toBe(true);
      expect(kinds.has("tree.node_changed")).toBe(true);
      expect(kinds.has("audit.evidence_recorded")).toBe(true);
    } finally {
      logger.close();
    }
  });

  it("records the source ledger record_id for ledger-witnessed events", () => {
    const manager = newManager(dir);
    const logger = new DevToolsTraceLogger(manager, { persistence_dir: dir, disable_fsync: true });
    logger.start();
    try {
      startCampaignBranchAndRecord(manager);
      const lines = readLines(join(dir, "devtools", "devtools.log"));
      const evidence = lines.find((l) => l.event_kind === "audit.evidence_recorded");
      expect(evidence).toBeDefined();
      expect(evidence!.source_record_id).not.toBe(null);
      expect(evidence!.source_record_id).toMatch(/^trace_/);
    } finally {
      logger.close();
    }
  });

  it("source_record_id is null for events without a direct ledger pointer", () => {
    const manager = newManager(dir);
    const logger = new DevToolsTraceLogger(manager, { persistence_dir: dir, disable_fsync: true });
    logger.start();
    try {
      // `startCampaign` alone emits campaign.changed but NOT tree.node_changed
      // — branching is what changes a node. This previously read
      // `if (treeChanged) { ... }`, so the tree.node_changed assertion was
      // vacuously skipped on every run and had never once executed: the test
      // advertised covering that event and did not. Branch first, so the
      // event genuinely exists and the assertion genuinely runs.
      manager.startCampaign("c1", "/tmp/plan.md", rootAction);
      manager.branch("c1", "root", [refactorAction]);
      const lines = readLines(join(dir, "devtools", "devtools.log"));
      const treeChanged = lines.find((l) => l.event_kind === "tree.node_changed");
      expect(treeChanged).toBeDefined();
      expect(treeChanged!.source_record_id).toBe(null);
      const campaignChanged = lines.find((l) => l.event_kind === "campaign.changed");
      expect(campaignChanged).toBeDefined();
      expect(campaignChanged!.source_record_id).toBe(null);
    } finally {
      logger.close();
    }
  });

  it("rotates when the active segment exceeds max_bytes", () => {
    const manager = newManager(dir);
    const logger = new DevToolsTraceLogger(manager, {
      persistence_dir: dir,
      max_bytes: 1024,
      max_segments: 2,
      disable_fsync: true,
    });
    logger.start();
    try {
      for (let i = 0; i < 50; i++) {
        manager.startCampaign(`c${i}`, "/tmp/plan.md", rootAction);
      }
      const devtoolsDir = join(dir, "devtools");
      const files = readdirSync(devtoolsDir).filter((f) => f.endsWith(".log"));
      expect(files.length).toBeGreaterThan(1);
      expect(files).toContain("devtools.log");
      const activeSize = existsSync(join(devtoolsDir, "devtools.log"))
        ? readFileSync(join(devtoolsDir, "devtools.log")).byteLength
        : 0;
      expect(activeSize).toBeLessThanOrEqual(1024 * 4);
    } finally {
      logger.close();
    }
  });

  it("is backpressure-safe: overflow drops oldest and writes a synthetic stream.truncated marker", () => {
    const manager = newManager(dir);
    const logger = new DevToolsTraceLogger(manager, {
      persistence_dir: dir,
      max_pending: 2,
      flush_interval_ms: 100,
      disable_fsync: true,
    });
    logger.start();
    try {
      for (let i = 0; i < 10; i++) {
        manager.startCampaign(`overflow-${i}`, "/tmp/plan.md", rootAction);
      }
    } finally {
      logger.close();
    }
    const lines = readLines(join(dir, "devtools", "devtools.log"));
    const truncation = lines.find((l) => l.synthetic && l.event_kind === "stream.truncated");
    expect(truncation).toBeDefined();
    expect((truncation!.event as { dropped_records: number }).dropped_records).toBeGreaterThan(0);
  });

  it("subscribes only while started; events before start or after close are not logged", () => {
    const manager = newManager(dir);
    const logger = new DevToolsTraceLogger(manager, { persistence_dir: dir, disable_fsync: true });
    manager.startCampaign("before-start", "/tmp/plan.md", rootAction);
    logger.start();
    try {
      manager.startCampaign("during", "/tmp/plan.md", rootAction);
    } finally {
      logger.close();
    }
    manager.startCampaign("after-close", "/tmp/plan.md", rootAction);
    const lines = readLines(join(dir, "devtools", "devtools.log"));
    const ids = lines.map((l) => l.campaign_id);
    expect(ids).not.toContain("before-start");
    expect(ids).toContain("during");
    expect(ids).not.toContain("after-close");
  });

  it("default options (fsync per line) keep the active file durable after close", () => {
    const manager = newManager(dir);
    const logger = new DevToolsTraceLogger(manager, { persistence_dir: dir });
    logger.start();
    try {
      manager.startCampaign("c1", "/tmp/plan.md", rootAction);
    } finally {
      logger.close();
    }
    const lines = readLines(join(dir, "devtools", "devtools.log"));
    expect(lines.length).toBeGreaterThan(0);
  });

  it("is idempotent on start and idempotent on close", () => {
    const manager = newManager(dir);
    const logger = new DevToolsTraceLogger(manager, { persistence_dir: dir, disable_fsync: true });
    logger.start();
    logger.start();
    try {
      manager.startCampaign("c1", "/tmp/plan.md", rootAction);
      const lines1 = readLines(join(dir, "devtools", "devtools.log")).length;
      manager.startCampaign("c2", "/tmp/plan.md", rootAction);
      const lines2 = readLines(join(dir, "devtools", "devtools.log")).length;
      expect(lines2).toBeGreaterThan(lines1);
    } finally {
      logger.close();
      logger.close();
    }
  });

  it("multi-campaign: each line carries the correct campaign_id", () => {
    const manager = newManager(dir);
    const logger = new DevToolsTraceLogger(manager, { persistence_dir: dir, disable_fsync: true });
    logger.start();
    try {
      manager.startCampaign("alpha", "/tmp/plan.md", rootAction);
      manager.startCampaign("beta", "/tmp/plan.md", rootAction);
      const lines = readLines(join(dir, "devtools", "devtools.log"));
      const ids = new Set(lines.map((l) => l.campaign_id));
      expect(ids.has("alpha")).toBe(true);
      expect(ids.has("beta")).toBe(true);
    } finally {
      logger.close();
    }
  });

  it("rejects invalid constructor options", () => {
    const manager = newManager(dir);
    expect(() => new DevToolsTraceLogger(manager, { persistence_dir: "" })).toThrow();
    expect(() => new DevToolsTraceLogger(manager, { persistence_dir: dir, max_bytes: 0 })).toThrow();
    expect(() => new DevToolsTraceLogger(manager, { persistence_dir: dir, max_bytes: 100 })).toThrow();
    expect(() => new DevToolsTraceLogger(manager, { persistence_dir: dir, max_segments: -1 })).toThrow();
    expect(() => new DevToolsTraceLogger(manager, { persistence_dir: dir, max_pending: 0 })).toThrow();
    expect(() => new DevToolsTraceLogger(manager, { persistence_dir: dir, flush_interval_ms: -1 })).toThrow();
  });

  it("creates the devtools directory if it does not exist", () => {
    const nested = join(dir, "nested", "deeper");
    const manager = new CampaignManager({ persistence_dir: dir });
    const logger = new DevToolsTraceLogger(manager, { persistence_dir: nested, disable_fsync: true });
    logger.start();
    try {
      manager.startCampaign("c1", "/tmp/plan.md", rootAction);
      expect(existsSync(join(nested, "devtools", "devtools.log"))).toBe(true);
    } finally {
      logger.close();
    }
  });

  it("loopEvent writes a loop.* line carrying the full loop payload", () => {
    const manager = newManager(dir);
    const logger = new DevToolsTraceLogger(manager, { persistence_dir: dir, disable_fsync: true });
    logger.start();
    try {
      logger.loopEvent({ type: "specialist_dispatched", campaign_id: "c1", node_id: "n1", agent: "seed" });
      const lines = readLines(join(dir, "devtools", "devtools.log"));
      const line = lines.find((l) => l.event_kind === "loop.specialist_dispatched");
      expect(line).toBeDefined();
      expect(line!.loop_event).toEqual({ type: "specialist_dispatched", campaign_id: "c1", node_id: "n1", agent: "seed" });
      expect(line!.campaign_id).toBe("c1");
      expect(line!.node_id).toBe("n1");
    } finally {
      logger.close();
    }
  });

  it("runtime and loop events share one FIFO (arrival order preserved)", () => {
    const manager = newManager(dir);
    const logger = new DevToolsTraceLogger(manager, { persistence_dir: dir, disable_fsync: true });
    logger.start();
    try {
      manager.startCampaign("c1", "/tmp/plan.md", rootAction); // runtime: campaign.changed
      logger.loopEvent({ type: "campaign_start", campaign_id: "c1" });
      logger.loopEvent({ type: "specialist_dispatched", campaign_id: "c1", node_id: "n1" });
      const kinds = readLines(join(dir, "devtools", "devtools.log")).map((l) => l.event_kind);
      const campaignIdx = kinds.indexOf("campaign.changed");
      const startIdx = kinds.indexOf("loop.campaign_start");
      const dispatchIdx = kinds.indexOf("loop.specialist_dispatched");
      expect(campaignIdx).toBeGreaterThanOrEqual(0);
      expect(startIdx).toBeGreaterThan(campaignIdx);
      expect(dispatchIdx).toBeGreaterThan(startIdx);
    } finally {
      logger.close();
    }
  });

  it("loopEvent is no-op before start and after close", () => {
    const manager = newManager(dir);
    const logger = new DevToolsTraceLogger(manager, { persistence_dir: dir, disable_fsync: true });
    logger.start();
    logger.close();
    logger.loopEvent({ type: "specialist_dispatched", campaign_id: "c1" });
    expect(readLines(join(dir, "devtools", "devtools.log"))).toHaveLength(0);
  });

  it("loopEvent ignores malformed events (no type)", () => {
    const manager = newManager(dir);
    const logger = new DevToolsTraceLogger(manager, { persistence_dir: dir, disable_fsync: true });
    logger.start();
    try {
      logger.loopEvent({ type: "" } as never);
      logger.loopEvent({} as never);
      logger.loopEvent(null as never);
      expect(readLines(join(dir, "devtools", "devtools.log"))).toHaveLength(0);
    } finally {
      logger.close();
    }
  });

  it("devtoolsLoopHook routes an executor.log emission into the logger", () => {
    const manager = newManager(dir);
    const logger = new DevToolsTraceLogger(manager, { persistence_dir: dir, disable_fsync: true });
    logger.start();
    try {
      const hook = devtoolsLoopHook(logger);
      const received: unknown[] = [];
      const fakeExecutorLog = (e: unknown) => { received.push(e); hook(e); };
      fakeExecutorLog({ type: "node_verified", campaign_id: "c1", node_id: "n1", score: 42 });
      const lines = readLines(join(dir, "devtools", "devtools.log"));
      const line = lines.find((l) => l.event_kind === "loop.node_verified");
      expect(line).toBeDefined();
      expect((line!.loop_event as unknown as { score: number }).score).toBe(42);
      expect(received).toHaveLength(1);
    } finally {
      logger.close();
    }
  });

  it("devtoolsLoopHook with null logger is a safe no-op", () => {
    const hook = devtoolsLoopHook(null);
    expect(() => hook({ type: "halt", reason: "budget" })).not.toThrow();
    expect(() => hook("not-an-object")).not.toThrow();
  });
});

describe("devtoolsHookForRuntime", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "devtools-hook-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it("routes loop events into a runtime's started devtools logger", () => {
    const manager = newManager(dir);
    const logger = new DevToolsTraceLogger(manager, { persistence_dir: dir, disable_fsync: true });
    logger.start();
    try {
      const runtime = { startedParticipants: [{ name: "devtools-trace-logger", logger }] };
      devtoolsHookForRuntime(runtime)({ type: "specialist_dispatched", campaign_id: "c1", node_id: "n1" });
      const lines = readLines(join(dir, "devtools", "devtools.log"));
      expect(lines.some((l) => l.event_kind === "loop.specialist_dispatched")).toBe(true);
    } finally {
      logger.close();
    }
  });

  it("is a safe no-op for a runtime started without a devtools logger", () => {
    expect(() => devtoolsHookForRuntime({ startedParticipants: [] })({ type: "specialist_dispatched" })).not.toThrow();
    expect(() => devtoolsHookForRuntime(undefined)({ type: "specialist_dispatched" })).not.toThrow();
  });
});
