import { describe, expect, it } from "vitest";
import { kbScreen } from "../src/screens/kb.js";
import { displayWidth } from "../src/widgets.js";

describe("KB empty-state product pipeline", () => {
  it.each([
    ["empty runtime list", []],
    ["no query result", null],
    ["unrecognised response", { unexpected: true }],
  ])("retains orientation and the authoritative caption for %s", (_name, result) => {
    const size = { width: 80, height: 20 };
    const projection = kbScreen.project(result, size);
    const lines = kbScreen.render({ projection, ...size });
    expect(lines[0]).toBe("KNOWLEDGE BASE");
    expect(lines.join(" ").replace(/\s+/gu, " "))
      .toContain(projection.caption!.replace(/\s+/gu, " "));
    expect(lines.join(" ")).toContain("Ctrl+P: return to Console or inspect Campaigns.");
    expect(projection.rows).toEqual([]);
    expect(lines.length).toBeLessThanOrEqual(size.height);
    expect(lines.every((line) => displayWidth(line) <= size.width)).toBe(true);
  });

  it("keeps the missing-result and malformed-result messages distinct", () => {
    const size = { width: 40, height: 20 };
    const absent = kbScreen.project(null, size);
    const malformed = kbScreen.project({ unexpected: true }, size);
    expect(absent.caption).not.toBe(malformed.caption);
    for (const projection of [absent, malformed]) {
      const lines = kbScreen.render({ projection, ...size });
      expect(lines[0]).toBe("KNOWLEDGE BASE");
      expect(lines.every((line) => displayWidth(line) <= size.width)).toBe(true);
    }
  });
});
