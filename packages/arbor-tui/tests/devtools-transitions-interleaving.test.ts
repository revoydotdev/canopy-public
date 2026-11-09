/**
 * `queryResults` folds the devtools.stream transition map forward by diffing
 * the new `devtools.stream` result against "the previous devtools.stream
 * result" (player-piano.ts's `deriveTransitions`). It reads that previous
 * result off `model.latestQueryValue` — a single GLOBAL "most recent query
 * result of any screen" field. `update.test.ts`'s "4F.1 per-screen query
 * routing" establishes that `latestQueryValue` is legacy and that
 * `model.screens` is the real per-screen store (each screen keeps its own
 * slot, `latestQueryValue` does not).
 *
 * In production (`arbor-mcp/src/tui.ts`'s `refreshExecutionStatus`), a
 * `campaign.tree` poll for the `tree` screen runs on its own cadence
 * independently of which screen has focus — including while the operator is
 * looking at the devtools screen. That poll's `query_results` overwrites
 * `latestQueryValue` with a non-devtools shape between two devtools.stream
 * fetches. Diffing against `model.latestQueryValue` then treats every
 * currently-flashable node as brand new (no prior lines to compare against),
 * re-raising flashes for rows that had already settled — a visible spurious
 * re-flash glitch every time an unrelated screen's query lands in between.
 */
import { describe, expect, it } from "vitest";
import { update } from "../src/update.js";
import { initialModel } from "../src/model.js";
import type { DevToolsStreamLine } from "../src/player-piano.js";

const settledLine: DevToolsStreamLine = {
  seq: 1, ts: "t1", event_kind: "loop.node_verified", campaign_id: "c1", node_id: "n1", node_state: "verified", synthetic: false,
};

describe("devtools transition folding survives an interleaved other-screen query", () => {
  it("does not re-raise a full-strength flash for a node whose state has not changed, even after a tree poll lands in between", () => {
    const first = update(initialModel(), {
      type: "query_results", queryId: "q1", screen: "devtools", value: { campaign_id: "c1", lines: [settledLine] },
    }).model;
    expect(first.devtoolsTransitions.get("n1")).toEqual({ state: "verified", frames_remaining: 8 });

    // Let the flash decay most of the way down via ordinary devtools polls
    // reporting the SAME settled line each time (no state change).
    let model = first;
    for (let i = 0; i < 5; i += 1) {
      model = update(model, {
        type: "query_results", queryId: `q-decay-${i}`, screen: "devtools", value: { campaign_id: "c1", lines: [settledLine] },
      }).model;
    }
    expect(model.devtoolsTransitions.get("n1")?.frames_remaining).toBe(3);

    // An unrelated screen's poll (production: refreshExecutionStatus's
    // campaign.tree fetch, independent of focus) lands in between.
    const afterUnrelatedPoll = update(model, {
      type: "query_results", queryId: "q-tree", screen: "tree", value: { campaign_id: "c1", nodes: [{ id: "n1", state: "verified" }] },
    }).model;

    // The next devtools poll still reports the SAME settled state — no real
    // transition happened, so the flash should keep decaying, not reset.
    const next = update(afterUnrelatedPoll, {
      type: "query_results", queryId: "q-after", screen: "devtools", value: { campaign_id: "c1", lines: [settledLine] },
    }).model;

    expect(next.devtoolsTransitions.get("n1")?.frames_remaining).toBe(2);
  });
});
