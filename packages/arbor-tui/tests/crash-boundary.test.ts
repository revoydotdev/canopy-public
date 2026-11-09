import { describe, expect, it } from "vitest";
import { crashActionForKey, projectCrash, renderCrashScreen } from "../src/index.js";
import { displayWidth } from "../src/widgets.js";

describe("crash boundary", () => {
  it("replaces the full screen and bounds an oversized stack", () => {
    const error = new Error("renderer exploded");
    error.stack = `Error: renderer exploded\n${"frame at enormous-stack\n".repeat(2_000)}`;
    const projection = projectCrash(error, 512);
    expect(projection.stack_truncated).toBe(true);
    expect(Buffer.byteLength(projection.stack)).toBeLessThanOrEqual(512);
    const rendered = renderCrashScreen(projection, 80);
    expect(rendered).toContain(`${String.fromCharCode(27)}[2J`);
    expect(rendered).toContain("revoy2 crashed");
    expect(rendered).toContain("copy as issue");
    expect(rendered).toContain("restart");
    expect(rendered).toContain("quit");
  });
  it("maps only the disclosed recovery keys", () => {
    expect(crashActionForKey("c")).toBe("copy_issue");
    expect(crashActionForKey("r")).toBe("restart");
    expect(crashActionForKey("q")).toBe("quit");
    expect(crashActionForKey("x")).toBeNull();
  });
});

describe("the crash message keeps its cause (EC-040)", () => {
  const LONG_PATH = "/tmp/claude-1000/-home-revelri-Dev-revoy-revoy2/219d45d4-5cac/scratchpad/ro-proj/.arbor/kb/failure-modes.jsonl";
  const projection = {
    title: "revoy2 crashed" as const,
    message: `could not durably save KB stream ${LONG_PATH}: Error: EACCES: permission denied, open '${LONG_PATH}.tmp-3840847'`,
    stack: `KBIntegrityError: could not durably save KB stream ${LONG_PATH}\n    at atomicWrite (/workspace/canopy/packages/arbor-kb/src/persist.ts:94:59)`,
    stack_truncated: false,
    issue_text: "",
    actions: ["c · copy as issue", "r · restart", "q · quit"] as const,
  };

  it("wraps the message so the reason survives a path longer than the terminal", () => {
    // Clipping every line to the width lost exactly the actionable half: the
    // absolute path consumed the row and "EACCES: permission denied" fell off.
    const out = renderCrashScreen(projection, 150);
    expect(out).toContain("EACCES");
    expect(out).toContain("permission denied");
  });

  it("keeps every rendered row inside the terminal width", () => {
    for (const width of [60, 100, 150]) {
      const rows = renderCrashScreen(projection, width).replace(/\u001b\[[0-9;]*[A-Za-z]/g, "").split("\n");
      for (const row of rows) expect(displayWidth(row)).toBeLessThanOrEqual(width);
    }
  });

  it("marks a stack frame it had to cut", () => {
    const out = renderCrashScreen(projection, 60);
    expect(out).toContain("\u2026");
  });
});
