import { describe, expect, it } from "vitest";
import type { RuntimeEvent, RuntimeEventEnvelope, SupervisorTask } from "@arbor/core";
import {
  TUI_READ_MODEL_VERSION,
  emptyReadModel,
  applySnapshot,
  applyEnvelopes,
  summarizeForInspect,
  type TuiReadModel,
} from "../src/read-model.js";

const STREAM = "s1";

function envelope(sequence: number, event: RuntimeEvent, streamId = STREAM): RuntimeEventEnvelope {
  return {
    schema_version: 1,
    id: `${streamId}:${sequence}`,
    cursor: { stream_id: streamId, sequence },
    occurred_at: "2026-01-01T00:00:00.000Z",
    correlation_id: `corr-${sequence}`,
    event,
    redacted: false,
  };
}

function task(overrides: Partial<SupervisorTask> & Pick<SupervisorTask, "id">): SupervisorTask {
  return {
    id: overrides.id,
    operation_id: overrides.operation_id ?? `op-${overrides.id}`,
    kind: overrides.kind ?? "worker",
    owner_scope_id: overrides.owner_scope_id ?? "scope-1",
    parent_id: overrides.parent_id ?? null,
    state: overrides.state ?? "started",
    started_at: overrides.started_at ?? "2026-01-01T00:00:00.000Z",
    deadline_at: overrides.deadline_at ?? null,
    progress: overrides.progress ?? null,
    last_progress_at: overrides.last_progress_at ?? null,
    last_heartbeat_at: overrides.last_heartbeat_at ?? null,
    progress_sequence: overrides.progress_sequence ?? 0,
    retry_attempt: overrides.retry_attempt ?? 0,
    cleanup: overrides.cleanup ?? null,
  };
}

// A deterministic PRNG (mulberry32) so the property-style test below is
// reproducible across runs/CI without pulling in a dependency.
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle<T>(items: readonly T[], rand: () => number): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [copy[i], copy[j]] = [copy[j]!, copy[i]!];
  }
  return copy;
}

