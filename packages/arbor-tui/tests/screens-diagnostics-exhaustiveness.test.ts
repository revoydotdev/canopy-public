/**
 * screens-diagnostics-exhaustiveness.test.ts — a compile-time canary for
 * diagnostics.ts's `describeEvent`.
 *
 * `describeEvent` deliberately duck-types `payload.kind` as a bare string
 * rather than importing `RuntimeEvent` from `@arbor/core` — the module's own
 * doc comment names this as leaf-module isolation, so it degrades gracefully
 * on ANY shape instead of hard-coupling to the exact current contract. That
 * is the right call for the RUNTIME behavior, but it means TypeScript cannot
 * enforce the switch is exhaustive against the real union from inside
 * diagnostics.ts itself: a ninth-vs-tenth RuntimeEvent variant added to
 * arbor-core would compile there with zero signal here.
 *
 * This test imports the real `RuntimeEvent` type ONLY here, where the
 * coupling costs nothing at runtime (`import type`, erased entirely), and
 * mirrors describeEvent's own case list in a `switch`+`never` exhaustiveness
 * check. The moment `RuntimeEvent` gains a member this list doesn't
 * enumerate, this file fails to typecheck under `npm run gate:typecheck-tests`
 * (G-23, `scripts/typecheck-tests.mjs` — the gate that actually typechecks
 * `tests/**` via each package's `tsconfig.tests.json`; `npm run build`'s
 * `tsc --build` only covers `src/**`, and `npx tsc --noEmit` checks zero
 * files in this repo) — describeEvent itself still needs a matching case
 * added by hand; this only makes the drift impossible to miss.
 */
import { describe, it, expect } from "vitest";
import type { RuntimeEvent } from "@arbor/core";
import { diagnosticsScreen } from "../src/screens/diagnostics.js";

/** Exhaustiveness assertion: fails `npm run build` if `RuntimeEvent["kind"]` gains a member not listed below. */
function assertHandledByDescribeEvent(kind: RuntimeEvent["kind"]): void {
  switch (kind) {
    case "campaign.changed":
    case "tree.node_changed":
    case "gate.recorded":
    case "kb.entry_added":
    case "audit.evidence_recorded":
    case "operation.accepted":
    case "operation.rejected":
    case "task.changed":
    case "taskcomposer.changed":
    case "stream.truncated":
    case "tree.decomposed":
      return;
    default: {
      const exhaustive: never = kind;
      throw new Error(`diagnostics.ts's describeEvent has no case for RuntimeEvent kind ${String(exhaustive)}`);
    }
  }
}

const ALL_RUNTIME_EVENT_KINDS: readonly RuntimeEvent["kind"][] = [
  "campaign.changed",
  "tree.node_changed",
  "gate.recorded",
  "kb.entry_added",
  "audit.evidence_recorded",
  "operation.accepted",
  "operation.rejected",
  "task.changed",
  "taskcomposer.changed",
  "stream.truncated",
  "tree.decomposed",
];

describe("diagnostics screen — describeEvent exhaustiveness canary", () => {
  it("every real RuntimeEvent kind is one describeEvent's switch recognizes", () => {
    for (const kind of ALL_RUNTIME_EVENT_KINDS) {
      expect(() => assertHandledByDescribeEvent(kind)).not.toThrow();
    }
  });

  it("a kind outside the closed union renders a visible marker, never the same blank pair a real detail-less event produces", () => {
    const envelope = {
      cursor: { stream_id: "s", sequence: 1 },
      occurred_at: "2026-01-01T00:00:00.000Z",
      event: { kind: "future.unknown_kind" },
    };
    const projection = diagnosticsScreen.project(
      { kind: "events", cursor: { stream_id: "s", sequence: 1 }, events: [envelope] },
      { width: 100, height: 10 },
    );
    expect(projection.rows[0]?.node_id).toBe("-");
    expect(String(projection.rows[0]?.detail)).toContain("future.unknown_kind");
  });
});
