/**
 * Regression coverage for the Threads screen's keyboard row selection.
 *
 * `screenRowIds` in operator-selection.ts has no "threads" case, so
 * `selectScreenRow`/`stepScreenSelection`/`selectScreenEndpoint`/
 * `stickyScreenSelection` can never resolve a selection for the Threads
 * screen from keyboard input (j/k, Home/End, direct row index) — only a
 * mouse click via `select_row_identity`, which reads
 * `ScreenProjection.row_ids` directly in update.ts, works. This starves
 * `threadAckFormContext` (which gates `bus.thread.ack`) of a
 * keyboard-reachable selection.
 *
 * Raw shape matches the live `bus.thread.history` projection consumed by
 * `screens/threads.ts`: `{thread_id, parent_node_id, child_node_id,
 * version, messages: [{id, author_node_id, ack_required, ...}]}`.
 */
import { describe, expect, it } from "vitest";
import {
  selectScreenEndpoint,
  selectScreenRow,
  stepScreenSelection,
  stickyScreenSelection,
} from "../src/operator-selection.js";

const thread = {
  thread_id: "thread-1",
  parent_node_id: "n-parent",
  child_node_id: "n-child",
  version: "v7",
  messages: [
    { id: "m1", author_node_id: "n-parent", ack_required: true },
    { id: "m2", author_node_id: "n-child", ack_required: false },
    { id: "m3", author_node_id: "n-parent", ack_required: true },
  ],
};

describe("Threads screen row selection (keyboard parity)", () => {
  it("selectScreenRow resolves an absolute row index to a message selection", () => {
    const selection = selectScreenRow("threads", thread, 0);
    expect(selection).toEqual({
      id: "m1",
      context: {
        parent_node_id: "n-parent",
        child_node_id: "n-child",
        expected_thread_version: "v7",
        author_node_id: "n-parent",
        ack_required: "true",
      },
    });
  });

  it("selectScreenEndpoint resolves first/last without depending on repeated key timing", () => {
    expect(selectScreenEndpoint("threads", thread, "first")?.id).toBe("m1");
    expect(selectScreenEndpoint("threads", thread, "last")?.id).toBe("m3");
  });

  it("stepScreenSelection seeds a selection on the first keypress and steps thereafter", () => {
    const seeded = stepScreenSelection("threads", null, thread, 1);
    expect(seeded?.id).toBe("m1");
    const next = stepScreenSelection("threads", seeded, thread, 1);
    expect(next?.id).toBe("m2");
  });

  it("stickyScreenSelection keeps a selection whose row id survives a refresh, carrying full context", () => {
    const current = { id: "m2", context: { parent_node_id: "n-parent", child_node_id: "n-child", expected_thread_version: "v7", author_node_id: "n-child", ack_required: "false" } };
    const sticky = stickyScreenSelection("threads", current, thread);
    expect(sticky).toEqual(current);
  });
});

describe("Operations screen selection admits only canonical operation rows", () => {
  const events = [
    { id: "evt-1", cursor: { sequence: 1 }, event: { kind: "stream.truncated" } },
    { id: "evt-2", operation_id: "op-2", cursor: { sequence: 2 }, event: { kind: "operation.rejected" } },
  ];

  it("does not reinterpret RuntimeEventEnvelope identities as operations", () => {
    expect(stepScreenSelection("operations", null, events, 1)).toBeNull();
    expect(selectScreenRow("operations", events, 0)).toBeNull();
  });
});

/**
 * `ApprovalService.list()` (approval-service.ts) sorts `records` by
 * `expires_at` DESCENDING (`compareCodeUnits(right.expires_at,
 * left.expires_at)`) — the record with the MOST time left comes first, the
 * soonest-to-expire comes last. `oldestPendingApproval`'s doc comment says
 * it picks "the oldest still-pending approval request — the next one an
 * operator would triage", but it returned `raw.records`'s first pending
 * match, i.e. under the real producer's order, the LEAST urgent (furthest
 * from expiring) pending request — not the most urgent one. `ApprovalRecord`
 * has no `created_at`; `expires_at` is the only timestamp, so "oldest" here
 * can only mean "soonest to expire".
 */
describe("oldestPendingApproval picks the most urgent request regardless of input order", () => {
  it("selects the pending record with the soonest expires_at, not array position 0", async () => {
    const { oldestPendingApproval } = await import("../src/operator-selection.js");
    // Mirrors ApprovalService.list()'s real descending-by-expires_at order:
    // furthest-from-expiring first, soonest-to-expire last.
    const raw = {
      records: [
        { request_id: "far", status: "pending", action: "a", action_fingerprint: null, expires_at: "2026-09-01T00:00:00.000Z" },
        { request_id: "soon", status: "pending", action: "a", action_fingerprint: null, expires_at: "2026-08-27T01:00:00.000Z" },
        { request_id: "mid", status: "pending", action: "a", action_fingerprint: null, expires_at: "2026-08-28T00:00:00.000Z" },
      ],
    };
    expect(oldestPendingApproval(raw)?.request_id).toBe("soon");
  });
});

/**
 * Harness Sessions / Live Session parity: `screens/harness-sessions.ts`'s
 * `row_ids` tags each session with `context.interruptible` ("no" for a
 * session that already recorded a `terminal.cause`), which `update.ts`'s
 * `cancel_selected_row` reads to WARN instead of dispatching
 * `harness.session.interrupt` at an already-terminal session. Keyboard
 * selection went through `screenRowIds`'s bare-id "harness-sessions"/
 * "live-session" case, which carried no context at all — so a
 * keyboard-selected terminal session would silently skip the guard and
 * attempt to interrupt a session that already finished.
 *
 * `screens/live-session.ts` additionally only ever shows still-live rows
 * (`isLiveRow`: `attachable === true && terminal == null`) — the unfiltered
 * `screenRowIds` case let a keyboard cursor land on a session id the screen
 * itself never displays.
 */
describe("Harness session row selection (keyboard parity: interruptible context + live-only filter)", () => {
  const sessions = {
    sessions: [
      { session_id: "s-running", attachable: true, terminal: null },
      { session_id: "s-done", attachable: true, terminal: { cause: "completed" } },
    ],
  };

  it("harness-sessions: keyboard selection of a terminal session carries context.interruptible = 'no'", async () => {
    const { selectScreenRow } = await import("../src/operator-selection.js");
    expect(selectScreenRow("harness-sessions", sessions, 1)).toEqual({ id: "s-done", context: { interruptible: "no" } });
  });

  it("harness-sessions: keyboard selection of a live session carries context.interruptible = 'yes'", async () => {
    const { selectScreenRow } = await import("../src/operator-selection.js");
    expect(selectScreenRow("harness-sessions", sessions, 0)).toEqual({ id: "s-running", context: { interruptible: "yes" } });
  });

  it("live-session: keyboard row selection never lands on a terminal session the screen hides", async () => {
    const { selectScreenRow, stepScreenSelection } = await import("../src/operator-selection.js");
    expect(selectScreenRow("live-session", sessions, 0)).toEqual({ id: "s-running", context: { interruptible: "yes" } });
    expect(selectScreenRow("live-session", sessions, 1)).toBeNull();
    const stepped = stepScreenSelection("live-session", { id: "s-running", context: { interruptible: "yes" } }, sessions, 1);
    expect(stepped?.id).toBe("s-running"); // only one live row: wraps to itself, never reaches s-done
  });
});
