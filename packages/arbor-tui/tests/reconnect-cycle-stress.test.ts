import { describe, expect, it } from "vitest";
import { buildOperatorViewModel } from "../src/operator-view-model.js";

function reconnectEvents(cycles: number): readonly Readonly<Record<string, unknown>>[] {
  const events: Array<Readonly<Record<string, unknown>>> = [{ sequence: 1, kind: "lifecycle", payload: { state: "started" } }];
  for (let cycle = 0; cycle < cycles; cycle += 1) {
    const degradedSequence = cycle * 3 + 2;
    const durableSequence = degradedSequence + 1;
    const recoveredSequence = degradedSequence + 2;
    events.push(
      { sequence: degradedSequence, kind: "diagnostic", payload: { code: "degraded", message: `reconnect ${cycle + 1} pending` } },
      { sequence: durableSequence, kind: "model_text", payload: { text: `durable event ${cycle + 1}`, phase: "commentary" } },
      { sequence: durableSequence, kind: "model_text", payload: { text: `durable event ${cycle + 1}`, phase: "commentary" } },
      { sequence: recoveredSequence, kind: "diagnostic", payload: { code: "recovered", message: `reconciled at cursor ${durableSequence}` } },
    );
  }
  events.push({ sequence: cycles * 3 + 2, kind: "terminal", payload: { state: "completed" } });
  return events;
}

describe("reconnect-cycle stress", () => {
  it("deduplicates every durable replay and preserves degraded/recovered order across 100 cycles", () => {
    let finalView: ReturnType<typeof buildOperatorViewModel> | null = null;
    for (let cycles = 1; cycles <= 100; cycles += 1) {
      finalView = buildOperatorViewModel({
        now_ms: cycles,
        viewport: { columns: 100, rows: 30 },
        session_attach: { session: { session_id: "reconnect-stress" }, events: reconnectEvents(cycles) },
      });
      expect(finalView.bounds.deduplicated_rows).toBe(cycles);
      expect(finalView.document.some((event) => event.summary.includes("conflicting replay"))).toBe(false);
      expect(new Set(finalView.document.map((event) => event.id)).size).toBe(finalView.document.length);
    }

    expect(finalView).not.toBeNull();
    expect(finalView!.document.filter((event) => event.summary === "degraded")).toHaveLength(100);
    expect(finalView!.document.filter((event) => event.summary === "recovered")).toHaveLength(100);
    expect(finalView!.document.at(-1)).toMatchObject({ kind: "terminal", lifecycle: "completed" });
  });
});