describe("read-model (M1.3 pure projection)", () => {
  it("emptyReadModel starts clean, versioned, and un-watermarked", () => {
    const model = emptyReadModel(STREAM);
    expect(model).toEqual({
      version: TUI_READ_MODEL_VERSION,
      stream_id: STREAM,
      watermark: null,
      status: "ok",
      eventTail: [],
      tasks: new Map(),
      operations: new Map(),
      gates: new Map(),
      treeNodes: new Map(),
      terminalAttempts: new Map(),
      lastTaskId: null,
      resyncedAtSeq: null,
    });
  });

  it("replaying an identical envelope batch twice from empty gives a deep-equal model", () => {
    const envelopes: RuntimeEventEnvelope[] = [
      envelope(1, { kind: "task.changed", task: task({ id: "t1", state: "started" }) }),
      envelope(2, { kind: "gate.recorded", campaign_id: "c1", node_id: "n1", gate: "review", result: "pass" }),
      envelope(3, { kind: "tree.node_changed", campaign_id: "c1", node_id: "n1", state: "completed" }),
      envelope(4, { kind: "operation.accepted", accepted_operation_id: "op-1" }),
    ];
    const first = applyEnvelopes(emptyReadModel(STREAM), envelopes).model;
    const second = applyEnvelopes(emptyReadModel(STREAM), envelopes).model;
    expect(first).toEqual(second);
    expect(first.watermark).toEqual({ stream_id: STREAM, sequence: 4 });
    expect(first.tasks.get("t1")?.state).toBe("started");
    expect(first.gates.get(`c1\u0000n1\u0000review`)).toMatchObject({ result: "pass" });
    expect(first.treeNodes.get(`c1\u0000n1`)).toMatchObject({ state: "completed" });
    expect(first.operations.get("op-1")).toEqual({ operation_id: "op-1", accepted: true });
    expect(first.eventTail.map((entry) => entry.cursor.sequence)).toEqual([1, 2, 3, 4]);
  });

  it("a duplicate (already-applied) sequence is ignored and counted, not reapplied", () => {
    const started = envelope(1, { kind: "task.changed", task: task({ id: "t1", state: "started" }) });
    const completed = envelope(2, { kind: "task.changed", task: task({ id: "t1", state: "completed" }) });
    const { model: applied } = applyEnvelopes(emptyReadModel(STREAM), [started, completed]);
    expect(applied.tasks.get("t1")?.state).toBe("completed");
    // Redeliver #1 (a duplicate) after the watermark has already advanced past it.
    const { model: after, outcome } = applyEnvelopes(applied, [started]);
    expect(outcome).toMatchObject({ applied: 0, duplicates: 1, resync_required: false });
    expect(after).toEqual(applied);
  });

  it("a later non-terminal event for the SAME retry_attempt cannot resurrect a terminal task", () => {
    const completed = envelope(1, { kind: "task.changed", task: task({ id: "t1", state: "completed", retry_attempt: 0 }) });
    const staleRestart = envelope(2, { kind: "task.changed", task: task({ id: "t1", state: "started", retry_attempt: 0 }) });
    const { model, outcome } = applyEnvelopes(emptyReadModel(STREAM), [completed, staleRestart]);
    // The resurrection attempt is a real event at a real next sequence, so it
    // still advances the watermark (it is not a duplicate/gap) — it is simply
    // not folded into the tasks map.
    expect(outcome.applied).toBe(2);
    expect(model.tasks.get("t1")?.state).toBe("completed");
    expect(model.watermark).toEqual({ stream_id: STREAM, sequence: 2 });
  });

  it("a lower retry_attempt never overwrites a higher one, regardless of order of arrival", () => {
    const attempt2 = envelope(1, { kind: "task.changed", task: task({ id: "t1", state: "started", retry_attempt: 2 }) });
    const attempt1Stale = envelope(2, { kind: "task.changed", task: task({ id: "t1", state: "retrying", retry_attempt: 1 }) });
    const { model } = applyEnvelopes(emptyReadModel(STREAM), [attempt2, attempt1Stale]);
    expect(model.tasks.get("t1")).toMatchObject({ retry_attempt: 2, state: "started" });
  });

  it("a NEW (higher) retry_attempt after a terminal one is a legitimate, allowed transition", () => {
    const failedAttempt0 = envelope(1, { kind: "task.changed", task: task({ id: "t1", state: "failed", retry_attempt: 0 }) });
    const startedAttempt1 = envelope(2, { kind: "task.changed", task: task({ id: "t1", state: "started", retry_attempt: 1 }) });
    const { model } = applyEnvelopes(emptyReadModel(STREAM), [failedAttempt0, startedAttempt1]);
    expect(model.tasks.get("t1")).toMatchObject({ retry_attempt: 1, state: "started" });
  });

  it("a sequence gap flips status to resync_required and halts further application until a new snapshot", () => {
    const e1 = envelope(1, { kind: "tree.node_changed", campaign_id: "c1", node_id: "n1", state: "pending" });
    const e3 = envelope(3, { kind: "tree.node_changed", campaign_id: "c1", node_id: "n1", state: "completed" }); // gap: skips #2
    const { model, outcome } = applyEnvelopes(emptyReadModel(STREAM), [e1, e3]);
    expect(outcome).toMatchObject({ applied: 1, gap_detected: true, resync_required: true });
    expect(model.status).toBe("resync_required");
    expect(model.treeNodes.get(`c1\u0000n1`)).toMatchObject({ state: "pending" }); // e3 never applied

    // No further application, even of a perfectly valid next envelope, until re-seeded.
    const e4 = envelope(4, { kind: "tree.node_changed", campaign_id: "c1", node_id: "n1", state: "completed" });
    const { model: stillStuck, outcome: stuckOutcome } = applyEnvelopes(model, [e4]);
    expect(stuckOutcome).toEqual({ applied: 0, duplicates: 0, rejected_foreign_stream: 0, gap_detected: false, truncated: false, resync_required: true });
    expect(stillStuck).toEqual(model);

    // applySnapshot re-seeds and application resumes normally.
    const reseeded = applySnapshot(model, { stream_id: STREAM, sequence: 3 }, undefined);
    expect(reseeded.status).toBe("ok");
    const { model: resumed, outcome: resumedOutcome } = applyEnvelopes(reseeded, [e4]);
    expect(resumedOutcome).toMatchObject({ applied: 1, resync_required: false });
    expect(resumed.treeNodes.get(`c1\u0000n1`)).toMatchObject({ state: "completed" });
  });

  it("stream.truncated forces resync_required even with no gap", () => {
    const e1 = envelope(1, { kind: "campaign.changed", campaign_id: "c1", change: "created" });
    const truncated = envelope(2, { kind: "stream.truncated", stream_id: STREAM, cursor: { stream_id: STREAM, sequence: 2 }, dropped_records: 5 });
    const { model, outcome } = applyEnvelopes(emptyReadModel(STREAM), [e1, truncated]);
    expect(outcome).toMatchObject({ applied: 2, truncated: true, resync_required: true });
    expect(model.status).toBe("resync_required");
  });

  it("an envelope from a foreign stream_id is rejected outright, never contaminating the model", () => {
    const foreign = envelope(1, { kind: "campaign.changed", campaign_id: "c1", change: "created" }, "other-stream");
    const { model, outcome } = applyEnvelopes(emptyReadModel(STREAM), [foreign]);
    expect(outcome).toMatchObject({ applied: 0, rejected_foreign_stream: 1, resync_required: false });
    expect(model).toEqual(emptyReadModel(STREAM));
  });

  it("bounds the tasks map, evicting the oldest inserted id first", () => {
    const bound = 4_096; // TUI_READ_MODEL_BOUNDS.max_tasks — keep in sync if that constant changes
    const envelopes: RuntimeEventEnvelope[] = Array.from({ length: bound + 10 }, (_, i) =>
      envelope(i + 1, { kind: "task.changed", task: task({ id: `t${i}`, state: "started" }) }));
    const { model } = applyEnvelopes(emptyReadModel(STREAM), envelopes);
    expect(model.tasks.size).toBe(bound);
    expect(model.tasks.has("t0")).toBe(false); // oldest evicted
    expect(model.tasks.has(`t${bound + 9}`)).toBe(true); // newest retained
  });

  it("eviction never resurrects a terminal attempt: a late non-terminal event for an evicted completed task is refused", () => {
    const bound = 4_096; // TUI_READ_MODEL_BOUNDS.max_tasks
    const envelopes: RuntimeEventEnvelope[] = [
      envelope(1, { kind: "task.changed", task: task({ id: "t0", state: "completed", retry_attempt: 0 }) }),
      ...Array.from({ length: bound }, (_, i) => envelope(i + 2, { kind: "task.changed", task: task({ id: `f${i}`, state: "started" }) })),
      envelope(bound + 2, { kind: "task.changed", task: task({ id: "t0", state: "started", retry_attempt: 0 }) }),
    ];
    const { model } = applyEnvelopes(emptyReadModel(STREAM), envelopes);
    expect(model.tasks.has("t0")).toBe(false);
    expect(model.terminalAttempts.get("t0")).toBe(0);
    // A genuine retry (higher attempt) is still admitted and clears the tombstone.
    const retried = applyEnvelopes(model, [envelope(bound + 3, { kind: "task.changed", task: task({ id: "t0", state: "started", retry_attempt: 1 }) })]).model;
    expect(retried.tasks.get("t0")).toMatchObject({ state: "started", retry_attempt: 1 });
    expect(retried.terminalAttempts.has("t0")).toBe(false);
  });

  it("property: any permutation/duplication of a fixed, gapless in-order log either matches the in-order replay or is flagged resync_required, never silently diverges", () => {
    const baseLog: RuntimeEventEnvelope[] = [
      envelope(1, { kind: "task.changed", task: task({ id: "t1", state: "started", retry_attempt: 0 }) }),
      envelope(2, { kind: "gate.recorded", campaign_id: "c1", node_id: "n1", gate: "review", result: "pass" }),
      envelope(3, { kind: "task.changed", task: task({ id: "t1", state: "completed", retry_attempt: 0 }) }),
      envelope(4, { kind: "tree.node_changed", campaign_id: "c1", node_id: "n1", state: "completed" }),
      envelope(5, { kind: "operation.accepted", accepted_operation_id: "op-1" }),
      envelope(6, { kind: "task.changed", task: task({ id: "t2", state: "started", retry_attempt: 1 }) }),
    ];
    const inOrderResult = applyEnvelopes(emptyReadModel(STREAM), baseLog).model;
    const rand = mulberry32(0xc0ffee);
    for (let trial = 0; trial < 40; trial++) {
      // Randomly duplicate a handful of entries, then shuffle the whole batch.
      const withDuplicates = [...baseLog];
      const duplicateCount = Math.floor(rand() * 3);
      for (let d = 0; d < duplicateCount; d++) {
        withDuplicates.push(baseLog[Math.floor(rand() * baseLog.length)]!);
      }
      const permuted = shuffle(withDuplicates, rand);
      const { model } = applyEnvelopes(emptyReadModel(STREAM), permuted);
      const matchesInOrder = JSON.stringify(serialize(model)) === JSON.stringify(serialize(inOrderResult));
      expect(matchesInOrder || model.status === "resync_required", `trial ${trial} diverged silently: ${JSON.stringify(serialize(model))}`).toBe(true);
    }
  });
});

