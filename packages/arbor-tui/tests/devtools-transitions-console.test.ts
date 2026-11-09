/**
 * Finding B/C companion: `queryResults` (update.ts:115-141) folds the
 * player-piano transition map forward whenever a dispatched `query_results`
 * event's `value` is devtools-stream-shaped — it branches on
 * `isDevToolsStreamShape(value)`, never on the event's `screen` field. Step 2
 * wires a LIMITED `devtools.stream` into the cockpit's own query surface
 * (`tui.ts`'s `refreshProductSurface`, "console" arm), which means a
 * devtools-shaped result can now legitimately arrive tagged `screen:
 * "console"`, not only `screen: "devtools"`.
 *
 * This is a regression/documentation test for the fold's screen-agnostic
 * contract: it must keep working — and keep decaying/re-raising flashes
 * correctly — regardless of which screen the devtools-shaped payload is
 * dispatched under. Mirrors `devtools-transitions-interleaving.test.ts`'s
 * fixtures and assertions, substituting "console" for "devtools" as the
 * dispatch screen.
 */
import { describe, expect, it } from "vitest";
import { update } from "../src/update.js";
import { initialModel } from "../src/model.js";
import type { DevToolsStreamLine } from "../src/player-piano.js";

const settledLine: DevToolsStreamLine = {
  seq: 1, ts: "t1", event_kind: "loop.node_verified", campaign_id: "c1", node_id: "n1", node_state: "verified", synthetic: false,
};

const freshlyVerifiedLine: DevToolsStreamLine = {
  seq: 2, ts: "t2", event_kind: "loop.node_verified", campaign_id: "c1", node_id: "n2", node_state: "verified", synthetic: false,
};

describe("devtoolsTransitions folds under screen === \"cockpit\", not only \"devtools\"", () => {
  it("raises a full-strength flash for a devtools-shaped result dispatched with screen: \"cockpit\"", () => {
    const next = update(initialModel(), {
      type: "query_results", queryId: "q1", screen: "console", value: { campaign_id: "c1", lines: [freshlyVerifiedLine] },
    }).model;
    expect(next.devtoolsTransitions.get("n2")).toEqual({ state: "verified", frames_remaining: 8 });
  });

  it("decays an existing flash on successive cockpit-tagged devtools polls of the same settled state, exactly as the devtools screen's own polls do", () => {
    let model = update(initialModel(), {
      type: "query_results", queryId: "q1", screen: "console", value: { campaign_id: "c1", lines: [settledLine] },
    }).model;
    expect(model.devtoolsTransitions.get("n1")?.frames_remaining).toBe(8);

    for (let i = 0; i < 5; i += 1) {
      model = update(model, {
        type: "query_results", queryId: `q-decay-${i}`, screen: "console", value: { campaign_id: "c1", lines: [settledLine] },
      }).model;
    }
    expect(model.devtoolsTransitions.get("n1")?.frames_remaining).toBe(3);
  });

  it("folds the SAME devtoolsTransitions map regardless of whether the payload is tagged \"devtools\" or \"cockpit\" — the fold keys off value shape, not screen identity", () => {
    const viaDevtools = update(initialModel(), {
      type: "query_results", queryId: "q1", screen: "devtools", value: { campaign_id: "c1", lines: [freshlyVerifiedLine] },
    }).model;
    const viaCockpit = update(initialModel(), {
      type: "query_results", queryId: "q1", screen: "console", value: { campaign_id: "c1", lines: [freshlyVerifiedLine] },
    }).model;
    expect(viaCockpit.devtoolsTransitions).toEqual(viaDevtools.devtoolsTransitions);
  });
});
