/**
 * screens-node-state-exhaustiveness.test.ts — a compile-time canary plus real-
 * surface assertions for the two functions that map `NodeState` to a visual.
 *
 * WHY THIS EXISTS. `NodeState` (`@arbor/core`) is a closed union of nine
 * members. Three separate functions map it to a glyph or a colour, and on
 * 2026-08-27 every one of them was silently incomplete:
 *
 *   - `screens/tree.ts`'s `nodeStateIcon`      — 8 of 9, `awaiting_review` → "?"
 *   - `player-piano.ts`'s `nodeStateColor`     — 5 of 9, four states uncoloured
 *
 * The consequence was not cosmetic. `awaiting_review` is the state a node holds
 * WHILE A CRITIC REVIEWS IT — the most distinctive thing this harness does — and
 * the operator cockpit rendered it as the unknown glyph. A 25-minute recording
 * of a real campaign shows exactly that.
 *
 * WHY THE PRODUCTION FUNCTIONS STILL TAKE `string`. They read `state` off a wire
 * projection, not off a typed in-process value, so a malformed or
 * newer-than-this-build payload must degrade to "?" rather than throw. That is
 * the same argument `screens-diagnostics-exhaustiveness.test.ts` makes for
 * `describeEvent`, and this file is its sibling: the runtime keeps duck-typing,
 * and the drift is made impossible to miss HERE, where `import type` costs
 * nothing at runtime.
 *
 * The moment `NodeState` gains a member the switch below does not enumerate,
 * this file fails to typecheck under `gate:typecheck-tests`. The production
 * switches still need their case added by hand — this only guarantees nobody
 * finds out from a screenshot.
 */
import { describe, it, expect, afterEach } from "vitest";
import type { NodeState } from "@arbor/core";
import { TERMINAL_NODE_STATES, STATES_CLOSED_TO_DIRECT_INPUT } from "@arbor/core";
import { TERMINAL_ROOT_STATES } from "../src/screens/product.js";
import { clearRegisteredScreens } from "../src/screens/screen.js";
import { treeScreen } from "../src/screens/tree.js";
import { nodeStateColor } from "../src/player-piano.js";

afterEach(() => clearRegisteredScreens());

/**
 * Exhaustiveness assertion. Fails `gate:typecheck-tests` if `NodeState` gains a
 * member not listed here, which is the signal that the two production
 * switches need a matching case.
 */
function assertEveryNodeStateHasAVisual(state: NodeState): void {
  switch (state) {
    case "pending":
    case "expanding":
    case "verified":
    case "claimed":
    case "failed":
    case "pruned":
    case "interrupted":
    case "abandoned":
    case "awaiting_review":
      return;
    default: {
      const exhaustive: never = state;
      throw new Error(`NodeState ${String(exhaustive)} has no declared visual`);
    }
  }
}

const ALL_NODE_STATES: readonly NodeState[] = [
  "pending", "expanding", "verified", "claimed", "failed",
  "pruned", "interrupted", "abandoned", "awaiting_review",
];

function treeRows(state: NodeState, unicode = true): string {
  const result = { campaign_id: "c", nodes: [{ id: "n1", label: "task", depth: 0, state, has_children: false }] };
  const projection = treeScreen.project(result, { width: 100, height: 20 });
  return treeScreen.render({ projection, width: 100, height: 20, unicode }).join("\n");
}

describe("every NodeState has a visual", () => {
  it("enumerates the whole union (compile-time canary)", () => {
    for (const state of ALL_NODE_STATES) expect(() => assertEveryNodeStateHasAVisual(state)).not.toThrow();
  });

  it("gives awaiting_review its own glyph on the tree screen, not the unknown marker", () => {
    // The state a node holds while a critic reviews it must be legible.
    expect(treeRows("awaiting_review")).not.toContain("?");
  });

  it("renders a distinct glyph for every state on the dedicated tree screen", () => {
    for (const unicode of [true, false]) {
      const glyphs = new Set(ALL_NODE_STATES.map((state) => {
        const row = treeRows(state, unicode).split("\n").find((line) => line.includes("task")) ?? "";
        return row.replace(/task.*$/s, "").trim();
      }));
      // Nine states must not collapse onto fewer than nine marks; a collision
      // means two different situations look identical to an operator.
      expect(glyphs.size).toBe(ALL_NODE_STATES.length);
    }
  });

  it("colours every state, so none is silently indistinguishable from unstyled text", () => {
    const uncoloured = ALL_NODE_STATES.filter((state) => nodeStateColor(state) === "");
    expect(uncoloured).toEqual([]);
  });
});

describe("terminal-state definitions agree", () => {
  it("the dashboard's leaf-isolated list matches the canonical set", () => {
    // product.ts keeps literals for leaf-module isolation; this is the seam
    // that stops the two from drifting. Four call sites previously carried
    // four different answers, two of them contradicting each other.
    expect([...TERMINAL_ROOT_STATES].sort()).toEqual([...TERMINAL_NODE_STATES].sort());
  });

  it("does not treat a recoverable state as terminal", () => {
    for (const recoverable of ["pending", "expanding", "interrupted", "awaiting_review"] as const) {
      expect(TERMINAL_NODE_STATES.has(recoverable)).toBe(false);
    }
  });
});

describe("the two 'terminal' predicates stay distinct", () => {
  it("a claimed node is terminal for expansion but still open to operator input", () => {
    // These were merged once, on the theory they had drifted. They had not:
    // "will it re-expand?" and "can a human still reply?" are different
    // questions. Merging them silently closed the thread on exactly the node a
    // human most wants to respond to.
    expect(TERMINAL_NODE_STATES.has("claimed")).toBe(true);
    expect(STATES_CLOSED_TO_DIRECT_INPUT.has("claimed")).toBe(false);
  });

  it("differ on claimed and nothing else", () => {
    const onlyInTerminal = [...TERMINAL_NODE_STATES].filter((s) => !STATES_CLOSED_TO_DIRECT_INPUT.has(s));
    const onlyInClosed = [...STATES_CLOSED_TO_DIRECT_INPUT].filter((s) => !TERMINAL_NODE_STATES.has(s));
    expect(onlyInTerminal).toEqual(["claimed"]);
    expect(onlyInClosed).toEqual([]);
  });
});
