import { describe, expect, it } from "vitest";
import { a2aScreen } from "../src/screens/a2a.js";
import { agentsScreen } from "../src/screens/agents.js";
import { backlogScreen } from "../src/screens/backlog.js";
import { busScreen } from "../src/screens/bus.js";
import { capabilitiesScreen } from "../src/screens/capabilities.js";
import { communicationsScreen } from "../src/screens/communications.js";
import { compactionScreen } from "../src/screens/compaction.js";
import { configScreen } from "../src/screens/config.js";
import { devtoolsScreen } from "../src/screens/devtools.js";
import { interviewsScreen } from "../src/screens/interviews.js";
import { jobsScreen } from "../src/screens/jobs.js";
import { kbScreen } from "../src/screens/kb.js";
import { operationsScreen } from "../src/screens/operations.js";
import { siblingsScreen } from "../src/screens/siblings.js";
import { surveillanceScreen } from "../src/screens/surveillance.js";
import { tasksScreen } from "../src/screens/tasks.js";
import type { ScreenModule } from "../src/screens/screen.js";

/**
 * WA-59: 16 screens rendered the bare caption "No data" for BOTH a
 * legitimately empty query result and an unrecognised/malformed one — an
 * operator had no way to tell "genuinely nothing here" from "the wire
 * contract broke". Every screen listed here now builds its zero-rows
 * caption from `empty-state.ts`'s `emptyCaption`/`unrecognisedCaption`,
 * which are guaranteed to differ. This test proves that contract holds for
 * every one of the 16 screens the audit flagged (`grep -rn 'caption: "No
 * data"' packages/arbor-tui/src/screens` — audit/2026-08-23-50-defects.md).
 *
 * Two probes exercise `registry.ts`'s two distinct fallback paths:
 *   - `null` — `buildScreenPipeline`'s `project()` short-circuits on a
 *     null/not-yet-issued query result (the "empty" reason).
 *   - `[]` and `{items: []}` — generic shapes that (verified per-screen
 *     below) match none of these 16 screens' own variant guards, so they
 *     fall through to the "unrecognised" reason. A couple of screens
 *     (kb.ts, operations.ts) deliberately treat a bare `[]` as a real,
 *     recognized empty list instead — that is legitimate, intentional
 *     behavior documented in those modules, and still produces a caption
 *     distinct from both the null-probe and the generic "No data" string,
 *     so the same three assertions hold either way.
 */
const SCREENS: readonly ScreenModule[] = [
  a2aScreen,
  agentsScreen,
  backlogScreen,
  busScreen,
  capabilitiesScreen,
  communicationsScreen,
  compactionScreen,
  configScreen,
  devtoolsScreen,
  interviewsScreen,
  jobsScreen,
  kbScreen,
  operationsScreen,
  siblingsScreen,
  surveillanceScreen,
  tasksScreen,
];

const CONTEXT = { width: 80, height: 12 };

describe("typed empty-state contract (WA-59)", () => {
  for (const screen of SCREENS) {
    describe(screen.id, () => {
      it("never renders the bare 'No data' caption for a null result", () => {
        const projection = screen.project(null, CONTEXT);
        expect(projection.rows).toEqual([]);
        expect(projection.caption).toEqual(expect.any(String));
        expect(projection.caption).not.toBe("");
        expect(projection.caption).not.toBe("No data");
      });

      it("never renders the bare 'No data' caption for an unrecognised/empty-array result", () => {
        for (const probe of [[], { items: [] }] as const) {
          const projection = screen.project(probe, CONTEXT);
          expect(projection.caption).toEqual(expect.any(String));
          expect(projection.caption).not.toBe("");
          expect(projection.caption).not.toBe("No data");
        }
      });

      it("distinguishes a null result from an unrecognised/empty-array one", () => {
        const nullCaption = screen.project(null, CONTEXT).caption;
        for (const probe of [[], { items: [] }] as const) {
          const probeCaption = screen.project(probe, CONTEXT).caption;
          expect(probeCaption).not.toBe(nullCaption);
        }
      });
    });
  }
});
