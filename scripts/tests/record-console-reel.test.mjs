import { describe, expect, it } from "vitest";
import { pasteCommandPlan, resizeArgs } from "../record-console-reel.mjs";

describe("record-console-reel new step kinds", () => {
  it("builds a resize-window argv for a { resize: [cols, rows] } step", () => {
    expect(resizeArgs("reel-123", 200, 55)).toEqual(["resize-window", "-t", "reel-123", "-x", "200", "-y", "55"]);
  });

  it("builds a load-buffer + bracketed paste-buffer argv pair for a { paste: text } step", () => {
    const plan = pasteCommandPlan("reel-123", "reel-paste-0", "/tmp/claude-1000/paste-0.txt");
    expect(plan.loadArgs).toEqual(["load-buffer", "-b", "reel-paste-0", "/tmp/claude-1000/paste-0.txt"]);
    // -p is the bracketed-paste flag; -d frees the buffer after use.
    expect(plan.pasteArgs).toEqual(["paste-buffer", "-p", "-d", "-b", "reel-paste-0", "-t", "reel-123"]);
  });
});