describe("summarizeForInspect (M2 Inspect rail tab)", () => {
  it("reports the watermark and the most recently touched task, scoped gates included", () => {
    const envelopes: RuntimeEventEnvelope[] = [
      envelope(1, { kind: "task.changed", task: task({ id: "t1", state: "started", retry_attempt: 0 }) }),
      envelope(2, { kind: "gate.recorded", campaign_id: "c1", node_id: "n1", gate: "review", result: "pass" }),
      envelope(3, { kind: "task.changed", task: task({ id: "t1", state: "completed", retry_attempt: 0 }) }),
    ];
    const model = applyEnvelopes(emptyReadModel(STREAM), envelopes).model;
    const summary = summarizeForInspect(model, { campaign_id: "c1" });
    expect(summary.status).toBe("ok");
    expect(summary.watermark_seq).toBe(3);
    expect(summary.resync_note).toBeNull();
    expect(summary.task).toMatchObject({ task_id: "t1", state: "completed", retry_attempt: 0 });
    expect(summary.gates).toEqual([{ gate: "review", node_id: "n1", result: "pass" }]);
  });

  it("never claims 'nothing running' while resync is required -- task/gates are empty, not a false negative", () => {
    const gap = applyEnvelopes(emptyReadModel(STREAM), [envelope(5, { kind: "task.changed", task: task({ id: "t1" }) })]).model;
    expect(gap.status).toBe("resync_required");
    const summary = summarizeForInspect(gap, { campaign_id: "c1" });
    expect(summary.status).toBe("resync_required");
    expect(summary.resync_note).toMatch(/resync required/);
    expect(summary.task).toBeNull();
    expect(summary.gates).toEqual([]);
  });

  it("marks a freshly re-seeded model as 'resynced' (not 'nothing running') until a real task is observed again", () => {
    const seeded = applySnapshot(emptyReadModel(STREAM), { stream_id: STREAM, sequence: 9 }, undefined);
    const beforeAnyTask = summarizeForInspect(seeded);
    expect(beforeAnyTask.status).toBe("ok");
    expect(beforeAnyTask.task).toBeNull();
    expect(beforeAnyTask.resync_note).toMatch(/resynced.*seq 9/);

    const { model: afterTask } = applyEnvelopes(seeded, [envelope(10, { kind: "task.changed", task: task({ id: "t1" }) })]);
    const afterTaskSummary = summarizeForInspect(afterTask);
    expect(afterTaskSummary.resync_note).toBeNull();
    expect(afterTaskSummary.task).not.toBeNull();
  });
});

function serialize(model: TuiReadModel): unknown {
  return {
    ...model,
    tasks: [...model.tasks.entries()],
    operations: [...model.operations.entries()],
    gates: [...model.gates.entries()],
    treeNodes: [...model.treeNodes.entries()],
    terminalAttempts: [...model.terminalAttempts.entries()],
  };
}
