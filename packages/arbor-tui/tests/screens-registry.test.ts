/**
 * Registry pipeline tests (roadmap 4F.8).
 *
 * buildScreenPipeline (src/screens/registry.ts) replaces each leaf screen's
 * hand-written shape-sniffing `project()` cascade + render()-time
 * `columns.some(...)` guessing with one generic, table-driven dispatcher.
 * These tests prove:
 *   1. every screen totally resolves null / unmatched-shape input to a
 *      `variant: "empty"` projection — never throws;
 *   2. the render()-time column-shape-sniffing branches the registry
 *      replaced are actually gone from the leaf source files.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { ScreenModule } from "../src/screens/screen.js";

const [
  { campaignsScreen },
  { tasksScreen },
  { operationsScreen },
  { outputScreen },
  { communicationsScreen },
  { diagnosticsScreen },
  { configScreen },
  { agentsScreen },
  { jobsScreen },
  { approvalsScreen },
  { interviewsScreen },
  { devtoolsScreen },
] = await Promise.all([
  import("../src/screens/campaigns.js"),
  import("../src/screens/tasks.js"),
  import("../src/screens/operations.js"),
  import("../src/screens/output.js"),
  import("../src/screens/communications.js"),
  import("../src/screens/diagnostics.js"),
  import("../src/screens/config.js"),
  import("../src/screens/agents.js"),
  import("../src/screens/jobs.js"),
  import("../src/screens/approvals.js"),
  import("../src/screens/interviews.js"),
  import("../src/screens/devtools.js"),
]);

const allScreens: readonly ScreenModule[] = [
  campaignsScreen,
  tasksScreen,
  operationsScreen,
  outputScreen,
  communicationsScreen,
  diagnosticsScreen,
  configScreen,
  agentsScreen,
  jobsScreen,
  approvalsScreen,
  interviewsScreen,
  devtoolsScreen,
];

const LEAF_SCREEN_FILES = [
  "campaigns.ts",
  "tasks.ts",
  "operations.ts",
  "output.ts",
  "communications.ts",
  "diagnostics.ts",
  "config.ts",
  "agents.ts",
  "jobs.ts",
  "approvals.ts",
  "interviews.ts",
  "devtools.ts",
];

describe("screen registry — total resolution", () => {
  it("resolves null input to a variant:empty, zero-row projection for every screen", () => {
    for (const screen of allScreens) {
      const p = screen.project(null, { width: 80, height: 24 });
      expect(p.rows).toHaveLength(0);
      expect(p.variant).toBe("empty");
    }
  });

  // Genuinely non-matching garbage: verified against every screen's real
  // predicates (all require either Array.isArray + length > 0, or a specific
  // named property present on a non-null object) — none of 42, "garbage", or
  // {} satisfy any of the 12 screens' match predicates.
  for (const garbage of [42, "garbage", {}] as const) {
    it(`resolves ${JSON.stringify(garbage)} input to variant:empty without throwing, for every screen`, () => {
      for (const screen of allScreens) {
        expect(() => {
          const p = screen.project(garbage, { width: 80, height: 24 });
          expect(p.rows).toHaveLength(0);
          expect(p.variant).toBe("empty");
        }).not.toThrow();
      }
    });
  }
});

describe("screen registry — shape-sniffing removed from render()", () => {
  it("no leaf screen source file re-inspects projection.columns to pick a render path", () => {
    for (const file of LEAF_SCREEN_FILES) {
      const source = readFileSync(new URL(`../src/screens/${file}`, import.meta.url), "utf8");
      expect(source, `${file} should not contain a columns.some( shape-sniffing branch`).not.toContain(".columns.some(");
    }
  });
});
