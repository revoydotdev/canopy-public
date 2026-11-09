/**
 * arbor-core/tests/scale-thresholds.test.ts — Phase 5.2 scale/threshold benchmarks.
 *
 * Asserts bounded, deterministic scale behavior in core:
 *
 *   - Long-running supervision: a TaskSupervisor driven by a fake clock handles
 *     a long simulated session with bounded terminal retention (no wall-clock
 *     sleeps).
 *   - Event backlogs: a RuntimeEventStream with bounded capacity evicts old
 *     events and closes slow subscribers on backpressure instead of silently
 *     dropping control events.
 *   - Large action trees: a tree with >1,000 nodes selects, expands, and
 *     resolves correctly.
 *
 * These tests assert EXISTING behavior; they use fake clocks and deterministic
 * data only.
 */

import { describe, it, expect } from "vitest";
import { TaskSupervisor } from "../src/task-supervisor.js";
import { RuntimeEventStream } from "../src/event-stream.js";
import { createCampaign, createChild, beginExpansion, verifyNode, selectNode } from "../src/tree.js";
import type { Action, ScoreContext, Provenance } from "../src/types.js";
import { DEFAULT_SCORE_CONFIG } from "../src/types.js";

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

const ctx: ScoreContext = {
  accuracy_regression_rate: 0,
  crash_regression_rate: 0,
  best_known: 100,
  total_visits: 5,
};

const verifiedProv: Provenance = { tag: "verified", cmd: "pytest", exit: 0, stdout_hash: "sha256:test"};

describe("long-running supervision (fake clock, bounded retention)", () => {
  it("handles a long simulated session with bounded terminal retention", () => {
    // Fake clock: each call advances one second. No wall-clock sleeps.
    let tick = 0;
    const clock = () => new Date(Date.UTC(2026, 7, 1, 12, 0, tick++));
    const supervisor = new TaskSupervisor({ clock, terminal_retention: 10 });

    const total = 500;
    for (let i = 0; i < total; i++) {
      supervisor.register({ id: `t${i}`, operation_id: `op${i}`, kind: "campaign", owner_scope_id: "scope" });
      supervisor.start(`t${i}`);
      supervisor.complete(`t${i}`);
      supervisor.completeCleanup(`t${i}`);
    }

    // Terminal retention bounds the retained records.
    expect(supervisor.list({ include_terminal: true }).length).toBeLessThanOrEqual(10);
    // The fake clock advanced deterministically across the whole session.
    expect(tick).toBeGreaterThan(0);
  });

  it("rejects a restored task that requires reconciliation before transition", () => {
    const supervisor = new TaskSupervisor({ clock: () => new Date("2026-08-01T12:00:00.000Z") });
    supervisor.restore([{
      id: "t1", operation_id: "op1", kind: "campaign", owner_scope_id: "scope",
      parent_id: null, state: "started", started_at: "2026-08-01T12:00:00.000Z",
      deadline_at: null, progress: 0.5, last_progress_at: null, last_heartbeat_at: null, progress_sequence: 0, retry_attempt: 0, cleanup: null,
    }]);
    expect(supervisor.requiresReconciliation("t1")).toBe(true);
    expect(() => supervisor.start("t1")).toThrow("requires reconciliation");
  });
});

describe("event backlogs (bounded capacity, backpressure)", () => {
  function event(id: string) {
    return {
      id,
      occurred_at: "2026-08-01T12:00:00.000Z",
      correlation_id: "correlation",
      redacted: false,
      event: { kind: "campaign.changed" as const, campaign_id: "campaign", change: "created" as const },
    };
  }

  it("evicts old events beyond capacity while keeping the cursor monotonic", () => {
    const stream = new RuntimeEventStream("runtime", 100);
    for (let i = 0; i < 1_000; i++) stream.publish(event(`e${i}`));
    expect(stream.cursor().sequence).toBe(1_000);
    // Only the bounded tail is retained.
    const resumed = stream.resume({ stream_id: "runtime", sequence: 0 }, {});
    expect(resumed.kind).toBe("resync");
  });

  it("closes a slow subscriber on backpressure instead of silently dropping", () => {
    const stream = new RuntimeEventStream("runtime");
    const slow = stream.subscribe({ max_pending: 1 });
    stream.publish(event("one"));
    stream.publish(event("two"));
    expect(slow.status()).toMatchObject({ closed: true, reason: "backpressure" });
  });

  it("rejects duplicate events without advancing the cursor", () => {
    const stream = new RuntimeEventStream("runtime");
    stream.publish(event("one"));
    expect(() => stream.publish(event("one"))).toThrow("already published");
    expect(stream.cursor().sequence).toBe(1);
  });
});

describe("large action trees (>1,000 nodes)", () => {
  it("builds and resolves a tree with >1,000 nodes", () => {
    const c = createCampaign("camp1", "plan.md", rootAction);
    const count = 1_100;

    // Build a wide tree: root → many children.
    const childIds: string[] = [];
    for (let i = 0; i < count; i++) {
      childIds.push(createChild(c.tree, "root", { ...childAction, description: `child ${i}` }));
    }
    expect(c.tree.size).toBe(count + 1);

    // Expand and verify a subset deterministically.
    for (let i = 0; i < 100; i++) {
      beginExpansion(c.tree, childIds[i]);
      verifyNode(c.tree, childIds[i], verifiedProv, "ok", i);
    }

    // Selection still works across the large tree.
    const selected = selectNode(c.tree, ctx, DEFAULT_SCORE_CONFIG);
    expect(selected).not.toBeNull();

  });
});
