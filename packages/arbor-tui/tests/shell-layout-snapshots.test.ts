/**
 * Cell-snapshot tests of `renderScene` (the cockpit shell) at the M2
 * acceptance viewports (ui-spec §8), plus recovery from undersized back to
 * a full layout. FIXTURE-ONLY: `syntheticProjection` below builds a
 * deliberately synthetic, minimal `RenderProjection` — no real runtime,
 * campaign, or console session is involved. Fixture files under
 * `tests/fixtures/shell-layout/` are committed golden snapshots of that
 * synthetic scene's flattened rows; a real layout regression changes them,
 * a deliberate geometry change updates them (see the M2 report for which
 * fixtures changed and why).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createNavigation, initialModel, renderScene, type RenderProjection } from "../src/index.js";
import { installScreens } from "../src/screens/install.js";
import { clearRegisteredScreens, type ScreenId } from "../src/screens/screen.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = join(HERE, "fixtures", "shell-layout");

afterEach(() => clearRegisteredScreens());

/** FIXTURE-ONLY: a synthetic, deterministic console context — never real runtime data. */
function syntheticProjection(columns: number, rows: number): RenderProjection {
  clearRegisteredScreens();
  installScreens();
  const tree = {
    campaign_id: "fixture-campaign",
    nodes: [
      { id: "root", parent_id: null, state: "verified", action_description: "Plan the change" },
      { id: "child", parent_id: "root", state: "expanding", action_description: "Implement it", visit_count: 3 },
    ],
  };
  const console_input = { text: "fixture draft", cursor: 5, focused: true, action: "send" as const };
  return {
    app: {
      ...initialModel(),
      screen: "console",
      telemetryCampaignId: "fixture-campaign",
      screens: new Map<ScreenId, unknown>([
        ["console", { captured_at: "2026-01-01T00:00:00Z", tree, sidebar_visibility: "auto", console_input }],
      ]),
    },
    output: "",
    navigation: createNavigation({ id: "cockpit", route: "/", split: "horizontal", ratio: 0.5, panes: [{ id: "main", title: "revoy2" }] }, { columns, rows }),
  };
}

function fixturePath(name: string): string {
  return join(FIXTURE_DIR, `${name}.txt`);
}

/** Compares against (or, with UPDATE_SHELL_LAYOUT_FIXTURES=1, writes) a committed golden fixture. */
function expectMatchesFixture(name: string, actual: string): void {
  const path = fixturePath(name);
  if (process.env.UPDATE_SHELL_LAYOUT_FIXTURES === "1") {
    mkdirSync(FIXTURE_DIR, { recursive: true });
    writeFileSync(path, actual, "utf8");
    return;
  }
  if (!existsSync(path)) throw new Error(`missing fixture ${path}; run with UPDATE_SHELL_LAYOUT_FIXTURES=1 to create it`);
  expect(actual).toBe(readFileSync(path, "utf8"));
}

const VIEWPORTS: readonly { readonly name: string; readonly columns: number; readonly rows: number }[] = [
  { name: "160x48", columns: 160, rows: 48 },
  { name: "120x36", columns: 120, rows: 36 },
  { name: "100x30", columns: 100, rows: 30 },
  { name: "80x24", columns: 80, rows: 24 },
  { name: "60x18", columns: 60, rows: 18 },
  { name: "50x14", columns: 50, rows: 14 },
];

describe("shell layout cell snapshots (ui-spec §8 viewports, FIXTURE-ONLY data)", () => {
  for (const viewport of VIEWPORTS) {
    it(`matches the committed fixture at ${viewport.name}`, () => {
      const scene = renderScene(syntheticProjection(viewport.columns, viewport.rows), { color: false, unicode: true });
      expectMatchesFixture(viewport.name, scene.rows.join("\n") + "\n");
    });
  }

  it("recovers a full, non-minimal frame after shrinking to 50x14 and growing back to 160x48", () => {
    const shrunk = renderScene(syntheticProjection(50, 14), { color: false });
    expect(shrunk.layout_class).toBe("minimal");
    const recovered = renderScene(syntheticProjection(160, 48), { color: false });
    expect(recovered.layout_class).toBe("docked");
    expectMatchesFixture("160x48", recovered.rows.join("\n") + "\n");
  });
});
