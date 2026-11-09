import { describe, expect, it } from "vitest";
import { projectResponsiveSidebar, renderResponsiveSidebar } from "../src/responsive-sidebar.js";
import { clipLabelWithEllipsis } from "../src/screens/region.js";
import { stripAnsi } from "../src/player-piano.js";
import { displayWidth } from "../src/widgets.js";
import { deriveTheme, toForegroundSgr } from "../src/theme.js";

describe("colored inspector geometry", () => {
  it.each(["truecolor", "ansi256"] as const)("keeps focused geometry and a non-color focus cue in %s mode", (mode) => {
    const projection = projectResponsiveSidebar({ width: 160, visibility: "auto", tab: "docs", focused: true });
    const plain = renderResponsiveSidebar(projection, { width: 42, height: 20, color: false });
    const colored = renderResponsiveSidebar(projection, { width: 42, height: 20, color: true, color_mode: mode });
    expect(colored.map(stripAnsi)).toEqual(plain);
    expect(plain[0]).toContain("FOCUSED");
    expect(plain[0]).toMatch(/^╔/);
    expect(plain.at(-1)).toMatch(/^╚/);
    expect(colored.every((value) => displayWidth(stripAnsi(value)) === 42)).toBe(true);
  });
  it("uses semantic colors beyond the active tab without changing document prose", () => {
    const projection = projectResponsiveSidebar({ width: 160, visibility: "auto", tab: "project" });
    const theme = deriveTheme("dark");
    const lines = renderResponsiveSidebar(projection, { height: 30, color: true, theme });
    expect(lines.join("\n")).toContain(toForegroundSgr(theme.colors.info) + "PROJECT REPO");
    expect(lines.join("\n")).toContain(toForegroundSgr(theme.colors.special) + "GOVERNANCE");
    const document = { ...projection, document: { title: "Reference", source_path: "README.md", content: "failed verified claimed" } };
    const prose = renderResponsiveSidebar(document, { height: 20, color: true, theme }).find((value) => value.includes("failed verified claimed"));
    expect(prose).toContain("failed verified claimed");
    expect(prose).not.toContain(toForegroundSgr(theme.colors.danger));
    expect(prose).not.toContain(toForegroundSgr(theme.colors.success));
  });
  it.each(["project", "adrs", "docs", "devtools"] as const)("keeps %s tabs and borders identical to plain rendering", (tab) => {
    const projection = projectResponsiveSidebar({ width: 160, visibility: "auto", tab });
    const plain = renderResponsiveSidebar(projection, { width: 42, height: 30, color: false });
    const colored = renderResponsiveSidebar(projection, { width: 42, height: 30, color: true });
    expect(colored.map(stripAnsi)).toEqual(plain);
    expect(colored.every((line) => displayWidth(stripAnsi(line)) === 42)).toBe(true);
    expect(colored.some((line) => line.includes("DOCS"))).toBe(true);
  });
  it("clips visible cells rather than ANSI bytes and closes the active style", () => {
    const label = toForegroundSgr(deriveTheme("dark").colors.accent) + "a long colored label";
    expect(stripAnsi(clipLabelWithEllipsis(label, 8))).toBe("a long …");
    expect(clipLabelWithEllipsis(label, 8)).toMatch(/\[0m$/);
  });
});
